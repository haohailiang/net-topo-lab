/**
 * 布局层配置
 *
 * 单独抽成一个模块，是为了把「布局」和「图组件」彻底分开：
 * 想换一种排布方式，只需要在这里加一项、在 UI 上多一个 chip，
 * 图组件那边一行都不用改。这就是"代码量降到原来的 1/6"的由来。
 */

export type LayoutKey = 'dagre' | 'force' | 'grid' | 'radial';

export const LAYOUT_LABELS: Record<LayoutKey, string> = {
  dagre: '分层树 (antv-dagre)',
  force: '力导向 (force)',
  grid: '网格 (grid)',
  radial: '环形 (radial)',
};

// G6 v5 的 LayoutOptions 是联合类型，逐个键显式声明会非常啰嗦；
// 这里用一个宽松映射，实际字段按 G6 各布局的官方参数填写。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const LAYOUT_CONFIG: Record<LayoutKey, any> = {
  dagre: { type: 'antv-dagre', rankdir: 'TB', nodesep: 14, ranksep: 48 },
  force: { type: 'force', preventOverlap: true, link: { distance: 60 } },
  grid: { type: 'grid' },
  radial: { type: 'radial', focusNode: 'core-01' },
};

export const LAYOUT_KEYS: LayoutKey[] = ['dagre', 'force', 'grid', 'radial'];
