/**
 * 主干链布局（第 1 层）
 *
 * 顶层只看到主干网元之间的抽象链路，所以把网元一字排开、链路横向相连，
 * 最容易看出"从哪一跳跳到哪一跳"。
 */

import type { LayerTopo } from '../../data/model';

export function chainLayout(ctx: { topo: LayerTopo; width: number; height: number }) {
  const { topo, width, height } = ctx;
  const positions = new Map<string, { x: number; y: number }>();

  const n = topo.nodes.length;
  const marginX = Math.min(90, width * 0.08);
  const usable = Math.max(1, width - marginX * 2);
  const gap = n > 1 ? usable / (n - 1) : 0;

  topo.nodes.forEach((node, i) => {
    positions.set(node.id, { x: marginX + gap * i, y: height / 2 });
  });

  return { positions };
}
