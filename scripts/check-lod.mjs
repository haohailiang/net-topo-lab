/** 验证第4层 LOD：全览只画点，滚轮放大后出单板编号与告警角标 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage();
await page.setViewport({ width: 1680, height: 1080 });
await page.goto('http://localhost:5180/', { waitUntil: 'networkidle2' });
await sleep(2500);

async function graphs() {
  return page.evaluate(() => (window.__topoGraphs || []).length);
}
async function waitG(n) {
  for (let i = 0; i < 200; i += 1) {
    if ((await graphs()) >= n) return true;
    await sleep(200);
  }
  return false;
}
async function point(vi) {
  return page.evaluate((index) => {
    const item = window.__topoGraphs[index];
    const link = item.topo.links.find((l) => l.drillable);
    if (!link) return null;
    const canvas = document.querySelectorAll('.view')[index].querySelector('canvas');
    const r = canvas.getBoundingClientRect();
    const a = item.positions[link.source];
    const b = item.positions[link.target];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const vp = item.graph.getViewportByCanvas([mid.x, mid.y]);
    return { x: r.left + vp[0], y: r.top + vp[1] };
  }, vi);
}

const p1 = await point(0);
await page.mouse.click(p1.x, p1.y);
await waitG(2);

const p2 = await point(1);
await page.mouse.click(p2.x, p2.y);
await waitG(3);

const cta = await page.evaluate(() => {
  const views = document.querySelectorAll('.view');
  const btn = views[views.length - 1].querySelector('.cta');
  btn.scrollIntoView({ block: 'center' });
  const r = btn.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.click(cta.x, cta.y);
await waitG(4);
await sleep(1200);

const before = await page.evaluate(() => {
  const views = document.querySelectorAll('.view');
  const last = views[views.length - 1];
  const canvas = last.querySelector('canvas');
  canvas.scrollIntoView({ block: 'center' });
  const r = canvas.getBoundingClientRect();
  return { lod: last.querySelector('.lod')?.textContent, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
});

// 在第4层画布中心向下滚轮放大
await page.mouse.move(before.cx, before.cy);
for (let i = 0; i < 4; i += 1) {
  await page.mouse.wheel({ deltaY: -420 });
  await sleep(320);
}
await sleep(900);

const after = await page.evaluate(() => {
  const views = document.querySelectorAll('.view');
  const last = views[views.length - 1];
  const g = window.__topoGraphs[window.__topoGraphs.length - 1].graph;
  return { lod: last.querySelector('.lod')?.textContent, zoom: g.getZoom().toFixed(2) };
});

await page.screenshot({ path: '.verify-lod-zoom.png' });
await browser.close();
console.log(JSON.stringify({ before, after }, null, 2));
