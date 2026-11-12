/**
 * 按「下钻路径」确定性地生成某一层的拓扑。
 *
 * 同一个 path 每次生成的节点 id、连线、域完全一致（种子由 path 哈希得到），
 * 缓存、对比、刷新才有可比性。数据全部由程序合成，不含任何真实网络信息。
 *
 * 形态约定：
 *   第1层  主干链：一排主干网元，相邻两个之间一条抽象主干链路（可展开）
 *   第2/3层 三走廊：左右两端点 + 中间 2~3 条并行路径，每条路径若干中继节点
 *   第4层  单板层：第3层全部网元各自的一堆单板 + 单板间 CTP 连接（≤1000 块）
 */

import {
  type DomainBox,
  type LayerIndex,
  type LayerTopo,
  type PathSeg,
  type ScaleKey,
  type TopoLink,
  type TopoNode,
} from './model';

export interface ScaleSpec {
  label: string;
  /** 第1层主干网元数量 */
  trunkNodes: number;
  /** 每层并行路径数（三走廊的走廊条数） */
  paths: number;
  /** 每条路径上的中继节点数 */
  hops: number;
  /** 第4层每个网元下的单板数 */
  boardsPerNe: number;
  hint: string;
}

export const SCALES: Record<ScaleKey, ScaleSpec> = {
  S: {
    label: '小 · 2 条路径',
    trunkNodes: 5,
    paths: 2,
    hops: 2,
    boardsPerNe: 34,
    hint: '结构完整但节点少，适合先把下钻关系讲清楚',
  },
  M: {
    label: '中 · 3 条路径',
    trunkNodes: 6,
    paths: 3,
    hops: 3,
    boardsPerNe: 90,
    hint: '推荐：三走廊 + 第4层 990 块单板，最接近真实量级',
  },
  L: {
    label: '大 · 长路径',
    trunkNodes: 8,
    paths: 3,
    hops: 4,
    boardsPerNe: 71,
    hint: '每条路径更长，用来观察多图并存与整棵子树销毁的开销',
  },
};

export const SCALE_KEYS: ScaleKey[] = ['S', 'M', 'L'];

/** 每层最多放出多少个可下钻入口，避免递归汇总把浏览器拖死 */
const MAX_DRILL_PER_LAYER = 3;

/* ------------------------------------------------------------ 确定性随机 */

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function pad2(n: number): string {
  return String(Math.max(0, n)).padStart(2, '0');
}

/** 路径的唯一键，也是缓存 key */
export function pathKey(path: PathSeg[]): string {
  if (path.length === 0) return 'root';
  return path.map((p) => `${p.kind}:${p.id}`).join('|');
}

/** 由路径派生的短标签，保证不同路径下的图元 id 不冲突 */
function pathTag(path: PathSeg[]): string {
  return hashString(pathKey(path)).toString(36).slice(0, 5);
}

/**
 * 当前路径对应的层号。
 * 网元层最多到第 3 层；第 4 层只能由第 3 层的「整层详情」进入。
 */
export function layerOf(path: PathSeg[]): LayerIndex {
  const last = path[path.length - 1];
  if (last && last.kind === 'detail') return 4;
  return Math.min(3, path.length + 1) as LayerIndex;
}

/* ------------------------------------------------------------ 标题文案 */

function describe(path: PathSeg[], layer: LayerIndex): { title: string; subtitle: string } {
  if (path.length === 0) {
    return {
      title: '第 1 层 · 主干拓扑',
      subtitle: '只显示最顶层的主干链路，子网与中间设备全部被抽象掉；点链路或域可展开',
    };
  }
  const last = path[path.length - 1];
  if (last.kind === 'link') {
    return {
      title: `第 ${layer} 层 · ${last.label} 展开`,
      subtitle: `点链路 ${last.label} 展开：两端网元 + 中间并行的多条路径`,
    };
  }
  if (last.kind === 'domain') {
    return {
      title: `第 ${layer} 层 · ${last.label} 展开`,
      subtitle: `${last.label} 内两个网元之间的通路（域由后端预先分组）`,
    };
  }
  return {
    title: '第 4 层 · 单板层',
    subtitle: '上一层的全部网元与端口在此展开为单板与 CTP 连接，最底层，不再下钻',
  };
}

/* ------------------------------------------------------------ 第1层：主干链 */

