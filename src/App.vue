<script setup lang="ts">
/**
 * 演示主界面。
 *
 * 四层拓扑纵向堆叠，每层一张独立的图、固定 340px 高，超出部分整页滚动。
 * 每层由「路径」唯一确定：点链路 / 点域 / 点整层详情，都会在下面接一层新的图。
 * 同层再点另一个入口时，原来的这张子图连同它下面所有层整棵销毁。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import TopoGraph from './components/TopoGraph.vue';
import { buildLayer, findLink, pathKey, SCALES, SCALE_KEYS } from './data/generate';
import { digestOf, localAlarms, setQueryCost } from './data/alarms';
import {
  descendantPaths,
  fetchLayer,
  prefetchPath,
  refreshLayer,
  summarize as runSummary,
} from './data/server';
import type { Digest, LayerTopo, PathSeg, ScaleKey } from './data/model';
import {
  BUILTIN_KEYS,
  CUSTOM_KEYS,
  LAYOUT_META,
  defaultLayoutForLayer,
  type LayoutKey,
} from './components/layouts';

/* ------------------------------------------------------------ 视图状态 */

interface ViewState {
  key: string;
  path: PathSeg[];
  topo: LayerTopo;
  layoutKey: LayoutKey;
  highlightIds: string[];
  digests: Map<string, Digest>;
  loading: boolean;
  ms: number;
  fromCache: boolean;
  lodTier: number;
  controller?: AbortController;
}

const scale = ref<ScaleKey>('M');
const views = ref<ViewState[]>([]);
const logs = ref<string[]>([]);
const prefetchOn = ref(true);
const busy = ref(false);

const metrics = reactive({
  fetches: 0,
  cacheHits: 0,
  aborts: 0,
  lastMs: 0,
  lastCache: false,
  serialMs: 0,
  serialQueries: 0,
  parallelMs: 0,
  parallelQueries: 0,
  compared: false,
});

function log(msg: string) {
  logs.value = [`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${msg}`, ...logs.value].slice(0, 8);
}

const layoutOptions = computed(() => [
  ...CUSTOM_KEYS.map((k) => ({ key: k as LayoutKey, ...LAYOUT_META[k] })),
  ...BUILTIN_KEYS.map((k) => ({ key: k as LayoutKey, ...LAYOUT_META[k] })),
]);

const cacheSize = computed(() => {
  const set = new Set(views.value.map((v) => `${scale.value}:${v.key}`));
  return set.size;
});

/* ------------------------------------------------------------ 拉一层图 */

function indexOf(view: ViewState): number {
  return views.value.findIndex((v) => v.key === view.key);
}

async function computeDigests(v: ViewState, signal: AbortSignal): Promise<void> {
  const out = new Map<string, Digest>();

  // 单板层近千个图元，逐个递归汇总没有意义：只按本层告警落色与角标
  if (v.topo.layer === 4) {
    const byObject = new Map<string, ReturnType<typeof localAlarms>>();
    for (const a of localAlarms(v.topo)) {
      const list = byObject.get(a.objectId);
      if (list) list.push(a);
      else byObject.set(a.objectId, [a]);
    }
    for (const [id, list] of byObject) out.set(id, digestOf(list));
    v.digests = out;
    return;
  }

  const tasks: Promise<[string, Digest]>[] = [];
  for (const n of v.topo.nodes) {
    tasks.push(
      runSummary(v.path, n.id, 'node', scale.value, 'parallel', signal).then(
        (r) => [n.id, digestOf(r.alarms)] as [string, Digest],
      ),
    );
  }
  for (const l of v.topo.links) {
    if (!l.drillable) continue;
    tasks.push(
      runSummary(v.path, l.id, 'link', scale.value, 'parallel', signal).then(
        (r) => [l.id, digestOf(r.alarms)] as [string, Digest],
      ),
    );
  }

  const pairs = await Promise.all(tasks);
  for (const [id, dg] of pairs) out.set(id, dg);
  v.digests = out;
}

