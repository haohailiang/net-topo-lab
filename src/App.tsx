import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import TopoGraph, { LAYOUT_LABELS, type LayoutKey, type TopoGraphHandle } from './components/TopoGraph';
import {
  SCALES,
  buildTopology,
  fetchChildren,
  resetMockCache,
  type ScaleKey,
  type TopoEdge,
  type TopoNode,
  type TopoSnapshot,
} from './data/topo';

type Mode = 'full' | 'lazy';

interface FullResult {
  scale: ScaleKey;
  ms: number;
  nodes: number;
  edges: number;
  bytes: number;
}

interface LazyResult {
  scale: ScaleKey;
  ms: number;
  nodes: number;
  bytes: number;
}

/** 响应体字节数：懒加载的核心优势其实在这里 —— 首屏只需要传极少的数据 */
function payloadBytes(snapshot: TopoSnapshot): number {
  return new Blob([JSON.stringify(snapshot)]).size;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} 秒`;
  if (ms < 1) return '<1 ms';
  return `${ms.toFixed(0)} ms`;
}

// 支持用查询参数直接进入某个对比场景，便于分享具体结论的链接，例如：
//   ?scale=L&autorun=full   直接跑大规模全量渲染
//   ?scale=S&autorun=lazy   直接跑小规模懒加载
const QUERY = new URLSearchParams(window.location.search);
const INITIAL_SCALE: ScaleKey = (() => {
  const s = QUERY.get('scale');
  return s === 'S' || s === 'M' || s === 'L' ? s : 'M';
})();
const AUTO_RUN = QUERY.get('autorun');

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function App() {
  const graphRef = useRef<TopoGraphHandle | null>(null);
  const fullRef = useRef<TopoSnapshot | null>(null);
  const visibleRef = useRef<{ nodes: TopoNode[]; edges: TopoEdge[] }>({ nodes: [], edges: [] });

  const [mode, setMode] = useState<Mode>('full');
  const [scaleKey, setScaleKey] = useState<ScaleKey>(INITIAL_SCALE);
  const [layout, setLayout] = useState<LayoutKey>('dagre');
  const [running, setRunning] = useState(false);
  const [fullResult, setFullResult] = useState<FullResult | null>(null);
  const [lazyResult, setLazyResult] = useState<LazyResult | null>(null);
  const [visibleCount, setVisibleCount] = useState({ nodes: 0, edges: 0 });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [requests, setRequests] = useState(0);
  const [cacheHits, setCacheHits] = useState(0);
  const [lastMs, setLastMs] = useState<number | null>(null);
  const [log, setLog] = useState<string[]>([]);

  // running 的 state 版本用于驱动 UI，ref 版本用于串行判断：
  // 「一键对比」要连续跑完全量再跑懒加载，若只看 state，第二次会被旧值拦掉。
  const runningRef = useRef(false);
  const setBusy = useCallback((busy: boolean) => {
    runningRef.current = busy;
    setRunning(busy);
  }, []);

  const pushLog = useCallback((text: string) => {
    setLog((prev) => [`${stamp()}  ${text}`, ...prev].slice(0, 12));
  }, []);

  // 让浏览器先把「渲染中」的 UI 画出来，再开始同步布局。
  // 这里用 setTimeout 而不是 requestAnimationFrame：rAF 在无头/后台标签页里
  // 可能永不触发，会让渲染流程卡死；定时器在任何环境下都能推进。
  const nextFrame = () =>
    new Promise<void>((resolve) => {
      setTimeout(() => resolve(), 0);
    });

  const runFull = useCallback(async () => {
    if (runningRef.current) return;
    setMode('full');
    setBusy(true);
    setExpanded(new Set());
    resetMockCache();
    pushLog(`开始全量渲染 · ${SCALES[scaleKey].label}`);
    // 先清干净画布再计时，避免上一次遗留的大量节点销毁成本混进来
    await graphRef.current?.clearSafely();
    await nextFrame();

    const topo = buildTopology(scaleKey);
    fullRef.current = topo;
    visibleRef.current = { nodes: topo.nodes, edges: topo.edges };
    setVisibleCount({ nodes: topo.nodes.length, edges: topo.edges.length });

    const ms = await graphRef.current?.render(topo) ?? 0;
    setLastMs(ms);
    setFullResult({
      scale: scaleKey,
      ms,
      nodes: topo.nodes.length,
      edges: topo.edges.length,
      bytes: payloadBytes(topo),
    });
    pushLog(`全量渲染完成：${topo.nodes.length} 节点 / ${topo.edges.length} 边，布局+绘制合计 ${fmtMs(ms)}`);
    setBusy(false);
  }, [pushLog, scaleKey, setBusy]);

  const runLazy = useCallback(async () => {
    if (runningRef.current) return;
    setMode('lazy');
    setBusy(true);
    setExpanded(new Set());
    resetMockCache();

    const topo = buildTopology(scaleKey);
    fullRef.current = topo;
    pushLog(`开始分层懒加载 · ${SCALES[scaleKey].label}，仅请求根层级`);

    // 同样先清空再计时：懒加载测的是"从零开始的首屏"，不是"拆掉旧图的速度"
    await graphRef.current?.clearSafely();
    await nextFrame();
    const rootRes = await fetchChildren(topo, null, 45);
    let merged: TopoSnapshot = rootRes.snapshot;
    let requestCount = 1;
    let cacheHit = rootRes.fromCache ? 1 : 0;
    let bytes = payloadBytes(rootRes.snapshot);

    // 首屏再多拉一跳（核心 -> 汇聚），避免打开页面只看到一个孤立的点。
    // 更下面的层级全部靠点击节点逐层下钻，不会一次性回来。
    const rootNode = merged.nodes[0];
    if (rootNode) {
      const level1 = await fetchChildren(topo, rootNode.id, 45);
      merged = {
        nodes: [...merged.nodes, ...level1.snapshot.nodes],
        edges: [...merged.edges, ...level1.snapshot.edges],
      };
      requestCount += 1;
      bytes += payloadBytes(level1.snapshot);
      if (level1.fromCache) cacheHit += 1;
    }

    visibleRef.current = merged;
    setVisibleCount({ nodes: merged.nodes.length, edges: merged.edges.length });
    setRequests(requestCount);
    setCacheHits(cacheHit);

    const ms = await graphRef.current?.render(merged) ?? 0;
    setLastMs(ms);
    setLazyResult({ scale: scaleKey, ms, nodes: merged.nodes.length, bytes });
    pushLog(
      `首屏完成：只请求核心与汇聚两层、渲染 ${merged.nodes.length} 个节点，用时 ${fmtMs(ms)}；更下层点节点再按需加载`,
    );
    setBusy(false);
  }, [pushLog, scaleKey, setBusy]);

  const handleNodeClick = useCallback(
    async (nodeId: string) => {
      if (mode !== 'lazy' || runningRef.current) return;
      if (expanded.has(nodeId)) return;
      const full = fullRef.current;
      if (!full) return;

      const node = visibleRef.current.nodes.find((n) => n.id === nodeId);
      if (!node || node.childCount === 0) return;

      setBusy(true);
      const res = await fetchChildren(full, nodeId, 45);
      setRequests((c) => c + 1);
      if (res.fromCache) setCacheHits((c) => c + 1);

      const merged: { nodes: TopoNode[]; edges: TopoEdge[] } = {
        nodes: [...visibleRef.current.nodes, ...res.snapshot.nodes],
        edges: [...visibleRef.current.edges, ...res.snapshot.edges],
      };
      visibleRef.current = merged;
      setVisibleCount({ nodes: merged.nodes.length, edges: merged.edges.length });

      const ms = await graphRef.current?.render(merged) ?? 0;
      setLastMs(ms);
      setExpanded((prev) => new Set(prev).add(nodeId));
      pushLog(
        `下钻 ${node.name}：新增 ${res.snapshot.nodes.length} 个子节点，渲染 ${fmtMs(ms)}${res.fromCache ? ' · 命中缓存' : ' · 回源'}；可见节点 ${merged.nodes.length}`,
      );
      setBusy(false);
    },
    [expanded, mode, pushLog, setBusy],
  );

  // 首屏自动跑一次懒加载：访客打开页面即可看到拓扑，而不是一张空白画布。
  // 注意守卫要放在定时器回调内部 —— StrictMode 会在首次挂载后立刻执行
  // effect 清理函数，若在 effect 外层置位守卫，第二次挂载就不会再安排定时器。
  const autoRan = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (autoRan.current) return;
      autoRan.current = true;
      if (AUTO_RUN === 'full') {
        void runFull();
      } else {
        void runLazy();
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [runFull, runLazy]);

  // 一键对比：先跑全量、再跑懒加载，最后直接给出同规模下的倍数。
  // 这是给访客最省事的入口 —— 点一次就能看到结论，不用自己记两个数字。
  const runCompare = useCallback(async () => {
    if (runningRef.current) return;
    await graphRef.current?.clearSafely();
    setLog([]);
    setFullResult(null);
    setLazyResult(null);
    await runFull();
    await runLazy();
  }, [runFull, runLazy]);

  const handleLayout = useCallback((key: LayoutKey) => {
    setLayout(key);
    graphRef.current?.setLayout(key);
    pushLog(`切换布局 -> ${LAYOUT_LABELS[key]}（图组件不重建，只换布局层）`);
  }, [pushLog]);

  const reset = useCallback(() => {
    void graphRef.current?.clearSafely();
    visibleRef.current = { nodes: [], edges: [] };
    fullRef.current = null;
    resetMockCache();
    setVisibleCount({ nodes: 0, edges: 0 });
    setExpanded(new Set());
    setRequests(0);
    setCacheHits(0);
    setLastMs(null);
    setFullResult(null);
    setLazyResult(null);
    setLog([]);
  }, []);

  const ratio = useMemo(() => {
    if (!fullResult || !lazyResult) return null;
    if (fullResult.scale !== lazyResult.scale) return null;
    return lazyResult.ms > 0 ? fullResult.ms / lazyResult.ms : null;
  }, [fullResult, lazyResult]);

  const byteRatio = useMemo(() => {
    if (!fullResult || !lazyResult) return null;
    if (fullResult.scale !== lazyResult.scale) return null;
    return lazyResult.bytes > 0 ? fullResult.bytes / lazyResult.bytes : null;
  }, [fullResult, lazyResult]);

  return (
    <div className="app">
      <aside className="panel">
        <header className="brand">
          <h1>net-topo-lab</h1>
          <p>多层拓扑的分层懒加载与布局解耦演示</p>
          <p className="disclaimer">
            拓扑数据由程序合成生成，不含任何前雇主 / 客户 / 运营商的真实网络数据。
          </p>
        </header>

        <section className="block">
          <h2>1. 选择数据规模</h2>
          <div className="segmented">
            {(Object.keys(SCALES) as ScaleKey[]).map((k) => (
              <button
                key={k}
                className={k === scaleKey ? 'seg active' : 'seg'}
                onClick={() => setScaleKey(k)}
                disabled={running}
              >
                {SCALES[k].label}
              </button>
            ))}
          </div>
          <p className="hint">{SCALES[scaleKey].hint}</p>
        </section>

        <section className="block">
          <h2>2. 跑一次对比</h2>
          <button className="btn btn-compare" onClick={runCompare} disabled={running}>
            一键对比（先全量、再懒加载）
          </button>
          <div className="actions">
            <button className="btn btn-full" onClick={runFull} disabled={running}>
              只跑全量（旧实现）
            </button>
            <button className="btn btn-lazy" onClick={runLazy} disabled={running}>
              只跑懒加载（优化后）
            </button>
          </div>
          <p className="hint">
            一键对比会自动跑完两遍，右下角给出同规模下的倍数。规模选「大」时全量约 1 秒量级，具体取决于机器性能。
          </p>
        </section>

        <section className="block">
          <h2>3. 切换布局</h2>
          <div className="layouts">
            {(Object.keys(LAYOUT_LABELS) as LayoutKey[]).map((k) => (
              <button
                key={k}
                className={k === layout ? 'chip active' : 'chip'}
                onClick={() => handleLayout(k)}
              >
                {LAYOUT_LABELS[k]}
              </button>
            ))}
          </div>
          <p className="hint">懒加载模式下点节点可逐层下钻；切布局时图组件不重建，只替换布局层。</p>
        </section>

        <section className="block">
          <h2>运行指标</h2>
          <dl className="metrics">
            <dt>可见节点</dt>
            <dd>{visibleCount.nodes}</dd>
            <dt>可见边</dt>
            <dd>{visibleCount.edges}</dd>
            <dt>最近一次渲染</dt>
            <dd>{lastMs === null ? '—' : fmtMs(lastMs)}</dd>
            <dt>接口请求数</dt>
            <dd>{requests}</dd>
            <dt>缓存命中</dt>
            <dd>{cacheHits}</dd>
            <dt>已展开层级</dt>
            <dd>{expanded.size} 个节点</dd>
          </dl>
          <button className="btn btn-ghost" onClick={reset} disabled={running}>
            重置
          </button>
        </section>

        <section className="block">
          <h2>操作日志</h2>
          <ul className="log">
            {log.length === 0 && <li className="log-empty">还没有操作记录</li>}
            {log.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>
      </aside>

      <main className="stage">
        <TopoGraph ref={graphRef} layout={layout} onNodeClick={handleNodeClick} />

        {(fullResult || lazyResult) && (
          <div className="compare">
            {fullResult && (
              <div className="compare-card full">
                <span className="tag">全量渲染（一次拉全量）</span>
                <strong>{fmtMs(fullResult.ms)}</strong>
                <small>
                  {fullResult.nodes} 节点 / {fullResult.edges} 边 · 数据 {fmtBytes(fullResult.bytes)}
                </small>
              </div>
            )}
            {lazyResult && (
              <div className="compare-card lazy">
                <span className="tag">懒加载首屏</span>
                <strong>{fmtMs(lazyResult.ms)}</strong>
                <small>
                  {lazyResult.nodes} 节点 · 首屏数据 {fmtBytes(lazyResult.bytes)}
                </small>
              </div>
            )}
            {ratio !== null && byteRatio !== null && (
              <div className="compare-card ratio">
                <span className="tag">同规模差距</span>
                <strong>{byteRatio.toFixed(0)}×</strong>
                <small>
                  首屏数据量小 {byteRatio.toFixed(0)} 倍，渲染快 {ratio.toFixed(0)} 倍
                </small>
              </div>
            )}
          </div>
        )}

        {running && <div className="running">渲染中…大规模型下会明显卡顿</div>}
      </main>
    </div>
  );
}
