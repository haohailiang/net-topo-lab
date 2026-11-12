/**
 * 界面冒烟验证：打开页面 -> 等首屏渲染 -> 截图 -> 报页面错误。
 * 用法：node scripts/check-ui.mjs [输出文件名]
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
const out = process.argv[2] || '.verify-ui.png';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1680, height: 1080 });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

const base = process.env.BASE_URL || 'http://localhost:5180/';
await page.goto(base, { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 3000));

const info = await page.evaluate(() => ({
  views: document.querySelectorAll('.view').length,
  canvases: document.querySelectorAll('.topo-host canvas').length,
  titles: Array.from(document.querySelectorAll('.vt')).map((e) => e.textContent),
  stats: Array.from(document.querySelectorAll('.stat')).map((e) => e.textContent),
  logs: Array.from(document.querySelectorAll('.log li'))
    .map((e) => e.textContent)
    .slice(0, 6),
}));

await page.screenshot({ path: out, fullPage: false });
await browser.close();

console.log(JSON.stringify(info, null, 2));
if (errors.length) console.log('页面错误:', errors.slice(0, 6));
else console.log('无页面错误');
console.log('截图:', out);
