/**
 * Vegetation dynamics: a gap-free cohort model of five functional types.
 *
 * Each cell is revisited once a month on a staggered schedule (1/30 of the map
 * per day). Trees share one canopy layer limited by the site's capacity:
 * shade-tolerant fir creeps in beneath pine and aspen and slowly overtops them;
 * aspen regenerates from long-lived clonal roots after disturbance (unless deer
 * eat every sucker); pine seedlings need open mineral soil; everyone suffers in
 * drought. Mortality feeds snags and coarse wood; canopies feed the litter that
 * fire will one day consume.
 */
import { boxBlur, clamp01, lerp, smoothstep } from '../grid.ts';
import { annualMeanTemp, canopyCapacity, siteWetness, suitability } from '../env.ts';
import { SP } from '../types.ts';
import { seasonalTemp } from './climate.ts';
import { moistureCache } from './moisture.ts';
import type { World } from '../world.ts';

export const TREE_PARAMS = {
  aspen: { r: 0.34, life: 125, shadeTol: 0.1, droughtTol: 0.38, mature: 10, biomass: 130 },
  pine: { r: 0.12, life: 420, shadeTol: 0.3, droughtTol: 0.82, mature: 25, biomass: 240 },
  fir: { r: 0.09, life: 260, shadeTol: 0.9, droughtTol: 0.3, mature: 30, biomass: 220 },
};

interface VegCache {
  wet: Float32Array;
  meanT: Float32Array;
  cap: Float32Array;
  suit: Float32Array[]; // per species
  slot: Uint8Array; // day-of-month on which the cell updates
}
const caches = new WeakMap<World, VegCache>();

export function vegCache(w: World): VegCache {
  let c = caches.get(w);
  if (c) return c;
  const N = w.N;
  const wet = new Float32Array(N),
    meanT = new Float32Array(N),
    cap = new Float32Array(N),
    slot = new Uint8Array(N);
  const suit = [0, 1, 2, 3, 4].map(() => new Float32Array(N));
  for (let i = 0; i < N; i++) {
    wet[i] = siteWetness(w, i);
    meanT[i] = annualMeanTemp(w.L.elev[i]);
    cap[i] = canopyCapacity(meanT[i], wet[i]);
    for (let s = 0; s < 5; s++) suit[s][i] = suitability(s, meanT[i], wet[i]);
    const x = i % w.W,
      y = (i / w.W) | 0;
    slot[i] = (x * 7 + y * 13 + ((x * y) % 5)) % 30;
  }
  c = { wet, meanT, cap, suit, slot };
  caches.set(w, c);
  applyClimateShift(w, c);
  return c;
}

/**
 * Site suitability under the climate of the current year. Depends only on
 * static terrain and the persisted `lastYearStarted`, so a reloaded game
 * rebuilds exactly the same cache.
 */
function applyClimateShift(w: World, c: VegCache): void {
  const years = Math.max(0, w.lastYearStarted - w.startYear);
  // forests respond to warming with a lag; use half the realised trend
  const dT = 0.5 * w.climate.trendPerDecade * (years / 10);
  for (let i = 0; i < w.N; i++) {
    const mt = c.meanT[i] + dT;
    // warming also dries sites a little (higher evaporative demand)
    const wet = clamp01(c.wet[i] - dT * 0.03);
    c.cap[i] = canopyCapacity(mt, wet);
    for (let s = 0; s < 5; s++) c.suit[s][i] = suitability(s, mt, wet);
  }
}

/** Re-evaluate site suitability (called at the start of each year). */
export function refreshSuitability(w: World): void {
  applyClimateShift(w, vegCache(w));
}

/** Seed rain: blurred maps of cone/seed-bearing canopy, recomputed monthly. */
export function computeSeedRain(w: World): void {
  const L = w.L;
  const N = w.N;
  const tmp = new Float32Array(N),
    a = new Float32Array(N),
    b = new Float32Array(N);
  const species: Array<[Float32Array, Float32Array, Float32Array, number]> = [
    [L.aspen, L.ageA, L.seedA, TREE_PARAMS.aspen.mature],
    [L.pine, L.ageP, L.seedP, TREE_PARAMS.pine.mature],
    [L.fir, L.ageF, L.seedF, TREE_PARAMS.fir.mature],
  ];
  for (const [cov, age, out, mat] of species) {
    let mean = 0;
    for (let i = 0; i < N; i++) {
      a[i] = cov[i] * smoothstep(mat * 0.6, mat * 1.5, age[i]);
      mean += a[i];
    }
    mean /= N;
    boxBlur(a, b, tmp, w.W, w.H, 2);
    boxBlur(b, out, tmp, w.W, w.H, 3);
    // long-distance dispersal floor (birds, wind storms)
    for (let i = 0; i < N; i++) out[i] = Math.min(1, out[i] * 1.6 + mean * 0.05);
  }
}

