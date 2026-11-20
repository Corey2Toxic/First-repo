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
import { DX8, DY8, MinHeap, clamp, clamp01, smoothstep } from '../grid.ts';
import { FIRE, INFRA, SUBSTEPS_PER_DAY, ZONE } from '../types.ts';
import type { FireCause, FireEvent, FireResponse } from '../types.ts';
import { cellFuel } from './fuels.ts';
import type { CellFuel } from './fuels.ts';
import { diurnal, droughtSeverity } from './climate.ts';
import { loseStructure } from './towns.ts';
import type { World } from '../world.ts';

const HOURS = 24 / SUBSTEPS_PER_DAY;
const tmpFuel: CellFuel = { fine: 0, grassShare: 0, ladder: 0, canopy: 0, heavy: 0, green: 0 };
const houseFuel: CellFuel = { fine: 0, grassShare: 0, ladder: 0, canopy: 0, heavy: 0, green: 0 };

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
  // Wilderness policy: a lightning fire is left to do its work when the day allows it. (v1.x
  // monitored every wilderness fire whatever the weather, harmless while fires died in a day; a
  // fire now lives for weeks, and one left alone in August at very high danger takes the valley.)
  if (z === ZONE.WILDERNESS && d > 16 && cause === 'lightning' && w.weather.dangerClass <= 2 && !w.weather.windEvent) return 'monitor';
  return 'suppress';
}

// ---------------------------------------------------------------- fire behaviour (v2)
/*
 * Intensity is physical since v2. v1.x used a load-and-dryness proxy (0..~2) that did not know how
 * fast the fire was moving, so a grass head fire running 1.4 km/h read as the mildest fire on the
 * map: crews worked its head, it never scorched a tree, never threw an ember (verification finding
 * R9). Now every cell that ignites gets Byram's fireline intensity from the rate the front arrived at
 * and the fine fuel it consumes,
 *
 *     I = H · w · R        (kW/m; H = 18,000 kJ/kg, w in kg/m², R in m/s)
 *
 * and the layers `fint` / `fpeak` hold FLAME LENGTH IN METRES (Byram 1959 for surface fire, Thomas
 * 1963 for crown fire). Everything that used the proxy reads flame length instead:
 *   crews      direct attack by hand ≤ 1.2 m, by engines ≤ 2.4 m, from the air ≤ 3.4 m (the standard
 *              fire-suppression interpretation chart, Andrews & Rothermel 1982);
 *   crowning   Van Wagner's (1977) initiation criterion: surface intensity against the canopy base
 *              height (from ladder fuels) and foliar moisture;
 *   severity   scorch grows with flame length (cool, moderate, stand-replacing);
 *   embers, houses, smoke: all scale with the flames that are actually there.
 * Because the rate on the flanks and the back of a wind ellipse is a small fraction of the head
 * rate, flanks are cool and workable while the head is not: "anchor and flank" emerges.
 */
/** Low heat of combustion of forest fuels, kJ/kg. */
export const HEAT_YIELD = 18000;
/** Direct-attack limits, metres of flame. */
export const FLAME_LIMIT = { hand: 1.2, engine: 2.4, air: 3.4 } as const;
/** Below this rate (cells/h; 3 m/h) an edge is not an advancing front: it holds or goes out. */
export const R_MIN = 0.03;

/** Fine fuel consumed in the flaming front, kg/m²: the first 6 t/ha in full, deeper litter in part. */
export function frontLoad(fine: number): number {
  const f = Math.min(fine, 25);
  return 0.1 * (Math.min(f, 6) + 0.35 * Math.max(0, f - 6));
}
/** Byram's fireline intensity (kW/m) for a fuel load (kg/m²) and a rate of spread (cells = 100 m per hour). */
export function byramIntensity(loadKgM2: number, rateCellsPerHour: number): number {
  return HEAT_YIELD * loadKgM2 * ((rateCellsPerHour * 100) / 3600);
}
/** Flame length (m) of a surface fire of intensity I (kW/m): Byram (1959). */
export function surfaceFlameLength(I: number): number {
  return 0.0775 * Math.pow(Math.max(0, I), 0.46);
}
/** Flame length (m) of a crown fire: Thomas (1963). */
export function crownFlameLength(I: number): number {
  return 0.0266 * Math.pow(Math.max(0, I), 2 / 3);
}
/** Canopy base height (m) implied by ladder-fuel continuity: ~9 m in open old pine, about half a metre in a thicket. */
export function canopyBaseHeight(ladder: number): number {
  return 0.5 + 9 * Math.pow(1 - clamp01(ladder), 3);
}
/** Van Wagner's (1977) critical surface intensity (kW/m) for crown-fire initiation. */
export function crownInitiationIntensity(cbh: number, foliarMoisturePct: number): number {
  return Math.pow(0.01 * cbh * (460 + 25.9 * foliarMoisturePct), 1.5);
}
/**
 * Van Wagner's critical rate for active crown fire, in cells (100 m) per hour: 3 / CBD m/min, with a
 * canopy bulk density of 0.2 kg/m³ at full crown fuel (0.1-0.15 in a typical closed conifer stand).
 */
export function criticalCrownRate(canopyFuel: number): number {
  return 9 / Math.max(0.05, canopyFuel);
}
/** Foliar moisture (%): lower in drought, far lower in beetle-killed red crowns. */
export function foliarMoistureOf(drought: number, green: number, red: number): number {
  return Math.max(45, 105 - 30 * drought + 12 * green - 60 * Math.min(1, red * 1.5));
}
/** Surface intensity (kW/m) at which the stand in cell i torches; Infinity where there is no canopy to torch. */
export function torchingIntensity(w: World, i: number, f: CellFuel, drought: number = droughtSeverity(w.climate.droughtIndex)): number {
  if (f.canopy <= 0.25) return Infinity;
  return crownInitiationIntensity(canopyBaseHeight(f.ladder), foliarMoistureOf(drought, f.green, w.L.red[i]));
}

const behaviour = { flame: 0, crown: false, intensity: 0 };
/**
 * Behaviour of a front arriving at surface rate `rs` (cells/h) in fuel that puts `load` kg/m2 into
 * the flaming front, under a canopy `canopy` that torches at surface intensity `i0`. `rc` > 0 means
 * it arrives as a crown run at that rate. Returns a shared object: read it before the next call.
 * (The simulation and the projections both come through here.)
 */
