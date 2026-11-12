/**
 * 三走廊布局（第 2~3 层）
 *
 * 一条主干链路展开后是「左端点 + 右端点 + 中间几条并行路径」，
 * 把每条路径画成一条从上到下的走廊：
 *
 *        ┌── 中继 ── 中继 ── 中继 ──┐
 *   左 ●──┼── 中继 ── 中继 ── 中继 ──┤──● 右
 *        └── 中继 ── 中继 ── 中继 ──┘
 *
 * 两端点固定居中，每条路径占一条横向带，带内节点等距。
 */

import type { LayerTopo } from '../../data/model';

export function corridorLayout(ctx: { topo: LayerTopo; width: number; height: number }) {
  const { topo, width, height } = ctx;
  const positions = new Map<string, { x: number; y: number }>();

  const marginX = Math.min(70, width * 0.07);
  const usable = Math.max(1, width - marginX * 2);
  const centerY = height / 2;

  const pathIds = Array.from(
    new Set(topo.nodes.map((n) => n.pathIndex ?? -1).filter((i) => i >= 0)),
  ).sort((a, b) => a - b);

  const bandCount = Math.max(1, pathIds.length);
  // 上下留出边距后把高度均分给各条走廊
  const bandGap = bandCount > 1 ? (height - 90) / (bandCount - 1) : 0;

  for (const node of topo.nodes) {
    if (node.entry) {
      const isLeft = node.name.endsWith('-L');
      positions.set(node.id, {
        x: isLeft ? marginX : width - marginX,
        y: centerY,
      });
      continue;
    }

    const p = node.pathIndex ?? 0;
    const bandY = centerY + (p - (bandCount - 1) / 2) * bandGap;

    const siblings = topo.nodes.filter((n) => n.pathIndex === p && !n.entry);
    const idx = siblings.findIndex((n) => n.id === node.id);
    const step = usable / (siblings.length + 1);

    positions.set(node.id, { x: marginX + step * (idx + 1), y: bandY });
  }

  return { positions };
}
