/**
 * 星辐布局（备用）
 *
 * 核心节点居中、其余按角度均分在圆周上。业务上用得少，但保留它作为
 * 「同一张图换一种排法」的对照组 —— 布局是纯函数，加一种只加一个文件。
 */

import type { LayerTopo } from '../../data/model';

export function starLayout(ctx: { topo: LayerTopo; width: number; height: number }) {
  const { topo, width, height } = ctx;
  const positions = new Map<string, { x: number; y: number }>();

  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.36;
  const n = topo.nodes.length;

  topo.nodes.forEach((node, i) => {
    if (i === 0) {
      positions.set(node.id, { x: cx, y: cy });
      return;
    }
    const angle = (Math.PI * 2 * (i - 1)) / Math.max(1, n - 1) - Math.PI / 2;
    positions.set(node.id, {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  });

  return { positions };
}