export function arrivalBehaviour(load: number, canopy: number, i0: number, rs: number, rc: number): { flame: number; crown: boolean; intensity: number } {
  const Is = byramIntensity(load, rs);
  // torching from below, or a crown run arriving through crowns close enough to carry it (the crown
  // rate falls away in an open canopy: see crownRunRate)
  const crown = canopy > 0.25 && (Is >= i0 || rc > 0);
  if (crown) {
    const I = byramIntensity(load + 1.1 * canopy, Math.max(rs, rc));
    behaviour.intensity = I;
    behaviour.flame = Math.max(3, crownFlameLength(I));
  } else {
    behaviour.intensity = Is;
    behaviour.flame = surfaceFlameLength(Is);
  }
  behaviour.crown = crown;
  return behaviour;
}
/** Behaviour of a front arriving in cell i, whose fuel is `f` (see arrivalBehaviour). */
export function frontBehaviour(w: World, i: number, f: CellFuel, rs: number, rc: number): { flame: number; crown: boolean; intensity: number } {
  return arrivalBehaviour(frontLoad(f.fine), f.canopy, torchingIntensity(w, i, f), rs, rc);
}

/** How long (hours) a cell holds fire once its front has stopped: heavy fuel and duff, more in drought. */
export function holdHours(w: World, i: number, f: CellFuel, crown: boolean): number {
  const d = droughtSeverity(w.climate.droughtIndex);
  return Math.min(96, 4 + w.L.litter[i] * 0.4 + f.heavy * (0.3 + 1.5 * d) + (crown ? 3 : 0));
}

export function igniteCell(w: World, i: number, fe: FireEvent, I: number, crown: boolean): void {
  const L = w.L;
  L.fire[i] = FIRE.BURNING;
  L.fid[i] = fe.id;
  L.fint[i] = I;
  L.fpeak[i] = I;
  L.fphase[i] = 0;
  L.crown[i] = crown ? 1 : 0;
  L.fprog[i] = 0;
  L.fstop[i] = 0;
  const f = cellFuel(w, i, tmpFuel);
  L.ftime[i] = holdHours(w, i, f, crown);
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
    startSub: w.sub,
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
  // a new start is a small, cool fire: it becomes whatever the fuel and weather make of it as it spreads
  igniteCell(w, i, fe, smolder ? 0.1 : 0.4, false);
  if (smolder) {
    // a holdover: it sits in a log or a snag for days and wakes on a dry, windy afternoon
    L.ftime[i] = 24 + w.rng.fire.range(24, 96);
    L.fphase[i] = 1;
  }
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
  /** the fire has gone out; its cells still carry its id (the moment to read its final edge) */
  onEnding?: (fe: FireEvent) => void;
  onEnd?: (fe: FireEvent) => void;
}

/**
 * Time for fire to cross from one cell into a neighbour: Erlang(k) with the given mean.
 * With exponential times (k = 1, v1.0) first-passage over many competing paths made the simulated
 * front run up to ~3.7x faster than the rate formula in light wind and ~1.2x in strong wind, so the
 * model's rates were not physical rates. A shape of 8, with the 16-direction stencil, keeps enough
 * roughness to hide the stencil's polygonal bias while the front advances close to the specified
 * rate whatever the wind direction (with shape 4 the extra fast paths near the diagonals ran ~25 %
 * ahead).
 */
export const TRAVEL_SHAPE = 8;
function travelTime(r: { next(): number }, mean: number): number {
  let p = 1;
  for (let k = 0; k < TRAVEL_SHAPE; k++) p *= 1 - r.next();
  return (-Math.log(p) * mean) / TRAVEL_SHAPE;
}

// Event queue for within-step spread (stochastic minimum travel time).
const evHeap = new MinHeap(4096);
let evTarget = new Int32Array(4096);
let evSource = new Int32Array(4096);
let evKind = new Uint8Array(4096); // 0 = surface spread, 1 = ember, 2 = structure, 3 = crown run
let evRate = new Float32Array(4096); // surface rate the front arrives at, cells/h
let evRateC = new Float32Array(4096); // crown rate for a crown run, cells/h
let evCount = 0;
function pushEvent(t: number, target: number, source: number, kind: number, rate = 0, rateC = 0): void {
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
    const d = new Float32Array(n);
    d.set(evRate);
    evRate = d;
    const e = new Float32Array(n);
    e.set(evRateC);
    evRateC = e;
  }
  evTarget[evCount] = target;
  evSource[evCount] = source;
  evKind[evCount] = kind;
  evRate[evCount] = rate;
  evRateC[evCount] = rateC;
  evHeap.push(t, evCount++);
}

/**
 * Spread progress (v2). A front that cannot reach the next cell centre inside the 3-hour step keeps
 * the fraction of the crossing it has made (layer `fprog`) and goes on from there in the next step.
 * v1.x redrew the whole crossing every step and threw the progress away, so any fire slower than
 * about 30 m/h (one cell in three hours) never arrived: pine litter in a 3 m/s wind advanced at 27 %
 * of its specified rate, at 1 m/s at 5 %, fir litter and every night-time litter fire not at all.
 * Flanks, backing fire and overnight creep did not exist, and nearly every wildfire was out within a
 * day whatever anyone did. Progress made by several sources in the same step does not add up: the
 * step's best is committed when the step ends.
 */
let progNew = new Float32Array(0);
const progTouched: number[] = [];
/** Per-step scratch: the best rate (cells/h) each prior burning cell could spread at, and whether it is on the edge. */
let potScratch = new Float32Array(0);
let edgeScratch = new Uint8Array(0);