function genTrunkLayer(scale: ScaleKey): LayerTopo {
  const cfg = SCALES[scale];
  const layer: LayerIndex = 1;
  const tag = pathTag([]);
  const n = cfg.trunkNodes;

  const nodes: TopoNode[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({
      id: `ne-${tag}-${pad2(i + 1)}`,
      name: `NE-01-${pad2(i + 1)}`,
      layer,
      kind: 'ne',
      size: 30,
      drillLinks: [],
      // 第1层本身就是顶层，"入口"概念只用于从上层下钻进来的端点
      entry: false,
      pathIndex: -1,
    });
  }

  const links: TopoLink[] = [];

  // 相邻主干链路：每条都是一个被抽象掉的聚合体，点开才是它的内部结构
  for (let i = 0; i < n - 1; i++) {
    const drillable = i < MAX_DRILL_PER_LAYER;
    const id = `lk-${tag}-t${pad2(i + 1)}`;
    links.push({
      id,
      label: `TRUNK-${pad2(i + 1)}`,
      source: nodes[i].id,
      target: nodes[i + 1].id,
      drillable,
      pathIndex: 0,
    });
    if (drillable) nodes[i].drillLinks.push(id);
  }

  // 备份跨接链路：隔两个节点拉一条，模拟主备关系，不再下钻
  if (n >= 4) {
    links.push({
      id: `lk-${tag}-b1`,
      label: 'TRUNK-B1',
      source: nodes[0].id,
      target: nodes[Math.min(n - 1, 3)].id,
      drillable: false,
      pathIndex: 0,
    });
  }

  // 域：后端已分好组，一个域固定两个相邻主干网元
  const domains: DomainBox[] = [];
  for (let i = 0; i < n - 1; i++) {
    domains.push({
      id: `dm-${tag}-${pad2(i + 1)}`,
      name: `域 D-${pad2(i + 1)}`,
      members: [nodes[i].id, nodes[i + 1].id],
      drillable: i === 0,
    });
  }
  for (const d of domains) {
    for (const m of d.members) {
      const nd = nodes.find((x) => x.id === m);
      if (nd && !nd.domainId) nd.domainId = d.id;
    }
  }

  const meta = describe([], layer);
  return {
    path: [],
    layer,
    title: meta.title,
    subtitle: meta.subtitle,
    nodes,
    links,
    domains,
    canEnterBoard: false,
  };
}

/* ------------------------------------------------------------ 第2/3层：三走廊 */

function genCorridorLayer(path: PathSeg[], scale: ScaleKey): LayerTopo {
  const cfg = SCALES[scale];
  const layer = layerOf(path);
  const tag = pathTag(path);
  const left = `ne-${tag}-l`;
  const right = `ne-${tag}-r`;

  const nodes: TopoNode[] = [
    {
      id: left,
      name: `NE-${layer}-L`,
      layer,
      kind: 'ne',
      size: 28,
      drillLinks: [],
      entry: true,
      pathIndex: -1,
    },
    {
      id: right,
      name: `NE-${layer}-R`,
      layer,
      kind: 'ne',
      size: 28,
      drillLinks: [],
      entry: true,
      pathIndex: -1,
    },
  ];

  // 每条并行路径上的中继节点
  for (let p = 0; p < cfg.paths; p++) {
    for (let h = 0; h < cfg.hops; h++) {
      nodes.push({
        id: `ne-${tag}-p${p + 1}h${h + 1}`,
        name: `NE-${layer}-${p + 1}${h + 1}`,
        layer,
        kind: 'ne',
        size: 20,
        drillLinks: [],
        entry: false,
        pathIndex: p,
      });
    }
  }

  const links: TopoLink[] = [];

  // 每条路径：左端点 -> 中继1 -> ... -> 中继n -> 右端点
  for (let p = 0; p < cfg.paths; p++) {
    const chain = [left];
    for (let h = 0; h < cfg.hops; h++) chain.push(`ne-${tag}-p${p + 1}h${h + 1}`);
    chain.push(right);

    for (let s = 0; s < chain.length - 1; s++) {
      const id = `lk-${tag}-p${p + 1}s${s + 1}`;
      // 每条路径只放第一段可下钻；到第 3 层就不再有链路入口了 ——
      // 第 3 层往下是整层的单板层，由「详情」按钮进入，不是逐条链路展开
      const drillable = s === 0 && layer < 3;
      links.push({
        id,
        label: `SEG-${p + 1}-${s + 1}`,
        source: chain[s],
        target: chain[s + 1],
        drillable,
        pathIndex: p,
      });
      if (drillable) {
        const src = nodes.find((nd) => nd.id === chain[s]);
        if (src) src.drillLinks.push(id);
      }
    }
  }

  // 域：同一条路径上相邻的两个网元打包
  const domains: DomainBox[] = [];
  for (let p = 0; p < Math.min(2, cfg.paths); p++) {
    domains.push({
      id: `dm-${tag}-p${p + 1}`,
      name: `域 D-${p + 1}`,
      members: [`ne-${tag}-p${p + 1}h1`, `ne-${tag}-p${p + 1}h2`],
      drillable: p === 0 && layer < 3,
    });
  }
  for (const d of domains) {
    for (const m of d.members) {
      const nd = nodes.find((x) => x.id === m);
      if (nd) nd.domainId = d.id;
    }
  }

  const meta = describe(path, layer);
  return {
    path,
    layer,
    title: meta.title,
    subtitle: meta.subtitle,
    nodes,
    links,
    domains,
    canEnterBoard: layer === 3,
  };
}

