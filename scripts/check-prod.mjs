/** 生产包诊断：抓控制台/页面错误，统计画布元素 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--proxy-server=http://127.0.0.1:7897'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1383, height: 900 });

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`));

await page.goto(process.argv[2] || 'http://127.0.0.1:4173/', { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise((r) => setTimeout(r, 4000));

console.log('--- logs ---');
console.log(logs.slice(0, 20).join('\n') || '(none)');

const info = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const svgAll = document.querySelectorAll('svg').length;
  const views = document.querySelectorAll('.view').length;
  const g6 = document.querySelectorAll('[class*="g6"]').length;
  return {
    canvas: canvas ? `${canvas.width}x${canvas.height}` : null,
    svgCount: svgAll,
    viewCount: views,
    g6Nodes: g6,
    storeExists: !!window.__topoGraphs,
    storeLen: (window.__topoGraphs || []).length,
  };
});
console.log('--- dom ---');
console.log(JSON.stringify(info, null, 2));

await page.screenshot({ path: '.verify-prod.png' });
await browser.close();