/** The weather a front spreads in during one sub-step. */
export interface SpreadEnv {
  /** 10 m wind, m/s, after the diurnal cycle */
  windEff: number;
  /** unit vector the wind blows toward */
  wdx: number;
  wdy: number;
  /** diurnal offset on dead fuel moisture */
  fmAdd: number;
  /** diurnal multiplier on the rate of spread */
  spread: number;
  /** design days only: dead fine-fuel moisture everywhere (instead of each cell's own plus fmAdd) */
  fm?: number;
  /** design days only: live greenness everywhere (instead of today's phenology) */
  green?: number;
  /** design days only: drought severity 0..1 (instead of this year's) */
  drought?: number;
}
interface StepCtx extends SpreadEnv {
  w: World;
  hooks: FireStepHooks;
  fireById: Map<number, FireEvent>;
  /** fires still building toward their full rate: id -> fraction of it (see buildUp) */
  build: Map<number, number>;
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
 * (~1.9x for crown runs) is gone with Erlang times, and its rate is now the head of a wind ellipse
 * (flanks much slower); this scale keeps crown head-fire speeds in the observed range (fire lab:
 * ~0.25 km/h at 6 m/s to ~1.6 km/h at 15 m/s; Rothermel 1991, Stocks et al. 2004).
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

/** How much a full understory speeds a litter fire (fuel model 10 against 8 and 9). */
export const UNDERSTORY_LIFT = 1.4;
/** Moisture of extinction of each fine-fuel component (fraction of dry weight). */
export const MX_GRASS = 0.15,
  MX_SHRUB = 0.25,
  MX_LITTER = 0.28;
/**
 * How dead-fuel moisture slows a front, relative to fuel at the 6 % the dry rates are quoted for:
 * Rothermel's damping coefficient, and the extra heat needed to bring damp fuel to ignition
 * (Q_ig = 250 + 1116·M Btu/lb), which v1.x left out. Together they roughly halve the rate between
 * 6 % and 16 % and stop it at the moisture of extinction.
 */
export function moistureResponse(fm: number, mx: number): number {
  const ref = moistureDamping(0.06 / mx);
  return ((moistureDamping(fm / mx) / ref) * (250 + 1116 * 0.06)) / (250 + 1116 * fm);
}

/**
 * Flat head-fire rate of spread (m/h) in cell n for a 10 m wind of `u10` m/s, before slope and the
 * diurnal cycle. `f` must hold cellFuel(w, n). `fmDead` is the dead fine-fuel moisture the front
 * meets; leave it out for the dry (6 %) rate. Each component of the fuel bed answers to its own
 * moisture of extinction: v1.x damped the whole bed by one blended value, so cured grass in a mixed
 * stand went on carrying fire at full grass speed in air far too damp for grass to burn.
 */
export function surfaceHeadRate(w: World, n: number, f: CellFuel, u10: number, fmDead?: number): number {
  const L = w.L;
  if (f.fine < 0.3) return 0;
  const can = L.pine[n] + L.fir[n] + L.aspen[n] * 0.6;
  const waf = windAdjustment(can);
  const midMph = u10 * waf * 2.237;
  const windTerm = Math.pow(midMph, 1.4);
  // grass under trees feels the reduced wind too (timber–grass understory burns slower than open grass)
  const grassU = u10 * (waf / 0.4) * 3.6;
  // (under aspen the ground layer is lush forbs that stay green: the classic natural fuel break)
  let rGrass = 1000 * grassHeadRateKmh(grassU) * KE_GRASS * (1 - 0.75 * Math.min(1, L.aspen[n] * 1.6));
  let rShrub = 40 * (1 + 0.85 * windTerm) * KE_SHRUB;
  // long-needle pine litter is fluffy and fast; short fir/spruce needles pack tight; aspen leaf litter is slow
  const conifer = L.pine[n] + L.fir[n];
  const pineFrac = conifer > 0.02 ? L.pine[n] / conifer : 0.5;
  const leafy = can > 0.02 ? (L.aspen[n] * 0.6) / can : 0;
  const r0Litter = (6 + 18 * pineFrac) * (1 - 0.5 * leafy);
  // An understory of saplings and brush lifts and aerates the litter bed: timber litter with
  // understory (fuel model 10) spreads about three times as fast as compact litter alone (model 8)
  // at the same mid-flame wind. v1.x's rate ignored everything but the litter's own type, so a
  // suppressed thicket crept at a fifth of its published rate and no treatment could slow a fire.
  const bedLift = 1 + UNDERSTORY_LIFT * Math.min(1, L.under[n] + 0.5 * L.shrub[n]);
  let rLitter = r0Litter * (1 + 0.55 * windTerm) * KE_LITTER * bedLift;
  if (fmDead !== undefined) {
    // live green growth in the bed raises its effective moisture: most in grass, least in litter
    rGrass *= moistureResponse(Math.max(0.02, fmDead + 0.12 * f.green), MX_GRASS);
    rShrub *= moistureResponse(Math.max(0.02, fmDead + 0.08 * f.green), MX_SHRUB);
    rLitter *= moistureResponse(Math.max(0.02, fmDead + 0.04 * f.green), MX_LITTER);
  }
  const shrubFine = L.shrub[n] * 2.4 * (1 - 0.45 * f.green);
  const sShare = Math.min(1 - f.grassShare, shrubFine / f.fine);
  const lShare = Math.max(0, 1 - f.grassShare - sShare);
  const continuity = smoothstep(0.3, 2.0, f.fine);
  // A bed of interleaved fuels spreads at neither the mean of its components' rates (that holds for
  // separate patches wider than the flame front, and lets a sixth of cured grass in a needle bed run
  // at three times the needle rate) nor at their harmonic mean (fuels strictly in series): the
  // share-weighted geometric mean lies between (cf. Fujioka 1985, Finney 2003). Components too damp
  // to burn are gaps in the bed.
  let logSum = 0,
    burning = 0;
  if (rGrass > 0 && f.grassShare > 0) {
    logSum += f.grassShare * Math.log(rGrass);
    burning += f.grassShare;
  }
  if (rShrub > 0 && sShare > 0) {
    logSum += sShare * Math.log(rShrub);
    burning += sShare;
  }
  if (rLitter > 0 && lShare > 0) {
    logSum += lShare * Math.log(rLitter);
    burning += lShare;
  }
  if (burning <= 0) return 0;
  return Math.exp(logSum / burning) * Math.sqrt(burning) * continuity;
}

/**
 * The spread stencil: the 8 neighbours plus the 8 knight moves, 16 directions at most 26.6° apart.
 * With only 8 directions (45° apart) a narrow wind ellipse pointing between two of them was barely
 * reached: with the wind at 22.5° a grass head fire advanced at ~25 % of its on-axis speed (auditor's
 * anisotropy harness). Knight moves cross two cells, which must both let fire through.
 */
const SX = [1, 1, 0, -1, -1, -1, 0, 1, 2, 1, -1, -2, -2, -1, 1, 2] as const;
const SY = [0, 1, 1, 1, 0, -1, -1, -1, 1, 2, 2, 1, -1, -2, -2, -1] as const;
const SD = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, ...Array(8).fill(Math.sqrt(5))] as readonly number[];
/**
 * Angular resolution: each direction takes the ellipse's rate at its angle from the wind less half
 * the gap to its neighbouring directions, so a head fire pointing between two stencil directions
 * still runs at ≥ cos(13.3°) = 97 % of its rate along the wind. The price is a fire shape somewhat
 * wider than the ideal ellipse in those orientations (like a wind meandering by a few degrees).
 * Auditor's anisotropy harness (head distance along the wind, 0° / 22.5° / 45°): grass 1 : 1.13 :
 * 1.12, crown fire 1 : 1.11 : 1.07 (v1.0: within 9–20 %; v1.1's first 8-direction ellipse 1 : 0.25 : 1.02).
 */
/** Half the angular gap to the neighbouring stencil directions: axes ±26.6°, diagonals and knights 18.4°. */
const HALF_GAP = [...Array(16)].map((_, d) => (d < 8 && d % 2 === 0 ? Math.atan2(1, 2) : Math.PI / 4 - Math.atan2(1, 2)) / 2);
const COS_GAP = HALF_GAP.map(Math.cos),
  SIN_GAP = HALF_GAP.map(Math.sin);
