/**
 * Fire: ignition, spread, crowning, spotting, structures, burnout effects,
 * detection and the bookkeeping of named fire events.
 *
 * Spread is a stochastic cellular automaton whose per-step transition
 * probabilities come from a simplified Rothermel-style rate of spread: fine
 * fuel load and its moisture, mid-flame wind along the spread direction, and
 * slope. Surface fires transition to crown fires when surface intensity times
 * ladder-fuel continuity exceeds a threshold in dry canopies. Intense fires
 * loft embers downwind that can jump rivers, roads and control lines.
 */
import { DIST8, DX8, DY8, MinHeap, clamp01, smoothstep } from '../grid.ts';
import { FIRE, INFRA, SUBSTEPS_PER_DAY, ZONE } from '../types.ts';
import type { FireCause, FireEvent, FireResponse } from '../types.ts';
import { cellFuel } from './fuels.ts';
import type { CellFuel } from './fuels.ts';
import { diurnal, droughtSeverity } from './climate.ts';
import { loseStructure } from './towns.ts';
import type { World } from '../world.ts';

const HOURS = 24 / SUBSTEPS_PER_DAY;
const tmpFuel: CellFuel = { fine: 0, grassShare: 0, ladder: 0, canopy: 0, heavy: 0, green: 0 };

// ---------------------------------------------------------------- naming
const ROMAN = ['', ' II', ' III', ' IV', ' V', ' VI', ' VII'];

