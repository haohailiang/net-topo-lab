/**
 * 告警生成与汇总。
 *
 * 真实业务里一个网元上的告警数是「它下面所有子拓扑告警的汇总结果」，
 * 所以算一个节点的数字要递归走完整棵子树 —— 这正是耗时来源。
 *
 * 这里实现了同一件事的两种跑法，用来对比：
 *   serial   旧实现：兄弟分支一条一条按顺序查（Node.js 单线程同步的老路子）
 *   parallel 新实现：兄弟分支同时查，最后合并（对应 Java 微服务 + 线程池）
 *
 * 数据全部由程序合成，不含任何真实网络告警。
 */

import { findDomain, findLink, findNode, buildLayer, pathKey } from './generate';
import {
  type Alarm,
  type AlarmKind,
  type AlarmLevel,
  type Digest,
  type LayerTopo,
  type PathSeg,
  type ScaleKey,
} from './model';

export type SummaryMode = 'serial' | 'parallel';

/** 每一次"子查询"的模拟网络往返耗时，用来放大串行与并行的差异 */
let queryCost = 15;

/**
 * 调整单次子查询的模拟耗时。
 * 画图上的角标用 0（口径相同但不该为了上色等一秒钟），
 * 「一键对比」时切回 15，把串行和并行的差距放大到肉眼可见。
 */
export function setQueryCost(ms: number): void {
  queryCost = Math.max(0, ms);
}

/* ------------------------------------------------------------ 告警生成 */

const alarmCache = new Map<string, Alarm[]>();

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * 给某一层生成告警。确定性：同一个 path 每次得到同一批告警。
 *
 * 四类告警的落点：
 *   ne    网元节点
 *   port  链路（同时算在链路和它一侧的网元上）
 *   board 单板节点（只在第4层）
 *   ctp   第4层的连接（同时算在连接和它一侧的单板上）
 */
function buildAlarms(topo: LayerTopo): Alarm[] {
  const key = pathKey(topo.path);
  const cached = alarmCache.get(key);
  if (cached) return cached;

  const rng = makeRng(hashString(`${key}@alarm`));
  const out: Alarm[] = [];

  // 级别分布：一级最少，三级最多 —— 真实网管里也是这个倒挂
  const level = (): AlarmLevel => {
    const r = rng();
    if (r < 0.14) return 1;
    if (r < 0.52) return 2;
    return 3;
  };

  if (topo.layer === 4) {
    const ownerOf = new Map(topo.nodes.map((n) => [n.id, n.ownerId]));
    for (const node of topo.nodes) {
      if (rng() < 0.5) {
        out.push({
          id: `${node.id}#board`,
          kind: 'board',
          level: level(),
          objectId: node.id,
          ownerId: node.ownerId,
        });
      }
    }
    for (const link of topo.links) {
      if (rng() < 0.4) {
        out.push({
          id: `${link.id}#ctp`,
          kind: 'ctp',
          level: level(),
          objectId: link.id,
          peerId: link.source,
          ownerId: ownerOf.get(link.source),
        });
      }
    }
  } else {
    for (const node of topo.nodes) {
      if (rng() < 0.35) {
        out.push({ id: `${node.id}#ne`, kind: 'ne', level: level(), objectId: node.id });
      }
    }
    for (const link of topo.links) {
      if (rng() < 0.28) {
        out.push({
          id: `${link.id}#port`,
          kind: 'port',
          level: level(),
          objectId: link.id,
          peerId: link.source,
        });
      }
    }
  }

  alarmCache.set(key, out);
  return out;
}

/** 清空告警生成缓存（重置时用） */
export function resetAlarmCache(): void {
  alarmCache.clear();
}

/** 只取本层告警（不递归）。单板层近千个图元，逐个递归汇总没有意义 */
export function localAlarms(topo: LayerTopo): Alarm[] {
  return buildAlarms(topo);
}

/* ------------------------------------------------------------ 汇总统计 */

/** 把一批原始告警压成一个摘要：最高级别决定颜色，去重后的对象数决定角标 */
export function digestOf(alarms: Alarm[]): Digest {
  let topLevel: 0 | 1 | 2 | 3 = 0;
  const byKind: Record<AlarmKind, number> = { ne: 0, port: 0, board: 0, ctp: 0 };
  const seen = new Set<string>();

  for (const a of alarms) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    if (topLevel === 0 || a.level < topLevel) topLevel = a.level;
    byKind[a.kind] += 1;
  }

  return { topLevel, count: seen.size, byKind };
}

/* ------------------------------------------------------------ 递归汇总 */

function tick(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, queryCost);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 一层拓扑里所有能继续下钻的入口。
 *
 * 这里刻意不含「整层详情」：单板层是整层共用的，如果参与上层汇总，
 * 同一批单板告警会被同时算进这一层每一个网元的角标里，数字虚高且没有意义。
 * 单板告警只在第4层自己那张图上落色与数角标。
 */