/** The stencil, for projections that must look in the same directions as the simulation. */
export const STENCIL = { DX: SX as readonly number[], DY: SY as readonly number[], DIST: SD } as const;
/** cos(max(0, θ − half gap of direction d)) for an angle θ given by its cosine. */
export function cosResolved(cosT: number, d: number): number {
  if (cosT >= COS_GAP[d]) return 1;
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
  return cosT * COS_GAP[d] + sinT * SIN_GAP[d];
}

/**
 * Direction-independent terms of spread into a cell under one environment. The simulation and the
 * projections (projection.ts) both build their rates from these, so a projected fire and a real one
 * obey the same formulas.
 */
export interface CellTerms {
  /** holds fuel that can carry fire at all */
  fuel: boolean;
  /** surface head rate, cells/h: fuel, moisture, diurnal cycle, retardant, wetting, roads and rivers; before direction, slope and fireline */
  head: number;
  /** eccentricity of the surface wind ellipse */
  ecc: number;
  /** head rate a crown fire would run at through this canopy on level ground, cells/h (0: no canopy to carry one, or not asked for) */
  crownPot: number;
  /** eccentricity of the crown-run ellipse (the same for every cell of an environment) */
  eccCrown: number;
  /** Van Wagner's critical rate for a running crown fire here, cells/h */
  crownCrit: number;
  /** fine fuel consumed in the flaming front, kg/m2 */
  load: number;
  /** crown fuel 0..1 */
  canopy: number;
  /** surface intensity (kW/m) at which this stand torches (Infinity: no canopy to torch) */
  i0: number;
}
export function newCellTerms(): CellTerms {
  return { fuel: false, head: 0, ecc: 0, crownPot: 0, eccCrown: 0, crownCrit: Infinity, load: 0, canopy: 0, i0: Infinity };
}

const termsFuel: CellFuel = { fine: 0, grassShare: 0, ladder: 0, canopy: 0, heavy: 0, green: 0 };
/**
 * Fill `t` for cell n. `crown` asks for the crown-run terms too (they cost a little and only matter
 * to a front that is crowning); `behaviour` for the torching threshold (projections need it for every
 * cell; the simulation computes it when a cell ignites).
 */
export function cellTerms(env: SpreadEnv, w: World, n: number, t: CellTerms, crown = true, behaviour = true): CellTerms {
  const L = w.L;
  const f = cellFuel(w, n, termsFuel, env.green);
  t.fuel = false;
  t.head = 0;
  t.crownPot = 0;
  t.crownCrit = Infinity;
  t.i0 = Infinity;
  t.load = frontLoad(f.fine);
  t.canopy = f.canopy;
  // elliptical distribution of the head rate around the wind direction
  const LB = lengthToBreadth(env.windEff * 3.6, f.grassShare);
  t.ecc = Math.sqrt(1 - 1 / (LB * LB));
  // (crown runs capped at 5:1: spotting and wind shifts keep real crown runs wider than the ideal ellipse)
  const LBc = Math.min(5, lengthToBreadth(env.windEff * 3.6, 0));
  t.eccCrown = Math.sqrt(1 - 1 / (LBc * LBc));
  if (f.fine < 0.3) return t;
  t.fuel = true;
  const fmDead = env.fm !== undefined ? env.fm : L.fm[n] + env.fmAdd;
  // what slows fire entering this cell whichever way it comes: retardant, wetting, a road, a fuel
  // break, a stream; a river and its green banks all but stop surface fire and check a crown fire
  const k = (1 - 0.9 * L.retard[n]) * (1 - L.wet[n]) * (L.infra[n] & INFRA.ROAD ? 0.5 : 1) * (L.infra[n] & INFRA.FUELBREAK ? 0.35 : 1);
  const acc = L.flowAcc[n];
  const kS = acc > 1000 ? k * 0.05 : acc > 300 ? k * 0.6 : k;
  const kC = acc > 1000 ? k * 0.4 : acc > 300 ? k * 0.6 : k;
  // m/h → cells/h
  t.head = (surfaceHeadRate(w, n, f, env.windEff, fmDead) / 100) * env.spread * kS;
  if (behaviour) t.i0 = torchingIntensity(w, n, f, env.drought !== undefined ? env.drought : droughtSeverity(w.climate.droughtIndex));
  if (crown && f.canopy > 0.3 && kC > 0) {
    const fm = Math.max(0.02, fmDead + f.green * (0.06 + 0.06 * f.grassShare));
    const canopyCov = L.pine[n] + L.fir[n] + L.aspen[n] * 0.6;
    const windMid = env.windEff * (1 - 0.55 * Math.min(1, canopyCov));
    // head rate as in v1.0, distributed on a wind ellipse (v1.0's lateral crown rate grew with wind
    // too, so crown fires were nearly circular and burned ~4x the area of a real crown run)
    const crownDamp = clamp01(1 - fm / 0.2) * (1 - 0.55 * f.green * (1 - f.grassShare));
    // (the slowing factor scales the rate and its threshold alike, so it does not change whether
    // the canopy can carry a running crown fire, only how fast)
    t.crownPot = CROWN_SCALE * (0.1 + 0.12 * env.windEff) * crownDamp * f.canopy * Math.pow(Math.exp(0.22 * windMid), 0.6) * kC;
    t.crownCrit = criticalCrownRate(f.canopy) * kC;
  }
  return t;
}

/** Slope factor for a front moving from one elevation to another over `dist` cells: fast uphill, slow down. */
export function slopeFactor(elevFrom: number, elevTo: number, dist: number): number {
  const tanPhi = (elevTo - elevFrom) / (dist * 100);
  return tanPhi > 0 ? Math.exp(3.2 * Math.min(tanPhi, 0.8)) : Math.exp(1.2 * Math.max(tanPhi, -0.8));
}

/**
 * Surface rate (cells/h) along a direction at `cosT` from the wind and a slope factor `sf`, into a
 * cell with fireline of strength `fline`, from a source whose flames are `srcFlame` m long. A line
 * scraped to mineral soil stops surface fire unless the flames are long enough to reach across it
 * (v1.x: any line stopped any surface fire, so a ring of hand line beat every other defence).
 */
export function surfaceRunRate(head: number, ecc: number, cosT: number, sf: number, fline: number, srcFlame: number): number {
  const lineHold = fline * (1 - smoothstep(2, 4.5, srcFlame));
  return head * ((1 - ecc) / (1 - ecc * cosT)) * sf * (1 - lineHold);
}