export function fireName(w: World, x: number, y: number): string {
  let best = '';
  let bd = Infinity;
  for (const m of w.landmarks) {
    const d = Math.hypot(m.x - x, m.y - y) / (m.kind === 'town' ? 0.6 : m.kind === 'creek' ? 1.2 : 1);
    if (d < bd && d < 60) {
      bd = d;
      best = m.name;
    }
  }
  let base = best ? best.replace(/^Mount /, '').replace(/^Lake /, '').replace(/ Reservoir$/, ' Reservoir').replace(/'s Crossing$/, '') : '';
  if (!base) base = `Section ${Math.floor(x / 10) + 1}-${Math.floor(y / 10) + 1}`;
  const key = `${w.year}:${base}`;
  const n = (w.counters.fireNames[key] ?? 0) + 1;
  w.counters.fireNames[key] = n;
  return `${base}${ROMAN[Math.min(n - 1, ROMAN.length - 1)]} Fire`;
}

// ---------------------------------------------------------------- helpers
/** Rothermel (1972) moisture damping coefficient for r = moisture / extinction moisture. */
export function moistureDamping(r: number): number {
  if (r >= 1) return 0;
  if (r <= 0) return 1;
  return Math.max(0, 1 - 2.59 * r + 5.11 * r * r - 3.52 * r * r * r);
}

export function isBurnable(w: World, i: number): boolean {
  const L = w.L;
  if (L.water[i] >= 2 || L.pond[i] > 0.35) return false;
  if (L.fire[i] !== FIRE.NONE) return false;
  return true;
}

function nearestStructureDist(w: World, x: number, y: number): number {
  let best = Infinity;
  for (const t of w.towns) best = Math.min(best, Math.hypot(t.x - x, t.y - y) - Math.sqrt(t.structures) * 0.6);
  return Math.max(0, best);
}

export function defaultResponse(w: World, i: number, cause: FireCause): FireResponse {
  if (cause === 'prescribed' || cause === 'pile') return 'contain';
  const z = w.L.zone[i];
  if (z === ZONE.BUFFER) return 'suppress';
  const d = nearestStructureDist(w, i % w.W, (i / w.W) | 0);
  if (z === ZONE.WILDERNESS && d > 16) return 'monitor';
  return 'suppress';
}

/** Surface fire intensity and crowning for a cell about to ignite. */
function ignitionIntensity(w: World, i: number, f: CellFuel, windMid: number, slopeF: number, fmAdd: number): [number, boolean] {
  const L = w.L;
  const fm = Math.max(0.02, L.fm[i] + fmAdd + f.green * (0.06 + 0.06 * f.grassShare));
  const damp = moistureDamping(fm / (0.15 + 0.13 * (1 - f.grassShare)));
  let I = Math.min(1.3, Math.pow(Math.max(0, f.fine), 0.85) * 0.055 * damp * (1 + 0.12 * windMid) * Math.max(1, Math.sqrt(slopeF)));
  const torch = I * (0.35 + 1.1 * f.ladder);
  const crownDamp = clamp01(1 - fm / 0.2) * (1 - 0.55 * f.green * (1 - f.grassShare));
  let crown = false;
  if (torch > 0.46 && f.canopy > 0.25 && crownDamp > 0.3) {
    crown = true;
    I = 1 + 0.6 * f.canopy;
  }
  return [I, crown];
}

export function igniteCell(w: World, i: number, fe: FireEvent, I: number, crown: boolean): void {
  const L = w.L;
  L.fire[i] = FIRE.BURNING;
  L.fid[i] = fe.id;
  L.fint[i] = I;
  L.fpeak[i] = I;
  L.fphase[i] = 0;
  L.crown[i] = crown ? 1 : 0;
  const f = cellFuel(w, i, tmpFuel);
  const heavyAvail = 0.25 + 0.5 * droughtSeverity(w.climate.droughtIndex);
  L.ftime[i] = Math.min(48, 3 + L.litter[i] * 0.25 + f.heavy * heavyAvail + (crown ? 3 : 0));
  w.burning.push(i);
  fe.area++;
  if (crown) fe.crownArea++;
  if (I > fe.maxIntensity) fe.maxIntensity = I;
  extendFireBounds(w, fe, i);
  if (L.zone[i] === ZONE.BUFFER && !fe.inBuffer) enterBuffer(w, fe, i);
}

/**
 * A wildfire that burns into a Community Buffer is always fought: a "monitor" or "contain" order is
 * upgraded to full suppression and the dispatcher sends crews there first (see crews.autoDispatch).
 * Prescribed burns inside a buffer stay with their crews.
 */
function enterBuffer(w: World, fe: FireEvent, i: number): void {
  fe.inBuffer = true;
  if (fe.cause === 'prescribed' || fe.cause === 'pile') return;
  if (fe.response !== 'suppress') {
    fe.response = 'suppress';
    if (fe.detected) w.notify(`${fe.name} has reached the community buffer — crews ordered to suppress it.`, 'warn', i % w.W, (i / w.W) | 0, fe.id);
  }
}

/**
 * Every cell a fire touches must lie inside its bounding box: the box is what the
 * end-of-fire sweep releases (BURNT → NONE), what crews and the UI scan, and how
 * threat to towns is measured. (v1.0 forgot this for burning houses, which then
 * stayed BURNT forever and came back fireproof when rebuilt.)
 */
function extendFireBounds(w: World, fe: FireEvent, i: number): void {
  const x = i % w.W,
    y = (i / w.W) | 0;
  if (x < fe.minX) fe.minX = x;
  if (y < fe.minY) fe.minY = y;
  if (x > fe.maxX) fe.maxX = x;
  if (y > fe.maxY) fe.maxY = y;
}

/**
 * Release fire-state left behind by fires that are no longer active (repairs saves
 * written by v1.0, where burned houses outside a fire's box were never released).
 * Returns the number of cells repaired.
 */
export function releaseOrphanFireCells(w: World): number {
  const L = w.L;
  const active = new Set<number>();
  for (const fe of w.fires) if (fe.active) active.add(fe.id);
  let n = 0;
  for (let i = 0; i < w.N; i++) {
    if (L.fire[i] === FIRE.BURNT && !active.has(L.fid[i])) {
      L.fire[i] = FIRE.NONE;
      L.fid[i] = -1;
      n++;
    } else if (L.fire[i] === FIRE.NONE && L.fid[i] !== -1 && !active.has(L.fid[i])) {
      L.fid[i] = -1;
    }
  }
  if (n) w.dirty.fire++;
  return n;
}

/**
 * Natural and human ignitions happen at a random moment inside the afternoon step, not at its start
 * (v1.0 gave every new fire a full three hours of spread in its first step). Offsets live only
 * between dailyIgnitions and the fireSubstep of the same tick, so they never need saving.
 */
const pendingStart = new WeakMap<World, Map<number, number>>();
export function setIgnitionOffset(w: World, cell: number, hours: number): void {
  let m = pendingStart.get(w);
  if (!m) {
    m = new Map();
    pendingStart.set(w, m);
  }
  m.set(cell, hours);
}

export function startFire(w: World, i: number, cause: FireCause, projectId = -1, smolder = false): FireEvent | null {
  const L = w.L;
  if (!isBurnable(w, i) || L.town[i] > 0) return null;
  const x = i % w.W,
    y = (i / w.W) | 0;
  const fe: FireEvent = {
    id: w.nextId(),
    name: fireName(w, x, y),
    cause,
    originX: x,
    originY: y,
    startDay: w.day,
    detected: cause === 'prescribed' || cause === 'pile',
    detectedDay: cause === 'prescribed' || cause === 'pile' ? w.day : -1,
    detectedBy: cause === 'prescribed' || cause === 'pile' ? 'crew' : '',
    response: defaultResponse(w, i, cause),
    active: true,
    outDay: -1,
    area: 0,
    burning: 0,
    crownArea: 0,
    highSeverity: 0,
    lowSeverity: 0,
    structuresLost: 0,
    maxIntensity: 0,
    cost: 0,
    projectId,
    containment: 0,
    minX: x,
    minY: y,
    maxX: x,
    maxY: y,
    threatenedTowns: [],
    spotFires: 0,
  };
  w.fires.push(fe);
  const f = cellFuel(w, i, tmpFuel);
  const [I0, crown] = ignitionIntensity(w, i, f, w.weather.windSpeed * 0.5, 1, 0);
  igniteCell(w, i, fe, smolder ? 0.06 : Math.max(0.12, I0), smolder ? false : crown);
  if (smolder) L.ftime[i] = 24 + w.rng.fire.range(24, 96);
  fe.burning = 1;
  w.dirty.fire++;
  return fe;
}

// ---------------------------------------------------------------- sub-step
export interface FireStepHooks {
  onDetect?: (fe: FireEvent) => void;
  onStructureLost?: (townId: number, cell: number, fe: FireEvent) => void;
  onCrown?: (fe: FireEvent, cell: number) => void;
  onSpot?: (fe: FireEvent, cell: number, crossed: boolean) => void;
  onEscape?: (fe: FireEvent) => void;
  onEnd?: (fe: FireEvent) => void;
}

/**
 * Time for fire to cross from one cell into a neighbour: Erlang(k) with the given mean.
 * With exponential times (k = 1, v1.0) first-passage over many competing paths made the simulated
 * front run up to ~3.7x faster than the rate formula in light wind and ~1.2x in strong wind, so the
 * model's rates were not physical rates. A shape of 4 keeps the stochastic roughness that hides the
 * grid's octagonal bias while the front advances close to the specified rate of spread.
 */
export const TRAVEL_SHAPE = 4;
function travelTime(r: { next(): number }, mean: number): number {
  let p = 1;
  for (let k = 0; k < TRAVEL_SHAPE; k++) p *= 1 - r.next();
  return (-Math.log(p) * mean) / TRAVEL_SHAPE;
}

// Event queue for within-step spread (stochastic minimum travel time).
const evHeap = new MinHeap(4096);
let evTarget = new Int32Array(4096);
let evSource = new Int32Array(4096);
let evKind = new Uint8Array(4096); // 0 = surface/crown spread, 1 = ember, 2 = structure
let evCount = 0;
function pushEvent(t: number, target: number, source: number, kind: number): void {
  if (evCount >= evTarget.length) {
    const n = evTarget.length * 2;
    const a = new Int32Array(n);
    a.set(evTarget);
    evTarget = a;
    const b = new Int32Array(n);
    b.set(evSource);
    evSource = b;
    const c = new Uint8Array(n);
    c.set(evKind);
    evKind = c;
  }
  evTarget[evCount] = target;
  evSource[evCount] = source;
  evKind[evCount] = kind;
  evHeap.push(t, evCount++);
}

interface StepCtx {
  w: World;
  hooks: FireStepHooks;
  fireById: Map<number, FireEvent>;
  windEff: number;
  wdx: number;
  wdy: number;
  fmAdd: number;
  spread: number;
}

// ---------------------------------------------------------------- surface rate of spread
/*
 * Surface spread (v1.1). v1.0 tied the base rate to a smoothstep of fine-fuel LOAD (up to 6 t/ha),
 * so light, fast cured grass (≤ 2.6 t/ha) ran at a few metres per hour — slower than closed fir
 * litter and 1–2 orders of magnitude below observed grass fires, while crown fire ran at realistic
 * speeds (audit: grass 40 m/h at 6 m/s wind; dense fir out-ran grass 3.6–6.9×).
 *
 * Rate now depends on fuel TYPE (fineness and bed structure), as in the fire-behaviour literature:
 *  - cured grass: CSIRO grassland head-fire model (Cheney, Gould & Catchpole 1998), open 10 m wind;
 *  - shrub: Rothermel-type response to mid-flame wind, fitted to fuel model 5 (Anderson 1982);
 *  - litter: same form, fitted between fuel models 8 (short-needle, compact) and 9 (long-needle pine);
 * weighted by each component's share of the fine fuel; load only matters through continuity
 * (sparse fuel does not carry). Mid-flame wind = 10 m wind × a wind adjustment factor that falls
 * from 0.4 in the open to 0.12 under a closed canopy.
 *
 * KE_* are explicit effective-rate factors for heterogeneity a 1-ha cell cannot resolve (rock,
 * bare patches, green swales, trails, partly cured grass, broken litter). They are calibration
 * choices, documented with their sensitivity in docs/FIRE_MODEL.md. KE_GRASS = 0.2 scales the CSIRO
 * model (calibrated on continuous pasture) to sparse mountain bunchgrass, comparable to Scott &
 * Burgan's GR1–GR2 dry-climate grass models (~0.5–1.6 km/h at a 6–7 mph mid-flame wind).
 *
 * Direction: the head rate is distributed around an ellipse whose length-to-breadth ratio grows with
 * wind (Alexander 1985 for forest fuels; Cheney & Sullivan for grass): R(θ) = R_head (1−e)/(1−e cosθ).
 * Crown-fire rates (already realistic in v1.0) are unchanged.
 */
export const KE_GRASS = 0.2;
export const KE_SHRUB = 0.5;
export const KE_LITTER = 0.6;
/**
 * v1.0's crown-rate formula was tuned under exponential travel times, whose first-passage speed-up
 * (~1.9x for crown runs) is gone with Erlang(4) times; this restores the same observed crown-fire
 * front speeds (fire lab: ~1–2 km/h at 12–15 m/s), which the audit found realistic.
 */
export const CROWN_SCALE = 3.0;

/** CSIRO grassland head-fire rate (km/h), fully cured, before moisture; u10 = open 10 m wind in km/h. */
export function grassHeadRateKmh(u10: number): number {
  return u10 < 5 ? 0.054 + 0.269 * u10 : 1.4 + 0.838 * Math.pow(u10 - 5, 0.844);
}

/** Length-to-breadth ratio of a wind-driven fire (u10 in km/h), blended by the grass share of the fuel. */
export function lengthToBreadth(u10: number, grassShare: number): number {
  const forest = 1 + 8.729 * Math.pow(1 - Math.exp(-0.03 * u10), 2.155);
  const grass = u10 < 5 ? 1 : 1.1 * Math.pow(u10, 0.464);
  return Math.min(8, Math.max(1, forest + (grass - forest) * grassShare));
}

/** Wind adjustment factor: 10 m open wind → mid-flame wind, from open ground to closed canopy. */
export function windAdjustment(canopyCover: number): number {
  return 0.4 - 0.28 * Math.min(1, canopyCover);
}

/**
 * Dry, flat head-fire rate of spread (m/h) in cell n for a 10 m wind of `u10` m/s, before moisture
 * damping, slope and the diurnal cycle. `f` must hold cellFuel(w, n).
 */
export function surfaceHeadRate(w: World, n: number, f: CellFuel, u10: number): number {
  const L = w.L;
  if (f.fine < 0.3) return 0;
  const can = L.pine[n] + L.fir[n] + L.aspen[n] * 0.6;
  const waf = windAdjustment(can);
  const midMph = u10 * waf * 2.237;
  const windTerm = Math.pow(midMph, 1.4);
  // grass under trees feels the reduced wind too (timber–grass understory burns slower than open grass)
  const grassU = u10 * (waf / 0.4) * 3.6;
  const rGrass = 1000 * grassHeadRateKmh(grassU) * KE_GRASS;
  const rShrub = 40 * (1 + 0.85 * windTerm) * KE_SHRUB;
  // long-needle pine litter is fluffy and fast; short fir/spruce needles pack tight; aspen leaf litter is slow
  const conifer = L.pine[n] + L.fir[n];
  const pineFrac = conifer > 0.02 ? L.pine[n] / conifer : 0.5;
  const leafy = can > 0.02 ? (L.aspen[n] * 0.6) / can : 0;
  const r0Litter = (6 + 18 * pineFrac) * (1 - 0.5 * leafy);
  const rLitter = r0Litter * (1 + 0.55 * windTerm) * KE_LITTER;
  const shrubFine = L.shrub[n] * 2.4 * (1 - 0.45 * f.green);
  const sShare = Math.min(1 - f.grassShare, shrubFine / f.fine);
  const lShare = Math.max(0, 1 - f.grassShare - sShare);
  const continuity = smoothstep(0.3, 2.0, f.fine);
  return (f.grassShare * rGrass + sShare * rShrub + lShare * rLitter) * continuity;
}

/** Rate of spread (cells/hour) from burning cell b into neighbour n (direction d). */
function spreadRate(ctx: StepCtx, b: number, n: number, d: number, vigor: number, crownSrc: boolean): number {
  const w = ctx.w;
  const L = w.L;
  const f = tmpFuel;
  cellFuel(w, n, f);
  if (f.fine < 0.3) return 0;
  const fm = Math.max(0.02, L.fm[n] + ctx.fmAdd + f.green * (0.06 + 0.06 * f.grassShare));
  // cured grass has a low moisture of extinction; litter and duff a higher one
  const mx = 0.15 + 0.13 * (1 - f.grassShare);
  const damp = moistureDamping(fm / mx);
  if (damp <= 0 && !crownSrc) return 0;
  const dist = DIST8[d];
  const cosT = (DX8[d] * ctx.wdx + DY8[d] * ctx.wdy) / dist;
  const tanPhi = (L.elev[n] - L.elev[b]) / (dist * 100);
  const sf = tanPhi > 0 ? Math.exp(3.2 * Math.min(tanPhi, 0.8)) : Math.exp(1.2 * Math.max(tanPhi, -0.8));
  // elliptical distribution of the head rate around the wind direction
  const LB = lengthToBreadth(ctx.windEff * 3.6, f.grassShare);
  const e = Math.sqrt(1 - 1 / (LB * LB));
  const dir = (1 - e) / (1 - e * cosT);
  // m/h → cells/h
  let R = (surfaceHeadRate(w, n, f, ctx.windEff) / 100) * damp * dir * sf * ctx.spread;
  if (crownSrc && f.canopy > 0.3) {
    const canopyCov = L.pine[n] + L.fir[n] + L.aspen[n] * 0.6;
    const windMid = ctx.windEff * (1 - 0.55 * Math.min(1, canopyCov));
    // head rate as in v1.0, distributed on a wind ellipse (v1.0's lateral crown rate grew with wind
    // too, so crown fires were nearly circular and burned ~4x the area of a real crown run)
    const wfHead = Math.exp(0.22 * windMid);
    // (capped at 5:1: spotting and wind shifts keep real crown runs wider than the ideal ellipse)
    const LBc = Math.min(5, lengthToBreadth(ctx.windEff * 3.6, 0));
    const ec = Math.sqrt(1 - 1 / (LBc * LBc));
    const crownDamp = clamp01(1 - fm / 0.2) * (1 - 0.55 * f.green * (1 - f.grassShare));
    const Rc =
      CROWN_SCALE * (0.1 + 0.12 * ctx.windEff) * crownDamp * f.canopy * Math.pow(wfHead, 0.6) * Math.pow(sf, 0.7) * ((1 - ec) / (1 - ec * cosT));
    R = Math.max(R, Rc * (1 - 0.5 * L.fline[n]));
  } else {
    R *= 1 - L.fline[n];
  }
  R *= (1 - 0.9 * L.retard[n]) * (1 - L.wet[n]);
  if (L.infra[n] & INFRA.ROAD) R *= 0.5;
  if (L.infra[n] & INFRA.FUELBREAK) R *= 0.35;
  const acc = L.flowAcc[n];
  if (acc > 1000) R *= crownSrc ? 0.4 : 0.12;
  else if (acc > 300) R *= 0.6;
  return R * vigor;
}

/** Queue spread, structure and ember events out of cell b, which started burning at time t0. */
function scheduleFrom(ctx: StepCtx, b: number, t0: number, vigor: number): void {
  const w = ctx.w;
  const L = w.L;
  const r = w.rng.fire;
  const W = w.W,
    H = w.H;
  const bx = b % W,
    by = (b / W) | 0;
  const isStructure = L.town[b] > 0;
  const crownSrc = L.crown[b] === 1;
  const remaining = HOURS - t0;
  if (remaining <= 0) return;
  for (let d = 0; d < 8; d++) {
    const nx = bx + DX8[d],
      ny = by + DY8[d];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const n = ny * W + nx;
    if (L.fire[n] !== FIRE.NONE) continue;
    if (L.water[n] >= 2 || L.pond[n] > 0.35) continue;
    if (L.town[n] > 0) {
      // radiant heat and embers from neighbouring fire onto houses
      const town = w.towns[L.town[n] - 1];
      const fw = town ? town.firewise : 0;
      const p = (isStructure ? 0.16 : 0.1 * L.fint[b] * (crownSrc ? 2 : 1)) * (1 - 0.75 * fw) * (1 - structureProtection(w, n));
      if (p > 0) {
        const rate = -Math.log(1 - Math.min(0.999, p)) / HOURS;
        const tau = r.exponential(1 / rate);
        if (tau < remaining) pushEvent(t0 + tau, n, b, 2);
      }
      continue;
    }
    if (isStructure) continue; // houses spread to houses and by embers
    const R = spreadRate(ctx, b, n, d, vigor, crownSrc);
    if (R <= 0) continue;
    // a road or fuel break stops a surface fire unless it is pushed across by wind or intensity
    // (v1.0 only halved the rate, which stops nothing once grass runs at realistic speed)
    if (!crownSrc && L.infra[n] & (INFRA.ROAD | INFRA.FUELBREAK)) {
      const cosW = (DX8[d] * ctx.wdx + DY8[d] * ctx.wdy) / DIST8[d];
      // (per attempt; a long front makes many attempts, so a light-wind fire crosses only rarely
      // while a wind-driven head fire still gets across)
      const push = smoothstep(3, 12, ctx.windEff * Math.max(0, cosW)) * 0.5 + smoothstep(0.3, 0.9, L.fint[b]) * 0.4;
      const breach = clamp01(0.004 + push) * (L.infra[n] & INFRA.FUELBREAK ? 0.6 : 1);
      if (r.next() >= breach) continue;
    }
    const tau = travelTime(r, DIST8[d] / R);
    if (tau < remaining) pushEvent(t0 + tau, n, b, 0);
  }
  // ember spotting from intense fire
  const Ib = L.fint[b];
  const windEff = ctx.windEff;
  if ((Ib > 0.75 || crownSrc || isStructure) && windEff > 2) {
    const frac = remaining / HOURS;
    const embers = r.poisson(0.09 * Ib * (windEff / 4) * (crownSrc ? 1.6 : 1) * frac);
    const wx = w.weather;
    for (let e = 0; e < embers; e++) {
      const dist = windEff * (0.12 + 0.55 * r.next()) * (crownSrc ? 1.25 : 0.6);
      const ang = wx.windDir + r.normal(0, 0.28);
      const sx = Math.round(bx + Math.cos(ang) * dist),
        sy = Math.round(by + Math.sin(ang) * dist);
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const s = sy * W + sx;
      if (L.fire[s] !== FIRE.NONE || L.water[s] >= 2 || L.pond[s] > 0.35) continue;
      pushEvent(t0 + r.range(0.1, 0.4) + r.next() * (remaining - 0.4 > 0 ? remaining - 0.4 : 0), s, b, 1);
    }
  }
}

export function fireSubstep(w: World, hooks: FireStepHooks = {}): void {
  if (w.burning.length === 0) return;
  const L = w.L;
  const r = w.rng.fire;
  const wx = w.weather;
  const di = diurnal(w.sub);
  const windEff = wx.windSpeed * di.wind;
  const fireById = new Map<number, FireEvent>();
  for (const fe of w.fires) if (fe.active) fireById.set(fe.id, fe);
  const ctx: StepCtx = {
    w,
    hooks,
    fireById,
    windEff,
    wdx: Math.cos(wx.windDir),
    wdy: Math.sin(wx.windDir),
    fmAdd: di.fmAdd,
    spread: di.spread,
  };
  const f = tmpFuel;

  // deterministic order
  w.burning.sort((a, b) => a - b);
  const starts = pendingStart.get(w);
  const prior = w.burning.slice();
  evHeap.clear();
  evCount = 0;

  // 1. cells already burning: flare-ups, then schedule their spread for this step
  for (const b of prior) {
    if (L.fire[b] !== FIRE.BURNING) continue;
    if (!fireById.has(L.fid[b])) continue;
    const isStructure = L.town[b] > 0;
    // a flaming front spreads at full rate; smouldering edges creep
    let vigor = L.fphase[b] === 0 ? 1 : 0.3;
    // smouldering holdovers can flare when it dries out and the wind picks up
    if (L.fphase[b] === 1 && !isStructure) {
      const dryness = clamp01((0.16 - (L.fm[b] + di.fmAdd)) / 0.1);
      if (r.next() < 0.05 * dryness * (0.5 + windEff / 8)) {
        cellFuel(w, b, f);
        const [I] = ignitionIntensity(w, b, f, windEff * 0.6, 1, di.fmAdd);
        L.fint[b] = Math.max(L.fint[b], I);
        L.fpeak[b] = Math.max(L.fpeak[b], L.fint[b]);
        L.fphase[b] = 0;
        vigor = 1;
      }
    }
    scheduleFrom(ctx, b, starts?.get(b) ?? 0, vigor);
  }
  starts?.clear();

  // 2. process ignition events in arrival-time order; new fires spread on within the step
  let guard = 0;
  while (evHeap.size > 0 && guard++ < 400000) {
    const t = evHeap.peekKey();
    const e = evHeap.pop();
    const n = evTarget[e],
      src = evSource[e],
      kind = evKind[e];
    if (L.fire[n] !== FIRE.NONE) continue;
    const fe = fireById.get(L.fid[src]);
    if (!fe) continue;
    if (kind === 2) {
      igniteStructure(w, n, fe);
      scheduleFrom(ctx, n, t, 1);
      continue;
    }
    const sx = src % w.W,
      sy = (src / w.W) | 0;
    const nx = n % w.W,
      ny = (n / w.W) | 0;
    if (kind === 1) {
      // ember landing: needs receptive dry fine fuel
      if (L.town[n] > 0) {
        const town = w.towns[L.town[n] - 1];
        const p = 0.22 * (1 - 0.75 * (town ? town.firewise : 0)) * (1 - structureProtection(w, n));
        if (r.next() < p) {
          igniteStructure(w, n, fe);
          scheduleFrom(ctx, n, t, 1);
        }
        continue;
      }
      cellFuel(w, n, f);
      const fm = L.fm[n] + di.fmAdd;
      const recept = Math.pow(clamp01(1 - fm / 0.17), 2) * smoothstep(1, 6, f.fine) * (1 - L.wet[n]) * (1 - 0.8 * L.retard[n]);
      if (r.next() >= recept * 0.55) continue;
      const crossed = crossesBarrier(w, src, n);
      const [I, crown] = ignitionIntensity(w, n, f, windEff * 0.6, 1, di.fmAdd);
      igniteCell(w, n, fe, Math.max(0.1, I * 0.7), crown && r.next() < 0.5);
      fe.spotFires++;
      if (hooks.onSpot) hooks.onSpot(fe, n, crossed);
      checkEscape(w, fe, n, hooks);
      scheduleFrom(ctx, n, t, 1);
      continue;
    }
    // surface / crown spread from an adjacent cell
    cellFuel(w, n, f);
    const canopyCov = L.pine[n] + L.fir[n] + L.aspen[n] * 0.6;
    const windMid = windEff * (1 - 0.55 * Math.min(1, canopyCov));
    const dist = Math.hypot(nx - sx, ny - sy) || 1;
    const tanPhi = (L.elev[n] - L.elev[src]) / (dist * 100);
    const sf = tanPhi > 0 ? Math.exp(3.2 * Math.min(tanPhi, 0.8)) : Math.exp(1.2 * Math.max(tanPhi, -0.8));
    const [I, crown] = ignitionIntensity(w, n, f, windMid, sf, di.fmAdd);
    igniteCell(w, n, fe, Math.max(0.08, I), crown);
    if (crown && hooks.onCrown) hooks.onCrown(fe, n);
    checkEscape(w, fe, n, hooks);
    scheduleFrom(ctx, n, t, 1);
  }

  // 3. smoke, and burn-down of cells that were already burning at the start of the step
  const burnedOut: number[] = [];
  const floor = 0.06 + 0.07 * droughtSeverity(w.climate.droughtIndex);
  for (const b of prior) {
    if (L.fire[b] !== FIRE.BURNING) continue;
    if (!fireById.has(L.fid[b])) {
      burnedOut.push(b);
      continue;
    }
    const isStructure = L.town[b] > 0;
    cellFuel(w, b, f);
    L.smoke[b] = Math.min(4, L.smoke[b] + 0.05 * Math.min(1.6, L.fint[b]) * (1 + (f.fine + 0.25 * f.heavy) / 12) * (isStructure ? 2 : 1));
    // the flaming front passes within a few hours; heavy fuels and duff smoulder on,
    // unless damp air settles in and the fire "goes to sleep"
    L.ftime[b] -= HOURS;
    if (!isStructure) {
      if (L.fphase[b] === 0) {
        // the front has passed: drop to smouldering
        L.fphase[b] = 1;
        L.fint[b] = Math.min(L.fint[b], floor);
      }
      const damp = L.fm[b] + di.fmAdd - 0.14;
      if (damp > 0) L.ftime[b] -= damp * 60;
    }
    if (L.ftime[b] <= 0) burnedOut.push(b);
  }
  // newly ignited cells emit smoke too
  for (let k = prior.length; k < w.burning.length; k++) {
    const b = w.burning[k];
    L.smoke[b] = Math.min(4, L.smoke[b] + 0.04 * Math.min(1.6, L.fint[b]));
  }
  for (const b of burnedOut) burnout(w, b, fireById.get(L.fid[b]), hooks);
  if (burnedOut.length) w.burning = w.burning.filter((c) => L.fire[c] === FIRE.BURNING);
  updateFireEvents(w, hooks);
  w.dirty.fire++;
}

function crossesBarrier(w: World, a: number, b: number): boolean {
  // sample the straight line between the source and landing cells
  const W = w.W;
  const ax = a % W,
    ay = (a / W) | 0,
    bx = b % W,
    by = (b / W) | 0;
  const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
  for (let k = 1; k < n; k++) {
    const x = Math.round(ax + ((bx - ax) * k) / n),
      y = Math.round(ay + ((by - ay) * k) / n);
    const i = y * W + x;
    if (w.L.water[i] >= 2 || w.L.flowAcc[i] > 1000 || w.L.fline[i] > 0.5 || w.L.infra[i] & (INFRA.ROAD | INFRA.FUELBREAK)) return true;
  }
  return false;
}

/** Engines protecting a town reduce the chance houses catch. */
export function structureProtection(w: World, i: number): number {
  const x = i % w.W,
    y = (i / w.W) | 0;
  let p = 0;
  for (const c of w.crews) {
    if (c.kind !== 'engine' || c.state !== 'working') continue;
    const d = Math.hypot(c.x - x - 0.5, c.y - y - 0.5);
    if (d < 5) p = Math.max(p, 0.7 * (1 - d / 6));
  }
  return p;
}

function igniteStructure(w: World, i: number, fe: FireEvent): void {
  const L = w.L;
  L.fire[i] = FIRE.BURNING;
  L.fid[i] = fe.id;
  L.fint[i] = 1.2;
  L.fphase[i] = 0;
  L.crown[i] = 0;
  L.ftime[i] = 6;
  w.burning.push(i);
  extendFireBounds(w, fe, i);
  const tid = L.town[i] - 1;
  if (tid >= 0 && !fe.threatenedTowns.includes(tid)) fe.threatenedTowns.push(tid);
}

/** Prescribed burns that spread outside their unit become escapes. */
function checkEscape(w: World, fe: FireEvent, cell: number, hooks: FireStepHooks): void {
  if (fe.cause !== 'prescribed' || fe.projectId < 0) return;
  const pr = w.projects.find((p) => p.id === fe.projectId);
  if (!pr) return;
  if (!projectContains(w, pr.id, cell)) {
    fe.cause = 'escaped';
    fe.response = 'suppress';
    fe.name = fe.name.replace(/ Fire$/, ' Escape');
    w.counters.yearEscapes++;
    w.memory.totalEscapes = (w.memory.totalEscapes ?? 0) + 1;
    if (hooks.onEscape) hooks.onEscape(fe);
  }
}

// per-world cache of project unit membership (ids restart in every new game)
const projectSets = new WeakMap<World, Map<number, Set<number>>>();
/** Call after changing a project's unit so the membership cache follows it. */
export function forgetProjectUnit(w: World, projectId: number): void {
  projectSets.get(w)?.delete(projectId);
}
export function projectContains(w: World, projectId: number, cell: number): boolean {
  let m = projectSets.get(w);
  if (!m) {
    m = new Map();
    projectSets.set(w, m);
  }
  let s = m.get(projectId);
  if (!s) {
    const pr = w.projects.find((p) => p.id === projectId);
    s = new Set(pr ? pr.unit : []);
    m.set(projectId, s);
  }
  return s.has(cell);
}

// ---------------------------------------------------------------- burnout
function burnout(w: World, i: number, fe: FireEvent | undefined, hooks: FireStepHooks): void {
  const L = w.L;
  const crown = L.crown[i] === 1;
  L.fire[i] = FIRE.BURNT;
  if (L.town[i] > 0) {
    // a structure lost
    const tid = loseStructure(w, i);
    if (fe) {
      fe.structuresLost++;
      if (hooks.onStructureLost) hooks.onStructureLost(tid, i, fe);
    } else {
      // no live fire owns this cell any more: nothing will release it, so do it now
      L.fire[i] = FIRE.NONE;
      L.fid[i] = -1;
    }
    return;
  }
  // severity from the peak behaviour of this burn
  const peak = L.fpeak[i];
  const sev = crown ? 3 : peak > 0.62 ? 2 : 1;
  L.fpeak[i] = 0;
  applyFireEffects(w, i, sev);
  if (fe) {
    if (sev === 3) fe.highSeverity++;
    else if (sev === 1) fe.lowSeverity++;
  }
  if (!fe) {
    L.fire[i] = FIRE.NONE;
    L.fid[i] = -1;
  }
  w.counters.yearBurned++;
  w.counters.totalBurned++;
  if (sev === 3) {
    w.counters.yearBurnedHigh++;
    w.counters.totalHighSeverity++;
  }
}

/** Ecological effects of fire on a cell (also used by tests and pile burns). */
export function applyFireEffects(w: World, i: number, sev: number): void {
  const L = w.L;
  const s = sev / 3;
  const bio = (cov: number, age: number, b: number) => cov * b * Math.min(1, 0.15 + age / 90);
  // trees
  const aKeep = L.ageA[i] < 15 ? 0 : sev === 1 ? 0.7 : sev === 2 ? 0.25 : 0;
  const pMature = L.ageP[i] > 40;
  const pKeep = pMature ? (sev === 1 ? 0.93 : sev === 2 ? 0.6 : 0.02) : sev === 1 ? 0.4 : sev === 2 ? 0.08 : 0;
  const fKeep = sev === 1 ? 0.35 : sev === 2 ? 0.08 : 0;
  const killed = bio(L.aspen[i] * (1 - aKeep), L.ageA[i], 130) + bio(L.pine[i] * (1 - pKeep), L.ageP[i], 240) + bio(L.fir[i] * (1 - fKeep), L.ageF[i], 220);
  L.aspen[i] *= aKeep;
  L.pine[i] *= pKeep;
  L.fir[i] *= fKeep;
  if (L.aspen[i] < 1e-3) L.ageA[i] = 0;
  if (L.fir[i] < 1e-3) L.ageF[i] = 0;
  if (L.pine[i] < 1e-3) L.ageP[i] = 0;
  // young fir and pine thin out under surface fire → the stand opens up
  if (sev === 1 && L.ageF[i] < 40) L.fir[i] *= 0.4;
  L.snag[i] = L.snag[i] * (1 - 0.15 * s) + killed * (sev === 3 ? 0.9 : 1);
  // surface fuels consumed
  L.litter[i] *= sev === 1 ? 0.25 : sev === 2 ? 0.12 : 0.05;
  L.dead[i] *= 1 - 0.3 * s;
  L.red[i] *= sev >= 2 ? 0 : 0.4;
  L.slash[i] *= 0.1;
  L.shrub[i] *= 0.45 - 0.12 * sev;
  L.grass[i] *= sev === 3 ? 0.2 : 0.45;
  L.beetle[i] = 0;
  // soil: ash pulse, water repellency after severe fire, organic loss
  L.fert[i] = clamp01(L.fert[i] + 0.18 * sev);
  if (sev >= 2) L.hydro[i] = Math.max(L.hydro[i], sev === 3 ? 0.75 : 0.3);
  L.soil[i] = Math.max(0.05, L.soil[i] - 0.008 * sev);
  // aspen clones are stimulated to sucker
  if (L.aroot[i] > 0.05) L.aroot[i] = clamp01(L.aroot[i] + 0.1);
  L.lastBurn[i] = w.yearF;
  L.burnSev[i] = sev;
  L.burnCount[i]++;
  L.fint[i] = 0;
  L.ftime[i] = 0;
  L.crown[i] = 0;
  w.dirty.veg++;
}

// ---------------------------------------------------------------- events
/**
 * Tenure statistics kept as running totals, because saves keep only the 400 most recent finished
 * fires: v1.0 derived the epilogue's wildfire count and largest fire from that trimmed list, so they
 * changed after a reload in long tenures (D16).
 */
function recordFireEnd(w: World, fe: FireEvent): void {
  if (fe.cause === 'prescribed' || fe.cause === 'pile') return;
  const m = w.memory;
  m.wildfireCount = (m.wildfireCount ?? 0) + 1;
  if (!m.largestWildfire || fe.area > m.largestWildfire.area)
    m.largestWildfire = { name: fe.name, area: fe.area, startDay: fe.startDay, structuresLost: fe.structuresLost };
}

/** Keep every active fire and the 400 most recent finished ones, in order (bounded saves). */
export function pruneFires(w: World): void {
  let inactive = 0;
  for (const f of w.fires) if (!f.active) inactive++;
  if (inactive <= 450) return;
  let drop = inactive - 400;
  w.fires = w.fires.filter((f) => f.active || drop-- <= 0);
}

function updateFireEvents(w: World, hooks: FireStepHooks): void {
  let pruned = false;
  const L = w.L;
  const counts = new Map<number, number>();
  for (const b of w.burning) counts.set(L.fid[b], (counts.get(L.fid[b]) ?? 0) + 1);
  for (const fe of w.fires) {
    if (!fe.active) continue;
    fe.burning = counts.get(fe.id) ?? 0;
    if (fe.burning === 0) {
      fe.active = false;
      fe.outDay = w.day;
      recordFireEnd(w, fe);
      pruned = true;
      // release burnt cells
      for (let y = fe.minY; y <= fe.maxY; y++)
        for (let x = fe.minX; x <= fe.maxX; x++) {
          const i = y * w.W + x;
          if (L.fid[i] === fe.id) {
            if (L.fire[i] === FIRE.BURNT) L.fire[i] = FIRE.NONE;
            L.fid[i] = -1;
          }
        }
      if (hooks.onEnd) hooks.onEnd(fe);
    } else {
      fe.containment = containment(w, fe);
    }
  }
  if (pruned) pruneFires(w);
}

/** Fraction of the active perimeter that is blocked by line, retardant or barriers. */
export function containment(w: World, fe: FireEvent): number {
  const L = w.L;
  let edge = 0,
    held = 0;
  for (const b of w.burning) {
    if (L.fid[b] !== fe.id) continue;
    const bx = b % w.W,
      by = (b / w.W) | 0;
    for (let d = 0; d < 8; d += 2) {
      const nx = bx + DX8[d],
        ny = by + DY8[d];
      if (!w.inside(nx, ny)) continue;
      const n = ny * w.W + nx;
      if (L.fire[n] !== FIRE.NONE) continue;
      edge++;
      const blocked =
        L.water[n] >= 2 || L.fline[n] > 0.6 || L.retard[n] > 0.5 || L.wet[n] > 0.6 || L.flowAcc[n] > 1000 || cellFuel(w, n, tmpFuel).fine < 0.8;
      if (blocked) held++;
    }
  }
  return edge === 0 ? 1 : held / edge;
}

// ---------------------------------------------------------------- daily processes
interface IgnitionCache {
  version: number;
  cum: Float64Array;
  cells: Int32Array;
  total: number;
}
const ignCache = new WeakMap<World, IgnitionCache>();

/** Human activity weights: roads, campgrounds, recreation, town edges, logging. */
function humanActivity(w: World): IgnitionCache {
  const version = w.dirty.infra * 1000 + w.dirty.zone;
  const c = ignCache.get(w);
  if (c && c.version === version) return c;
  const L = w.L;
  const cells: number[] = [];
  const weights: number[] = [];
  for (let i = 0; i < w.N; i++) {
    if (L.water[i] >= 2 || L.town[i] > 0) continue;
    let wt = 0;
    if (L.infra[i] & INFRA.ROAD) wt += 1;
    if (L.infra[i] & INFRA.CAMP) wt += 10;
    if (L.zone[i] === ZONE.RECREATION) wt += 0.35;
    if (L.zone[i] === ZONE.TIMBER) wt += 0.08;
    if (L.zone[i] === ZONE.RANGE) wt += 0.05;
    // town fringe
    const x = i % w.W,
      y = (i / w.W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d] * 2,
        ny = y + DY8[d] * 2;
      if (w.inside(nx, ny) && L.town[ny * w.W + nx] > 0) {
        wt += 0.6;
        break;
      }
    }
    if (wt > 0) {
      cells.push(i);
      weights.push(wt);
    }
  }
  const cum = new Float64Array(weights.length);
  let s = 0;
  for (let k = 0; k < weights.length; k++) {
    s += weights[k];
    cum[k] = s;
  }
  const nc = { version, cum, cells: Int32Array.from(cells), total: s };
  ignCache.set(w, nc);
  return nc;
}

