/**
 * Fire behaviour lab: ignite fires under controlled weather and report growth.
 *   node scripts/fire-lab.ts [seed]
 * Targets (unsuppressed):
 *   moist spring      → dies out, < 5 ha
 *   typical summer    → tens of ha over 4 days
 *   dry + breezy      → hundreds of ha
 *   wind event        → thousands of ha, crown runs, spotting
 */
import { generateWorld } from '../src/sim/gen/index.ts';
import { makeConfig } from '../src/sim/scenarios.ts';
import { fireSubstep, startFire } from '../src/sim/systems/fire.ts';
import { smokeSubstep } from '../src/sim/systems/smoke.ts';
import { emc } from '../src/sim/systems/moisture.ts';
import { SUBSTEPS_PER_DAY } from '../src/sim/types.ts';
import type { World } from '../src/sim/world.ts';

const seed = process.argv[2] ?? 'cedar-otter-77';
const scen = (process.argv[3] ?? 'tinderbox') as 'tinderbox';

interface Wx {
  name: string;
  rh: number;
  temp: number;
  wind: number;
  drought: number;
  doy: number;
  days: number;
}
const cases: Wx[] = [
  { name: 'moist spring', rh: 0.55, temp: 10, wind: 3, drought: 0.15, doy: 40, days: 4 },
  { name: 'typical summer', rh: 0.32, temp: 22, wind: 3.5, drought: 0.45, doy: 130, days: 4 },
  { name: 'dry + breezy', rh: 0.18, temp: 28, wind: 6, drought: 0.75, doy: 150, days: 4 },
  { name: 'wind event', rh: 0.1, temp: 26, wind: 14, drought: 0.85, doy: 220, days: 2 },
];

function prepare(w: World, c: Wx): void {
  w.day = c.doy;
  w.weather.rh = c.rh;
  w.weather.temp = c.temp;
  w.weather.tmax = c.temp + 7;
  w.weather.windSpeed = c.wind;
  w.weather.windDir = 0.3;
  w.weather.precip = 0;
  w.climate.droughtIndex = c.drought;
  const e = emc(c.rh, c.temp + 7);
  for (let i = 0; i < w.N; i++) {
    if (w.L.water[i] >= 2) continue;
    const shade = w.L.pine[i] + w.L.fir[i] + 0.6 * w.L.aspen[i];
    w.L.fm[i] = Math.min(0.35, e + 0.03 * shade - 0.02 * w.L.aspectS[i]);
    w.L.sm[i] = Math.max(0.05, 0.6 - c.drought * 0.55 + 0.3 * w.L.twi[i]);
    w.L.snow[i] = 0;
  }
}

// pick ignition points in forest, grass and mixed terrain
const base = generateWorld(makeConfig(scen, seed));
const pts: number[] = [];
const r = base.rng.misc.fork('lab');
while (pts.length < 6) {
  const i = r.int(base.N);
  const L = base.L;
  if (L.water[i] || L.town[i] || L.elev[i] > 2700) continue;
  const can = L.pine[i] + L.fir[i] + L.aspen[i];
  if (pts.length < 3 ? can > 0.4 : can < 0.2 && L.grass[i] > 0.4) pts.push(i);
}
for (const c of cases) {
  const results: string[] = [];
  for (const p of pts) {
    const w = generateWorld(makeConfig(scen, seed));
    prepare(w, c);
    const fe = startFire(w, p, 'lightning');
    if (!fe) continue;
    for (let s = 4; s < 4 + c.days * SUBSTEPS_PER_DAY && w.burning.length > 0; s++) {
      w.sub = s % SUBSTEPS_PER_DAY;
      fireSubstep(w);
      smokeSubstep(w);
    }
    results.push(`${fe.area}ha${fe.crownArea ? `/c${fe.crownArea}` : ''}${fe.spotFires ? `/s${fe.spotFires}` : ''}${fe.active ? '' : ' out'}`);
  }
  console.log(`${c.name.padEnd(16)} ${results.join('  ')}`);
}
