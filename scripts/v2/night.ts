/**
 * Screenshot a fire by day and by night (checks the night shading and the fire's glow).
 *   npm run build && node scripts/v2/night.ts <outdir>
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const out = process.argv[2] ?? '/tmp/shots';
mkdirSync(out, { recursive: true });
const root = new URL('../../dist', import.meta.url).pathname;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let p = join(root, url === '/' ? 'index.html' : url);
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(root, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
  res.end(readFileSync(p));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1 });
const errors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto('http://127.0.0.1:' + port + '/');
await page.waitForSelector('.logo', { timeout: 60000 });
await page.click('text=New valley');
await page.waitForSelector('.scenarios');
await page.click('.scenario:has-text("The Tinderbox")');
await page.fill('input[type="text"]', 'look-1');
await page.click('text=Begin tenure');
await page.waitForFunction(() => (window as any).fireweed?.world !== undefined, null, { timeout: 120000 });
await page.waitForTimeout(1000);
const found = await page.evaluate(() => {
  const s = (window as any).fireweed;
  const w = s.world;
  for (let t = 0; t < 8 * 360 * 6; t++) {
    if (w.review.pending) s.command({ t: 'closeReview' }, true);
    s.sim.tick();
    const fe = w.fires.find((f: any) => f.active && f.detected && f.area >= 40 && f.cause !== 'prescribed');
    if (fe && w.sub === 5) {
      s.focus((fe.minX + fe.maxX) / 2, (fe.minY + fe.maxY) / 2, 8);
      return fe.name;
    }
  }
  return null;
});
console.log('fire', found);
await page.waitForTimeout(2500);
await page.screenshot({ path: join(out, 'day.png') });
await page.evaluate(() => {
  const s = (window as any).fireweed;
  while (s.world.sub !== 0) s.sim.tick();
});
await page.waitForTimeout(3000);
await page.screenshot({ path: join(out, 'night.png') });
console.log('night level', await page.evaluate(() => (window as any).fireweed.nightShown));
console.log('errors:', errors.length ? errors.slice(0, 6).join(' | ') : 'none');
await browser.close();
server.close();
