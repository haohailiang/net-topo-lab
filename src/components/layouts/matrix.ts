/**
 * 单板矩阵布局（第 4 层）
 *
 * 第4层是整个第3层展开后的单板，总量接近一千块，不能撒成一团。
 * 按「所属网元」分块：每个网元占一块，块内单板按固定间距密排。
 *
 * 关键：间距按像素写死，不按画布尺寸压缩。
 * 如果每块都塞进画布，990 块板必然挤成一片；这里让内容整体远大于画布，
 * 由 fitView 缩小成"全览点阵"，用户放大后才逐级看到单板编号和告警角标。
 */

import type { LayerTopo } from '../../data/model';

const GAP_X = 58; // 单板横向间距，要大于标签文字宽度
const GAP_Y = 46;
const BLOCK_PAD = 40;
const BLOCK_GAP = 64;

export function matrixLayout(ctx: { topo: LayerTopo; width: number; height: number }) {
  const { topo, width } = ctx;
  const positions = new Map<string, { x: number; y: number }>();

  const groups = new Map<string, typeof topo.nodes>();
  for (const node of topo.nodes) {
    const key = node.ownerName ?? '未分组';
    const list = groups.get(key);
    if (list) list.push(node);
    else groups.set(key, [node]);
  }

  const blockCount = Math.max(1, groups.size);
  const perRow = blockCount <= 4 ? blockCount : width < 900 ? 4 : 6;

  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let bi = 0;

  for (const [, list] of groups) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
    const innerRows = Math.ceil(list.length / cols);
    const bw = cols * GAP_X + BLOCK_PAD;
    const bh = innerRows * GAP_Y + BLOCK_PAD;

    if (bi % perRow === 0 && bi > 0) {
      cursorY += rowHeight + BLOCK_GAP;
      cursorX = 0;
      rowHeight = 0;
    }

    list.forEach((node, i) => {
      const ix = i % cols;
      const iy = Math.floor(i / cols);
      positions.set(node.id, {
        x: cursorX + BLOCK_PAD / 2 + ix * GAP_X,
        y: cursorY + BLOCK_PAD / 2 + iy * GAP_Y,
      });
    });

    cursorX += bw + BLOCK_GAP;
    rowHeight = Math.max(rowHeight, bh);
    bi += 1;
  }

  return { positions };
}
