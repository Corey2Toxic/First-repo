/**
 * Look at the game: serve dist/, start a valley, run to an escaped fire and screenshot the interface.
 *   npm run build && node scripts/v2/look.ts <outdir> [scenario title] [seed]
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const out = process.argv[2] ?? '/tmp/shots';
const scenario = process.argv[3] ?? 'The Tinderbox';
const seed = process.argv[4] ?? 'look-1';
mkdirSync(out, { recursive: true });
const root = new URL('../../dist', import.meta.url).pathname;
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const shot = async (name: string) => {
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(out, name + '.png') });
  console.log('shot', name);
};
try {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('.logo', { timeout: 60000 });
  await shot('00-title');
  await page.click('text=New valley');
  await page.waitForSelector('.scenarios');
  await page.click(`.scenario:has-text("${scenario}")`);
  await page.fill('input[type="text"]', seed);
  await shot('01-new');
  await page.click('text=Begin tenure');
  await page.waitForFunction(() => (window as any).fireweed?.world !== undefined, null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  // skip the tutorial if there is one
  if (await page.isVisible('text=Skip tutorial')) await page.click('text=Skip tutorial');
  await shot('02-start');
  // run headless to the first escaped fire
  const found = await page.evaluate(() => {
    const s = (window as any).fireweed;
    const w = s.world;
    for (let t = 0; t < 8 * 360 * 6; t++) {
      if (w.review.pending) s.command({ t: 'closeReview' }, true);
      s.sim.tick();
      const fe = w.fires.find((f: any) => f.active && f.detected && (f.stage ?? 0) >= 1 && f.area >= 60 && f.cause !== 'prescribed');
      if (fe && w.sub === 4) {
        s.select({ type: 'fire', id: fe.id });
        s.focus((fe.minX + fe.maxX) / 2, (fe.minY + fe.maxY) / 2, 7);
        return { name: fe.name, area: fe.area, day: w.day, year: w.year };
      }
    }
    return null;
  });
  console.log('escaped fire', JSON.stringify(found));
  await page.waitForTimeout(1500);
  await shot('03-incident');
  await page.click('.dock button:has-text("Fires")');
  await shot('04-fires-panel');
  await page.click('.drawer .close');
  await page.click('.dock button:has-text("Charge")');
  await shot('05-charge');
  await page.click('.drawer .close');
  await page.evaluate(() => (window as any).fireweed.select(null));
  await page.click('#lens-fireshed');
  await page.evaluate(() => {
    const s = (window as any).fireweed;
    s.cam.fit();
  });
  await page.waitForTimeout(1200);
  await shot('06-fireshed');
  await page.click('#lens-behaviour');
  await page.waitForTimeout(1200);
  await shot('07-behaviour');
  await page.click('#lens-none');
  // let the fire run its course, then look at the report
  const rep = await page.evaluate(() => {
    const s = (window as any).fireweed;
    const w = s.world;
    const n0 = w.reports.length;
    for (let t = 0; t < 8 * 60 && w.reports.filter((r: any) => r.area >= 60).length === w.reports.slice(0, n0).filter((r: any) => r.area >= 60).length; t++) {
      if (w.review.pending) s.command({ t: 'closeReview' }, true);
      s.sim.tick();
    }
    return w.reports.slice(-3);
  });
  console.log('reports', JSON.stringify(rep, null, 1).slice(0, 3000));
  await page.click('.dock button:has-text("Fires")');
  await page.waitForTimeout(400);
  const cards = await page.$$('.drawer .card');
  if (cards.length) await cards[cards.length > 1 ? 0 : 0].click().catch(() => {});
  await shot('08-reports');
  const notes = await page.evaluate(() => (window as any).fireweed.world.notifications.slice(-14).map((n: any) => `[${n.level}${n.stop ? ' stop' + n.stop : ''}] ${n.text}`));
  console.log(notes.join('\n'));
} catch (e) {
  console.log('FAILED', (e as Error).message);
  await page.screenshot({ path: join(out, 'zz-failure.png') }).catch(() => {});
}
console.log('errors:', errors.length ? errors.slice(0, 8).join(' | ') : 'none');
await browser.close();
server.close();
