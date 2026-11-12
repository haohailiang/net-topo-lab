<script setup lang="ts">
/**
 * 一张图的渲染封装。
 *
 * 组件不决定"图长什么样"，只负责把外面算好的坐标、告警、高亮画出来：
 *   - 坐标由 layouts/ 下的纯函数算好传进来，这里用 preset 布局直接落位
 *   - 告警按级别着色，角标数字是去重后的告警对象数
 *   - 域用背景矩形框住两个成员网元，点框就是一次域下钻
 *   - 缩放跨过阈值时批量切样式（LOD 三档），不重画整张图
 */
import { onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue';
import { Graph } from '@antv/g6';
import { ALARM_COLORS, type Digest, type LayerTopo } from '../data/model';
import { BUILTIN_CONFIG, computeLayout, isCustom, type LayoutKey } from './layouts';

const props = defineProps<{
  topo: LayerTopo;
  layoutKey: LayoutKey;
  height: number;
  highlightIds: string[];
  digests: Map<string, Digest>;
}>();

const emit = defineEmits<{
  (e: 'drill-link', linkId: string): void;
  (e: 'drill-domain', domainId: string): void;
  (e: 'pick-node', nodeId: string): void;
  (e: 'lod-change', tier: number): void;
}>();

const host = ref<HTMLDivElement | null>(null);
let graph: Graph | null = null;
let currentTier = -1;
let lodTimer: number | null = null;
let destroyed = false;

/* ------------------------------------------------------------- 样式计算 */

function levelColor(level: number): string {
  if (level === 1) return ALARM_COLORS[1];
  if (level === 2) return ALARM_COLORS[2];
  if (level === 3) return ALARM_COLORS[3];
  return '#64748b';
}

function nodeSize(kind: string, entry: boolean): number {
  if (kind === 'board') return 6;
  return entry ? 26 : 18;
}

function labelOf(name: string, count: number): string {
  return count > 0 ? `${name} ${count}` : name;
}

/** 域框：包住两个成员网元的矩形 */
function buildDomainEls(positions: Map<string, { x: number; y: number }>) {
  const out: any[] = [];
  for (const d of props.topo.domains) {
    // 只有可下钻的域才画框：一层的域如果全画出来，虚线会糊成一片
    if (!d.drillable) continue;
    const pts = d.members
      .map((m) => positions.get(m))
      .filter((p): p is { x: number; y: number } => Boolean(p));
    if (pts.length < 2) continue;

    const minX = Math.min(...pts.map((p) => p.x));
    const maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const maxY = Math.max(...pts.map((p) => p.y));
    const padX = 40;
    const padY = 26;

    out.push({
      id: d.id,
      type: 'rect',
      data: { ...d, role: 'domain' },
      style: {
        // 域框只做视觉底，不参与命中：否则框里所有节点和链路都点不到
        zIndex: -1,
        pointerEvents: 'none',
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2,
        size: [maxX - minX + padX * 2, maxY - minY + padY * 2],
        radius: 8,
        fill: d.drillable ? '#eaf2ff' : '#f2f5f9',
        stroke: d.drillable ? '#9dbdf0' : '#d6dde8',
        lineWidth: 1,
        lineDash: [6, 4],
        labelText: d.name,
        labelPlacement: 'top',
        labelFontSize: 10,
        labelFill: d.drillable ? '#3f6eae' : '#94a3b8',
        cursor: d.drillable ? 'pointer' : 'default',
      },
    });
  }
  return out;
}

function buildNodes(positions: Map<string, { x: number; y: number }>, tier: number) {
  return props.topo.nodes.map((n) => {
    const pos = positions.get(n.id) ?? { x: 0, y: 0 };
    const dg = props.digests.get(n.id);
    const level = dg?.topLevel ?? 0;
    const count = dg?.count ?? 0;
    const base = nodeSize(n.kind, n.entry);

    return {
      id: n.id,
      type: 'circle',
      data: { ...n, x: pos.x, y: pos.y },
      style: {
        x: pos.x,
        y: pos.y,
        size: tier === 0 ? Math.max(4, base * 0.55) : base,
        fill: n.entry ? '#ffffff' : levelColor(level),
        stroke: level > 0 ? levelColor(level) : n.entry ? '#7ea3dd' : '#94a3b8',
        lineWidth: level > 0 ? 2 : 1,
        labelText: tier === 0 ? '' : labelOf(n.name, count),
        labelPlacement: 'bottom',
        labelFontSize: 9,
        labelFill: level > 0 ? levelColor(level) : '#475569',
        cursor: 'default',
      },
      state: {
        highlight: {
          lineWidth: 3,
          stroke: '#2563eb',
          shadowColor: '#2563eb',
          shadowBlur: 14,
        },
      },
    };
  });
}

/**
 * 可下钻链路中点上的点击热区。
 * 链路本身只有 2px 宽，直接用鼠标点线很难命中，这里放一个小圆点当把手。
 */
function buildHotspots(positions: Map<string, { x: number; y: number }>) {
  const out: any[] = [];
  for (const l of props.topo.links) {
    if (!l.drillable) continue;
    const a = positions.get(l.source);
    const b = positions.get(l.target);
    if (!a || !b) continue;
    out.push({
      id: `hs-${l.id}`,
      type: 'circle',
      data: { role: 'hotspot', linkId: l.id, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      style: {
        zIndex: 10,
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        size: 16,
        fill: '#ffffff',
        stroke: '#2563eb',
        lineWidth: 1.5,
        labelText: '＋',
        labelFontSize: 9,
        labelFill: '#2563eb',
        cursor: 'pointer',
      },
    });
  }
  return out;
}

function buildEdges(tier: number) {
  return props.topo.links.map((l) => {
    const dg = props.digests.get(l.id);
    const level = dg?.topLevel ?? 0;
    const color = level > 0 ? levelColor(level) : l.drillable ? '#7ea3dd' : '#cbd5e1';

    return {
      id: l.id,
      source: l.source,
      target: l.target,
      data: { ...l },
      style: {
        stroke: color,
        lineWidth: l.drillable ? 2 : tier === 0 ? 0.6 : 1,
        opacity: tier === 0 ? 0.5 : 1,
        lineDash: l.drillable ? undefined : [4, 4],
        cursor: l.drillable ? 'pointer' : 'default',
        labelText: tier >= 2 ? l.label : '',
        labelFontSize: 8,
        labelFill: '#94a3b8',
      },
      state: {
        highlight: {
          lineWidth: 4,
          stroke: '#2563eb',
        },
      },
    };
  });
}

/* ------------------------------------------------------------------ 渲染 */

async function clearSafely() {
  if (!graph) return;
  const old = graph;
  graph = null;
  const bucket = (window as unknown as { __topoGraphs?: { graph: unknown }[] }).__topoGraphs;
  if (bucket) {
    const i = bucket.findIndex((x) => x.graph === old);
    if (i >= 0) bucket.splice(i, 1);
  }
  try {
    old.destroy();
  } catch {
    /* 销毁期间的异常忽略，不能让它打断下一次渲染 */
  }
}

async function render() {
  if (destroyed) return;
  await clearSafely();
  await nextTick();

  const el = host.value;
  if (!el) {
    console.debug('[topo] no host', props.topo.layer);
    return;
  }

  const width = Math.max(320, el.clientWidth || 800);
  const height = props.height;

  const { positions } = computeLayout(props.layoutKey, {
    topo: props.topo,
    width,
    height,
  });

  const tier0 = props.topo.nodes.length > 300 ? 0 : 1;
  currentTier = -1;

  const data = {
    nodes: [...buildDomainEls(positions), ...buildNodes(positions, tier0), ...buildHotspots(positions)],
    edges: buildEdges(tier0),
  };

  const builtin: any = isCustom(props.layoutKey)
    ? { type: 'preset' }
    : BUILTIN_CONFIG[props.layoutKey as keyof typeof BUILTIN_CONFIG];

  const g = new Graph({
    container: el,
    width,
    height,
    data: data as any,
    layout: builtin,
    node: {
      type: 'circle',
      style: { labelPlacement: 'bottom', labelFontSize: 9 },
    },
    edge: {
      type: 'line',
      style: { labelPlacement: 'center' },
    },
    behaviors: ['zoom-canvas', 'drag-canvas', 'drag-element'],
    autoFit: 'view',
  });

  graph = g;

  try {
    await g.render();
  } catch (err) {
    console.warn('[topo] render failed', err);
    return;
  }
  // 记下全览时的缩放，LOD 分档都以它为基准
  try {
    fitZoom = g.getZoom();
  } catch {
    fitZoom = 1;
  }
  if (destroyed) {
    console.debug('[topo] destroyed before push', props.topo.layer);
    return;
  }

  // 开发期调试出口：验证脚本靠它把图元 id 换算成屏幕坐标去点击
  if (import.meta.env.DEV) {
    const bucket = (window as unknown as { __topoGraphs?: unknown[] }).__topoGraphs;
    const arr = bucket ?? [];
    if (!bucket) (window as unknown as { __topoGraphs: unknown[] }).__topoGraphs = arr;
    arr.push({
      id: props.topo.path.map((p) => p.id).join('/') || 'root',
      graph: g,
      topo: props.topo,
      positions: Object.fromEntries(positions),
    });
  }

  bindEvents(g);
  applyHighlight(props.highlightIds);
  scheduleLod();
}

function bindEvents(g: Graph) {
  const idOf = (e: any): string => {
    const t = e?.target;
    return (t && t.id) || '';
  };
  // G6 v5 事件里的 target.data 拿不到业务字段，这里直接按 id 回查拓扑模型
  const HS_PREFIX = 'hs-';

  g.on('node:click', (e: any) => {
    const id = idOf(e);
    if (!id) return;

    if (id.startsWith(HS_PREFIX)) {
      emit('drill-link', id.slice(HS_PREFIX.length));
      return;
    }

    const domain = props.topo.domains.find((d) => d.id === id);
    if (domain) {
      if (domain.drillable) emit('drill-domain', id);
      return;
    }

    emit('pick-node', id);
  });

  g.on('edge:click', (e: any) => {
    const id = idOf(e);
    if (!id) return;
    const link = props.topo.links.find((l) => l.id === id);
    if (link?.drillable) emit('drill-link', id);
  });
}

/* ------------------------------------------------------------------- LOD */

/** 首屏 fitView 后的缩放，作为"用户没动过"的基准 */
let fitZoom = 0;

function tierOf(zoom: number): number {
  // 1000 个单板全塞进 340px，靠绝对 zoom 判档没有意义：
  // fitView 之后的 zoom 已经是"全览"，所以按相对初始缩放判档。
  // 另外稀疏的层级全览时就该显示名称，不能因为"没放大"就退化成小点。
  const rel = fitZoom > 0 ? zoom / fitZoom : 1;
  const dense = props.topo.nodes.length > 400;

  if (dense) {
    if (rel < 1.15) return 0;
    if (rel < 2) return 1;
    return 2;
  }

  if (rel < 0.6) return 0;
  if (rel < 0.85) return 1;
  return 2;
}

function applyLod() {
  const g = graph;
  if (!g) return;
  let zoom = 1;
  try {
    zoom = g.getZoom();
  } catch {
    return;
  }
  const tier = tierOf(zoom);
  if (tier === currentTier) return;
  currentTier = tier;

  const pos = new Map<string, { x: number; y: number }>();
  for (const n of props.topo.nodes) pos.set(n.id, { x: 0, y: 0 });

  const nodeUpdates = props.topo.nodes.map((n) => {
    const dg = props.digests.get(n.id);
    const count = dg?.count ?? 0;
    const base = nodeSize(n.kind, n.entry);
    return {
      id: n.id,
      style: {
        size: tier === 0 ? Math.max(4, base * 0.55) : base,
        labelText: tier === 0 ? '' : labelOf(n.name, count),
      },
    };
  });

  const edgeUpdates = props.topo.links.map((l) => ({
    id: l.id,
    style: {
      lineWidth: l.drillable ? (tier === 0 ? 1 : 2) : tier === 0 ? 0.6 : 1,
      opacity: tier === 0 ? 0.5 : 1,
      labelText: tier >= 2 ? l.label : '',
    },
  }));

  try {
    g.updateNodeData(nodeUpdates);
    g.updateEdgeData(edgeUpdates);
    g.draw();
  } catch (err) {
    console.warn('[topo] lod update failed', err);
  }

  emit('lod-change', tier);
  void pos;
}

function scheduleLod() {
  if (lodTimer !== null) window.clearTimeout(lodTimer);
  lodTimer = window.setTimeout(() => {
    lodTimer = null;
    applyLod();
  }, 120);
}

/* ---------------------------------------------------------------- 高亮 */

function applyHighlight(ids: string[]) {
  const g = graph;
  if (!g) return;

  const on = new Set(ids);

  // G6 的 setElementState 在这个版本上不落样式，这里直接改绘制属性
  const nodeUpdates = props.topo.nodes.map((n) => {
    const dg = props.digests.get(n.id);
    const level = dg?.topLevel ?? 0;
    const hi = on.has(n.id);
    return {
      id: n.id,
      style: hi
        ? { stroke: '#2563eb', lineWidth: 3, shadowColor: '#2563eb', shadowBlur: 14, zIndex: 6 }
        : {
            stroke: level > 0 ? levelColor(level) : n.entry ? '#7ea3dd' : '#94a3b8',
            lineWidth: level > 0 ? 2 : 1,
            shadowBlur: 0,
            zIndex: 0,
          },
    };
  });

  const edgeUpdates = props.topo.links.map((l) => {
    const dg = props.digests.get(l.id);
    const level = dg?.topLevel ?? 0;
    const hi = on.has(l.id);
    return {
      id: l.id,
      style: hi
        ? { stroke: '#2563eb', lineWidth: 4, lineDash: [], opacity: 1, zIndex: 6 }
        : {
            stroke: level > 0 ? levelColor(level) : l.drillable ? '#7ea3dd' : '#cbd5e1',
            lineWidth: l.drillable ? 2 : 1,
            lineDash: l.drillable ? [] : [4, 4],
            opacity: 1,
            zIndex: 0,
          },
    };
  });

  const domainUpdates = props.topo.domains
    .filter((d) => d.drillable)
    .map((d) => ({
      id: d.id,
      style: on.has(d.id)
        ? { stroke: '#2563eb', lineWidth: 2, fill: '#dbeafe' }
        : { stroke: '#9dbdf0', lineWidth: 1, fill: '#eaf2ff' },
    }));

  try {
    if (edgeUpdates.length) (g as any).updateEdgeData(edgeUpdates);
    if (nodeUpdates.length) (g as any).updateNodeData(nodeUpdates);
    if (domainUpdates.length) (g as any).updateNodeData(domainUpdates);
    void g.draw();
  } catch {
    /* 图还没就绪时忽略 */
  }
}

/* ---------------------------------------------------------------- 生命周期 */

let wheelHandler: ((e: Event) => void) | null = null;

onMounted(() => {
  destroyed = false;
  void render();

  // G6 的缩放事件名在各版本不完全一致，这里再在容器上兜一层 wheel，
  // 保证滚轮缩放一定能把 LOD 切过来
  const el = host.value;
  if (el) {
    wheelHandler = () => scheduleLod();
    el.addEventListener('wheel', wheelHandler, { passive: true });
  }
});

onBeforeUnmount(() => {
  destroyed = true;
  const el = host.value;
  if (el && wheelHandler) el.removeEventListener('wheel', wheelHandler);
  if (lodTimer !== null) window.clearTimeout(lodTimer);
  void clearSafely();
});

watch(
  () => [props.topo, props.layoutKey],
  () => {
    void render();
  },
);

watch(
  () => props.highlightIds,
  (ids) => applyHighlight(ids),
  { deep: true },
);

defineExpose({ render, applyLod });
</script>

<template>
  <div ref="host" class="topo-host" :style="{ height: height + 'px' }" />
</template>

<style scoped>
.topo-host {
  width: 100%;
  background: #fbfcfe;
  border-radius: 8px;
  overflow: hidden;
}
</style>
