/**
 * One long-horizon headless run → one JSON record on stdout (QA / remediation measurements).
 *
 *   node scripts/qa/longrun.ts <scenario> <seed> <size> <years> [simRoot] [variantJson]
 *
 * `simRoot` defaults to this checkout's src/sim; point it at another export (e.g. the preserved
 * v1.0 baseline) to measure both versions with the same harness. Only long-stable APIs are used so
 * the harness runs against either version. Reviews are closed without ending the game (petitions
 * declined), so ecology and fire continue for the whole horizon regardless of dismissal.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [scen, seed, size, yearsS, rootArg, variantArg] = process.argv.slice(2);
const root = resolve(rootArg && rootArg !== '-' ? rootArg : new URL('../../src/sim', import.meta.url).pathname);
const imp = (p: string) => import(pathToFileURL(`${root}/${p}`).href);
const { generateWorld } = await imp('gen/index.ts');
const { makeConfig } = await imp('scenarios.ts');
const { Simulation } = await imp('sim.ts');
const { applyAllocation } = await imp('systems/council.ts');
const { vegetationSummary } = await imp('systems/vegetation.ts');
const { stateHash, encodeWorld } = await imp('save.ts');
const { FIRE } = await imp('types.ts');

const years = Number(yearsS);
const variant = variantArg ? JSON.parse(variantArg) : {};
const t0 = performance.now();
const w = generateWorld(makeConfig(scen, seed, size, { tenureYears: 999, ...(variant.config ?? {}) }));
const genMs = performance.now() - t0;
if (variant.policies) Object.assign(w.policies, variant.policies);
let wolfDeathsCulled = 0;
const sim = new Simulation(w, { onWolvesKilled: (_p: unknown, n: number) => (wolfDeathsCulled += n) }, { ignitions: !variant.noFire });
const close = (ww: any) => {
  for (const p of ww.review.petitions) {
    p.resolved = true;
    p.accepted = !!variant.acceptPetitions;
  }
  ww.review.pending = false;
  applyAllocation(ww);
};
const L = w.L;
let packExtinctions = 0;
let prevPacks = w.packs.length;
function snapshot(y: number) {
  const v = vegetationSummary(w);
  let young = 0,
    land = 0,
    browse = 0,
    stuck = 0,
    stuckH = 0,
    condS = 0;
  const active = new Set(w.fires.filter((f: any) => f.active).map((f: any) => f.id));
  for (let i = 0; i < w.N; i++) {
    if (L.water[i]) continue;
    land++;
    if (L.ageA[i] < 12) young += L.aspen[i];
    browse += L.browse[i];
    if (L.fire[i] !== FIRE.NONE && !active.has(L.fid[i])) {
      stuck++;
      if (L.town[i] !== 0) stuckH++;
    }
  }
  let deer = 0,
    wolves = 0;
  for (const h of w.herds) {
    deer += h.n;
    condS += h.cond * h.n;
  }
  for (const p of w.packs) wolves += p.n;
  const k = w.stats.burned.length - 1;
  return {
    y,
    deer,
    herds: w.herds.length,
    cond: deer ? +(condS / deer).toFixed(3) : 0,
    K: Math.round(w.memory.deerK ?? 0),
    wolves,
    packs: w.packs.length,
    beavers: w.colonies.filter((c: any) => c.active).reduce((s: number, c: any) => s + c.n, 0),
    colonies: w.colonies.filter((c: any) => c.active).length,
    aspen: +v.aspen.toFixed(4),
    youngAspen: +(young / land).toFixed(5),
    pine: +v.pine.toFixed(4),
    fir: +v.fir.toFixed(4),
    grass: +v.grass.toFixed(4),
    shrub: +v.shrub.toFixed(4),
    forest: +v.forestFrac.toFixed(4),
    og: v.oldGrowth,
    hazard: +v.hazard.toFixed(4),
    burned: w.stats.burned[k] ?? 0,
    high: w.stats.burnedHigh[k] ?? 0,
    homesLost: w.stats.structuresLost[k] ?? 0,
    homesLostTotal: w.counters.totalStructuresLost,
    homes: w.towns.reduce((s: number, t: any) => s + t.structures, 0),
    stuckBurnt: stuck,
    stuckHouse: stuckH,
    beetle: w.stats.beetle.at(-1) ?? 0,
    browse: +(browse / land).toFixed(4),
    trust: +w.trust.toFixed(1),
    funds: Math.round(w.economy.funds),
    mill: w.economy.millOpen,
    pop: w.population,
    silt: +w.reservoirSilt.toFixed(3),
    resLevel: +w.reservoirLevel.toFixed(3),
    fires: w.fires.length,
    packExtinctions,
    culled: wolfDeathsCulled,
    supp: Math.round(w.economy.history.at(-1)?.expense?.Suppression ?? 0),
  };
}
const rows: any[] = [snapshot(0)];
const yearMs: number[] = [];
let peakHeap = 0;
for (let y = 1; y <= years; y++) {
  const ty = performance.now();
  for (let d = 0; d < 360; d++) {
    sim.runDays(1, close);
    if (prevPacks > 0 && w.packs.length === 0) packExtinctions++;
    prevPacks = w.packs.length;
  }
  yearMs.push(performance.now() - ty);
  const hu = process.memoryUsage().heapUsed;
  if (hu > peakHeap) peakHeap = hu;
  rows.push(snapshot(y));
}
// per-fire records (all fires still in memory)
const fires = w.fires.map((f: any) => ({ id: f.id, cause: f.cause, start: f.startDay, det: f.detectedDay, area: f.area, high: f.highSeverity, homes: f.structuresLost, cost: Math.round(f.cost) }));
console.log(
  JSON.stringify({
    scen,
    seed,
    size,
    years,
    root,
    variant,
    W: w.W,
    H: w.H,
    genMs: Math.round(genMs),
    yearMs: yearMs.map((x) => Math.round(x)),
    peakHeapMB: Math.round(peakHeap / 1e6),
    saveBytes: encodeWorld(w).length,
    hash: stateHash(w),
    rows,
    fires,
  }),
);