async function loadView(path: PathSeg[], signal: AbortSignal): Promise<ViewState | null> {
  metrics.fetches += 1;
  const t0 = performance.now();
  try {
    const res = await fetchLayer(path, scale.value, { signal });
    if (res.fromCache) metrics.cacheHits += 1;

    const v: ViewState = {
      key: pathKey(path),
      path,
      topo: res.topo,
      layoutKey: defaultLayoutForLayer(res.topo.layer) as LayoutKey,
      highlightIds: [],
      digests: new Map(),
      loading: false,
      ms: res.ms,
      fromCache: res.fromCache,
      lodTier: -1,
      controller: undefined,
    };

    await computeDigests(v, signal);
    metrics.lastMs = performance.now() - t0;
    metrics.lastCache = res.fromCache;
    return v;
  } catch (err) {
    if ((err as DOMException)?.name === 'AbortError') {
      metrics.aborts += 1;
      return null;
    }
    log(`加载失败：${String(err)}`);
    return null;
  }
}

/* ------------------------------------------------------------ 下钻逻辑 */

async function drillLink(view: ViewState, linkId: string) {
  const idx = indexOf(view);
  if (idx < 0) return;

  const link = findLink(view.topo, linkId);
  if (!link || !link.drillable) return;

  await openSubView(view, idx, { kind: 'link', id: link.id, label: link.label }, [linkId]);
}

async function drillDomain(view: ViewState, domainId: string) {
  const idx = indexOf(view);
  if (idx < 0) return;
  const d = view.topo.domains.find((x) => x.id === domainId);
  if (!d || !d.drillable) return;

  await openSubView(view, idx, { kind: 'domain', id: d.id, label: d.name }, [domainId]);
}

async function enterBoard(view: ViewState) {
  const idx = indexOf(view);
  if (idx < 0 || !view.topo.canEnterBoard) return;

  const seg: PathSeg = {
    kind: 'detail',
    id: `${pathKey(view.topo.path)}#detail`,
    label: '整层全部单板',
  };
  await openSubView(view, idx, seg, []);
}

/**
 * 在某层下面接一层。
 *
 * 两个关键动作：
 *  1. 上一层的那个下钻请求（如果还在飞）立刻 abort —— 旧实现不取消不销毁，
 *     等它回来还会把新图覆盖掉。
 *  2. 同层被顶替：原来这一层下面的整棵子树全部销毁。
 */
async function openSubView(view: ViewState, idx: number, seg: PathSeg, highlightIds: string[]) {
  // 中断这一层上仍在进行中的下钻
  view.controller?.abort();
  const ctrl = new AbortController();
  view.controller = ctrl;

  // 父层：新的高亮、旧的恢复默认
  view.highlightIds = highlightIds;

  // 同层被顶替，它下面所有层整棵销毁
  for (const v of views.value.slice(idx + 1)) v.controller?.abort();
  views.value.splice(idx + 1);

  busy.value = true;
  log(`下钻 ${seg.label} …`);
  const sub = await loadView([...view.path, seg], ctrl.signal);
  busy.value = false;
  if (!sub) {
    log(`已中断 ${seg.label}（请求被取消，不会覆盖新图）`);
    return;
  }

  // 子层：把这条路径的入口端点标出来，一眼看出是"从哪进来的"
  sub.highlightIds = sub.topo.nodes.filter((n) => n.entry).map((n) => n.id);
  sub.controller = undefined;
  views.value.push(sub);
  log(`进入第 ${sub.topo.layer} 层 · ${sub.topo.nodes.length} 节点 / ${sub.topo.links.length} 链路`);
}

/** 关闭某一层：它自己 + 下面所有层一起销毁，父层高亮恢复默认 */
function closeFrom(view: ViewState) {
  const idx = indexOf(view);
  if (idx <= 0) return;

  for (const v of views.value.slice(idx)) v.controller?.abort();
  views.value.splice(idx);

  const parent = views.value[idx - 1];
  if (parent) parent.highlightIds = [];
  log(`关闭第 ${view.topo.layer} 层及以下`);
}

/** 刷新：只让当前这一层的缓存失效，父层子层都不动 */
async function refresh(view: ViewState) {
  const idx = indexOf(view);
  if (idx < 0) return;

  refreshLayer(view.path, scale.value);
  log(`刷新第 ${view.topo.layer} 层（只失效本层缓存）`);

  const ctrl = new AbortController();
  view.controller?.abort();
  view.controller = ctrl;
  view.loading = true;

  const fresh = await loadView(view.path, ctrl.signal);
  view.loading = false;
  if (!fresh) return;

  // 只替换这一层的数据，下面挂着的子层不动
  view.topo = fresh.topo;
  view.digests = fresh.digests;
  view.ms = fresh.ms;
  view.fromCache = fresh.fromCache;
  log(`第 ${view.topo.layer} 层已刷新${fresh.fromCache ? '（命中缓存）' : ''}`);
}