function sampleActivity(c: IgnitionCache, u: number): number {
  const target = u * c.total;
  let lo = 0,
    hi = c.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c.cum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return c.cells[lo];
}

export function fireBanActive(w: World): boolean {
  const p = w.policies.fireBan;
  if (p === 'never') return false;
  if (p === 'summer') return w.season === 1 || w.weather.dangerClass >= 3;
  return w.weather.dangerClass >= 3;
}

export function dailyIgnitions(w: World): FireEvent[] {
  const L = w.L;
  const r = w.rng.fire;
  const wx = w.weather;
  const started: FireEvent[] = [];
  // lightning
  if (wx.strikes > 0) {
    let lo = Infinity,
      hi = -Infinity;
    for (let k = 0; k < 200; k++) {
      const e = L.elev[r.int(w.N)];
      lo = Math.min(lo, e);
      hi = Math.max(hi, e);
    }
    for (let s = 0; s < wx.strikes; s++) {
      let i = -1;
      for (let t = 0; t < 20; t++) {
        const c = r.int(w.N);
        const rel = (L.elev[c] - lo) / Math.max(1, hi - lo);
        if (r.next() < 0.25 + 0.75 * rel) {
          i = c;
          break;
        }
      }
      if (i < 0 || !isBurnable(w, i) || L.town[i] > 0) continue;
      const f = cellFuel(w, i, tmpFuel);
      const dry = clamp01((0.22 - L.fm[i]) / 0.13);
      const fuelOK = smoothstep(1.5, 8, f.fine + f.heavy * 0.1);
      const p = dry * fuelOK * (wx.dryLightning ? 0.22 : 0.04);
      if (r.next() < p) {
        const smolder = r.next() < 0.3;
        const fe = startFire(w, i, 'lightning', -1, smolder);
        if (fe) {
          started.push(fe);
          setIgnitionOffset(w, i, r.range(0, HOURS));
        }
      }
    }
  }
  // human ignitions
  const act = humanActivity(w);
  if (act.total > 0 && w.season !== 3) {
    const visitors = w.season === 1 ? 1.4 : 0.8;
    const ban = fireBanActive(w);
    const lambda = 0.024 * visitors * (ban ? 0.25 : 1) * clamp01((wx.danger + 0.05) * 1.2) * (1 + w.population / 6000);
    const n = r.poisson(lambda);
    for (let k = 0; k < n; k++) {
      const i = sampleActivity(act, r.next());
      if (!isBurnable(w, i)) continue;
      const f = cellFuel(w, i, tmpFuel);
      const p = clamp01((0.17 - L.fm[i]) / 0.09) * smoothstep(1, 5, f.fine);
      if (r.next() < p) {
        const fe = startFire(w, i, 'human');
        if (fe) {
          started.push(fe);
          setIgnitionOffset(w, i, r.range(0, HOURS));
        }
      }
    }
  }
  return started;
}