/* ------------------------------------------------------------ 第4层：单板 */

function genBoardLayer(path: PathSeg[], scale: ScaleKey): LayerTopo {
  const cfg = SCALES[scale];
  const layer: LayerIndex = 4;
  const tag = pathTag(path);

  // 第4层由第3层整层展开而来，先拿到第3层的网元清单
  const parentPath = path.slice(0, -1);
  const parent = buildLayer(parentPath, scale);
  const rng = makeRng(hashString(`${pathKey(path)}@board`));

  const nodes: TopoNode[] = [];
  const neIndex = new Map<string, TopoNode[]>();

  parent.nodes.forEach((ne, neIdx) => {
    const list: TopoNode[] = [];
    for (let b = 0; b < cfg.boardsPerNe; b++) {
      const node: TopoNode = {
        id: `bd-${tag}-${pad2(neIdx + 1)}-${pad2(b + 1)}`,
        name: `BD-${pad2(b + 1)}`,
        layer,
        kind: 'board',
        size: 12,
        drillLinks: [],
        entry: false,
        pathIndex: -1,
        ownerName: ne.name,
        ownerId: ne.id,
      };
      nodes.push(node);
      list.push(node);
    }
    neIndex.set(ne.id, list);
  });

  const links: TopoLink[] = [];

  // 网元内部：单板之间的背板连接
  for (const [, list] of neIndex) {
    for (let i = 0; i < list.length - 1; i++) {
      links.push({
        id: `bl-${list[i].id}`,
        label: '',
        source: list[i].id,
        target: list[i + 1].id,
        drillable: false,
        pathIndex: -1,
        ctpScope: 'inner',
      });
    }
    // 少量内部冗余旁路
    if (list.length > 6) {
      for (let k = 0; k < 2; k++) {
        const a = Math.floor(rng() * list.length);
        const b = Math.floor(rng() * list.length);
        if (a === b) continue;
        links.push({
          id: `bl-${list[a].id}-x${k}`,
          label: '',
          source: list[a].id,
          target: list[b].id,
          drillable: false,
          pathIndex: -1,
          ctpScope: 'inner',
        });
      }
    }
  }

  // 跨网元：上一层每条链路对应一组 CTP 连接，落在两端网元的某块单板上
  parent.links.forEach((pl, i) => {
    const a = neIndex.get(pl.source);
    const b = neIndex.get(pl.target);
    if (!a || !b) return;
    links.push({
      id: `bl-cross-${i}`,
      label: '',
      source: a[a.length - 1].id,
      target: b[0].id,
      drillable: false,
      pathIndex: -1,
      ctpScope: 'cross',
    });
  });

  const meta = describe(path, layer);
  return {
    path,
    layer,
    title: meta.title,
    subtitle: meta.subtitle,
    nodes,
    links,
    domains: [],
    canEnterBoard: false,
  };
}

/* ------------------------------------------------------------ 对外入口 */

/**
 * 生成结果缓存。生成是纯函数、结果确定，所以缓存只用于避免重复计算 ——
 * 第4层一次要造上千个单板，不缓存的话每个节点的告警汇总都会重造一遍。
 */
const topoCache = new Map<string, LayerTopo>();

export function clearTopoCache(): void {
  topoCache.clear();
}

/**
 * 按路径生成一层拓扑。
 * 路径最后一段是 detail 时进单板层，其余都是网元层。
 */
export function buildLayer(path: PathSeg[], scale: ScaleKey): LayerTopo {
  const key = `${scale}:${pathKey(path)}`;
  const hit = topoCache.get(key);
  if (hit) return hit;

  const last = path[path.length - 1];
  let topo: LayerTopo;
  if (last && last.kind === 'detail') {
    topo = genBoardLayer(path, scale);
  } else if (path.length === 0) {
    topo = genTrunkLayer(scale);
  } else {
    topo = genCorridorLayer(path, scale);
  }

  topoCache.set(key, topo);
  return topo;
}

export function findLink(topo: LayerTopo, linkId: string): TopoLink | undefined {
  return topo.links.find((l) => l.id === linkId);
}

export function findDomain(topo: LayerTopo, domainId: string): DomainBox | undefined {
  return topo.domains.find((d) => d.id === domainId);
}

export function findNode(topo: LayerTopo, nodeId: string): TopoNode | undefined {
  return topo.nodes.find((n) => n.id === nodeId);
}