/**
 * Crown-run rate (cells/h) along a direction. Van Wagner's (1977) second criterion: flame is
 * sustained from crown to crown only if the fire moves fast enough for the canopy's bulk density,
 * R >= 3 / CBD m/min. Below that, trees torch singly and in groups and the front keeps its surface
 * rate (passive crowning). A running crown fire therefore needs both a strong wind and crowns close
 * together: thinning a stand from a canopy of 0.75 to 0.4 cuts the ratio almost fourfold.
 */
export function crownRunRate(crownPot: number, crownCrit: number, eccCrown: number, cosT: number, sf: number, fline: number): number {
  const head = crownPot * Math.pow(sf, 0.7);
  return head * ((1 - eccCrown) / (1 - eccCrown * cosT)) * (1 - 0.5 * fline) * smoothstep(0.6, 1, head / crownCrit);
}

/**
 * Chance, per attempt, that a surface front gets across a road or a fuel break: next to nothing for a
 * cool, calm edge; flames long enough to reach across, and wind, are what carry fire over. (v2: fires
 * lean on a road for days and unfinished crossings are remembered, so the chance per attempt of a
 * calm edge is far smaller than v1.x's 0.4 %.)
 */
export function roadBreachChance(windEff: number, cosW: number, srcFlame: number, fuelbreak: boolean): number {
  const push = smoothstep(3, 12, windEff * Math.max(0, cosW)) * 0.5 + smoothstep(1.2, 3.5, srcFlame) * 0.4;
  return clamp01(0.0002 + push) * (fuelbreak ? 0.6 : 1);
}

const rates = { rs: 0, rc: 0, fuel: false };
const stepTerms: CellTerms = newCellTerms();
/**
 * Rates of spread (cells/hour) from burning cell b into cell n along stencil direction d, left in
 * `rates`: `rs` over the surface, `rc` through the crowns (0 unless the source is crowning and n has
 * canopy to carry it), and whether n holds fuel at all (so b is on the fire's edge).
 */
function spreadRates(env: SpreadEnv, w: World, b: number, n: number, d: number, crownSrc: boolean): void {
  const L = w.L;
  const t = cellTerms(env, w, n, stepTerms, crownSrc, false);
  rates.rs = 0;
  rates.rc = 0;
  rates.fuel = t.fuel;
  if (!t.fuel) return;
  const crownOn = crownSrc && t.crownPot > 0;
  if (t.head <= 0 && !crownOn) return;
  const dist = SD[d];
  const cosT = cosResolved((SX[d] * env.wdx + SY[d] * env.wdy) / dist, d);
  const sf = slopeFactor(L.elev[b], L.elev[n], dist);
  rates.rs = surfaceRunRate(t.head, t.ecc, cosT, sf, L.fline[n], L.fint[b]);
  if (crownOn) rates.rc = crownRunRate(t.crownPot, t.crownCrit, t.eccCrown, cosT, sf, L.fline[n]);
}

/** Can a knight-move path cross cell c? Only burning or burnable, unbroken ground lets fire through. */
const passFuel: CellFuel = { fine: 0, grassShare: 0, ladder: 0, canopy: 0, heavy: 0, green: 0 };
export function passableGround(w: World, c: number): boolean {
  const L = w.L;
  // no hopping over a river or stream channel (fire entering one is slowed to 5-60 %)
  if (L.water[c] !== 0 || L.flowAcc[c] > 300 || L.pond[c] > 0.35 || L.town[c] !== 0) return false;
  if (L.infra[c] & (INFRA.ROAD | INFRA.FUELBREAK) || L.fline[c] > 0.5 || L.retard[c] > 0.5 || L.wet[c] > 0.5) return false;
  if (L.fire[c] === FIRE.BURNING) return true;
  if (L.fire[c] !== FIRE.NONE) return false;
  cellFuel(w, c, passFuel);
  return passFuel.fine >= 0.3;
}

/**
 * A fire starts as a point. For its first hours, until its head is a couple of hundred metres wide,
 * it runs well below the rate the fuel and wind would give a line of fire (Cheney & Gould 1995), and
 * its flames are shorter for it: the hours in which initial attack catches most fires.
 * `steps` is the number of 3-hour steps since it started, `area` its size in ha.
 * (v1.x and the first v2 builds started every fire at its full rate: on a windy afternoon a new
 * start was 50-190 ha before the first crew could be sent, and nothing was caught on a bad day.)
 */
export const BUILD_AREA = 6;
export function buildUp(steps: number, area: number): number {
  return area >= BUILD_AREA || steps >= 2 ? 1 : steps <= 0 ? 0.35 : 0.7;
}
/** Steps since a fire started (large for fires from saves that predate the record). */
export function fireAgeSteps(w: World, fe: FireEvent): number {
  return fe.startSub === undefined ? 99 : (w.day - fe.startDay) * SUBSTEPS_PER_DAY + (w.sub - fe.startSub);
}

/** Remaining burn time (h) at or below which a cell has been put out by crews. */
export const KNOCKED_DOWN = 0.02;
/** A front that has stopped creeps on through litter and duff at a fraction of the surface rate. */
export const HOLD_VIGOR = 0.15;
/** Flame length of a holding (smouldering) edge, m. */
function smoulderFlame(w: World): number {
  return 0.1 + 0.2 * droughtSeverity(w.climate.droughtIndex);
}
/**
 * Chance per 3-hour step that a house catches from one burning neighbour cell with flames of the
 * given length (before firewise and engines). Steeply convex, as radiant and convective heat are: a
 * litter fire creeping past with half-metre flames rarely takes a house, flames of two or three
 * metres often do, and a crown fire at the fence usually does. A front passing a house exposes it
 * about six times (several sides, a step or two each): ~2 % of unhardened homes lost at 0.5 m,
 * ~8 % at 1 m, ~20 % at 1.5 m, ~55 % at 2.5 m, ~90 % under crown fire.
 * (v2 first used a linear 0.045 per metre capped at 0.5, and before that v1.x used a proxy of fuel
 * load: either way a town lost nearly every home a fire reached whether or not the ground beside it
 * had been thinned and burned, which made the game's central work pointless where it matters most.)
 */
export function structureExposure(flame: number, grassShare = 0): number {
  // a grass front is tall but gone in seconds: it delivers far less heat to a wall than timber does
  return Math.min(0.35, 0.014 * Math.pow(flame, 2.4)) * (1 - 0.6 * grassShare);
}

const nbrRs = new Float32Array(16);
const nbrRc = new Float32Array(16);
const nbrCell = new Int32Array(16);

/**
 * Queue spread, structure and ember events out of cell b, which started burning at time t0.
 * `prior` cells were burning when the step began: a holding one may pick up again here, and the
 * best rate it could spread at is left in potScratch (it decides whether it stays an active front).
 */