function setLayout(view: ViewState, key: LayoutKey) {
  view.layoutKey = key;
}

function onLod(view: ViewState, tier: number) {
  view.lodTier = tier;
}

/* ------------------------------------------------------------ 切换规模 */

async function resetAll() {
  for (const v of views.value) v.controller?.abort();
  views.value = [];
  metrics.fetches = 0;
  metrics.cacheHits = 0;
  metrics.aborts = 0;
  metrics.compared = false;

  const ctrl = new AbortController();
  const root = await loadView([], ctrl.signal);
  if (root) views.value = [root];
  log(`已重置为「${SCALES[scale.value].label}」`);
  if (prefetchOn.value) void startPrefetch();
}

/* ------------------------------------------------------------ 空闲预取 */

function idle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number })
      .requestIdleCallback;
    if (ric) ric(() => resolve());
    else window.setTimeout(resolve, 60);
  });
}

/**
 * 页面空闲时把当前拓扑下面整棵子树的数据提前拉回本地缓存。
 * 用户感受不到；缓存没就绪时点下钻照样能走小请求，不阻塞。
 */
async function startPrefetch() {
  if (!prefetchOn.value || views.value.length === 0) return;
  const root = views.value[0];
  const paths = descendantPaths(root.path, scale.value, 2);
  if (paths.length === 0) return;

  log(`空闲预取 ${paths.length} 条子路径…`);
  const ctrl = new AbortController();
  let i = 0;

  while (i < paths.length) {
    // 用户一交互就抢占，预取让路
    if (busy.value) {
      ctrl.abort();
      log('预取被交互抢占，已让路');
      return;
    }
    const batch = paths.slice(i, i + 3);
    i += batch.length;
    await Promise.all(batch.map((p) => prefetchPath(p, scale.value, ctrl.signal)));
    await idle();
  }
  log(`预取完成，缓存 ${paths.length} 条`);
}

/* ------------------------------------------------------------ 串行/并行对比 */

async function runCompare() {
  const root = views.value[0];
  if (!root || metrics.compared) return;

  const target =
    root.topo.nodes.find((n) => n.drillLinks.length > 0) ?? root.topo.nodes[0];
  if (!target) return;

  log(`对比汇总：${target.name} 的完整子树`);
  setQueryCost(15);

  const serial = await runSummary(root.path, target.id, 'node', scale.value, 'serial');
  metrics.serialMs = serial.ms;
  metrics.serialQueries = serial.queries;

  const parallel = await runSummary(root.path, target.id, 'node', scale.value, 'parallel');
  metrics.parallelMs = parallel.ms;
  metrics.parallelQueries = parallel.queries;

  setQueryCost(0);
  metrics.compared = true;
  log(
    `串行 ${serial.queries} 次 / ${serial.ms.toFixed(0)}ms，并行 ${parallel.queries} 次 / ${parallel.ms.toFixed(0)}ms`,
  );
}

/* ------------------------------------------------------------ 启动 */

onMounted(async () => {
  setQueryCost(0);
  await resetAll();
});
</script>