/** Run the monthly update for every cell whose slot matches today. */
export function vegetationDaily(w: World): void {
  const c = vegCache(w);
  const dom = w.doy % 30;
  if (dom === 0) computeSeedRain(w);
  const slot = c.slot;
  for (let i = 0; i < w.N; i++) if (slot[i] === dom) updateCell(w, i, c);
  w.dirty.veg++;
}

function droughtFactor(stress: number, tol: number): number {
  return 1 - smoothstep(tol * 0.5, tol + 0.3, stress) * 0.8;
}

function updateCell(w: World, i: number, c: VegCache): void {
  const L = w.L;
  if (L.water[i] >= 2 || L.pond[i] > 0.5) {
    if (L.pond[i] > 0.5) {
      // flooded by beavers: trees drown slowly
      L.aspen[i] *= 0.97;
      L.pine[i] *= 0.95;
      L.fir[i] *= 0.95;
      L.grass[i] = Math.min(L.grass[i], 0.2);
    }
    return;
  }
  const dt = 1 / 12;
  const mc = moistureCache(w);
  const monthT = seasonalTemp(w.doy) + w.climate.yearTemp + mc.tOff[i];
  const gT = clamp01((monthT - 3) / 10);
  // soil depth (which erodes) scales how much canopy a site can hold
  const cap = Math.max(0.05, c.cap[i] * lerp(0.72, 1, L.soil[i]));
  const sA = c.suit[SP.ASPEN][i],
    sP = c.suit[SP.PINE][i],
    sF = c.suit[SP.FIR][i],
    sG = c.suit[SP.GRASS][i],
    sS = c.suit[SP.SHRUB][i];
  const sm = L.sm[i];

  // drought stress accumulates in dry growing-season months
  let stress = L.stress[i];
  if (gT > 0.2) stress += Math.max(0, 0.26 - sm) * 0.9 * gT;
  stress *= sm > 0.4 ? 0.8 : 0.95;
  stress = clamp01(stress);
  L.stress[i] = stress;

  let a = L.aspen[i],
    p = L.pine[i],
    f = L.fir[i];
  const total = a + p + f;
  const free = Math.max(0, cap - total) / cap;
  const yrsSinceFire = w.yearF - L.lastBurn[i];
  const postFire = yrsSinceFire >= 0 && yrsSinceFire < 4 ? 1.9 : 1;
  const litterInhib = 1 / (1 + (L.litter[i] + L.slash[i]) / 12);
  const estOpen = clamp01(1 - total / cap);
  const browse = L.browse[i];
  const browseSurv = clamp01(1 - browse * 1.4);

  const dfA = droughtFactor(stress, TREE_PARAMS.aspen.droughtTol);
  const dfP = droughtFactor(stress, TREE_PARAMS.pine.droughtTol);
  const dfF = droughtFactor(stress, TREE_PARAMS.fir.droughtTol);
  const fert = 1 + 0.5 * L.fert[i];

  // --- growth into free canopy space ---
  const gA = TREE_PARAMS.aspen.r * sA * a * free * gT * dfA * fert;
  const gP = TREE_PARAMS.pine.r * sP * p * free * gT * dfP * fert;
  const gF = TREE_PARAMS.fir.r * sF * f * free * gT * dfF * fert;

  // --- succession: shade-tolerant fir overtops aspen and pine in moist sites ---
  const over = TREE_PARAMS.fir.r * 0.75 * sF * f * (a + 0.55 * p) / cap * gT * dfF;
  const takeA = a + 0.55 * p > 0 ? (over * a) / (a + 0.55 * p) : 0;
  const takeP = over - takeA;
  // pine edges out aspen on drier ground
  const overP = TREE_PARAMS.pine.r * 0.35 * sP * p * a / cap * gT * (sP > sA ? 1 : 0.25);

  // --- recruitment ---
  const recA = 0.006 * L.seedA[i] * sA * estOpen * gT * browseSurv;
  const recP = 0.03 * L.seedP[i] * sP * estOpen * litterInhib * postFire * gT * dfP;
  const recF = 0.018 * L.seedF[i] * sF * (0.3 + 0.7 * Math.min(1, total / cap)) * gT * dfF;
  // clonal suckering from aspen roots, strongest in the open after fire
  const suck = L.aroot[i] > 0.04 ? 0.14 * L.aroot[i] * estOpen * Math.sqrt(sA) * gT * postFire * browseSurv : 0;

  // --- mortality (annual rates) ---
  const ageA = L.ageA[i],
    ageP = L.ageP[i],
    ageF = L.ageF[i];
  const sen = (age: number, life: number) => (age > life * 0.75 ? 0.09 * smoothstep(0.75, 1.15, age / life) : 0);
  const dMort = (tol: number) => 0.22 * smoothstep(tol, tol + 0.35, stress);
  let mA = 0.012 + sen(ageA, TREE_PARAMS.aspen.life) + dMort(TREE_PARAMS.aspen.droughtTol);
  const mP = 0.004 + sen(ageP, TREE_PARAMS.pine.life) + dMort(TREE_PARAMS.pine.droughtTol);
  const mF = 0.006 + sen(ageF, TREE_PARAMS.fir.life) + dMort(TREE_PARAMS.fir.droughtTol);
  // deer browse kills young aspen stems
  if (ageA < 10) mA += browse * 0.7;
  // trees cannot persist on unsuitable ground (e.g. after climate shifts)
  const misfit = (s: number) => (s < 0.08 ? 0.03 * (1 - s / 0.08) : 0);

  const killA = a * Math.min(0.5, (mA + misfit(sA)) * dt);
  const killP = p * Math.min(0.5, (mP + misfit(sP)) * dt);
  const killF = f * Math.min(0.5, (mF + misfit(sF)) * dt);

  // growth/succession terms are annual rates (× dt); recruitment terms are monthly increments
  const newA = Math.max(0, a + gA * dt - killA - takeA * dt - overP * dt) + recA + suck;
  const newP = Math.max(0, p + gP * dt - killP - takeP * dt + overP * dt) + recP;
  const newF = Math.max(0, f + gF * dt - killF + over * dt) + recF;
  // keep the sum within capacity (proportional squeeze)
  let na = newA,
    np = newP,
    nf = newF;
  const sum = na + np + nf;
  if (sum > cap) {
    const k = cap / sum;
    na *= k;
    np *= k;
    nf *= k;
  }
  // ages: survivors age, recruits enter at age 0
  const ageUpd = (old: number, age: number, recruits: number, nw: number) => {
    if (nw <= 1e-5) return 0;
    const surv = Math.max(0, Math.min(old, nw - recruits));
    return Math.min(600, (surv * (age + dt)) / Math.max(1e-6, surv + Math.min(recruits, nw)));
  };
  // stand age: years since the last stand-replacing disturbance. Unlike the cohort mean ages it is
  // not diluted by recruits, so old growth is lost to fire, beetles and cutting, not to seedlings
  // (v1.0 measured old growth on mean ages, so up to half its reported loss was an artefact)
  const canopyNow = na + np + nf;
  L.standAge[i] = canopyNow < 0.12 ? 0 : Math.min(800, L.standAge[i] + dt);
  // drought memory: a ~2-year moving average of the season's drought stress
  L.dstress[i] += (stress - L.dstress[i]) / 24;
  L.ageA[i] = ageUpd(a, ageA, recA + suck, na);
  L.ageP[i] = ageUpd(p, ageP, recP, np);
  L.ageF[i] = ageUpd(f, ageF, recF, nf);
  L.aspen[i] = na < 1e-4 ? 0 : na;
  L.pine[i] = np < 1e-4 ? 0 : np;
  L.fir[i] = nf < 1e-4 ? 0 : nf;
  // dead trees become snags (biomass t/ha at full cover scales with age)
  const bio = (age: number, b: number) => b * Math.min(1, 0.15 + age / 90);
  L.snag[i] += killA * bio(ageA, TREE_PARAMS.aspen.biomass) + killP * bio(ageP, TREE_PARAMS.pine.biomass) + killF * bio(ageF, TREE_PARAMS.fir.biomass);

  // aspen root reserve: grows with stems, persists for decades without them
  L.aroot[i] = clamp01(Math.max(L.aroot[i] * (1 - 0.018 * dt), Math.min(1, na * 1.2)) - (na < 0.01 ? 0.02 * dt : 0));

  // --- ground layer ---
  const leaf = w.season === 3 ? 0.3 : 1;
  const shade = np * 0.8 + nf * 1.05 + na * 0.55 * leaf;
  const groundLight = clamp01(1 - 0.85 * shade);
  const graze = L.graze[i];
  const moistF = smoothstep(0.05, 0.45, sm);
  const grassTarget = clamp01(sG * groundLight * (1 - 0.45 * L.shrub[i]) * (0.55 + 0.45 * moistF) * (1 + 0.4 * L.fert[i]) * (1 - 0.35 * graze));
  let grass = L.grass[i];
  if (gT > 0) grass += (grassTarget - grass) * Math.min(1, 2.2 * dt * (0.4 + gT));
  else if (grass > grassTarget) grass += (grassTarget - grass) * 0.05;
  grass -= grass * browse * 0.04;
  L.grass[i] = clamp01(grass);
  let shrub = L.shrub[i];
  // shrubs fill light gaps slowly; closed canopies shade them out
  const shrubCap = clamp01(sS * (0.18 + 0.5 * groundLight * groundLight) * (1 + 0.5 * graze));
  const shrubRoom = Math.max(0, shrubCap - shrub - 0.2 * L.grass[i]);
  shrub += (0.22 * shrub * shrubRoom * gT + 0.003 * sS * groundLight * gT) * (1 - 0.6 * browse);
  shrub -= shrub * browse * 0.06;
  if (shrub > shrubCap) shrub += (shrubCap - shrub) * 0.06;
  L.shrub[i] = clamp01(shrub);

  // --- litter and dead fuels (t/ha) ---
  const autumn = w.month >= 6 && w.month <= 8;
  const litterIn = (1.6 * np + 1.3 * nf + (autumn ? 1.2 * na * 4 : 0) + (autumn ? 1.1 * L.grass[i] * 4 : 0) + 0.4 * L.shrub[i]) * dt;
  const warm = clamp01((monthT + 2) / 18);
  const k = (0.05 + 0.32 * smoothstep(0.1, 0.7, sm) * warm) * dt;
  const redFall = L.red[i] * 0.7 * dt;
  L.litter[i] = Math.max(0, L.litter[i] + litterIn - k * L.litter[i] + redFall * 9);
  L.red[i] = Math.max(0, L.red[i] - redFall);
  const snagFall = L.snag[i] * 0.085 * dt;
  L.snag[i] -= snagFall;
  L.dead[i] = Math.max(0, L.dead[i] + snagFall + 0.22 * (na + np + nf) * dt - 0.035 * L.dead[i] * dt * (0.6 + warm));
  L.slash[i] = Math.max(0, L.slash[i] - L.slash[i] * 0.12 * dt);
  L.fert[i] = Math.max(0, L.fert[i] - L.fert[i] * 0.35 * dt);
  L.hydro[i] = Math.max(0, L.hydro[i] - L.hydro[i] * 0.55 * dt);
}

