/**
 * 布局注册表。
 *
 * 这一层的意义：把「布局」和「图组件」彻底解耦。每种拓扑形态要的排布不一样，
 * 所以布局是业务定制的 —— 想加一种排法，只在这里加一个文件、注册一行，
 * 图组件一行都不用改。内置布局只作为对照，点一下就能看出它们在这种
 * 两点多条路径的业务拓扑上排得有多难看。
 */

import type { LayerTopo } from '../../data/model';
import { chainLayout } from './chain';
import { corridorLayout } from './corridor';
import { matrixLayout } from './matrix';
import { starLayout } from './star';

export interface LayoutContext {
  topo: LayerTopo;
  width: number;
  height: number;
}

export interface LayoutOutput {
  /** 节点 id -> 中心坐标。为空表示交给 G6 的内置布局去算 */
  positions: Map<string, { x: number; y: number }>;
}

export type LayoutFn = (ctx: LayoutContext) => LayoutOutput;

export type CustomLayoutKey = 'chain' | 'corridor' | 'matrix' | 'star';
export type BuiltinLayoutKey = 'dagre' | 'force' | 'grid' | 'radial';
export type LayoutKey = CustomLayoutKey | BuiltinLayoutKey;

export const CUSTOM_LAYOUTS: Record<CustomLayoutKey, LayoutFn> = {
  chain: chainLayout,
  corridor: corridorLayout,
  matrix: matrixLayout,
  star: starLayout,
};

/** 内置布局参数，仅作对照 */
export const BUILTIN_CONFIG: Record<BuiltinLayoutKey, unknown> = {
  dagre: { type: 'antv-dagre', rankdir: 'TB', nodesep: 12, ranksep: 40 },
  force: { type: 'force', preventOverlap: true, link: { distance: 50 } },
  grid: { type: 'grid' },
  radial: { type: 'radial' },
};

export const LAYOUT_META: Record<
  LayoutKey,
  { label: string; kind: 'custom' | 'builtin'; hint: string }
> = {
  chain: { label: '主干链', kind: 'custom', hint: '第1层：主干网元一字排开，链路横向相连' },
  corridor: { label: '三走廊', kind: 'custom', hint: '第2~3层：两端点 + 中间多条并行走廊' },
  matrix: { label: '单板矩阵', kind: 'custom', hint: '第4层：按网元分块，块内网格密排' },
  star: { label: '星辐', kind: 'custom', hint: '核心节点居中，其余按角度散开，备用排法' },
  dagre: { label: '分层树（内置）', kind: 'builtin', hint: '通用树形布局，业务拓扑上会排成一团' },
  force: { label: '力导向（内置）', kind: 'builtin', hint: '通用力导向，节点会飘，看不出通路关系' },
  grid: { label: '网格（内置）', kind: 'builtin', hint: '只按格排，完全丢掉了拓扑语义' },
  radial: { label: '环形（内置）', kind: 'builtin', hint: '环形排布，两点之间的多条路径会重叠' },
};

export const CUSTOM_KEYS: CustomLayoutKey[] = ['chain', 'corridor', 'matrix', 'star'];
export const BUILTIN_KEYS: BuiltinLayoutKey[] = ['dagre', 'force', 'grid', 'radial'];

export function isCustom(key: LayoutKey): key is CustomLayoutKey {
  return (CUSTOM_KEYS as string[]).includes(key);
}

/** 按层自动选一个合适的默认布局 */
export function defaultLayoutForLayer(layer: number): CustomLayoutKey {
  if (layer <= 1) return 'chain';
  if (layer >= 4) return 'matrix';
  return 'corridor';
}

/** 算坐标：自定义布局返回真实坐标，内置布局返回空表交给 G6 */
export function computeLayout(key: LayoutKey, ctx: LayoutContext): LayoutOutput {
  if (isCustom(key)) {
    return CUSTOM_LAYOUTS[key](ctx);
  }
  return { positions: new Map() };
}