<template>
  <div class="app">
    <aside class="side">
      <h1>网络拓扑多层下钻</h1>
      <p class="decl">
        演示项目。结构与交互按真实业务重建，<b>所有网元、链路、单板、告警均为程序合成</b>，
        不含任何真实网络数据、客户信息或公司代码。
      </p>

      <section class="block">
        <h2>规模</h2>
        <div class="chips">
          <button
            v-for="k in SCALE_KEYS"
            :key="k"
            class="chip"
            :class="{ on: scale === k }"
            @click="scale = k; resetAll()"
          >
            {{ SCALES[k].label }}
          </button>
        </div>
        <p class="hint">{{ SCALES[scale].hint }}</p>
      </section>

      <section class="block">
        <h2>层级结构</h2>
        <ul class="tree">
          <li><b>第1层</b> 主干链路（子网与中间设备被抽象掉）</li>
          <li><b>第2~3层</b> 点链路 / 点域展开：两端点 + 2~3 条并行路径</li>
          <li><b>第4层</b> 整层「详情」展开：上一层的全部网元与端口的单板</li>
        </ul>
        <p class="hint">每层固定 340px 高，纵向堆叠，超出整页滚动；切换分支时旧子树整棵销毁。</p>
      </section>

      <section class="block">
        <h2>前端优化</h2>
        <label class="sw">
          <input v-model="prefetchOn" type="checkbox" @change="prefetchOn && startPrefetch()" />
          空闲预取（页面闲下来提前拉子树）
        </label>
        <p class="hint">
          缓存命中后下钻走短请求；缓存没就绪时也不阻塞，直接走小请求只拉需要的子树。
          点另一条链路会立刻中断还在飞的请求。
        </p>
      </section>

      <section class="block">
        <h2>前后端对比</h2>
        <button class="primary" :disabled="metrics.compared || busy" @click="runCompare">
          {{ metrics.compared ? '已对比' : '一键对比串行 / 并行' }}
        </button>
        <table v-if="metrics.compared" class="cmp">
          <thead>
            <tr><th></th><th>子查询</th><th>耗时</th></tr>
          </thead>
          <tbody>
            <tr><td>串行（旧）</td><td>{{ metrics.serialQueries }}</td><td>{{ metrics.serialMs.toFixed(0) }} ms</td></tr>
            <tr><td>并行（新）</td><td>{{ metrics.parallelQueries }}</td><td>{{ metrics.parallelMs.toFixed(0) }} ms</td></tr>
          </tbody>
        </table>
        <p v-if="metrics.compared" class="hint">
          同一个子树、同一次查询：串行要按顺序把每条兄弟分支都跑完；并行同时发出去，只等最慢的那条。
        </p>
      </section>

      <section class="block">
        <h2>指标</h2>
        <div class="kv">
          <div class="row"><span class="k">层数</span><span class="v">{{ views.length }} / 4</span></div>
          <div class="row"><span class="k">取数次数</span><span class="v">{{ metrics.fetches }}</span></div>
          <div class="row"><span class="k">缓存命中</span><span class="v">{{ metrics.cacheHits }}</span></div>
          <div class="row"><span class="k">中断次数</span><span class="v">{{ metrics.aborts }}</span></div>
          <div class="row"><span class="k">本次耗时</span><span class="v">{{ metrics.lastMs.toFixed(0) }} ms</span></div>
          <div class="row"><span class="k">本层缓存</span><span class="v">{{ metrics.lastCache ? '命中' : '回源' }}</span></div>
        </div>
      </section>

      <section class="block">
        <h2>日志</h2>
        <ul class="log">
          <li v-for="(l, i) in logs" :key="i">{{ l }}</li>
        </ul>
      </section>
    </aside>

    <main class="stack">
      <section v-for="(v, i) in views" :key="v.key" class="view">
        <header class="vhead">
          <div class="vtitles">
            <div class="vt">{{ v.topo.title }}</div>
            <div class="vs">{{ v.topo.subtitle }}</div>
            <div class="crumbs">
              <span>主干拓扑</span>
              <span v-for="(seg, k) in v.path" :key="k"> › {{ seg.label }}</span>
            </div>
          </div>

          <div class="vops">
            <span class="stat">{{ v.topo.nodes.length }} 节点 · {{ v.topo.links.length }} 链路 · {{ v.ms.toFixed(0) }}ms</span>
            <button v-if="v.topo.canEnterBoard" class="cta" @click="enterBoard(v)">详情：全部网元单板</button>
            <button class="op" @click="refresh(v)">{{ v.loading ? '刷新中…' : '刷新本层' }}</button>
            <button v-if="i > 0" class="op" @click="closeFrom(v)">关闭</button>
          </div>
        </header>

        <div class="lbar">
          <button
            v-for="opt in layoutOptions"
            :key="opt.key"
            class="lchip"
            :class="{ on: v.layoutKey === opt.key, builtin: opt.kind === 'builtin' }"
            :title="opt.hint"
            @click="setLayout(v, opt.key)"
          >
            {{ opt.label }}
          </button>
          <span class="lod">LOD 档 {{ v.lodTier < 0 ? '—' : v.lodTier }}</span>
        </div>

        <TopoGraph
          :topo="v.topo"
          :layout-key="v.layoutKey"
          :height="340"
          :highlight-ids="v.highlightIds"
          :digests="v.digests"
          @drill-link="(id: string) => drillLink(v, id)"
          @drill-domain="(id: string) => drillDomain(v, id)"
          @lod-change="(t: number) => onLod(v, t)"
        />
      </section>

      <p v-if="views.length === 0" class="empty">正在加载拓扑演示…</p>
    </main>
  </div>
</template>
