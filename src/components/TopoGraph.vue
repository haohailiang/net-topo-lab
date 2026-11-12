<script setup lang="ts">
import { Graph } from '@antv/g6';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TopoNode, TopoSnapshot } from '../data/topo';
import { LAYOUT_CONFIG, type LayoutKey } from './layouts';

const props = defineProps<{ layout: LayoutKey }>();
const emit = defineEmits<{ (e: 'node-click', id: string): void }>();

const container = ref<HTMLDivElement | null>(null);
let graph: Graph | null = null;

onMounted(() => {
  const el = container.value;
  if (!el) return;

  graph = new Graph({
    container: el,
    autoFit: 'center',
    animation: false,
    data: { nodes: [], edges: [] },
    node: {
      style: {
        size: (d: any) => (d?.data?.size as number) ?? 12,
        fill: (d: any) => (d?.data?.fill as string) ?? '#5B8FF9',
        stroke: '#1f2d3d',
        lineWidth: 1,
        // 还有子节点未展开的，标签后加一个 ▾，让访客一眼看出哪些点可以继续下钻
        labelText: (d: any) => {
          const name = (d?.data?.name as string) ?? '';
          return (d?.data?.childCount as number) > 0 ? `${name} ▾` : name;
        },
        labelFontSize: 9,
        labelFill: '#26415e',
        labelOffsetY: 9,
      },
    },
    edge: {
      style: {
        stroke: '#c2cbd9',
        lineWidth: 1,
        endArrow: false,
      },
    },
    layout: LAYOUT_CONFIG[props.layout],
    behaviors: ['zoom-canvas', 'drag-canvas'],
  });

  graph.on('node:click', (e: any) => {
    const id = e?.target?.id as string | undefined;
    if (id) emit('node-click', id);
  });
});

onBeforeUnmount(() => {
  graph?.destroy();
  graph = null;
});

/**
 * 布局变化时只替换布局配置，图实例本身不重建 ——
 * 这就是"切布局不动图组件"在代码上的样子。
 */
watch(
  () => props.layout,
  (key) => {
    if (!graph) return;
    graph.setOptions({ layout: LAYOUT_CONFIG[key] });
    graph.render();
  },
);

/** 渲染一份快照，返回「布局 + 绘制」的真实耗时（毫秒） */
async function render(snapshot: TopoSnapshot): Promise<number> {
  const g = graph;
  if (!g) return 0;
  const t0 = performance.now();
  g.setData({
    nodes: snapshot.nodes.map((n: TopoNode) => ({
      id: n.id,
      data: {
        name: n.name,
        size: n.size,
        fill: n.fill,
        level: n.level,
        childCount: n.childCount,
        parentId: n.parentId,
      },
    })),
    edges: snapshot.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
  });
  await g.render();
  return performance.now() - t0;
}

/** 清空画布并等待真正清完，避免上一张大图的销毁成本被算进下一次计时 */
async function clearSafely(): Promise<void> {
  const g = graph;
  if (!g) return;
  g.setData({ nodes: [], edges: [] });
  await g.render();
}

function setLayout(key: LayoutKey): void {
  if (!graph) return;
  graph.setOptions({ layout: LAYOUT_CONFIG[key] });
  graph.render();
}

defineExpose({ render, clearSafely, setLayout });
</script>

<template>
  <div ref="container" class="graph-canvas"></div>
</template>
