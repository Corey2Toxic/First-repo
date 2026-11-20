/**
 * Fuel census of a valley through time without fire: what grows there, how fast a fire would move
 * through it and how much of it would torch on a reference dry afternoon. Answers two design
 * questions: is "The Tinderbox" a tinderbox, and does unburned forest become more dangerous with
 * time (the fire paradox) or less?
 *
 *   node scripts/v2/fuels.ts <scenario> <seed> [years=20] [small|medium]
 */
import { loadSim } from './lib.ts';

const scen = process.argv[2] ?? 'tinderbox';
const seed = process.argv[3] ?? 'cal-a';
const years = Number(process.argv[4] ?? 20);
const size = process.argv[5] ?? 'medium';
const S = await loadSim();
if (!S.v2) throw new Error('fuels.ts needs the v2 fire core');
const w = S.generateWorld(S.makeConfig(scen, seed, size));
w.config.tenureYears = years + 5;
const sim = new S.Simulation(w, {}, { autoReview: true, ignitions: false });

/** Reference afternoon: dry fuel, the given 10 m wind, a droughty year. */
function census(label: string): void {
  const L = w.L;
  const F = S.fire;
  const env = (wind: number) => ({ windEff: wind, wdx: 1, wdy: 0, fmAdd: 0, spread: 1 });
  const saveDrought = w.climate.droughtIndex;
  w.climate.droughtIndex = 0.3;
  type Row = { n: number; fine: number; lad: number; can: number; cbh: number; r6: number; fl6: number; torch6: number; torch12: number; litter: number; heavy: number; shrub: number; firAge: number; fir: number };
  const cls: Record<string, Row> = {};
  let land = 0,
    forest = 0,
    torch6 = 0,
    torch12 = 0;
  const f = { fine: 0, grassShare: 0, ladder: 0, canopy: 0, heavy: 0, green: 0 };
  for (let i = 0; i < w.N; i++) {
    if (L.water[i] >= 2) continue;
    land++;
    S.fuels.cellFuel(w, i, f);
    const can = L.pine[i] + L.fir[i] + L.aspen[i];
    const k = can < 0.15 ? (L.shrub[i] > 0.35 ? 'shrubland' : f.fine < 0.5 ? 'barren' : 'grassland') : can < 0.4 ? 'open woodland' : L.fir[i] > L.pine[i] && L.fir[i] > L.aspen[i] ? 'fir forest' : L.aspen[i] > L.pine[i] ? 'aspen' : 'pine forest';
    const c = (cls[k] ??= { n: 0, fine: 0, lad: 0, can: 0, cbh: 0, r6: 0, fl6: 0, torch6: 0, torch12: 0, litter: 0, heavy: 0, shrub: 0, firAge: 0, fir: 0 });
    c.n++;
    c.fine += f.fine;
    c.lad += f.ladder;
    c.can += f.canopy;
    c.cbh += F.canopyBaseHeight(f.ladder);
    c.litter += L.litter[i];
    c.heavy += f.heavy;
    c.shrub += L.shrub[i];
    c.fir += L.fir[i];
    c.firAge += L.ageF[i] * L.fir[i];
    const r6 = F.surfaceHeadRate(w, i, f, env(6).windEff, 0.06) / 100;
    const b6 = F.frontBehaviour(w, i, f, r6, 0);
    c.r6 += r6 * 100;
    c.fl6 += b6.flame;
    const t6 = b6.crown;
    const r12 = F.surfaceHeadRate(w, i, f, 12, 0.06) / 100;
    const t12 = F.frontBehaviour(w, i, f, r12, 0).crown;
    if (t6) c.torch6++;
    if (t12) c.torch12++;
    if (can >= 0.15) {
      forest++;
      if (t6) torch6++;
      if (t12) torch12++;
    }
  }
  w.climate.droughtIndex = saveDrought;
  console.log(`${label}: of wooded land, ${Math.round((100 * torch6) / Math.max(1, forest))}% would torch at 6 m/s and ${Math.round((100 * torch12) / Math.max(1, forest))}% at 12 m/s (dry afternoon)`);
  for (const [k, c] of Object.entries(cls).sort((a, b) => b[1].n - a[1].n)) {
    const m = (x: number) => x / c.n;
    console.log(
      `   ${k.padEnd(14)} ${String(Math.round((100 * c.n) / land)).padStart(3)}%  fine ${m(c.fine).toFixed(1)} litter ${m(c.litter).toFixed(1)} heavy ${m(c.heavy).toFixed(0)} shrub ${m(c.shrub).toFixed(2)} fir ${m(c.fir).toFixed(2)}@${(c.firAge / Math.max(1e-6, c.fir)).toFixed(0)}y | ladder ${m(c.lad).toFixed(2)} CBH ${m(c.cbh).toFixed(1)} m canopy ${m(c.can).toFixed(2)} | head ${m(c.r6).toFixed(0)} m/h flame ${m(c.fl6).toFixed(1)} m | torch ${Math.round((100 * c.torch6) / c.n)}% / ${Math.round((100 * c.torch12) / c.n)}%`,
    );
  }
}

sim.runDays(150);
census(`${scen} ${seed} year 0 (late summer)`);
for (const y of [5, 10, 20, 30].filter((x) => x <= years)) {
  sim.runDays(y * 360 + 150 - w.day);
  census(`${scen} ${seed} year ${y}`);
}
