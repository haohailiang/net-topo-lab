/**
 * 交互验证：点节点下钻 + 切布局，确认 Vue 版的组件通信链路真的通了。
 * 用法：node scripts/check-interaction.mjs
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
const base = process.env.BASE_URL || 'http://localhost:5180/';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1680, height: 980 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(`${base}?scale=M`, { waitUntil: 'networkidle0' });
await page.waitForFunction(
  () => Array.from(document.querySelectorAll('.log li')).some((li) => li.textContent?.includes('首屏完成')),
  { timeout: 60000 },
);

const readState = () =>
  page.evaluate(() => {
    const dd = Array.from(document.querySelectorAll('.metrics dd')).map((el) => el.textContent?.trim() || '');
    const logs = Array.from(document.querySelectorAll('.log li')).map((li) => li.textContent || '');
    return { nodes: dd[0], edges: dd[1], requests: dd[3], cacheHits: dd[4], expanded: dd[5], logs: logs.slice(0, 2) };
  });

console.log('首屏状态:', await readState());

// 点汇聚层节点触发下钻。节点在画布上的精确位置随布局变化，
// 这里沿汇聚层所在的一行横向扫描，命中任意一个即可。
async function logTexts() {
  return page.evaluate(() => Array.from(document.querySelectorAll('.log li')).map((li) => li.textContent || ''));
}

let hit = null;
const rowY = [528, 520, 536, 512];
for (const y of rowY) {
  for (let x = 780; x <= 1040; x += 20) {
    await page.mouse.click(x, y);
    await new Promise((r) => setTimeout(r, 320));
    const logs = await logTexts();
    if (logs.some((l) => l.includes('下钻'))) {
      hit = [x, y];
      break;
    }
  }
  if (hit) break;
}
if (hit) console.log('下钻命中坐标:', hit);
else console.error('下钻未触发：扫描整行都没命中任何节点');
console.log('下钻后状态:', await readState());

// 切布局：验证 props watch -> setOptions 这条链路
const clickedLayout = await page.evaluate(() => {
  const chip = Array.from(document.querySelectorAll('button.chip')).find((b) =>
    (b.textContent || '').includes('力导向'),
  );
  if (chip) {
    chip.click();
    return true;
  }
  return false;
});
console.log('切换布局点到:', clickedLayout);

await new Promise((r) => setTimeout(r, 1200));
console.log('切布局后日志:', (await readState()).logs[0]);

await page.screenshot({ path: '.verify-interaction.png' });
await browser.close();

if (errors.length) console.log('页面错误:', errors.slice(0, 3));
else console.log('无页面错误');