/** Rain and snow damp or extinguish fires. */
export function weatherOnFires(w: World): void {
  const L = w.L;
  const p = w.weather.precip;
  if (p < 1.5 || w.burning.length === 0) return;
  const snow = w.weather.temp < 0.5;
  for (const b of w.burning) {
    if (L.town[b] > 0) continue;
    if (p > 8 || (snow && p > 2)) L.ftime[b] = 0;
    else {
      L.ftime[b] -= p * 2.5;
      L.fint[b] *= Math.max(0.15, 1 - p / 10);
    }
  }
}

/** Detection of unreported fires by lookouts, residents, travellers and patrols. */
export function detectFires(w: World, hooks: FireStepHooks): void {
  const r = w.rng.fire;
  const night = w.sub < 2 || w.sub > 6;
  for (const fe of w.fires) {
    if (!fe.active || fe.detected) continue;
    const size = fe.burning + fe.area * 0.25;
    const cx = (fe.minX + fe.maxX) / 2,
      cy = (fe.minY + fe.maxY) / 2;
    let p = 0;
    let by = '';
    for (const t of w.towers) {
      const d = Math.hypot((t % w.W) - cx, ((t / w.W) | 0) - cy);
      if (d < 34) {
        const q = 0.4 * (1 - d / 42) * smoothstep(0, 3, size);
        if (q > p) {
          p = q;
          by = 'lookout';
        }
      }
    }
    let dTown = Infinity;
    for (const t of w.towns) dTown = Math.min(dTown, Math.hypot(t.x - cx, t.y - cy));
    if (dTown < 30) {
      const q = 0.07 * smoothstep(1, 12, size) * (1 - dTown / 32);
      if (q > p) by = 'residents';
      p += q;
    }
    const oi = fe.originY * w.W + fe.originX;
    if (fe.cause === 'human' || w.L.infra[oi] & INFRA.ROAD) {
      p += 0.22;
      if (!by) by = 'passers-by';
    }
    if (w.policies.airPatrol && !night) {
      p += 0.06 * smoothstep(1, 5, size);
      if (!by) by = 'air patrol';
    }
    if (night) p *= 0.5;
    if (size > 70) {
      p = 1;
      by = by || 'a towering smoke column';
    }
    if (r.next() < p) {
      fe.detected = true;
      fe.detectedDay = w.day;
      fe.detectedBy = by || 'a hiker';
      fe.response = fe.inBuffer && fe.cause !== 'prescribed' && fe.cause !== 'pile' ? 'suppress' : defaultResponse(w, oi, fe.cause);
      if (hooks.onDetect) hooks.onDetect(fe);
    }
  }
}

export function anyFireActive(w: World): boolean {
  return w.burning.length > 0;
}

/** Number of distinct active fires. */
export function activeFires(w: World): FireEvent[] {
  return w.fires.filter((f) => f.active);
}
