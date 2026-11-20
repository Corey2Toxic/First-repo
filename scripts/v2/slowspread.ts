/**
 * Does a slow fire arrive? Realised versus specified head rate on uniform fuel, with the afternoon
 * (or night) step repeated so that only the step-boundary effect is measured.
 *
 *   node scripts/v2/slowspread.ts            # this tree
 *   FW_ROOT=<1.1.1 checkout> node scripts/v2/slowspread.ts
 *
 * On 1.1.1 any fire specified below ~30 m/h barely moves (pine litter at 3 m/s: 27 % of its rate;
 * at 1 m/s: 5 %; fir litter and all night-time litter fire: 0), because the crossing time is redrawn
 * every 3-hour step and the progress made is thrown away.
 */
import { loadSim, flatValley, ROOT } from './lib.ts';
import type { Bed } from './lib.ts';

const S = await loadSim();
console.log(`tree: ${ROOT}  (${S.v2 ? 'v2 fire core' : 'v1.x fire core'})`);

/** The head rate the model specifies for this bed, m/h, by the tree's own formulas. */
function specified(w: any, cell: number, wind: number, sub: number): number {
  const f = S.fuels.cellFuel(w, cell);
  if (S.v2) {
    const env = S.fire.spreadEnvFor(sub, w.weather, S.climate.droughtSeverity(w.climate.droughtIndex));
    return S.fire.surfaceHeadRate(w, cell, f, env.windEff, w.L.fm[cell] + env.fmAdd) * env.spread;
  }
  const di = S.climate.diurnal(sub);
  const fm = Math.max(0.02, w.L.fm[cell] + di.fmAdd + f.green * (0.06 + 0.06 * f.grassShare));
  return S.fire.surfaceHeadRate(w, cell, f, wind * di.wind) * S.fire.moistureDamping(fm / (0.15 + 0.13 * (1 - f.grassShare))) * di.spread;
}

function run(label: string, bed: Bed, wind: number, fm: number, sub = 4, hours = 24): void {
  const reps = 6;
  let sum = 0,
    spec = 0;
  for (let rep = 0; rep < reps; rep++) {
    const w = flatValley(S, bed, { w: 160, h: 61, fm, wind, sub });
    w.rng.fire = w.rng.fire.fork('rep' + rep);
    const c = 30 * w.W + 20;
    S.fire.startFire(w, c, 'lightning');
    for (let s = 0; s < hours / 3; s++) {
      w.sub = sub;
      // keep every burning cell alight and flaming, so burn-out does not confound the measurement
      for (const b of w.burning) {
        w.L.ftime[b] = 48;
        w.L.fphase[b] = 0;
      }
      S.fire.fireSubstep(w);
    }
    let maxX = 20;
    for (let i = 0; i < w.N; i++) if (w.L.fire[i] !== S.types.FIRE.NONE && Math.floor(i / w.W) === 30) maxX = Math.max(maxX, i % w.W);
    sum += ((maxX - 20) * 100) / hours;
    spec = specified(w, c + 5, wind, sub);
  }
  const mean = sum / reps;
  console.log(`${label.padEnd(26)} wind ${String(wind).padStart(2)} m/s  fm ${fm.toFixed(2)}   specified ${spec.toFixed(1).padStart(6)} m/h   realised ${mean.toFixed(1).padStart(6)} m/h   ratio ${(spec > 0 ? mean / spec : 0).toFixed(2)}`);
}

const pine: Bed = { name: 'pine litter', grass: 0, pine: 0.7, litter: 6, dead: 40 };
const fir: Bed = { name: 'fir litter', grass: 0, fir: 0.8, litter: 8, dead: 40 };
const grass: Bed = { name: 'grass', grass: 0.8, litter: 0.5, dead: 40 };
console.log('--- afternoon step repeated for 24 h ---');
run('pine litter', pine, 6, 0.06);
run('pine litter', pine, 3, 0.06);
run('pine litter', pine, 1, 0.06);
run('pine litter, damp', pine, 3, 0.12);
run('fir litter', fir, 6, 0.06, 4, 48);
run('fir litter', fir, 3, 0.08, 4, 48);
run('grass', grass, 1, 0.06);
console.log('--- night step repeated for 24 h ---');
run('pine litter, night', pine, 6, 0.06, 0, 48);
run('grass, night', grass, 6, 0.06, 0);
