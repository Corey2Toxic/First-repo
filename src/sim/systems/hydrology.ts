/**
 * Watershed: daily runoff is routed down the D8 network; bare or burned,
 * water-repellent slopes shed soil that travels downstream until it settles
 * in a beaver pond, a lake, or the town reservoir. The reservoir stores
 * snowmelt for the dry season; sediment steals its capacity and muddies the
 * town's water. Heavy rain on fresh burn scars can trigger debris flows.
 */
import { clamp01 } from '../grid.ts';
import { FIRE, INFRA } from '../types.ts';
import type { World } from '../world.ts';
import { loseStructure } from './towns.ts';
import { quickflowArray } from './moisture.ts';

interface HydroCache {
  order: Int32Array; // upstream → downstream
  inReservoir: Uint8Array;
  reservoirCap: number;
  outlet: number; // first cell below the dam that is not reservoir (-1 if none)
  meanFlow: Float32Array; // running mean discharge for flood detection
}
const caches = new WeakMap<World, HydroCache>();

/** First non-reservoir cell on the dam's downstream path (static terrain, so reloads agree). */
function damOutlet(w: World, inRes: Uint8Array): number {
  let cur = w.damCell;
  for (let k = 0; k < 50 && cur >= 0; k++) {
    if (!inRes[cur]) return cur;
    cur = w.L.flowTo[cur];
  }
  return -1;
}

function cache(w: World): HydroCache {
  let c = caches.get(w);
  if (c) return c;
  const idx = Array.from({ length: w.N }, (_, i) => i);
  // conditioned elevations give a valid topological order (D8 always flows downhill)
  idx.sort((a, b) => w.L.elev[b] - w.L.elev[a] || b - a);
  const inRes = new Uint8Array(w.N);
  for (const r of w.reservoirCells) inRes[r] = 1;
  c = {
    order: Int32Array.from(idx),
    inReservoir: inRes,
    reservoirCap: Math.max(1, w.reservoirCells.length) * 5000,
    outlet: damOutlet(w, inRes),
    meanFlow: new Float32Array(w.N),
  };
  caches.set(w, c);
  return c;
}

export interface HydroHooks {
  onDebrisFlow?: (x: number, y: number, damaged: number) => void;
  onFlood?: (townId: number) => void;
}

/**
 * Erosion coefficient (calibration). With the RUSLE-like cover factor below, 0.15 gives chronic
 * (fire-free) reservoir capacity loss of ~0.2–0.5 %/yr across seeds, the range reported for forested
 * mountain catchments; burned, water-repellent slopes add pulses on top. See REMEDIATION_REPORT.md.
 */
const EROSION_K = 0.15;
const flow = { a: null as Float32Array | null, s: null as Float32Array | null };

/**
 * Reservoir water and sediment balance (water in mm·ha). Returns what leaves through the dam: an
 * environmental release plus any spill, and the sediment the reservoir fails to trap. Trapping
 * follows Brune's curve (Dendy's fit), falling as silt eats into capacity, instead of v1.0's hard
 * cap at 85 % (which simply deleted further sediment while turbidity kept climbing).
 */
function reservoirBalance(w: World, c: HydroCache, inflow: number, sediment: number): { water: number; sediment: number } {
  const pop = w.population;
  const summer = w.season === 1 ? 1.4 : 1;
  const demand = pop * 0.22 * summer;
  const evap = w.reservoirCells.length * Math.max(0, w.weather.temp) * 0.25;
  const cap = c.reservoirCap * (1 - w.reservoirSilt);
  const m = w.memory;
  m.resInflowMean = (m.resInflowMean ?? inflow) * (1 - 1 / 360) + inflow / 360;
  let store = w.reservoirLevel * cap + inflow - demand - evap;
  if (store < 0) store = 0;
  // minimum instream flow: the lesser of today's natural inflow and a tenth of the mean, so a
  // drought is passed through rather than drained from storage
  const release = Math.min(store, inflow, 0.1 * (m.resInflowMean ?? 0));
  store -= release;
  const spill = Math.max(0, store - cap);
  store -= spill;
  w.reservoirLevel = cap > 0 ? store / cap : 0;
  if (w.reservoirLevel < 0.12) w.counters.yearWaterShortDays++;
  const ratio = cap / Math.max(1, (m.resInflowMean ?? inflow) * 360);
  const trap = clamp01(ratio / (0.012 + 1.02 * ratio));
  w.reservoirSilt = Math.min(0.97, w.reservoirSilt + sediment * trap * 0.00002);
  w.reservoirTurbidity = clamp01(w.reservoirTurbidity * 0.9 + sediment * trap * 0.002);
  return { water: release + spill, sediment: sediment * (1 - trap) };
}

