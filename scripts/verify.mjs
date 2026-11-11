/**
 * 真机（本机 Chrome）验证脚本
 *
 * 用 puppeteer-core 驱动本机 chrome，跑完一次「全量渲染」与一次「分层懒加载」，
 * 读取页面上真实的 performance.now() 计时，并把截图落到 .verify-*.png。
 *
 * 用法：node scripts/verify.mjs [S|M|L]
 * 默认跑 M（1800 节点）。
 */
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
  console.error('没有找到可用的 Chrome/Edge');
  process.exit(1);
}

const scale = process.argv[2] || 'M';
const base = 'http://localhost:5180/';

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'],
});

async function runScenario(kind) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1680, height: 980 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });

  await page.goto(`${base}?scale=${scale}&autorun=${kind}`, { waitUntil: 'domcontentloaded' });

  const doneText = kind === 'full' ? '全量渲染完成' : '首屏完成';
  try {
    await page.waitForFunction(
      (kw) => Array.from(document.querySelectorAll('.log li')).some((li) => li.textContent?.includes(kw)),
      { timeout: 300000, polling: 500 },
      doneText,
    );
  } catch {
    console.error(`[${kind}] 等待完成超时`);
  }

  const data = await page.evaluate(() => {
    const logLines = Array.from(document.querySelectorAll('.log li')).map((li) => li.textContent || '');
    const dd = Array.from(document.querySelectorAll('.metrics dd')).map((el) => el.textContent || '');
    const cards = Array.from(document.querySelectorAll('.compare-card')).map((el) => ({
      tag: el.querySelector('.tag')?.textContent || '',
      value: el.querySelector('strong')?.textContent || '',
      note: el.querySelector('small')?.textContent || '',
    }));
    return { logLines, metrics: dd, cards };
  });

  await page.screenshot({ path: `.verify-${kind}.png`, fullPage: false });
  await page.close();
  return { kind, data, errors };
}

const results = [];
for (const kind of ['full', 'lazy']) {
  console.log(`\n=== 场景: ${kind} / scale=${scale} ===`);
  const r = await runScenario(kind);
  console.log('日志:', r.data.logLines.slice(0, 3));
  console.log('指标(可见节点/可见边/最近渲染/请求数/缓存/展开):', r.data.metrics);
  if (r.data.cards.length) console.log('结果卡:', r.data.cards);
  if (r.errors.length) console.log('页面错误:', r.errors.slice(0, 3));
  results.push(r);
}

await browser.close();

console.log('\n=== 汇总 ===');
for (const r of results) {
  const logs = r.data.logLines.filter((l) => l.includes('完成'));
  console.log(`${r.kind}: ${logs[0] || '无完成日志'}`);
}
