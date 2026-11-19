/**
 * Watershed: daily runoff is routed down the D8 network; bare or burned,
 * water-repellent slopes shed soil that travels downstream until it settles
 * in a beaver pond, a lake, or the town reservoir. The reservoir stores
 * snowmelt for the dry season; sediment steals its capacity and muddies the
 * town's water. Heavy rain on fresh burn scars can trigger debris flows.
 */
import { clamp01 } from '../grid.ts';
import { INFRA } from '../types.ts';
import type { World } from '../world.ts';

interface HydroCache {
  order: Int32Array; // upstream → downstream
  inReservoir: Uint8Array;
  reservoirCap: number;
  meanFlow: Float32Array; // running mean discharge for flood detection
}
const caches = new WeakMap<World, HydroCache>();

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
    meanFlow: new Float32Array(w.N),
  };
  caches.set(w, c);
  return c;
}

export interface HydroHooks {
  onDebrisFlow?: (x: number, y: number, damaged: number) => void;
  onFlood?: (townId: number) => void;
}

const flow = { a: null as Float32Array | null, s: null as Float32Array | null };

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
  let resInflow = 0,
    resSediment = 0;
  let debris = -1;
  for (let k = 0; k < N; k++) {
    const i = c.order[k];
    // local runoff + erosion
    const ro = runoff[i];
    let qi = q[i] + ro;
    let si = sed[i];
    if (ro > 0.5 && !L.water[i]) {
      const cover = clamp01(L.grass[i] + L.shrub[i] + L.aspen[i] + L.pine[i] + L.fir[i] + L.litter[i] / 20);
      const erod = ro * (0.02 + L.slope[i]) * Math.pow(1 - 0.85 * cover, 2) * (1 + 3 * L.hydro[i]) * 0.004;
      if (erod > 0) {
        L.soil[i] = Math.max(0.03, L.soil[i] - erod * 0.02);
        si += erod;
      }
      if (heavyRain && L.hydro[i] > 0.45 && L.slope[i] > 0.22 && erod > 0.08 && debris < 0) debris = i;
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

  // reservoir water balance (units: mm·ha)
  const pop = w.population;
  const summer = w.season === 1 ? 1.4 : 1;
  const demand = pop * 0.22 * summer;
  const evap = w.reservoirCells.length * Math.max(0, w.weather.temp) * 0.25;
  const cap = c.reservoirCap * (1 - w.reservoirSilt);
  let store = w.reservoirLevel * cap + resInflow - demand - evap;
  if (store < 0) store = 0;
  if (store > cap) store = cap;
  w.reservoirLevel = cap > 0 ? store / cap : 0;
  if (w.reservoirLevel < 0.12) w.counters.yearWaterShortDays++;
  // sediment fills the reservoir and muddies the water
  w.reservoirSilt = Math.min(0.85, w.reservoirSilt + resSediment * 0.00002);
  w.reservoirTurbidity = clamp01(w.reservoirTurbidity * 0.9 + resSediment * 0.002);

  // debris flow: a pulse of mud down a burned, water-repellent hillside
  if (debris >= 0) {
    const x = debris % w.W,
      y = (debris / w.W) | 0;
    let damaged = 0;
    let cur = debris;
    for (let s = 0; s < 40 && cur >= 0; s++) {
      if (L.town[cur] > 0) {
        L.town[cur] = -L.town[cur];
        const t = w.towns[-L.town[cur] - 1];
        if (t) {
          t.structures = Math.max(0, t.structures - 1);
          t.lostStructures++;
        }
        damaged++;
      }
      if (L.infra[cur] & INFRA.ROAD) w.memory.roadsCut = (w.memory.roadsCut ?? 0) + 1;
      L.soil[cur] = Math.max(0.05, L.soil[cur] - 0.05);
      cur = L.flowTo[cur];
    }
    w.counters.debrisFlows++;
    w.reservoirSilt = Math.min(0.85, w.reservoirSilt + 0.01);
    if (damaged > 0) w.dirty.infra++;
    if (hooks.onDebrisFlow) hooks.onDebrisFlow(x, y, damaged);
  }
}

/** Reservoir dredging restores lost capacity. */
export function dredge(w: World, amount: number): void {
  w.reservoirSilt = Math.max(0, w.reservoirSilt - amount);
  w.reservoirTurbidity *= 0.5;
}