export function hydrologyDaily(w: World, runoff: Float32Array, hooks: HydroHooks = {}): void {
  const L = w.L;
  const c = cache(w);
  const N = w.N;
  if (!flow.a || flow.a.length !== N) {
    flow.a = new Float32Array(N);
    flow.s = new Float32Array(N);
  }
  const q = flow.a,
    sed = flow.s!;
  q.fill(0);
  sed.fill(0);
  const heavyRain = w.weather.precip > 24;
  const quick = quickflowArray(w);
  let resInflow = 0,
    resSediment = 0;
  let debris = -1;
  let balanced = false;
  for (let k = 0; k < N; k++) {
    const i = c.order[k];
    // everything draining to the reservoir lies upstream of the river below the dam, so its water
    // balance is complete here: what it cannot hold spills on down the river (v1.0 deleted it)
    if (i === c.outlet && !balanced) {
      const out = reservoirBalance(w, c, resInflow, resSediment);
      q[i] += out.water;
      sed[i] += out.sediment;
      balanced = true;
    }
    // local runoff + erosion
    const ro = runoff[i];
    let qi = q[i] + ro;
    let si = sed[i];
    const qf = quick[i];
    if (qf > 0.5 && !L.water[i]) {
      // RUSLE-like cover factor: ground cover (plants, litter and duff) protects the soil. v1.0's
      // factor bottomed out at 0.0225 under full forest — 5-20x RUSLE's ~0.001-0.005 — so intact
      // forest supplied most of the sediment and fire scars barely stood out. v1.0 also eroded with
      // all runoff, including slow subsurface drainage; only surface runoff (quickflow) does now
      const ground = clamp01(L.grass[i] + L.shrub[i] + 0.5 * (L.aspen[i] + L.pine[i] + L.fir[i]) + L.litter[i] / 8);
      // erosive load: surface runoff × slope × cover × water repellency
      const load = qf * (0.02 + L.slope[i]) * Math.pow(1 - 0.97 * ground, 2) * (1 + 3 * L.hydro[i]);
      if (load > 0) {
        L.soil[i] = Math.max(0.03, L.soil[i] - load * 0.00008); // v1.0's soil loss per unit load
        si += load * EROSION_K;
      }
      // same trigger as v1.0 (erod > 0.08 at its 0.004 coefficient)
      if (heavyRain && L.hydro[i] > 0.45 && L.slope[i] > 0.22 && load > 20 && debris < 0) debris = i;
    }
    // ponds and lakes trap sediment and buffer flow
    if (L.pond[i] > 0.3) {
      si *= 0.4;
      qi *= 0.8; // stored and released as baseflow (below)
    }
    if (L.water[i] === 2) si = 0;
    L.stream[i] = qi;
    L.sediment[i] = si;
    if (c.inReservoir[i]) {
      resInflow += ro; // rain on the reservoir itself
      continue;
    }
    const t = L.flowTo[i];
    if (t >= 0) {
      if (c.inReservoir[t]) {
        resInflow += qi;
        resSediment += si;
      } else {
        q[t] += qi;
        sed[t] += si;
      }
    }
  }
  // beaver ponds release stored water slowly: keep late-summer streams alive
  for (const col of w.colonies) if (col.active) L.stream[col.cell] += 2 * col.dam;

  if (!balanced) reservoirBalance(w, c, resInflow, resSediment);

  // debris flow: a pulse of mud down a burned, water-repellent hillside
  if (debris >= 0) {
    const x = debris % w.W,
      y = (debris / w.W) | 0;
    let damaged = 0;
    let cur = debris;
    for (let s = 0; s < 40 && cur >= 0; s++) {
      // a burning house is already being counted by the fire; any other is buried
      if (L.town[cur] > 0 && L.fire[cur] !== FIRE.BURNING) {
        loseStructure(w, cur);
        damaged++;
      }
      if (L.infra[cur] & INFRA.ROAD) w.memory.roadsCut = (w.memory.roadsCut ?? 0) + 1;
      L.soil[cur] = Math.max(0.05, L.soil[cur] - 0.05);
      cur = L.flowTo[cur];
    }
    w.counters.debrisFlows++;
    w.reservoirSilt = Math.min(0.97, w.reservoirSilt + 0.01);
    if (damaged > 0) w.dirty.infra++;
    if (hooks.onDebrisFlow) hooks.onDebrisFlow(x, y, damaged);
  }
}

/** Reservoir dredging restores lost capacity. */
export function dredge(w: World, amount: number): void {
  w.reservoirSilt = Math.max(0, w.reservoirSilt - amount);
  w.reservoirTurbidity *= 0.5;
}