/**
 * Initial stand age, from the cohort ages generation writes (the oldest well-represented species;
 * aspen clones count 1.4x, as in v1.0's old-growth test). Also used to fill the layer when a v1.0
 * save, which has none, is loaded.
 */
export function initStandAge(w: World): void {
  const L = w.L;
  for (let i = 0; i < w.N; i++) {
    const can = L.aspen[i] + L.pine[i] + L.fir[i];
    L.standAge[i] = can < 0.12 ? 0 : Math.max(L.pine[i] > 0.1 ? L.ageP[i] : 0, L.fir[i] > 0.1 ? L.ageF[i] : 0, L.aspen[i] > 0.1 ? L.ageA[i] * 1.4 : 0);
  }
}

/** Valley-wide vegetation summary (for stats and scoring). */
export function vegetationSummary(w: World) {
  const L = w.L;
  let land = 0,
    forest = 0,
    old = 0,
    a = 0,
    p = 0,
    f = 0,
    g = 0,
    s = 0,
    hazard = 0;
  for (let i = 0; i < w.N; i++) {
    if (L.water[i]) continue;
    land++;
    const can = L.aspen[i] + L.pine[i] + L.fir[i];
    if (can > 0.3) forest++;
    if (L.standAge[i] > 150 && can > 0.3) old++;
    a += L.aspen[i];
    p += L.pine[i];
    f += L.fir[i];
    g += L.grass[i];
    s += L.shrub[i];
    hazard += Math.min(1, (L.litter[i] + L.dead[i] * 0.25 + L.slash[i] * 0.5 + L.snag[i] * 0.05) / 25) * 0.6 + Math.min(1, L.shrub[i] + L.fir[i] * (L.ageF[i] < 60 ? 1 : 0.4)) * 0.4;
  }
  return {
    land,
    forestFrac: forest / land,
    oldGrowth: old,
    aspen: a / land,
    pine: p / land,
    fir: f / land,
    grass: g / land,
    shrub: s / land,
    hazard: hazard / land,
  };
}