function scheduleFrom(ctx: StepCtx, b: number, t0: number, prior: boolean): void {
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
  // 1. what can this cell spread into, and how fast?
  let k = 0;
  let potential = 0;
  let edge = false;
  for (let d = 0; d < 16; d++) {
    const nx = bx + SX[d],
      ny = by + SY[d];
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const n = ny * W + nx;
    if (L.fire[n] !== FIRE.NONE) continue;
    if (L.water[n] >= 2 || L.pond[n] > 0.35) continue;
    if (d >= 8) {
      // knight move: the two cells the straight path crosses must carry fire too, and fire reaches a
      // road or fuel break only from next door (so a front makes as many attempts on it as before)
      if (isStructure || L.town[n] > 0 || L.infra[n] & (INFRA.ROAD | INFRA.FUELBREAK)) continue;
      // e.g. (2, 1) crosses (1, 0) and (1, 1); (1, 2) crosses (0, 1) and (1, 1)
      const longX = Math.abs(SX[d]) === 2;
      const hx = longX ? SX[d] / 2 : 0,
        hy = longX ? 0 : SY[d] / 2;
      const c1 = (by + hy) * W + bx + hx,
        c2 = (by + (longX ? SY[d] : hy)) * W + bx + (longX ? hx : SX[d]);
      if (!passableGround(w, c1) || !passableGround(w, c2)) continue;
    }
    if (L.town[n] > 0) {
      // radiant heat and embers from neighbouring fire onto houses
      const town = w.towns[L.town[n] - 1];
      const fw = town ? town.firewise : 0;
      // house to house: rare in still air, a conflagration in wind (v1.x: a flat 0.16, so below
      // firewise ~0.5 one burning house took a neighbourhood whatever the weather)
      const p = (isStructure ? 0.03 + 0.012 * ctx.windEff : structureExposure(L.fint[b], cellFuel(w, b, houseFuel).grassShare)) * (1 - 0.75 * fw) * (1 - structureProtection(w, n));
      if (p > 0) {
        const rate = -Math.log(1 - Math.min(0.999, p)) / HOURS;
        const tau = r.exponential(1 / rate);
        if (tau < remaining) pushEvent(t0 + tau, n, b, 2);
      }
      continue;
    }
    if (isStructure) continue; // houses spread to houses and by embers
    spreadRates(ctx, w, b, n, d, crownSrc);
    if (rates.fuel && d < 8) edge = true;
    const rmax = rates.rs > rates.rc ? rates.rs : rates.rc;
    if (rmax <= 0) continue;
    // a road or fuel break stops a surface fire unless it is pushed across by wind or flame length
    if (!crownSrc && L.infra[n] & (INFRA.ROAD | INFRA.FUELBREAK)) {
      const cosW = (SX[d] * ctx.wdx + SY[d] * ctx.wdy) / SD[d];
      // (per attempt; a long front makes many attempts, so a light-wind fire crosses only rarely
      // while a wind-driven head fire still gets across)
      const breach = roadBreachChance(ctx.windEff, cosW, L.fint[b], (L.infra[n] & INFRA.FUELBREAK) !== 0);
      if (r.next() >= breach) continue;
    }
    if (rmax > potential) potential = rmax;
    nbrCell[k] = n * 16 + d;
    nbrRs[k] = rates.rs;
    nbrRc[k] = rates.rc;
    k++;
  }
  // 2. a young fire is still building; a holding edge picks up again when the air dries and the wind rises
  const build = isStructure ? 1 : (ctx.build.get(L.fid[b]) ?? 1);
  let vigor = build;
  if (prior && !isStructure) {
    if (L.fphase[b] === 1) {
      vigor = HOLD_VIGOR;
      if (potential >= R_MIN) {
        const dryness = clamp01((0.17 - (L.fm[b] + ctx.fmAdd)) / 0.09);
        if (r.next() < 0.3 * dryness * (0.5 + ctx.windEff / 8)) {
          L.fphase[b] = 0;
          vigor = build;
        }
      }
    }
    potScratch[b] = potential;
    edgeScratch[b] = edge ? 1 : 0;
  }
  // 3. draw crossing times; what does not arrive inside the step is kept as progress
  for (let j = 0; j < k; j++) {
    const n = (nbrCell[j] / 16) | 0,
      d = nbrCell[j] % 16;
    const rs = nbrRs[j] * vigor,
      rc = nbrRc[j] * vigor;
    const R = rs > rc ? rs : rc;
    const full = travelTime(r, SD[d] / R);
    const tau = full * (1 - L.fprog[n]);
    if (tau < remaining) pushEvent(t0 + tau, n, b, rc > rs ? 3 : 0, rs, rc);
    else {
      const p = Math.min(0.98, L.fprog[n] + remaining / full);
      if (p > progNew[n]) {
        if (progNew[n] === 0) progTouched.push(n);
        progNew[n] = p;
      }
    }
  }
  // ember spotting from intense fire
  const flame = L.fint[b];
  const windEff = ctx.windEff;
  if ((flame >= 2.5 || crownSrc || isStructure) && windEff > 2) {
    const frac = remaining / HOURS;
    const hb = Math.min(1.6, flame / 3.5);
    const embers = r.poisson(0.09 * hb * (windEff / 4) * (crownSrc ? 1.6 : 1) * frac);
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

/** The weather fronts spread in during the current sub-step. */
export function currentSpreadEnv(w: World): SpreadEnv {
  return spreadEnvFor(w.sub, w.weather, droughtSeverity(w.climate.droughtIndex));
}

/**
 * Overnight humidity recovery, 0..1: how far fine fuels re-wet after dark. Good on an ordinary
 * night; poor in drought and all but absent under a dry downslope wind, which is when fires run
 * through the night.
 */
export function nightRecovery(wx: { windEvent: boolean; rh: number }, drought: number): number {
  return clamp(1 - 0.45 * drought - (wx.windEvent ? 0.6 : 0) - 0.5 * Math.max(0, 0.3 - wx.rh), 0.1, 1);
}

/** The weather fronts spread in during sub-step `sub` of a day with weather `wx`. */
export function spreadEnvFor(sub: number, wx: { windSpeed: number; windDir: number; windEvent: boolean; rh: number }, drought: number): SpreadEnv {
  const di = diurnal(sub);
  // v1.x swung fuel moisture by at most +5 points at night; real fine fuels gain ~10 on a night of
  // good humidity recovery, which is what lets a fire lie down and crews catch it
  const h = sub * 3 + 1.5;
  const sun = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));
  const fmAdd = di.fmAdd + 0.06 * nightRecovery(wx, drought) * (1 - sun);
  const dir = windDirAt(sub, wx);
  return { windEff: wx.windSpeed * di.wind, wdx: Math.cos(dir), wdy: Math.sin(dir), fmAdd, spread: di.spread };
}