function entriesOf(topo: LayerTopo): PathSeg[] {
  const out: PathSeg[] = [];
  for (const link of topo.links) {
    if (link.drillable) out.push({ kind: 'link', id: link.id, label: link.label });
  }
  for (const d of topo.domains) {
    if (d.drillable) out.push({ kind: 'domain', id: d.id, label: d.name });
  }
  return out;
}

/** 某个节点身上能继续下钻的入口：它挂的链路、它所在的域、它的详情 */
function nodeEntries(topo: LayerTopo, nodeId: string): PathSeg[] {
  const out: PathSeg[] = [];
  const node = findNode(topo, nodeId);
  if (!node) return out;

  for (const lid of node.drillLinks) {
    const link = findLink(topo, lid);
    if (link) out.push({ kind: 'link', id: link.id, label: link.label });
  }
  if (node.domainId) {
    const d = findDomain(topo, node.domainId);
    if (d?.drillable) out.push({ kind: 'domain', id: d.id, label: d.name });
  }
  // 单板层不参与网元角标：它是整层共用的，见 entriesOf 里的说明
  return out;
}

/** 统计调用次数，用来在界面上证明"串行确实查了这么多次" */
export interface SummaryRun {
  alarms: Alarm[];
  queries: number;
}

/**
 * 递归汇总的展开深度上限。
 * 真实实现会把整棵子树查完；演示里截断到 2 层 —— 再往下展开就会把
 * 同一批单板告警重复计进很多个上层网元的角标，数字会虚高到没有意义。
 */
const MAX_COLLECT_DEPTH = 2;

/**
 * 收集一整层的告警（含它下面所有子层）。
 * 这是最重的那条路径：兄弟入口按 mode 决定是顺序还是并行。
 */
async function collectLayer(
  path: PathSeg[],
  scale: ScaleKey,
  mode: SummaryMode,
  signal: AbortSignal | undefined,
  run: SummaryRun,
  depth = 0,
): Promise<Alarm[]> {
  await tick(signal);
  run.queries += 1;

  const topo = buildLayer(path, scale);
  const out: Alarm[] = buildAlarms(topo).slice();

  if (depth >= MAX_COLLECT_DEPTH) return out;

  const entries = entriesOf(topo);
  if (entries.length === 0) return out;

  if (mode === 'serial') {
    for (const seg of entries) {
      const sub = await collectLayer([...path, seg], scale, mode, signal, run, depth + 1);
      out.push(...sub);
    }
  } else {
    const subs = await Promise.all(
      entries.map((seg) => collectLayer([...path, seg], scale, mode, signal, run, depth + 1)),
    );
    for (const sub of subs) out.push(...sub);
  }

  return out;
}

/**
 * 统计某个节点上的告警：它自己的告警 + 它所有下钻入口下面整棵子树的告警。
 * 界面上每个节点的角标和颜色都来自这里。
 */
export async function summarizeNode(
  path: PathSeg[],
  nodeId: string,
  scale: ScaleKey,
  mode: SummaryMode,
  signal?: AbortSignal,
): Promise<SummaryRun> {
  const run: SummaryRun = { alarms: [], queries: 0 };

  const topo = buildLayer(path, scale);
  const local = buildAlarms(topo);

  // 本层里算在这个节点头上的：网元告警本身，或者端口告警里它作为一侧
  const own = local.filter((a) => a.objectId === nodeId || a.peerId === nodeId);
  const out: Alarm[] = own.slice();

  const entries = nodeEntries(topo, nodeId);
  if (entries.length > 0) {
    // 单板层是整层的，只把归属本网元的那些算进来
    const merge = (seg: PathSeg, sub: Alarm[]) =>
      seg.kind === 'detail' ? sub.filter((a) => a.ownerId === nodeId) : sub;

    if (mode === 'serial') {
      for (const seg of entries) {
        const sub = await collectLayer([...path, seg], scale, mode, signal, run);
        out.push(...merge(seg, sub));
      }
    } else {
      const subs = await Promise.all(
        entries.map((seg) => collectLayer([...path, seg], scale, mode, signal, run)),
      );
      entries.forEach((seg, i) => out.push(...merge(seg, subs[i])));
    }
  }

  run.alarms = out;
  return run;
}

/**
 * 统计某条链路的告警：链路自身的端口告警 + 它展开后整棵子树的告警。
 * 端口告警要同时落在"网元"和"链路"两处，所以两边各算一次。
 */
export async function summarizeLink(
  path: PathSeg[],
  linkId: string,
  scale: ScaleKey,
  mode: SummaryMode,
  signal?: AbortSignal,
): Promise<SummaryRun> {
  const run: SummaryRun = { alarms: [], queries: 0 };
  const topo = buildLayer(path, scale);
  const local = buildAlarms(topo);
  const out: Alarm[] = local.filter((a) => a.objectId === linkId).slice();

  const link = findLink(topo, linkId);
  if (link?.drillable) {
    const sub = await collectLayer(
      [...path, { kind: 'link', id: link.id, label: link.label }],
      scale,
      mode,
      signal,
      run,
    );
    out.push(...sub);
  }

  run.alarms = out;
  return run;
}
