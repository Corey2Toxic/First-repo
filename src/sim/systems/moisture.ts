/**
 * Daily water balance per cell: snow accumulation/melt (degree-day), soil
 * moisture (infiltration, runoff, evapotranspiration, drainage, lateral
 * groundwater subsidy), and dead fine-fuel moisture relaxing toward the
 * equilibrium moisture content of the day's air (Simard 1968).
 */
import { clamp, clamp01, smoothstep } from '../grid.ts';
import { LAPSE, REF_ELEV, precipFactor } from '../env.ts';
import { phenology } from '../derived.ts';
import { droughtSeverity } from './climate.ts';
import type { World } from '../world.ts';

interface StaticCache {
  tOff: Float32Array; // temperature offset from the valley reference (°C)
  pFac: Float32Array; // precipitation multiplier
  riparian: Uint8Array; // next to permanent water
  sample: Int32Array; // land cells sampled for valley statistics
}
const caches = new WeakMap<World, StaticCache>();

export function moistureCache(w: World): StaticCache {
  let c = caches.get(w);
  if (c) return c;
  const L = w.L;
  const tOff = new Float32Array(w.N),
    pFac = new Float32Array(w.N),
    riparian = new Uint8Array(w.N);
  for (let i = 0; i < w.N; i++) {
    tOff[i] = -LAPSE * (L.elev[i] - REF_ELEV) + 0.9 * L.aspectS[i];
    pFac[i] = precipFactor(L.elev[i]) * (1 + 0.08 * (L.twi[i] - 0.5));
    if (L.flowAcc[i] >= 300 || L.water[i]) riparian[i] = 1;
  }
  for (let y = 1; y < w.H - 1; y++)
    for (let x = 1; x < w.W - 1; x++) {
      const i = y * w.W + x;
      if (riparian[i] === 1 && !L.water[i]) continue;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) if (L.water[i + dy * w.W + dx] >= 2 && !L.water[i]) riparian[i] = 2;
    }
  const land: number[] = [];
  for (let i = 0; i < w.N; i += 7) if (!L.water[i]) land.push(i);
  c = { tOff, pFac, riparian, sample: Int32Array.from(land) };
  caches.set(w, c);
  return c;
}

/** Soil water capacity (mm) follows soil depth, which erodes over time. */
export function soilCapacity(soil: number): number {
  return 70 + 190 * soil;
}

/** Kept for API compatibility: capacity is computed on the fly from soil depth. */
export function refreshSoilCapacity(_w: World): void {}

/**
 * Equilibrium moisture content (fraction) from relative humidity (0..1) and air temperature in °C.
 * Simard's (1968) regressions, as used by NFDRS, are defined in °F: v1.0 passed °C, reading
 * 0.5–1 percentage point too wet (D19).
 */
export function emc(rh: number, tC: number): number {
  const H = rh * 100;
  const t = tC * 1.8 + 32;
  let e: number;
  if (H < 10) e = 0.03229 + 0.281073 * H - 0.000578 * H * t;
  else if (H < 50) e = 2.22749 + 0.160107 * H - 0.01478 * t;
  else e = 21.0606 + 0.005565 * H * H - 0.00035 * H * t - 0.483199 * H;
  return clamp(e / 100, 0.015, 0.35);
}

/**
 * Today's surface runoff per cell (infiltration and saturation excess), mm. Erosion is driven by
 * this alone; v1.0 eroded soil with all runoff, including slow subsurface drainage. Recomputed every
 * day before hydrology runs, so it never needs saving.
 */
const quickflows = new WeakMap<World, Float32Array>();
export function quickflowArray(w: World): Float32Array {
  let q = quickflows.get(w);
  if (!q || q.length !== w.N) {
    q = new Float32Array(w.N);
    quickflows.set(w, q);
  }
  return q;
}

export interface DailyWaterTotals {
  runoff: Float32Array; // mm of runoff generated per cell today
}

