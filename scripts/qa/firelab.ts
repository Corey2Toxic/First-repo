/**
 * Fire lab: rate of spread on synthetic uniform landscapes with frozen weather.
 *
 *   node scripts/qa/firelab.ts [simRoot]
 *
 * Fuel beds (1-ha cells): cured grass; open pine with long-needle litter; dense young fir with
 * ladder fuel; shrubland. Fires burn one 3-hour step at 15:00 (peak afternoon) with fine dead fuel
 * moisture 6 %; head, flank and back distances are the mean over 16 replicate fires. A grid of
 * 700 x 241 cells (70 km) with ignition 20 cells from the upwind edge keeps fast runs on the map.
 * Run against both versions to compare (simRoot defaults to this checkout's src/sim).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const rootArg = process.argv[2];
const root = resolve(rootArg && rootArg !== '-' ? rootArg : new URL('../../src/sim', import.meta.url).pathname);
const imp = (p: string) => import(pathToFileURL(`${root}/${p}`).href);
const { World } = await imp('world.ts');
const { makeConfig } = await imp('scenarios.ts');
const { startFire, fireSubstep } = await imp('systems/fire.ts');

type Fuel = 'grass' | 'pine' | 'fir' | 'shrub';
function lab(W: number, H: number, fuel: Fuel, seed: string, fm = 0.06) {
  const w = new World({ ...makeConfig('custom', seed), width: W, height: H });
  const L = w.L;
  for (let i = 0; i < w.N; i++) {
    L.elev[i] = 1500;
    L.flowAcc[i] = 1;
    L.flowTo[i] = -1;
    L.soil[i] = 0.6;
    L.sm[i] = 0.25;
    L.fm[i] = fm;
    L.dead[i] = 5;
    if (fuel === 'grass') {
      L.grass[i] = 0.85;
      L.litter[i] = 0.4;
      L.shrub[i] = 0.03;
    } else if (fuel === 'pine') {
      L.grass[i] = 0.25;
      L.pine[i] = 0.55;
      L.ageP[i] = 120;
      L.litter[i] = 8;
      L.shrub[i] = 0.1;
    } else if (fuel === 'fir') {
      L.grass[i] = 0.1;
      L.fir[i] = 0.7;
      L.ageF[i] = 35;
      L.litter[i] = 14;
      L.shrub[i] = 0.35;
      L.dead[i] = 20;
    } else {
      L.grass[i] = 0.2;
      L.shrub[i] = 0.8;
      L.litter[i] = 2;
    }
  }
  w.day = 150; // midsummer: grass cured
  w.sub = 4;
  w.weather.rh = 0.2;
  w.weather.temp = 26;
  w.climate.droughtIndex = 0.6;
  return w;
}
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const W = 700,
  H = 241,
  CX = 20,
  CY = 120;
const out: Record<string, unknown> = { root };
for (const fuel of ['grass', 'shrub', 'pine', 'fir'] as Fuel[]) {
  const rows: string[] = [];
  const rec: Record<string, unknown> = {};
  for (const U of [1, 3, 6, 9, 12, 15]) {
    const head: number[] = [],
      flank: number[] = [],
      crown: number[] = [];
    for (let k = 0; k < 16; k++) {
      const w = lab(W, H, fuel, `${fuel}-${U}-${k}`);
      w.weather.windSpeed = U;
      w.weather.windDir = 0;
      const fe = startFire(w, CY * w.W + CX, 'human');
      fireSubstep(w, {});
      let hx = 0,
        fy = 0;
      for (let i = 0; i < w.N; i++) {
        if (w.L.fid[i] !== fe.id) continue;
        const x = (i % w.W) - CX,
          y = Math.abs(((i / w.W) | 0) - CY);
        if (Math.abs(y) <= 1 && x > hx) hx = x;
        if (Math.abs(x) <= 1 && y > fy) fy = y;
      }
      head.push((hx * 100) / 3);
      flank.push((fy * 100) / 3);
      crown.push(fe.crownArea);
    }
    rows.push(`U=${String(U).padStart(2)}: head ${mean(head).toFixed(0).padStart(5)} m/h, flank ${mean(flank).toFixed(0).padStart(4)} m/h, crown ${mean(crown).toFixed(0)} ha`);
    rec[U] = { head: Math.round(mean(head)), flank: Math.round(mean(flank)), crown: Math.round(mean(crown)) };
  }
  out[fuel] = rec;
  console.log(`${fuel.padEnd(6)} ${rows.join(' | ')}`);
}
// isotropy without wind: cured grass, 4 steps at the afternoon peak
{
  const ex: number[] = [],
    dg: number[] = [];
  for (let k = 0; k < 16; k++) {
    const w = lab(241, 241, 'grass', 'iso' + k);
    w.weather.windSpeed = 0.3;
    const fe = startFire(w, 120 * 241 + 120, 'human');
    for (let s = 0; s < 4; s++) fireSubstep(w, {});
    let e = 0,
      d = 0;
    for (let i = 0; i < w.N; i++) {
      if (w.L.fid[i] !== fe.id) continue;
      const x = (i % 241) - 120,
        y = ((i / 241) | 0) - 120;
      if (y === 0 && x > e) e = x;
      if (x === y && x > d) d = x;
    }
    ex.push(e);
    dg.push(d * Math.SQRT2);
  }
  console.log(`isotropy (no wind, grass, 12 h): axis ${mean(ex).toFixed(1)} cells, diagonal ${mean(dg).toFixed(1)} cells (ratio ${(mean(dg) / Math.max(0.1, mean(ex))).toFixed(2)})`);
}
if (process.env.FIRELAB_JSON) console.log(JSON.stringify(out));
