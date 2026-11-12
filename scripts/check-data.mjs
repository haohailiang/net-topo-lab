/**
 * 数据层自检：不依赖浏览器，直接用 vite 的 SSR 模块加载器跑一遍。
 *   node scripts/check-data.mjs
 */
import { createServer } from 'vite';

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

const gen = await server.ssrLoadModule('/src/data/generate.ts');
const srv = await server.ssrLoadModule('/src/data/server.ts');
const alarms = await server.ssrLoadModule('/src/data/alarms.ts');

const scale = 'M';

/* ---------------------------------------------------------- 第1层 */
const root = gen.buildLayer([], scale);
console.log('=== 第1层 · 主干链 ===');
console.log('标题:', root.title);
console.log('节点:', root.nodes.map((n) => n.name).join(' '));
console.log(
  '链路:',
  root.links.map((l) => `${l.label}${l.drillable ? '*' : ''}`).join(' '),
  `(共 ${root.links.length} 条, * = 可下钻)`,
);
console.log('域:', root.domains.map((d) => `${d.name}${d.drillable ? '*' : ''}(${d.members.length} 成员)`).join(' '));

/* ---------------------------------------------------------- 沿链路钻三层 */
console.log('\n=== 逐层下钻 ===');
let path = [];
let lvl = root;
for (let depth = 1; depth <= 3; depth++) {
  const seg = lvl.links.find((l) => l.drillable);
  if (!seg) break;
  path = [...path, { kind: 'link', id: seg.id, label: seg.label }];
  lvl = gen.buildLayer(path, scale);
  const entryNodes = lvl.nodes.filter((n) => n.entry).length;
  console.log(
    `第 ${lvl.layer} 层: ${lvl.nodes.length} 节点 / ${lvl.links.length} 链路 / ${lvl.domains.length} 域` +
      ` · 入口端点 ${entryNodes} 个 · 可下钻链路 ${lvl.links.filter((l) => l.drillable).length} 条` +
      ` — ${lvl.title}`,
  );
}

/* ---------------------------------------------------------- 第3层详情入口 */
const l3 = gen.buildLayer(path, scale);
console.log('\n=== 第3层详情入口 ===');
console.log('canEnterBoard:', l3.canEnterBoard, '(整层一个按钮，不是每网元一个)');

/* ---------------------------------------------------------- 第4层 */
console.log('\n=== 第4层 · 单板层 ===');
const detailId = `${gen.pathKey(l3.path)}#detail`;
const boardPath = [...path, { kind: 'detail', id: detailId, label: '整层全部单板' }];
const bd = gen.buildLayer(boardPath, scale);
console.log(`第 ${bd.layer} 层: ${bd.nodes.length} 单板 / ${bd.links.length} 连接 — ${bd.title}`);
console.log('单板总数 ≤1000 ?', bd.nodes.length <= 1000 ? '是' : '否');
console.log(
  '所属网元数:',
  new Set(bd.nodes.map((n) => n.ownerName)).size,
  '| 跨网元 CTP:',
  bd.links.filter((l) => l.ctpScope === 'cross').length,
  '| 网元内背板:',
  bd.links.filter((l) => l.ctpScope === 'inner').length,
);

/* ---------------------------------------------------------- 告警汇总对比 */
console.log('\n=== 告警汇总对比（第1层首节点，含整棵子树）===');
const core = root.nodes[0];
alarms.setQueryCost(15);
for (const mode of ['serial', 'parallel']) {
  const r = await srv.summarize([], core.id, 'node', scale, mode);
  const d = alarms.digestOf(r.alarms);
  console.log(
    `${mode.padEnd(9)} 耗时 ${Math.round(r.ms).toString().padStart(5)} ms · 子查询 ${String(r.queries).padStart(4)} 次` +
      ` · 告警 ${String(d.count).padStart(3)} 条 · 最高级别 ${d.topLevel} ${JSON.stringify(d.byKind)}`,
  );
}
alarms.setQueryCost(0);

/* ---------------------------------------------------------- 三种规模 */
console.log('\n=== 三种规模的第4层单板总数 ===');
for (const k of gen.SCALE_KEYS) {
  const r = gen.buildLayer([], k);
  const l1 = r.links.find((l) => l.drillable);
  const p = [{ kind: 'link', id: l1.id, label: l1.label }];
  const l2 = gen.buildLayer(p, k);
  const l2l = l2.links.find((x) => x.drillable);
  const p2 = [...p, { kind: 'link', id: l2l.id, label: l2l.label }];
  const lv3 = gen.buildLayer(p2, k);
  const bp = [...p2, { kind: 'detail', id: `${gen.pathKey(lv3.path)}#detail`, label: '整层全部单板' }];
  const b = gen.buildLayer(bp, k);
  console.log(`${k}: 第3层 ${lv3.nodes.length} 网元 -> 第4层 ${b.nodes.length} 单板 / ${b.links.length} 连接`);
}

await server.close();
