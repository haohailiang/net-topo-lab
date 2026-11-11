import { Graph } from '@antv/g6';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import type { TopoNode, TopoSnapshot } from '../data/topo';

export type LayoutKey = 'dagre' | 'force' | 'grid' | 'radial';

export const LAYOUT_LABELS: Record<LayoutKey, string> = {
  dagre: '分层树 (antv-dagre)',
  force: '力导向 (force)',
  grid: '网格 (grid)',
  radial: '环形 (radial)',
};

export interface TopoGraphHandle {
  render(snapshot: TopoSnapshot): Promise<number>;
  setLayout(key: LayoutKey): void;
  /** 清空画布并等待真正清完，避免上一次的大图销毁成本被算进下一次计时 */
  clearSafely(): Promise<void>;
}

interface Props {
  layout: LayoutKey;
  onNodeClick?: (nodeId: string) => void;
}

// G6 v5 的 LayoutOptions 是联合类型，逐个键显式声明会非常啰嗦；
// 这里用一个宽松映射，实际字段按 G6 各布局的官方参数填写。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const LAYOUT_CONFIG: Record<LayoutKey, any> = {
  dagre: { type: 'antv-dagre', rankdir: 'TB', nodesep: 14, ranksep: 48 },
  force: { type: 'force', preventOverlap: true, link: { distance: 60 } },
  grid: { type: 'grid' },
  radial: { type: 'radial', focusNode: 'core-01' },
};

const TopoGraph = forwardRef<TopoGraphHandle, Props>(function TopoGraph(props, ref) {
  const { layout, onNodeClick } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const clickRef = useRef<Props['onNodeClick']>(onNodeClick);
  clickRef.current = onNodeClick;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const graph = new Graph({
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
      layout: LAYOUT_CONFIG[layout],
      behaviors: ['zoom-canvas', 'drag-canvas'],
    });

    graph.on('node:click', (e: any) => {
      const id = e?.target?.id as string | undefined;
      if (id && clickRef.current) clickRef.current(id);
    });

    graphRef.current = graph;

    return () => {
      graphRef.current = null;
      graph.destroy();
    };
  }, []);

  const applyLayout = useCallback((key: LayoutKey) => {
    const g = graphRef.current;
    if (!g) return;
    g.setOptions({ layout: LAYOUT_CONFIG[key] });
    g.render();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      async render(snapshot: TopoSnapshot) {
        const g = graphRef.current;
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
      },
      setLayout(key: LayoutKey) {
        applyLayout(key);
      },
      async clearSafely() {
        const g = graphRef.current;
        if (!g) return;
        g.setData({ nodes: [], edges: [] });
        await g.render();
      },
    }),
    [applyLayout],
  );

  return <div className="graph-canvas" ref={containerRef} />;
});

export default TopoGraph;
