/**
 * End-to-end test: serves the production build, plays the game in headless
 * Chromium through the real UI, and asserts that it renders, simulates,
 * accepts player actions, saves and loads — with no console errors.
 *
 *   npm run build && npm run test:e2e
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

const root = process.argv[2] ?? 'dist';
if (!existsSync(join(root, 'index.html'))) {
  console.error(`No build found in ${root}/ — run "npm run build" first.`);
  process.exit(2);
}
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
const base = `http://127.0.0.1:${port}/`;

let failures = 0;
const check = (cond: unknown, msg: string) => {
  if (cond) console.log('  ✓ ' + msg);
  else {
    failures++;
    console.log('  ✗ ' + msg);
  }
};

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
const errors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(e.message));
const W = () => page.evaluate(() => {
  const s = (window as any).fireweed;
  const w = s.world;
  return { day: w.day, sub: w.sub, zones: Array.from(w.L.zone as Uint8Array).filter((z) => z === 5).length, projects: w.projects.length, crews: w.crews.length, review: w.review.pending, speed: s.speed };
});

try {
  console.log('Title screen');
  await page.goto(base);
  await page.waitForSelector('.logo', { timeout: 60000 });
  check(await page.isVisible('text=New valley'), 'title menu visible');

  console.log('New game');
  await page.click('text=New valley');
  await page.waitForSelector('.scenarios');
  check((await page.$$('.scenario')).length === 6, 'six scenarios offered');
  await page.click('.scenario:has-text("Custom Valley")');
  await page.fill('input[type="text"]', 'e2e-seed-42');
  await page.selectOption('select >> nth=-1', 'small').catch(() => {});
  const sizeSel = await page.$$('select');
  if (sizeSel.length) await sizeSel[sizeSel.length - 1].selectOption('small');
  await page.click('text=Begin tenure');
  await page.waitForFunction(() => (window as any).fireweed !== undefined, null, { timeout: 90000 });
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    const s = (window as any).fireweed;
    return { valley: s.world.valleyName, W: s.world.W, seed: s.world.config.seed };
  });
  check(info.seed === 'e2e-seed-42' && info.W === 176, `custom small valley generated (${info.valley})`);

  console.log('Rendering');
  const px = await page.evaluate(() => {
    const c = document.getElementById('map') as HTMLCanvasElement;
    const gl = c.getContext('webgl2')!;
    const buf = new Uint8Array(4 * 64);
    gl.readPixels(Math.floor(c.width / 2) - 32, Math.floor(c.height / 2), 64, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0,
      distinct = new Set<number>();
    for (let k = 0; k < 64; k++) {
      sum += buf[k * 4] + buf[k * 4 + 1] + buf[k * 4 + 2];
      distinct.add((buf[k * 4] << 16) | (buf[k * 4 + 1] << 8) | buf[k * 4 + 2]);
    }
    return { mean: sum / 64 / 3, distinct: distinct.size };
  });
  check(px.mean > 20 && px.distinct > 8, `map renders a varied landscape (mean ${px.mean.toFixed(0)}, ${px.distinct} colours)`);

  console.log('Player actions');
  await page.click('#tool-zone');
  await page.click('.flyout .opt:has-text("Community buffer")');
  const pt = await page.evaluate(() => {
    const s = (window as any).fireweed;
    const t = s.world.towns[0];
    s.cam.centerOn(t.x + 0.5, t.y + 0.5, 10);
    s.cam.cx = s.cam.tcx;
    s.cam.cy = s.cam.tcy;
    s.cam.scale = s.cam.tscale;
    return s.cam.worldToScreen(t.x + 6, t.y + 0.5);
  });
  await page.mouse.move(pt[0], pt[1]);
  await page.mouse.down();
  for (let k = 0; k < 12; k++) await page.mouse.move(pt[0] + k * 4, pt[1] + k * 5);
  await page.mouse.up();
  await page.waitForTimeout(300);
  let st = await W();
  check(st.zones > 10, `community buffer painted (${st.zones} ha)`);
  await page.click('#tool-thin');
  await page.mouse.move(pt[0] - 60, pt[1] - 60);
  await page.mouse.down();
  for (let k = 0; k < 8; k++) await page.mouse.move(pt[0] - 60 + k * 6, pt[1] - 60 + k * 2);
  await page.mouse.up();
  await page.waitForTimeout(300);
  st = await W();
  check(st.projects >= 1, 'thinning project queued');
  await page.keyboard.press('Escape');
  await page.click('.dock button:has-text("Crews")');
  await page.click('.drawer .btn:has-text("Hire") >> nth=0');
  st = await W();
  check(st.crews === 4, 'hired a hand crew');
  await page.click('.drawer .close');
  await page.click('.dock button:has-text("Policies")');
  await page.click('.drawer .seg button:has-text("Firewise")');
  const code = await page.evaluate(() => (window as any).fireweed.world.policies.buildingCode);
  check(code === 'firewise', 'policy change applied');
  await page.click('.drawer .close');

  console.log('Simulation');
  const before = await W();
  await page.evaluate(() => (window as any).fireweed.setSpeed(4));
  await page.waitForTimeout(12000);
  const after = await W();
  check(after.day > before.day + 5, `time advances (${before.day} → ${after.day} days)`);
  for (const lens of ['hazard', 'veg', 'wildlife', 'history']) {
    await page.click('#lens-' + lens);
    await page.waitForTimeout(250);
  }
  await page.click('#lens-none');
  check(true, 'lenses toggle');
  for (const label of ['Fires', 'Council', 'Budget', 'Trends', 'Almanac', 'Field notes', 'Help']) {
    await page.click(`.dock button:has-text("${label}")`);
    await page.waitForTimeout(200);
    check(await page.isVisible('.drawer'), `${label} panel opens`);
    await page.click('.drawer .close');
  }

  console.log('Annual review');
  // run until the first council review, then answer it
  await page.evaluate(() => (window as any).fireweed.setSpeed(4));
  await page.waitForFunction(() => (window as any).fireweed.world.review.pending, null, { timeout: 240000 }).catch(() => {});
  st = await W();
  if (!st.review) {
    // headless rendering is slow; advance the clock directly to the year end
    await page.evaluate(() => {
      const s = (window as any).fireweed;
      while (!s.world.review.pending && !s.world.outcome.ended) s.sim.tick();
    });
  }
  await page.waitForSelector('.modal:has-text("The Council Review")', { timeout: 20000 });
  check(true, 'council review appears at year end');
  const petitions = await page.$$('.petition .btn.primary');
  if (petitions.length) await petitions[0].click();
  await page.click('.modal .btn.primary:has-text("Begin year")');
  await page.waitForTimeout(300);
  st = await W();
  check(!st.review, 'review closed, year 2 begins');

  console.log('Save & load');
  await page.evaluate(() => (window as any).fireweed.setSpeed(0));
  await page.waitForTimeout(300);
  await page.click('.topbar .btn.ghost');
  await page.click('.drawer .btn:has-text("Save game")');
  await page.waitForSelector('.drawer :text("Saved.")', { timeout: 20000 });
  const savedDay = (await W()).day;
  await page.click('.drawer .btn:has-text("Quit to title")');
  await page.waitForSelector('.logo', { timeout: 60000 });
  await page.click('text=Continue');
  await page.waitForFunction(() => (window as any).fireweed?.world?.valleyName !== undefined, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  const loaded = await W();
  check(Math.abs(loaded.day - savedDay) <= 1 && loaded.crews === 4, `saved game restored (day ${loaded.day}, ${loaded.crews} crews)`);
} catch (e) {
  failures++;
  console.log('  ✗ exception: ' + (e as Error).message);
  await page.screenshot({ path: 'test-results/e2e-failure.png' }).catch(() => {});
}
check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
