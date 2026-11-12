/**
 * 模拟后端接口层。
 *
 * 真实项目里这里是 Java 微服务 + 线程池：一次「拿某个拓扑」要走网关、
 * 查库、再递归汇总子拓扑告警。这里用内存生成 + 人工延迟等价模拟一次往返，
 * 好让"串行 vs 并行""缓存 vs 回源""中断旧请求"这些差异在页面上看得见。
 *
 * 对外只暴露四个动作：
 *   fetchLayer      拉一层拓扑（走缓存，可中断）
 *   summarizeNode   汇总某节点的告警（串行/并行两种跑法）
 *   refreshLayer    只让当前这一层的缓存失效，父层子层都不受影响
 *   prefetchSubtree 空闲时把当前层下面整棵子树的数据提前拉回来
 */

import { summarizeLink, summarizeNode, type SummaryMode, type SummaryRun } from './alarms';
import { buildLayer, pathKey } from './generate';
import type { LayerTopo, PathSeg, ScaleKey } from './model';

/** 一次网络往返的模拟耗时 */
const NET_LATENCY_MS = 55;
/** 缓存命中时只走 15% 的延迟，模拟"内存缓存 vs 走网络" */
const CACHE_FACTOR = 0.15;

const layerCache = new Map<string, LayerTopo>();

function cacheKey(path: PathSeg[], scale: ScaleKey): string {
  return `${scale}:${pathKey(path)}`;
}

function abortError(): DOMException {
  return new DOMException('aborted', 'AbortError');
}

/** 可中断的等待：signal 一 abort 就立刻拒绝，不留计时器 */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface LayerFetch {
  topo: LayerTopo;
  fromCache: boolean;
  ms: number;
}

/**
 * 拉一层拓扑。
 * 命中缓存走短延迟；未命中走完整延迟并写入缓存。
 * 传入 signal 可在请求途中被打断 —— 这就是"点新链路中断旧请求"的落点。
 */
export async function fetchLayer(
  path: PathSeg[],
  scale: ScaleKey,
  opts: { signal?: AbortSignal; latency?: number; useCache?: boolean } = {},
): Promise<LayerFetch> {
  const key = cacheKey(path, scale);
  const cached = opts.useCache === false ? undefined : layerCache.get(key);
  const t0 = performance.now();

  if (cached) {
    await wait(NET_LATENCY_MS * CACHE_FACTOR, opts.signal);
    return { topo: cached, fromCache: true, ms: performance.now() - t0 };
  }

  await wait(opts.latency ?? NET_LATENCY_MS, opts.signal);

  const topo = buildLayer(path, scale);
  layerCache.set(key, topo);
  return { topo, fromCache: false, ms: performance.now() - t0 };
}

/** 只清掉这一层的缓存：父层、子层的缓存都保留，对应"刷新只刷当前拓扑" */
export function refreshLayer(path: PathSeg[], scale: ScaleKey): void {
  layerCache.delete(cacheKey(path, scale));
}

/** 清空全部缓存（重置用） */
export function resetLayerCache(): void {
  layerCache.clear();
}

export function layerCacheSize(): number {
  return layerCache.size;
}

/* ------------------------------------------------------- 告警汇总入口 */

export interface SummaryOutcome extends SummaryRun {
  mode: SummaryMode;
  ms: number;
}

export async function summarize(
  path: PathSeg[],
  targetId: string,
  kind: 'node' | 'link',
  scale: ScaleKey,
  mode: SummaryMode,
  signal?: AbortSignal,
): Promise<SummaryOutcome> {
  const t0 = performance.now();
  const run =
    kind === 'node'
      ? await summarizeNode(path, targetId, scale, mode, signal)
      : await summarizeLink(path, targetId, scale, mode, signal);
  return { ...run, mode, ms: performance.now() - t0 };
}

/* ---------------------------------------------------------- 空闲预取 */

/**
 * 列出某一层下面所有可以继续下钻的路径（广度优先，用来分批预取）。
 * 只列路径不算数据，真正拉取由调用方按空闲时间分片执行。
 */
export function descendantPaths(
  path: PathSeg[],
  scale: ScaleKey,
  maxDepth = 3,
): PathSeg[][] {
  const out: PathSeg[][] = [];
  const frontier: PathSeg[][] = [path];

  for (let depth = 0; depth < maxDepth; depth++) {
    const next: PathSeg[][] = [];
    for (const p of frontier) {
      const topo = buildLayer(p, scale);
      const segs: PathSeg[] = [];
      for (const l of topo.links) {
        if (l.drillable) segs.push({ kind: 'link', id: l.id, label: l.label });
      }
      for (const d of topo.domains) {
        if (d.drillable) segs.push({ kind: 'domain', id: d.id, label: d.name });
      }
      if (topo.canEnterBoard) {
        segs.push({ kind: 'detail', id: `${pathKey(p)}#detail`, label: '整层全部网元' });
      }
      for (const s of segs) {
        const child = [...p, s];
        out.push(child);
        next.push(child);
      }
    }
    frontier.length = 0;
    frontier.push(...next);
    if (frontier.length === 0) break;
  }

  return out;
}

/** 预取一条路径的数据（内部走 fetchLayer，命中缓存就便宜） */
export async function prefetchPath(
  path: PathSeg[],
  scale: ScaleKey,
  signal?: AbortSignal,
): Promise<boolean> {
  const res = await fetchLayer(path, scale, { signal });
  return !res.fromCache;
}