/**
 * Wind direction during sub-step `sub` (radians, blowing toward). The wind swings through the day
 * (slope and valley winds, passing gusts), backing in the morning and veering in the evening around
 * the day's direction, which it holds in mid-afternoon: fires fan out wider than one fixed direction
 * would draw them. A downslope wind event blows steadier.
 */
export function windDirAt(sub: number, wx: { windDir: number; windEvent: boolean }): number {
  const h = sub * 3 + 1.5;
  return wx.windDir + (wx.windEvent ? 0.1 : 0.3) * Math.sin((2 * Math.PI * (h - 15)) / 24);
}

export function fireSubstep(w: World, hooks: FireStepHooks = {}): void {
  if (w.burning.length === 0) return;
  const L = w.L;
  const r = w.rng.fire;
  const env = currentSpreadEnv(w);
  const di = { fmAdd: env.fmAdd };
  const fireById = new Map<number, FireEvent>();
  for (const fe of w.fires) if (fe.active) fireById.set(fe.id, fe);
  // how far each fire has built toward its full rate (prescribed burns are lit as a line)
  const build = new Map<number, number>();
  for (const fe of fireById.values()) {
    if (fe.cause === 'prescribed') continue;
    const k = buildUp(fireAgeSteps(w, fe), fe.area);
    if (k < 1) build.set(fe.id, k);
  }
  const ctx: StepCtx = { w, hooks, fireById, build, ...env };
  const f = tmpFuel;
  if (progNew.length !== w.N) {
    progNew = new Float32Array(w.N);
    potScratch = new Float32Array(w.N);
    edgeScratch = new Uint8Array(w.N);
  }

  // deterministic order
  w.burning.sort((a, b) => a - b);
  const starts = pendingStart.get(w);
  const prior = w.burning.slice();
  evHeap.clear();
  evCount = 0;

  // 1. cells already burning: schedule their spread for this step (holding edges may pick up again)
  for (const b of prior) {
    if (L.fire[b] !== FIRE.BURNING) continue;
    if (!fireById.has(L.fid[b])) continue;
    // a cell that crews have knocked down is out: it spreads no further (in v1.x "extinguishing" only
    // shortened a cell's burn time, and it still spread at full vigour in its last step, so direct
    // attack by engines, helicopters and burn-holding crews never stopped a front)
    if (L.ftime[b] <= KNOCKED_DOWN && L.town[b] === 0) {
      potScratch[b] = 0;
      edgeScratch[b] = 0;
      continue;
    }
    scheduleFrom(ctx, b, starts?.get(b) ?? 0, true);
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
      // a prescribed burn that sets a house alight has escaped (v1.x: 14 homes burned in one burn
      // that then closed as a success)
      checkEscape(w, fe, n, hooks);
      scheduleFrom(ctx, n, t, false);
      continue;
    }
    if (kind === 1) {
      // ember landing: needs receptive dry fine fuel
      if (L.town[n] > 0) {
        const town = w.towns[L.town[n] - 1];
        const p = 0.22 * (1 - 0.75 * (town ? town.firewise : 0)) * (1 - structureProtection(w, n));
        if (r.next() < p) {
          igniteStructure(w, n, fe);
          checkEscape(w, fe, n, hooks);
          scheduleFrom(ctx, n, t, false);
        }
        continue;
      }
      cellFuel(w, n, f);
      const fm = L.fm[n] + di.fmAdd;
      const recept = Math.pow(clamp01(1 - fm / 0.17), 2) * smoothstep(1, 6, f.fine) * (1 - L.wet[n]) * (1 - 0.8 * L.retard[n]);
      if (r.next() >= recept * 0.55) continue;
      const crossed = crossesBarrier(w, src, n);
      // a spot fire starts small and cool; it becomes what the fuel and wind make of it
      igniteCell(w, n, fe, 0.5, false);
      fe.spotFires++;
      if (hooks.onSpot) hooks.onSpot(fe, n, crossed);
      checkEscape(w, fe, n, hooks);
      scheduleFrom(ctx, n, t, false);
      continue;
    }
    // a front arriving from a neighbouring cell, over the surface (0) or through the crowns (3)
    cellFuel(w, n, f);
    const bh = frontBehaviour(w, n, f, evRate[e], kind === 3 ? evRateC[e] : 0);
    const crown = bh.crown;
    igniteCell(w, n, fe, Math.max(0.1, bh.flame), crown);
    if (crown && hooks.onCrown) hooks.onCrown(fe, n);
    checkEscape(w, fe, n, hooks);
    scheduleFrom(ctx, n, t, false);
  }

  // 3. smoke, and the fate of cells that were already burning at the start of the step
  const burnedOut: number[] = [];
  const smoulder = smoulderFlame(w);
  for (const b of prior) {
    if (L.fire[b] !== FIRE.BURNING) continue;
    if (!fireById.has(L.fid[b])) {
      burnedOut.push(b);
      continue;
    }
    const isStructure = L.town[b] > 0;
    cellFuel(w, b, f);
    const heat = Math.min(1.6, 0.06 + 0.3 * L.fint[b]);
    L.smoke[b] = Math.min(4, L.smoke[b] + 0.05 * heat * (1 + (f.fine + 0.25 * f.heavy) / 12) * (isStructure ? 2 : 1));
    if (isStructure) L.ftime[b] -= HOURS;
    else {
      const pot = potScratch[b];
      // a crown front is a source of crown runs for the step it arrives in and the one after: then
      // its canopy is gone and what is left is a surface fire (and something a crew can approach)
      if (L.crown[b] === 1) L.crown[b] = 2;
      if (L.fphase[b] === 0 && pot >= R_MIN) {
        // an advancing front: its flames are those of the fastest spread it is making now (so an
        // edge lies down at night and on the flanks), and it stays alight while it keeps moving
        L.fint[b] = Math.max(smoulder, surfaceFlameLength(byramIntensity(frontLoad(f.fine), pot)));
        if (L.fint[b] > L.fpeak[b]) L.fpeak[b] = L.fint[b];
        L.ftime[b] -= HOURS * 0.25;
      } else {
        // the front has passed or stalled: heavy fuel and duff hold fire for hours to days
        L.fphase[b] = 1;
        L.fint[b] = Math.min(L.fint[b], smoulder);
        L.ftime[b] -= HOURS * (edgeScratch[b] ? 1 : 3);
        // damp air puts a smouldering edge to sleep
        const damp = L.fm[b] + di.fmAdd - 0.2;
        if (damp > 0) L.ftime[b] -= damp * 40;
      }
    }
    if (L.ftime[b] <= 0) burnedOut.push(b);
  }
  // newly ignited cells emit smoke too
  for (let k = prior.length; k < w.burning.length; k++) {
    const b = w.burning[k];
    L.smoke[b] = Math.min(4, L.smoke[b] + 0.04 * Math.min(1.6, 0.06 + 0.3 * L.fint[b]));
  }
  // commit this step's spread progress
  for (const n of progTouched) {
    if (L.fire[n] === FIRE.NONE && progNew[n] > L.fprog[n]) L.fprog[n] = progNew[n];
    progNew[n] = 0;
  }
  progTouched.length = 0;
  for (const b of burnedOut) burnout(w, b, fireById.get(L.fid[b]), hooks);
  if (burnedOut.length) w.burning = w.burning.filter((c) => L.fire[c] === FIRE.BURNING);
  // nothing left alight anywhere: forget unfinished crossings
  if (w.burning.length === 0) L.fprog.fill(0);
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

