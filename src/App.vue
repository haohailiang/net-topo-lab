<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import TopoGraph from './components/TopoGraph.vue';
import { LAYOUT_KEYS, LAYOUT_LABELS, type LayoutKey } from './components/layouts';
import {
  SCALES,
  buildTopology,
  fetchChildren,
  resetMockCache,
  type ScaleKey,
  type TopoSnapshot,
} from './data/topo';

interface FullResult {
  scale: ScaleKey;
  ms: number;
  nodes: number;
  edges: number;
  bytes: number;
}

interface LazyResult {
  scale: ScaleKey;
  ms: number;
  nodes: number;
  bytes: number;
}

interface TopoGraphExpose {
  render(snapshot: TopoSnapshot): Promise<number>;
  clearSafely(): Promise<void>;
  setLayout(key: LayoutKey): void;
}

/** 响应体字节数：懒加载的核心优势其实在这里 —— 首屏只需要传极少的数据 */
function payloadBytes(snapshot: TopoSnapshot): number {
  return new Blob([JSON.stringify(snapshot)]).size;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} 秒`;
  if (ms < 1) return '<1 ms';
  return `${ms.toFixed(0)} ms`;
}

// 支持用查询参数直接进入某个对比场景，便于分享具体结论的链接，例如：
//   ?scale=L&autorun=full   直接跑大规模全量渲染
//   ?scale=S&autorun=lazy   直接跑小规模懒加载
const QUERY = new URLSearchParams(window.location.search);
const INITIAL_SCALE: ScaleKey = (() => {
  const s = QUERY.get('scale');
  return s === 'S' || s === 'M' || s === 'L' ? s : 'M';
})();
const AUTO_RUN = QUERY.get('autorun');

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const graphRef = ref<TopoGraphExpose | null>(null);

const mode = ref<'full' | 'lazy'>('full');
const scaleKey = ref<ScaleKey>(INITIAL_SCALE);
const layout = ref<LayoutKey>('dagre');
const running = ref(false);
const fullResult = ref<FullResult | null>(null);
const lazyResult = ref<LazyResult | null>(null);
const visibleNodes = ref(0);
const visibleEdges = ref(0);
const expandedSize = ref(0);
const requests = ref(0);
const cacheHits = ref(0);
const lastMs = ref<number | null>(null);
const log = ref<string[]>([]);

const scaleKeys = Object.keys(SCALES) as ScaleKey[];

// 以下不参与响应式：完整快照、当前可见快照、已展开节点集合
let full: TopoSnapshot | null = null;
let visible: TopoSnapshot = { nodes: [], edges: [] };
let expanded = new Set<string>();
// 同步守卫：一键对比要串行跑完全量再跑懒加载，只看 running 会被上一次的值拦掉
let busy = false;

function setBusy(v: boolean) {
  busy = v;
  running.value = v;
}

function pushLog(text: string) {
  log.value = [`${stamp()}  ${text}`, ...log.value].slice(0, 12);
}

// 让浏览器先把「渲染中」的 UI 画出来，再开始同步布局。
// 这里用 setTimeout 而不是 requestAnimationFrame：rAF 在无头/后台标签页里
// 可能永不触发，会让渲染流程卡死；定时器在任何环境下都能推进。
function nextFrame() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function onSelectScale(k: ScaleKey) {
  if (busy) return;
  scaleKey.value = k;
}

async function runFull() {
  if (busy) return;
  setBusy(true);
  try {
    mode.value = 'full';
    expanded = new Set();
    expandedSize.value = 0;
    resetMockCache();
    pushLog(`开始全量渲染 · ${SCALES[scaleKey.value].label}`);
    // 先清干净画布再计时，避免上一次遗留的大量节点销毁成本混进来
    await graphRef.value?.clearSafely();
    await nextFrame();

    const topo = buildTopology(scaleKey.value);
    full = topo;
    visible = { nodes: topo.nodes, edges: topo.edges };
    visibleNodes.value = topo.nodes.length;
    visibleEdges.value = topo.edges.length;

    const ms = (await graphRef.value?.render(topo)) ?? 0;
    lastMs.value = ms;
    fullResult.value = {
      scale: scaleKey.value,
      ms,
      nodes: topo.nodes.length,
      edges: topo.edges.length,
      bytes: payloadBytes(topo),
    };
    pushLog(`全量渲染完成：${topo.nodes.length} 节点 / ${topo.edges.length} 边，布局+绘制合计 ${fmtMs(ms)}`);
  } finally {
    setBusy(false);
  }
}

async function runLazy() {
  if (busy) return;
  setBusy(true);
  try {
    mode.value = 'lazy';
    expanded = new Set();
    expandedSize.value = 0;
    resetMockCache();

    const topo = buildTopology(scaleKey.value);
    full = topo;
    pushLog(`开始分层懒加载 · ${SCALES[scaleKey.value].label}，仅请求根层级`);

    // 同样先清空再计时：懒加载测的是"从零开始的首屏"，不是"拆掉旧图的速度"
    await graphRef.value?.clearSafely();
    await nextFrame();

    const rootRes = await fetchChildren(topo, null, 45);
    let merged: TopoSnapshot = rootRes.snapshot;
    let requestCount = 1;
    let cacheHit = rootRes.fromCache ? 1 : 0;
    let bytes = payloadBytes(rootRes.snapshot);

    // 首屏再多拉一跳（核心 -> 汇聚），避免打开页面只看到一个孤立的点。
    // 更下面的层级全部靠点击节点逐层下钻，不会一次性回来。
    const rootNode = merged.nodes[0];
    if (rootNode) {
      const level1 = await fetchChildren(topo, rootNode.id, 45);
      merged = {
        nodes: [...merged.nodes, ...level1.snapshot.nodes],
        edges: [...merged.edges, ...level1.snapshot.edges],
      };
      requestCount += 1;
      bytes += payloadBytes(level1.snapshot);
      if (level1.fromCache) cacheHit += 1;
    }

    visible = merged;
    visibleNodes.value = merged.nodes.length;
    visibleEdges.value = merged.edges.length;
    requests.value = requestCount;
    cacheHits.value = cacheHit;

    const ms = (await graphRef.value?.render(merged)) ?? 0;
    lastMs.value = ms;
    lazyResult.value = { scale: scaleKey.value, ms, nodes: merged.nodes.length, bytes };
    pushLog(
      `首屏完成：只请求核心与汇聚两层、渲染 ${merged.nodes.length} 个节点，用时 ${fmtMs(ms)}；更下层点节点再按需加载`,
    );
  } finally {
    setBusy(false);
  }
}

async function handleNodeClick(nodeId: string) {
  if (mode.value !== 'lazy' || busy) return;
  if (expanded.has(nodeId)) return;
  if (!full) return;

  const node = visible.nodes.find((n) => n.id === nodeId);
  if (!node || node.childCount === 0) return;

  setBusy(true);
  try {
    const res = await fetchChildren(full, nodeId, 45);
    requests.value += 1;
    if (res.fromCache) cacheHits.value += 1;

    const merged: TopoSnapshot = {
      nodes: [...visible.nodes, ...res.snapshot.nodes],
      edges: [...visible.edges, ...res.snapshot.edges],
    };
    visible = merged;
    visibleNodes.value = merged.nodes.length;
    visibleEdges.value = merged.edges.length;

    const ms = (await graphRef.value?.render(merged)) ?? 0;
    lastMs.value = ms;
    expanded.add(nodeId);
    expandedSize.value = expanded.size;
    pushLog(
      `下钻 ${node.name}：新增 ${res.snapshot.nodes.length} 个子节点，渲染 ${fmtMs(ms)}${res.fromCache ? ' · 命中缓存' : ' · 回源'}；可见节点 ${merged.nodes.length}`,
    );
  } finally {
    setBusy(false);
  }
}

// 一键对比：先跑全量、再跑懒加载，最后直接给出同规模下的倍数。
// 这是给访客最省事的入口 —— 点一次就能看到结论，不用自己记两个数字。
async function runCompare() {
  if (busy) return;
  await graphRef.value?.clearSafely();
  log.value = [];
  fullResult.value = null;
  lazyResult.value = null;
  await runFull();
  await runLazy();
}

function handleLayout(key: LayoutKey) {
  layout.value = key; // 子组件监听 layout 变化后自己换布局层，图实例不重建
  pushLog(`切换布局 -> ${LAYOUT_LABELS[key]}（图组件不重建，只换布局层）`);
}

function reset() {
  void graphRef.value?.clearSafely();
  visible = { nodes: [], edges: [] };
  full = null;
  expanded = new Set();
  resetMockCache();
  visibleNodes.value = 0;
  visibleEdges.value = 0;
  expandedSize.value = 0;
  requests.value = 0;
  cacheHits.value = 0;
  lastMs.value = null;
  fullResult.value = null;
  lazyResult.value = null;
  log.value = [];
}

const ratio = computed(() => {
  const f = fullResult.value;
  const l = lazyResult.value;
  if (!f || !l || f.scale !== l.scale) return null;
  return l.ms > 0 ? f.ms / l.ms : null;
});

const byteRatio = computed(() => {
  const f = fullResult.value;
  const l = lazyResult.value;
  if (!f || !l || f.scale !== l.scale) return null;
  return l.bytes > 0 ? f.bytes / l.bytes : null;
});

// 首屏自动跑一次：访客打开页面即可看到拓扑，而不是一张空白画布
onMounted(() => {
  setTimeout(() => {
    if (AUTO_RUN === 'full') void runFull();
    else void runLazy();
  }, 500);
});
</script>

<template>
  <div class="app">
    <aside class="panel">
      <header class="brand">
        <h1>net-topo-lab</h1>
        <p>多层拓扑的分层懒加载与布局解耦演示</p>
        <p class="disclaimer">
          拓扑数据由程序合成生成，不含任何前雇主 / 客户 / 运营商的真实网络数据。
        </p>
      </header>

      <section class="block">
        <h2>1. 选择数据规模</h2>
        <div class="segmented">
          <button
            v-for="k in scaleKeys"
            :key="k"
            :class="['seg', k === scaleKey ? 'active' : '']"
            :disabled="running"
            @click="onSelectScale(k)"
          >
            {{ SCALES[k].label }}
          </button>
        </div>
        <p class="hint">{{ SCALES[scaleKey].hint }}</p>
      </section>

      <section class="block">
        <h2>2. 跑一次对比</h2>
        <button class="btn btn-compare" :disabled="running" @click="runCompare">
          一键对比（先全量、再懒加载）
        </button>
        <div class="actions">
          <button class="btn btn-full" :disabled="running" @click="runFull">
            只跑全量（旧实现）
          </button>
          <button class="btn btn-lazy" :disabled="running" @click="runLazy">
            只跑懒加载（优化后）
          </button>
        </div>
        <p class="hint">
          一键对比会自动跑完两遍，右下角给出同规模下的倍数。规模选「大」时全量约 1 秒量级，具体取决于机器性能。
        </p>
      </section>

      <section class="block">
        <h2>3. 切换布局</h2>
        <div class="layouts">
          <button
            v-for="k in LAYOUT_KEYS"
            :key="k"
            :class="['chip', k === layout ? 'active' : '']"
            @click="handleLayout(k)"
          >
            {{ LAYOUT_LABELS[k] }}
          </button>
        </div>
        <p class="hint">懒加载模式下点节点可逐层下钻；切布局时图组件不重建，只替换布局层。</p>
      </section>

      <section class="block">
        <h2>运行指标</h2>
        <dl class="metrics">
          <dt>可见节点</dt>
          <dd>{{ visibleNodes }}</dd>
          <dt>可见边</dt>
          <dd>{{ visibleEdges }}</dd>
          <dt>最近一次渲染</dt>
          <dd>{{ lastMs === null ? '—' : fmtMs(lastMs) }}</dd>
          <dt>接口请求数</dt>
          <dd>{{ requests }}</dd>
          <dt>缓存命中</dt>
          <dd>{{ cacheHits }}</dd>
          <dt>已展开层级</dt>
          <dd>{{ expandedSize }} 个节点</dd>
        </dl>
        <button class="btn btn-ghost" :disabled="running" @click="reset">重置</button>
      </section>

      <section class="block">
        <h2>操作日志</h2>
        <ul class="log">
          <li v-if="log.length === 0" class="log-empty">还没有操作记录</li>
          <li v-for="(line, i) in log" :key="i">{{ line }}</li>
        </ul>
      </section>
    </aside>

    <main class="stage">
      <TopoGraph ref="graphRef" :layout="layout" @node-click="handleNodeClick" />

      <div v-if="fullResult || lazyResult" class="compare">
        <div v-if="fullResult" class="compare-card full">
          <span class="tag">全量渲染（一次拉全量）</span>
          <strong>{{ fmtMs(fullResult.ms) }}</strong>
          <small>
            {{ fullResult.nodes }} 节点 / {{ fullResult.edges }} 边 · 数据
            {{ fmtBytes(fullResult.bytes) }}
          </small>
        </div>
        <div v-if="lazyResult" class="compare-card lazy">
          <span class="tag">懒加载首屏</span>
          <strong>{{ fmtMs(lazyResult.ms) }}</strong>
          <small>{{ lazyResult.nodes }} 节点 · 首屏数据 {{ fmtBytes(lazyResult.bytes) }}</small>
        </div>
        <div v-if="ratio !== null && byteRatio !== null" class="compare-card ratio">
          <span class="tag">同规模差距</span>
          <strong>{{ byteRatio.toFixed(0) }}×</strong>
          <small>首屏数据量小 {{ byteRatio.toFixed(0) }} 倍，渲染快 {{ ratio.toFixed(0) }} 倍</small>
        </div>
      </div>

      <div v-if="running" class="running">渲染中…大规模型下会明显卡顿</div>
    </main>
  </div>
</template>
