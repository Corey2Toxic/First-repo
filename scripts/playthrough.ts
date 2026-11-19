/**
 * Scripted playthrough in headless Chromium for visual/functional checks:
 *   node scripts/playthrough.ts <baseUrl> <outDir>
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:5173/';
const out = process.argv[3] ?? 'tmp-shots';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
const shot = async (name: string) => {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log('shot', name);
};

await page.goto(base);
await page.waitForSelector('.logo', { timeout: 60000 });
await page.waitForTimeout(1200);
await shot('01-title');
await page.click('text=New valley');
await page.waitForSelector('.scenarios');
await page.waitForTimeout(400);
await shot('02-newgame');
await page.click('text=Begin tenure');
await page.waitForFunction(() => (window as any).fireweed !== undefined, null, { timeout: 90000 });
await page.waitForTimeout(1500);
await shot('03-game-start');
// tutorial: acknowledge the welcome card and the camera step
for (let k = 0; k < 2; k++) {
  const btn = await page.$('.advisor .btn.primary');
  if (btn) await btn.click();
  await page.waitForTimeout(300);
}
await page.click('#lens-hazard');
await page.waitForTimeout(1500);
await shot('04-hazard-lens');
await page.click('#lens-none');
// zoom into the main town
await page.evaluate(() => {
  const s = (window as any).fireweed;
  const t = s.world.towns[0];
  s.cam.centerOn(t.x + 0.5, t.y + 0.5, 14);
  s.cam.cx = s.cam.tcx;
  s.cam.cy = s.cam.tcy;
  s.cam.scale = s.cam.tscale;
});
await page.waitForTimeout(1200);
await shot('05-town-zoom');
// paint a community buffer with the zone tool
await page.click('#tool-zone');
await page.waitForTimeout(200);
const box = await page.evaluate(() => {
  const s = (window as any).fireweed;
  const t = s.world.towns[0];
  return s.cam.worldToScreen(t.x + 8, t.y + 0.5);
});
await page.mouse.move(box[0], box[1]);
await page.mouse.down();
for (let k = 0; k < 20; k++) await page.mouse.move(box[0] + Math.sin(k / 3) * 80, box[1] + k * 6);
await page.mouse.up();
await page.waitForTimeout(500);
await shot('06-zone-painted');
// queue a prescribed burn nearby
await page.click('#tool-burn');
await page.mouse.move(box[0] - 120, box[1] - 60);
await page.mouse.down();
for (let k = 0; k < 15; k++) await page.mouse.move(box[0] - 120 + k * 6, box[1] - 60 + k * 3);
await page.mouse.up();
await page.waitForTimeout(400);
await shot('07-burn-queued');
await page.keyboard.press('Escape');
await page.keyboard.press('Escape');
// run time fast for a while
await page.evaluate(() => {
  const s = (window as any).fireweed;
  s.cam.fit();
  s.setSpeed(4);
});
const t0 = Date.now();
while (Date.now() - t0 < 45000) {
  await page.waitForTimeout(2000);
  const st = await page.evaluate(() => {
    const s = (window as any).fireweed;
    return { day: s.world.day, review: s.world.review.pending, fires: s.world.fires.filter((f: any) => f.active && f.detected).length, card: !!s.advisor.card };
  });
  if (st.review) break;
  if (st.card) {
    const btn = await page.$('.advisor .btn.primary');
    // (software WebGL at top speed renders ~2 fps; a slow click is retried on the next pass)
    if (btn) await btn.click({ timeout: 8000 }).catch(() => {});
  }
  // keep speed up even if a fire slowed things down
  await page.evaluate(() => (window as any).fireweed.setSpeed(4));
}
await shot('08-after-running');
const info = await page.evaluate(() => {
  const s = (window as any).fireweed;
  const w = s.world;
  return { day: w.day, year: w.year, fires: w.fires.length, burned: w.counters.yearBurned, funds: Math.round(w.economy.funds), review: w.review.pending, notes: Object.keys(w.discoveries).length, tps: Math.round(s.ticksPerSec), fps: Math.round(s.fps) };
});
console.log(JSON.stringify(info));
// the year-end council review blocks the map until it is answered: answer it as a player would
await page.waitForTimeout(1500);
if (await page.$('.modal-back')) {
  await shot('09-council-review');
  const grant = await page.$('.petition .btn.primary');
  if (grant) {
    await grant.click();
    await page.waitForTimeout(400);
  }
  const close = await page.$('.modal .btn.primary:has-text("Begin year")');
  if (close) {
    await close.click();
    await page.waitForTimeout(800);
  }
}
// open a few panels (paused: under software WebGL at top speed the page runs at ~2 fps, too slow for
// the browser driver's click checks)
await page.evaluate(() => (window as any).fireweed.setSpeed(0));
await page.waitForTimeout(1000);
for (const label of ['Council', 'Trends', 'Field notes', 'Policies']) {
  const b = await page.$(`.dock button:has-text("${label}")`);
  if (!b) continue;
  const isOpen = () => b.evaluate((el) => el.classList.contains('on'));
  try {
    await b.click({ timeout: 5000 });
  } catch {
    // on a ~2 fps software renderer the click often lands while the driver's checks time out
    if (!(await isOpen())) {
      // something may be open over the dock (a field-note card, a drawer): close it as a player would
      await page.keyboard.press('Escape');
      for (const x of await page.$$('.modal .btn:has-text("Close"), .modal .btn:has-text("Got it")')) await x.click().catch(() => {});
      await page.waitForTimeout(400);
      await b.click({ timeout: 5000 }).catch(() => {});
    }
    if (!(await isOpen())) {
      const over = await page.evaluate((l) => {
        const btn = [...document.querySelectorAll('.dock button')].find((x) => x.textContent?.includes(l));
        if (!btn) return 'no button';
        const r = btn.getBoundingClientRect();
        const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) as HTMLElement | null;
        return `${el?.tagName}.${el?.className} "${(el?.textContent ?? '').slice(0, 80)}"`;
      }, label);
      console.log('could not open panel', label, '- covered by', over);
      await shot('10-blocked-' + label.replace(/\s+/g, '-').toLowerCase());
      continue;
    }
  }
  await page.waitForTimeout(500);
  await shot('10-panel-' + label.replace(/\s+/g, '-').toLowerCase());
}
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