/**
 * Engines protecting a town reduce the chance houses catch. v2: every engine within reach counts,
 * with diminishing returns, whether it was sent to the fire or is standing by at its station
 * (v1.x took the best single engine and only if it was `working`: a second engine was worth
 * nothing and an engine at home in a burning town did nothing).
 */
export function structureProtection(w: World, i: number): number {
  const x = i % w.W,
    y = (i / w.W) | 0;
  let miss = 1;
  for (const c of w.crews) {
    if (c.kind !== 'engine' || c.state === 'moving' || c.state === 'returning') continue;
    const d = Math.hypot(c.x - x - 0.5, c.y - y - 0.5);
    if (d < 5) miss *= 1 - 0.6 * (1 - d / 6);
  }
  return Math.min(0.9, 1 - miss);
}

function igniteStructure(w: World, i: number, fe: FireEvent): void {
  const L = w.L;
  L.fire[i] = FIRE.BURNING;
  L.fid[i] = fe.id;
  L.fint[i] = 4;
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
    // (v1.x looked for "… Fire" in a name that ends "… Rx Burn", so an escape kept its burn's name)
    fe.name = fe.name.replace(/ (Rx Burn|Fire)$/, ' Escape');
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
/** Flames this long (m) scorch crowns and kill thin-barked trees: moderate severity. */
export const SEVERITY_FLAME = 1.5;
/** Ground counts as treated for this many years after a thinning, a fuel break or a burn (fire reports). */
export const TREATED_YEARS = 12;
function burnout(w: World, i: number, fe: FireEvent | undefined, hooks: FireStepHooks): void {
  const L = w.L;
  const crown = L.crown[i] !== 0;
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
  // (fast grass flames pass in seconds and scorch less than their length suggests)
  const peak = L.fpeak[i] * (1 - 0.5 * cellFuel(w, i, tmpFuel).grassShare);
  const sev = crown ? 3 : peak >= SEVERITY_FLAME ? 2 : 1;
  L.fpeak[i] = 0;
  // was this ground thinned, cleared or burned in the years before? (asked before the burn is recorded)
  const prepared = w.yearF - L.lastTreat[i] < TREATED_YEARS || w.yearF - L.lastBurn[i] < TREATED_YEARS;
  applyFireEffects(w, i, sev);
  if (fe) {
    if (sev === 3) fe.highSeverity++;
    else if (sev === 1) fe.lowSeverity++;
    if (prepared) {
      fe.treatedArea = (fe.treatedArea ?? 0) + 1;
      if (sev === 3) fe.treatedHigh = (fe.treatedHigh ?? 0) + 1;
    }
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
  // saplings have thin bark and crowns within reach of any flame: this is how frequent fire keeps a
  // stand open, and what a prescribed burn buys
  L.under[i] *= sev === 1 ? 0.25 : sev === 2 ? 0.06 : 0;
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
      if (hooks.onEnding) hooks.onEnding(fe);
      // release burnt cells
      for (let y = fe.minY; y <= fe.maxY; y++)
        for (let x = fe.minX; x <= fe.maxX; x++) {
          const i = y * w.W + x;
          if (L.fid[i] === fe.id) {
            if (L.fire[i] === FIRE.BURNT) L.fire[i] = FIRE.NONE;
            L.fid[i] = -1;
            L.fstop[i] = 0;
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
export interface IgnitionCache {
  version: number;
  cum: Float64Array;
  cells: Int32Array;
  total: number;
}
const ignCache = new WeakMap<World, IgnitionCache>();

/**
 * Human activity weights: roads, campgrounds, recreation, town edges, logging. The weights depend
 * on the water, town, infra and zone layers but are rebuilt only when `dirty.infra` or `dirty.zone`
 * moves, so every runtime change to where houses stand, to roads and campgrounds, or to zoning must
 * bump one of them (towns.ts placeStructure/loseStructure, commands, petitions, campgrounds). A
 * missed bump leaves a long-running game with weights a reloaded game recomputes differently
 * (verification finding R1); tests/sim/reload.test.ts checks the two agree.
 */
export function humanActivity(w: World): IgnitionCache {
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

/**
 * Detection of unreported fires by lookouts, residents, travellers and patrols.
 * A smoke column over a mountain valley is seen from far off by day: v1.x made that certain only
 * above ~70 ha of fire and otherwise needed a tower or a town within 3 km, so fires went 18–54 hours
 * unreported — harmless while nothing spread, fatal to initial attack once fire moves as specified.
 * A fire of a few hectares is now usually reported within hours; small smouldering sleepers in the
 * backcountry still hide, and towers and air patrols are what find fires while they are tiny.
 */
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
        const q = 0.7 * (1 - d / 42) * smoothstep(0, 2, size);
        if (q > p) {
          p = q;
          by = 'lookout';
        }
      }
    }
    let dTown = Infinity;
    for (const t of w.towns) dTown = Math.min(dTown, Math.hypot(t.x - cx, t.y - cy));
    if (dTown < 30) {
      const q = 0.25 * smoothstep(0.5, 6, size) * (1 - dTown / 32);
      if (q > p) by = 'residents';
      p += q;
    }
    const oi = fe.originY * w.W + fe.originX;
    if (fe.cause === 'human' || w.L.infra[oi] & INFRA.ROAD) {
      p += 0.5;
      if (!by) by = 'passers-by';
    }
    if (w.policies.airPatrol && !night) {
      p += 0.25 * smoothstep(0.5, 3, size);
      if (!by) by = 'air patrol';
    }
    // a column of smoke by day (a glow by night) seen from the valley
    const column = 0.55 * smoothstep(0.8, 6, size);
    if (column > 0.05) {
      p += column;
      if (!by) by = night ? 'a glow on the ridge' : 'a smoke column';
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
