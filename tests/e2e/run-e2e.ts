/**
 * End-to-end test: serves the production build, plays the game in headless
 * Chromium through the real UI, and asserts that it renders, simulates,
 * accepts player actions, saves and loads — with no console errors.
 *
 *   npm run build && npm run test:e2e
 *   npm run test:e2e -- dist-single/fireweed-hosted.html   (the hosted variant)
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium } from 'playwright';

// A build directory (default dist/), or one HTML file such as
// dist-single/fireweed-hosted.html, which is served inside a minimal document
// like the one a host wraps around page content.
const target = process.argv[2] ?? 'dist';
const single = target.endsWith('.html');
const root = single ? '' : target;
if (!existsSync(single ? target : join(root, 'index.html'))) {
  console.error(`No build found at ${target} — run "npm run build" first.`);
  process.exit(2);
}
let page0 = single ? readFileSync(target, 'utf8') : '';
if (single && !/<html[\s>]/i.test(page0)) {
  page0 =
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}</style>' +
    `</head><body>${page0}</body></html>`;
}
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer((req, res) => {
  if (single) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page0);
    return;
  }
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
/** Mean brightness and distinct colours of a row of map pixels at the centre of the screen. */
const mapPixels = () =>
  page.evaluate(() => {
    const c = document.getElementById('map') as HTMLCanvasElement;
    const gl = c.getContext('webgl2')!;
    const buf = new Uint8Array(4 * 64);
    gl.readPixels(Math.floor(c.width / 2) - 32, Math.floor(c.height / 2), 64, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0;
    const distinct = new Set<number>();
    for (let k = 0; k < 64; k++) {
      sum += buf[k * 4] + buf[k * 4 + 1] + buf[k * 4 + 2];
      distinct.add((buf[k * 4] << 16) | (buf[k * 4 + 1] << 8) | buf[k * 4 + 2]);
    }
    return { mean: sum / 64 / 3, distinct: distinct.size };
  });
const openMenu = async () => {
  await page.click('.topbar .btn.ghost');
  await page.waitForSelector('.drawer .btn:has-text("Quit to title")');
};
/** Quit through the in-game menu; the title must be back within 15 s with no page errors (D21). */
const quitToTitle = async (label: string) => {
  const before = errors.length;
  await openMenu();
  const t0 = Date.now();
  await page.click('.drawer .btn:has-text("Quit to title")');
  const back = await page
    .waitForSelector('.logo', { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const gone = await page.evaluate(() => (window as any).fireweed === undefined);
  check(back && gone && errors.length === before, `${label}: title back in ${secs} s, no session left behind, no page errors${errors.length > before ? ': ' + errors.slice(before, before + 2).join(' | ') : ''}`);
};
/** Begin a non-tutorial valley of the default (medium) size from the title screen. */
const startMediumValley = async (seed: string) => {
  await page.click('text=New valley');
  await page.waitForSelector('.scenarios');
  await page.click('.scenario:has-text("The Tinderbox")');
  await page.fill('input[type="text"]', seed);
  await page.click('text=Begin tenure');
  await page.waitForFunction(() => (window as any).fireweed?.world?.W === 240, null, { timeout: 120000 });
};
/** Turn on the fuel hazard lens and let the game draw it for a moment. */
const hazardLens = async () => {
  if (await page.isVisible('.drawer')) await page.click('.drawer .close');
  await page.click('#lens-hazard');
  await page.evaluate(() => (window as any).fireweed.setSpeed(2));
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as any).fireweed.setSpeed(0));
  return page.evaluate(() => (window as any).fireweed.lens === 'hazard');
};

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
  const px = await mapPixels();
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
  const crews0 = st.crews;
  await page.click('.dock button:has-text("Crews")');
  await page.click('.drawer .btn:has-text("Hire") >> nth=0');
  st = await W();
  check(crews0 === 5 && st.crews === 6, 'hired a hand crew (' + crews0 + ' -> ' + st.crews + ')');
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
  for (const label of ['Fires', 'Charge', 'Council', 'Budget', 'Trends', 'Almanac', 'Field notes', 'Help']) {
    await page.click(`.dock button:has-text("${label}")`);
    await page.waitForTimeout(200);
    check(await page.isVisible('.drawer'), `${label} panel opens`);
    await page.click('.drawer .close');
  }

  console.log('Seeing fire coming (v2)');
  check((await page.$$('#forecast .fday')).length === 5, 'five-day forecast in the top bar');
  await page.click('.dock button:has-text("Charge")');
  check((await page.$$('.drawer .card')).length >= 3, 'the council\u2019s charge lists three objectives');
  await page.click('.drawer .close');
  for (const lens of ['fireshed', 'behaviour']) {
    await page.click('#lens-' + lens);
    await page.waitForTimeout(900);
    const painted = await page.evaluate(() => {
      const s = (window as any).fireweed;
      const buf = s.renderer.overlayData as Uint8Array;
      let n = 0;
      for (let i = 3; i < buf.length; i += 4) if (buf[i] > 0) n++;
      return n / (buf.length / 4);
    });
    check(painted > 0.02, lens + ' lens paints the valley (' + Math.round(painted * 100) + ' % of cells)');
  }
  await page.click('#lens-none');
  // run on to the first wildfire anyone reports, and look at its incident card
  const incident = await page.evaluate(() => {
    const s = (window as any).fireweed;
    const w = s.world;
    for (let t = 0; t < 8 * 360 * 5; t++) {
      if (w.review.pending) s.command({ t: 'closeReview' }, true);
      if (w.outcome.ended) break;
      s.sim.tick();
      const fe = w.fires.find((f: any) => f.active && f.detected && f.cause !== 'prescribed' && f.cause !== 'pile' && f.area >= 3);
      if (fe) {
        s.setSpeed(0);
        s.select({ type: 'fire', id: fe.id });
        return { name: fe.name as string, active: true, area: fe.area as number, year: w.year as number };
      }
    }
    return { name: '', active: false, area: 0, year: w.year as number };
  });
  if (incident && incident.name && incident.active) {
    await page.waitForTimeout(1200);
    check(await page.isVisible('#fire-projection'), 'incident card shows where the ' + incident.name + ' is headed');
    check(await page.isVisible('#call-aid'), 'an outside team can be called from the fire\u2019s card');
    const proj = await page.evaluate(() => {
      const s = (window as any).fireweed;
      return s.projection ? { horizon: s.projection.horizon, fire: s.projectionFire } : null;
    });
    check(proj !== null && proj.horizon === 48, 'a 48-hour spread projection is drawn for the selected fire');
    // the player's side of an incident, through the interface
    await page.click('.side .opt:has-text("Confine")');
    const resp = await page.evaluate(() => {
      const s = (window as any).fireweed;
      return s.world.fires.find((f: any) => f.id === s.selection?.id)?.response;
    });
    check(resp === 'contain', 'choosing Confine changes the fire’s response');
    await page.click('#call-aid');
    const aid = await page.evaluate(() => {
      const s = (window as any).fireweed;
      return s.world.aid.filter((t: any) => t.fireId === s.selection?.id && !t.released).length;
    });
    check(aid === 1, 'calling a team requests one for this fire');
    check(await page.isVisible('.side .btn:has-text("Send home")'), 'and the card offers to send it home');
    // cut a fireline with the tool: drag beside the fire and a hand crew takes the job
    const line = await page.evaluate(() => {
      const s = (window as any).fireweed;
      const w = s.world;
      const fe = w.fires.find((f: any) => f.id === s.selection?.id);
      const x = Math.min(w.W - 12, fe.maxX + 6),
        y = Math.max(8, Math.min(w.H - 8, Math.round((fe.minY + fe.maxY) / 2)));
      s.cam.centerOn(x + 0.5, y + 0.5, 12);
      s.cam.cx = s.cam.tcx;
      s.cam.cy = s.cam.tcy;
      s.cam.scale = s.cam.tscale;
      return { a: s.cam.worldToScreen(x + 0.5, y - 3.5), b: s.cam.worldToScreen(x + 0.5, y + 3.5) };
    });
    await page.keyboard.press('f');
    await page.mouse.move(line.a[0], line.a[1]);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(line.a[0] + ((line.b[0] - line.a[0]) * k) / 8, line.a[1] + ((line.b[1] - line.a[1]) * k) / 8);
    await page.mouse.up();
    await page.waitForTimeout(300);
    const lined = await page.evaluate(() => (window as any).fireweed.world.crews.filter((c: any) => c.task?.kind === 'line').length);
    check(lined >= 1, 'dragging the fireline tool sends a hand crew to cut the line');
    await page.keyboard.press('Escape');
  } else check(false, 'a wildfire was reported within five years (' + JSON.stringify(incident) + ')');
  await page.evaluate(() => (window as any).fireweed.select(null));

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
  await page.waitForSelector('.drawer :text("Saved.")', { timeout: 60000 });
  const savedDay = (await W()).day;
  await page.click('.drawer .btn:has-text("Quit to title")');
  await page.waitForSelector('.logo', { timeout: 60000 });
  await page.click('text=Continue');
  await page.waitForFunction(() => (window as any).fireweed?.world?.valleyName !== undefined, null, { timeout: 60000 });
  await page.waitForTimeout(800);
  const loaded = await W();
  check(Math.abs(loaded.day - savedDay) <= 1 && loaded.crews === 6, `saved game restored (day ${loaded.day}, ${loaded.crews} crews)`);

  // D21: v1.0 crashed (RangeError, UI gone for good) going back to the small title valley from a
  // medium game with a lens on, and loading a smaller save from inside a larger game is the same hazard
  console.log('Screen changes across valley sizes');
  await quitToTitle('small valley → title');
  await startMediumValley('e2e-medium-7');
  check(await hazardLens(), 'default-size (medium) valley begun, hazard lens on');
  await quitToTitle('medium valley with a lens → title');
  await startMediumValley('e2e-medium-8');
  await hazardLens();
  const beforeLoad = errors.length;
  await openMenu();
  const loadManual = '.drawer .row:has-text("manual") .btn:has-text("Load")';
  await page.waitForSelector(loadManual, { timeout: 20000 });
  await page.click(loadManual);
  await page.waitForFunction(() => (window as any).fireweed?.world?.W === 176, null, { timeout: 60000 });
  await page.waitForTimeout(1000);
  const small = await W();
  const px2 = await mapPixels();
  check(
    Math.abs(small.day - savedDay) <= 1 && px2.mean > 20 && px2.distinct > 8 && errors.length === beforeLoad,
    `small save loaded from inside a medium game and drawn (day ${small.day}, ${px2.distinct} colours)`,
  );
  check(await hazardLens(), 'lens works in the loaded small valley');
  await quitToTitle('loaded small valley with a lens → title');
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
