/**
 * 截图脚本：打开页面 -> 点「一键对比」-> 等倍数卡片出现 -> 截图
 * 用法：node scripts/snapshot.mjs [S|M|L] [输出文件名]
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
const scale = process.argv[2] || 'M';
const out = process.argv[3] || `.verify-compare-${scale}.png`;

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1680, height: 980 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

const base = process.env.BASE_URL || 'http://localhost:5180/';
await page.goto(`${base}?scale=${scale}`, { waitUntil: 'networkidle0' });

// 等首屏自动懒加载完成，避免和一键对比抢着跑
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.log li')).some((li) => li.textContent?.includes('首屏完成')),
  { timeout: 60000 },
);

await page.click('.btn-compare');

await page.waitForFunction(() => !!document.querySelector('.compare-card.ratio'), { timeout: 180000 });

const cards = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.compare-card')).map((el) => ({
    tag: el.querySelector('.tag')?.textContent || '',
    value: el.querySelector('strong')?.textContent || '',
    note: el.querySelector('small')?.textContent || '',
  })),
);

await page.screenshot({ path: out });
await browser.close();

console.log('结果卡:', cards);
if (errors.length) console.log('页面错误:', errors.slice(0, 3));
console.log('截图:', out);