export function dailyMoisture(w: World, runoff: Float32Array): void {
  const L = w.L;
  const wx = w.weather;
  const c = moistureCache(w);
  const doy = w.doy;
  const sunBoost = 1 + 0.45 * smoothstep(20, 90, doy) * (1 - smoothstep(150, 200, doy));
  const baseEmc = emc(wx.rh, wx.tmax);
  const regionalWet = clamp01(0.4 + 0.6 * (1 - droughtSeverity(w.climate.droughtIndex)));
  const N = w.N;
  // hoist layer arrays out of the hot loop
  const water = L.water,
    snowA = L.snow,
    smA = L.sm,
    fmA = L.fm,
    pond = L.pond,
    aspectS = L.aspectS,
    pine = L.pine,
    fir = L.fir,
    aspen = L.aspen,
    grass = L.grass,
    shrub = L.shrub,
    hydro = L.hydro,
    slope = L.slope,
    elev = L.elev,
    twi = L.twi,
    soil = L.soil;
  const tOff = c.tOff,
    pFac = c.pFac,
    rip = c.riparian;
  const precip = wx.precip,
    temp = wx.temp,
    dryAir = wx.rh < 0.3;
  const W = w.W;
  const quick = quickflowArray(w);
  for (let i = 0; i < N; i++) {
    runoff[i] = 0;
    quick[i] = 0;
    if (water[i] >= 2) {
      smA[i] = 1;
      fmA[i] = 0.4;
      snowA[i] = 0;
      // rain on a lake or the reservoir joins its water (v1.0 dropped it)
      runoff[i] = precip * pFac[i];
      continue;
    }
    const t = temp + tOff[i];
    const p = precip * pFac[i];
    let rain = 0;
    // --- snow ---
    let snow = snowA[i];
    if (p > 0) {
      if (t < 0.5) snow += p;
      else rain = p;
    }
    let melt = 0;
    if (snow > 0 && t > 0) {
      melt = Math.min(snow, (t * 3.2 + rain * 0.08 * t) * (1 + 0.35 * aspectS[i]) * sunBoost * (1 - 0.25 * (pine[i] + fir[i])));
      snow -= melt;
    }
    if (snow > 0 && dryAir) snow = Math.max(0, snow - 0.4); // sublimation
    snowA[i] = snow;

    // --- soil water ---
    const cap = 70 + 190 * soil[i];
    let sm = smA[i];
    const input = rain + melt;
    const can = pine[i] + fir[i] + 0.5 * aspen[i];
    if (input > 0) {
      // infiltration-excess runoff grows with intensity, slope and post-fire water repellency
      const canopyIntercept = Math.min(rain, 1.2 * can);
      const net = input - canopyIntercept;
      const excessFrac = clamp01(0.05 + 0.6 * hydro[i] + 0.25 * slope[i] + (net > 18 ? 0.25 : 0) - 0.2 * grass[i] - 0.15 * shrub[i]);
      let inf = net * (1 - excessFrac);
      let ro = net - inf;
      const room = (1 - sm) * cap;
      if (inf > room) {
        ro += inf - room;
        inf = room;
      }
      sm += inf / cap;
      runoff[i] = ro;
      quick[i] = ro;
    }
    // evapotranspiration
    if (snow < 5) {
      const pet = Math.max(0, 0.2 * (t + 4)) * (dryAir ? 1.2 : 1);
      const ph = phenology(doy, elev[i]);
      const cover = grass[i] + shrub[i] + aspen[i] + pine[i] + fir[i];
      const veg = 0.35 + 0.65 * ph * (cover > 1 ? 1 : cover);
      const aet = pet * veg * smoothstep(0.03, 0.55, sm);
      sm -= aet / cap;
    }
    // drainage below field capacity
    if (sm > 0.72) {
      const d = (sm - 0.72) * 0.12;
      sm -= d;
      runoff[i] += d * cap * 0.5; // slow baseflow to streams
    }
    // lateral groundwater subsidy keeps hollows and riparian strips green
    const tw = twi[i];
    sm += 0.0045 * tw * tw * regionalWet;
    const r = rip[i];
    if (r) sm = Math.max(sm, r === 2 ? 0.5 : 0.42);
    const pd = pond[i];
    if (pd > 0.05) sm = Math.max(sm, 0.85);
    else if (i > W && i < N - W && (pond[i - 1] > 0.2 || pond[i + 1] > 0.2 || pond[i - W] > 0.2 || pond[i + W] > 0.2)) sm = Math.max(sm, 0.6);
    sm = sm < 0.02 ? 0.02 : sm > 1 ? 1 : sm;
    smA[i] = sm;

    // --- dead fine fuel moisture ---
    let fm = fmA[i];
    if (snow > 3) fm = 0.4;
    else {
      const elevAdj = (elev[i] - REF_ELEV) * 0.000012;
      // shaded, high, north-facing and wet-soil sites hold fuel moisture longer
      const target = clamp(
        baseEmc + 0.03 * can + elevAdj - 0.02 * aspectS[i] + 0.06 * smoothstep(0.45, 0.85, sm) + (r ? 0.04 : 0),
        0.02,
        0.35,
      );
      fm += (target - fm) * 0.55;
      if (rain > 0.5) fm = Math.max(fm, Math.min(0.42, 0.16 + rain * 0.018));
    }
    fmA[i] = fm;
  }
  w.dirty.snow++;
}

/** Median dead fuel moisture over a land sample, for the valley danger rating. */
export function medianFuelMoisture(w: World): number {
  const c = moistureCache(w);
  const vals = new Float32Array(c.sample.length);
  for (let k = 0; k < c.sample.length; k++) vals[k] = w.L.fm[c.sample[k]];
  vals.sort();
  // weight toward the drier half (fires start where it's dry)
  return vals[Math.floor(vals.length * 0.35)];
}
