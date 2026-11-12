/**
 * 合成网络拓扑数据生成器
 *
 * 本文件生成的拓扑结构、节点名称、层级数量全部由程序合成，
 * 不含任何前雇主 / 客户 / 运营商的真实网络数据，仅用于演示
 * “分层懒加载 + 布局解耦 + 下钻缓存” 这套工程方法的性能差异。
 *
 * 结构：5 层树
 *   L0 核心  -> L1 汇聚 -> L2 接入 -> L3 楼层 -> L4 终端
 */

export type Kind = 'core' | 'agg' | 'acc' | 'edge' | 'terminal';

export interface TopoNode {
  id: string;
  name: string;
  level: number;
  kind: Kind;
  parentId: string | null;
  childCount: number;
  size: number;
  fill: string;
}

export interface TopoEdge {
  id: string;
  source: string;
  target: string;
}

export interface TopoSnapshot {
  nodes: TopoNode[];
  edges: TopoEdge[];
}

export type ScaleKey = 'S' | 'M' | 'L';

interface LevelSpec {
  prefix: string;
  label: string;
  kind: Kind;
  size: number;
  fill: string;
  pad: number;
}

const LEVEL_SPEC: LevelSpec[] = [
  { prefix: 'CORE', label: '核心交换机', kind: 'core', size: 34, fill: '#2f54eb', pad: 2 },
  { prefix: 'AGG', label: '汇聚交换机', kind: 'agg', size: 22, fill: '#597ef7', pad: 2 },
  { prefix: 'ACC', label: '接入交换机', kind: 'acc', size: 14, fill: '#69c0ff', pad: 3 },
  { prefix: 'FLR', label: '楼层交换机', kind: 'edge', size: 10, fill: '#95de64', pad: 4 },
  { prefix: 'PC', label: '终端设备', kind: 'terminal', size: 6, fill: '#bfbfbf', pad: 5 },
];

export const SCALES: Record<ScaleKey, { label: string; counts: number[]; hint: string }> = {
  S: { label: '小规模 · 600 节点', counts: [1, 4, 16, 64, 512], hint: '全量渲染也很快，用来做基线' },
  M: { label: '中规模 · 1800 节点', counts: [1, 8, 32, 160, 1600], hint: '推荐：差距最直观' },
  L: { label: '大规模 · 5250 节点', counts: [1, 8, 40, 200, 5000], hint: '全量模式要 1 秒以上才出画面，这就是旧实现的问题' },
};

export const LAYER_NAMES = LEVEL_SPEC.map((l) => l.label);

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function padNum(n: number, len: number): string {
  return String(n + 1).padStart(len, '0');
}

/**
 * 生成整棵拓扑树。
 * 同一 scale 每次生成的节点 id / 结构完全一致（确定性随机种子），
 * 便于多次对比时条件相同。
 */
export function buildTopology(scale: ScaleKey): TopoSnapshot {
  const counts = SCALES[scale].counts;
  const nodes: TopoNode[] = [];
  const layers: TopoNode[][] = [];
  const rng = makeRng(20261111);

  for (let level = 0; level < counts.length; level++) {
    const spec = LEVEL_SPEC[level];
    const layer: TopoNode[] = [];
    for (let i = 0; i < counts[level]; i++) {
      const id = `${spec.prefix.toLowerCase()}-${padNum(i, spec.pad)}`;
      const node: TopoNode = {
        id,
        name: `${spec.prefix}-${padNum(i, spec.pad)}`,
        level,
        kind: spec.kind,
        parentId: null,
        childCount: 0,
        size: spec.size,
        fill: spec.fill,
      };
      layer.push(node);
      nodes.push(node);
    }
    layers.push(layer);
  }

  // 分配父子关系：按比例均匀挂到上一层
  const edges: TopoEdge[] = [];
  for (let level = 1; level < layers.length; level++) {
    const children = layers[level];
    const parents = layers[level - 1];
    for (let i = 0; i < children.length; i++) {
      const pIdx = Math.floor((i * parents.length) / children.length);
      const parent = parents[pIdx];
      children[i].parentId = parent.id;
      parent.childCount += 1;
      edges.push({
        id: `${parent.id}->${children[i].id}`,
        source: parent.id,
        target: children[i].id,
      });
    }
  }

  // 每 64 个楼层节点里随机加 1 条横向互联边，模拟真实网络里的冗余链路
  if (layers.length >= 4) {
    const floorLayer = layers[3];
    for (let i = 1; i < floorLayer.length; i++) {
      if (rng() < 1 / 64) {
        edges.push({
          id: `${floorLayer[i - 1].id}~${floorLayer[i].id}`,
          source: floorLayer[i - 1].id,
          target: floorLayer[i].id,
        });
      }
    }
  }

  return { nodes, edges };
}

/**
 * 模拟后端接口：按 parentId 拉取下一层子节点。
 *
 * 真实的实现（backend/ 目录里的 Spring Boot 版本）是从数据库按 parent_id
 * 分页查询并走 Caffeine 缓存；这里用查询内存快照 + 人工延迟来等价模拟
 * “一次网络往返”。返回的仍是同一种 Snapshot 结构，前端渲染逻辑完全一致。
 */
export interface ChildrenResult {
  snapshot: TopoSnapshot;
  requestCount: number;
  fromCache: boolean;
}

const cache = new Map<string, TopoSnapshot>();

export function resetMockCache(): void {
  cache.clear();
}

export async function fetchChildren(
  full: TopoSnapshot,
  parentId: string | null,
  latencyMs = 45,
): Promise<ChildrenResult> {
  const key = parentId ?? '__ROOT__';
  const cached = cache.get(key);
  const t0 = performance.now();

  if (cached) {
    const wait = Math.max(0, latencyMs * 0.15 - (performance.now() - t0));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return { snapshot: cached, requestCount: 1, fromCache: true };
  }

  await new Promise((r) => setTimeout(r, latencyMs));

  const byId = new Map(full.nodes.map((n) => [n.id, n]));
  let childNodes: TopoNode[] = [];
  if (parentId === null) {
    childNodes = full.nodes.filter((n) => n.level === 0);
  } else {
    childNodes = full.nodes.filter((n) => n.parentId === parentId);
  }

  const childIds = new Set(childNodes.map((n) => n.id));
  const edges: TopoEdge[] = [];

  for (const e of full.edges) {
    // 父节点 → 本次返回的子节点
    if (parentId !== null && e.source === parentId && childIds.has(e.target)) {
      edges.push(e);
      continue;
    }
    // 子节点之间的横向互联边
    if (childIds.has(e.source) && childIds.has(e.target)) {
      edges.push(e);
    }
  }


  const snapshot: TopoSnapshot = { nodes: childNodes.slice(), edges };
  cache.set(key, snapshot);

  return { snapshot, requestCount: 1, fromCache: false };
}
