/**
 * Narrow-screen check: opens the built game at phone size (touch enabled),
 * walks title → new game → First Season → two panels, saves a screenshot of
 * each stage and reports page width (horizontal page scroll) and console errors.
 *
 *   npm run build && node scripts/phone-check.ts [dist | dist-single/fireweed-hosted.html] [outdir] [width] [height]
 *
 * Elements listed as "outside" are expected inside the swipeable lens bar and
 * dock (they scroll within their own row); the page itself must not be wider
 * than the viewport.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const target = process.argv[2] ?? 'dist';
const out = process.argv[3] ?? 'test-results/phone';
const width = Number(process.argv[4] ?? 400);
const height = Number(process.argv[5] ?? 860);
mkdirSync(out, { recursive: true });

const single = target.endsWith('.html');
let html = single ? readFileSync(target, 'utf8') : '';
if (single && !/<html[\s>]/i.test(html))
  html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body>${html}</body></html>`;
const server = createServer((req, res) => {
  if (single) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
    return;
  }
  let p = join(target, (req.url ?? '/').split('?')[0]);
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(target, 'index.html');
  res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' });
  res.end(readFileSync(p));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
let failures = 0;
async function stage(name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png` });
  const r = await page.evaluate(() => {
    const outside: string[] = [];
    for (const el of Array.from(document.querySelectorAll('#ui *'))) {
      const b = (el as HTMLElement).getBoundingClientRect();
      if (b.width > 0 && (b.right > innerWidth + 1 || b.left < -1)) outside.push(String((el as HTMLElement).className || el.tagName));
    }
    return { pageW: document.documentElement.scrollWidth, viewW: innerWidth, outside: outside.length };
  });
  const ok = r.pageW <= r.viewW;
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}: page ${r.pageW}px in a ${r.viewW}px viewport; ${r.outside} elements outside (scrolling rows)`);
}

try {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('.logo', { timeout: 60000 });
  await stage('1-title');
  await page.click('text=New valley');
  await page.waitForSelector('.scenarios');
  await stage('2-new-game');
  await page.click('.scenario:has-text("First Season")');
  await page.click('text=Begin tenure');
  await page.waitForFunction(() => (window as any).fireweed !== undefined, null, { timeout: 120000 });
  await page.waitForTimeout(2000);
  await stage('3-game');
  for (const label of ['Fires', 'Budget']) {
    await page.click(`.dock button:has-text("${label}")`);
    await stage(`4-${label.toLowerCase()}`);
    await page.click('.drawer .close');
  }
} catch (e) {
  failures++;
  console.log('✗ exception: ' + (e as Error).message.split('\n')[0]);
}
if (errors.length) failures++;
console.log(errors.length ? `✗ console errors: ${errors.slice(0, 3).join(' | ')}` : '✓ no console errors');
console.log(`screenshots in ${out}/`);
await browser.close();
server.close();
process.exit(failures ? 1 : 0);
