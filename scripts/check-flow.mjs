/**
 * 全链路交互验证：点链路 -> 第2层 -> 第3层 -> 点「详情」 -> 第4层单板层。
 * 用法：node scripts/check-flow.mjs
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1680, height: 1080 });
const errors = [];
const allLogs = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  allLogs.push(`${m.type()}: ${m.text()}`);
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

await page.goto(process.env.BASE_URL || 'http://localhost:5180/', { waitUntil: 'networkidle2' });
await sleep(2600);

/** 把某个 view 里第一条可下钻链路的中心换算成页面坐标 */
async function linkPoint(vi) {
  return page.evaluate((index) => {
    const item = (window.__topoGraphs || [])[index];
    if (!item) {
      const ids = (window.__topoGraphs || []).map((x) => `${x.id}@L${x.topo.layer}`);
      return { err: `no-item len=${ids.length} [${ids.join(', ')}]` };
    }
    const link = item.topo.links.find((l) => l.drillable);
    if (!link) return { err: `no-link layer=${item.topo.layer} n=${item.topo.links.length}` };
    const canvas = document.querySelectorAll('.view')[index]?.querySelector('canvas');
    if (!canvas) return { err: `no-canvas views=${document.querySelectorAll('.view').length}` };
    const rect = canvas.getBoundingClientRect();

    // 取两端节点坐标的中点，比查元素位置更稳
    const a = item.positions[link.source];
    const b = item.positions[link.target];
    if (!a || !b) return { err: `no-pos ${link.source}=${!!a} ${link.target}=${!!b}` };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    // getViewportByCanvas 只接受数组形式，传 {x,y} 会返回 null
    let vp = null;
    try {
      vp = item.graph.getViewportByCanvas([mid.x, mid.y]);
    } catch {
      vp = null;
    }
    const zoom = item.graph.getZoom();
    const ok = vp && Number.isFinite(vp[0]);
    const vx = ok ? vp[0] : (mid.x - rect.width / 2) * zoom + rect.width / 2;
    const vy = ok ? vp[1] : (mid.y - rect.height / 2) * zoom + rect.height / 2;

    return {
      x: rect.left + vx,
      y: rect.top + vy,
      id: link.id,
      label: link.label,
      mid,
      dbg: `vp=${ok ? 'ok' : 'fallback'} zoom=${zoom.toFixed(3)}`,
      rect: { l: rect.left, t: rect.top, w: rect.width, h: rect.height },
    };
  }, vi);
}

const steps = [];

async function countViews() {
  return page.evaluate(() => document.querySelectorAll('.view').length);
}

/** .view 出现 ≠ 画布画完，还要等对应的图实例挂进调试出口 */
async function countGraphs() {
  return page.evaluate(() => (window.__topoGraphs || []).length);
}

async function waitViews(n, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await countViews()) >= n && (await countGraphs()) >= n) return true;
    await sleep(200);
  }
  return false;
}

/* 第1层 -> 第2层 */
const p1 = await linkPoint(0);
steps.push(`第1层点击 ${p1?.label ?? p1?.err} @${Math.round(p1?.x ?? -1)},${Math.round(p1?.y ?? -1)} mid=${JSON.stringify(p1?.mid)} ${p1?.dbg ?? ''}`);
if (p1 && Number.isFinite(p1.x)) await page.mouse.click(p1.x, p1.y);
const ok2 = await waitViews(2);
await sleep(600);
steps.push(`-> 层数 ${await countViews()} ${ok2 ? 'OK' : '超时'}`);

/* 第2层 -> 第3层 */
await page.evaluate(() => window.scrollTo(0, 0));
const p2 = await linkPoint(1);
steps.push(`第2层点击 ${p2?.label ?? p2?.err} @${Math.round(p2?.x ?? -1)},${Math.round(p2?.y ?? -1)} ${p2?.dbg ?? ''}`);
if (p2 && Number.isFinite(p2.x)) await page.mouse.click(p2.x, p2.y);
const ok3 = await waitViews(3);
await sleep(600);
steps.push(`-> 层数 ${await countViews()} ${ok3 ? 'OK' : '超时'}`);

/* 第3层 -> 详情按钮 -> 第4层 */
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await sleep(300);
const ctaBox = await page.evaluate(() => {
  // 详情按钮只在第3层有，取最后一层的那个
  const views = document.querySelectorAll('.view');
  const last = views[views.length - 1];
  const btn = last?.querySelector('.cta');
  if (!btn) return null;
  btn.scrollIntoView({ block: 'center' });
  const r = btn.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
steps.push(ctaBox ? `点击详情按钮 @${Math.round(ctaBox.x)},${Math.round(ctaBox.y)}` : '未找到详情按钮');
if (ctaBox) await page.mouse.click(ctaBox.x, ctaBox.y);

const ok4 = await waitViews(4, 60000);
await sleep(1500);
steps.push(`-> 层数 ${await countViews()} ${ok4 ? 'OK' : '超时'}`);

const summary = await page.evaluate(() => {
  const views = Array.from(document.querySelectorAll('.view'));
  return views.map((v) => ({
    title: v.querySelector('.vt')?.textContent || '',
    stat: v.querySelector('.stat')?.textContent || '',
    crumbs: v.querySelector('.crumbs')?.textContent || '',
  }));
});

await page.screenshot({ path: '.verify-flow-all.png', fullPage: true });
await browser.close();

console.log(steps.join('\n'));
console.log('\n各层:');
console.log(JSON.stringify(summary, null, 2));
console.log('\n控制台:');
console.log(allLogs.filter((l) => l.includes('[topo]') || l.includes('view')).join('\n') || '(无 topo 打点)');
if (errors.length) console.log('\n错误:', errors.slice(0, 6));
else console.log('\n无页面错误');
