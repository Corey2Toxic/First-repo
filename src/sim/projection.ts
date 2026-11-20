/**
 * Seeing fire coming: projections built from the fire model's own rate functions.
 *
 *  - `projectSpread`  where a burning fire (or a hypothetical ignition) is expected to be over the
 *                     coming hours, under today's weather and the published forecast;
 *  - `computeFireshed` for every town, how long a fire starting anywhere in the valley would need
 *                     to reach its homes on a design day, and what those homes would then face.
 *
 * Both are expected-travel-time calculations (Dijkstra over the 16-direction spread stencil with the
 * mean crossing times of the simulation). They leave out what the simulation leaves to chance:
 * spotting, the luck of a road holding, flare-ups, and anything crews will do. They never draw a
 * random number or change the world, so they can be computed at any time without affecting a game.
 */
import { MinHeap, clamp01 } from './grid.ts';
import { FIRE, INFRA, SUBSTEPS_PER_DAY } from './types.ts';
import type { World } from './world.ts';
import {
  BUILD_AREA,
  HOLD_VIGOR,
  fireAgeSteps,
  R_MIN,
  STENCIL,
  arrivalBehaviour,
  buildUp,
  cellTerms,
  cosResolved,
  crownRunRate,
  newCellTerms,
  passableGround,
  roadBreachChance,
  slopeFactor,
  spreadEnvFor,
  structureExposure,
  surfaceRunRate,
} from './systems/fire.ts';
import type { CellTerms, SpreadEnv } from './systems/fire.ts';
import { cellFuel } from './systems/fuels.ts';
import type { CellFuel } from './systems/fuels.ts';
import { droughtSeverity } from './systems/climate.ts';
import { medianFuelMoisture } from './systems/moisture.ts';
import { forecast } from './forecast.ts';
import { discover } from './notes.ts';

const HOURS = 24 / SUBSTEPS_PER_DAY;
const { DX, DY, DIST } = STENCIL;

/** Direction-independent spread terms of every cell under one environment, filled in on demand. */
class TermsField {
  readonly env: SpreadEnv;
  private have: Uint8Array;
  readonly fuel: Uint8Array;
  readonly head: Float32Array;
  readonly ecc: Float32Array;
  readonly crownPot: Float32Array;
  readonly crownCrit: Float32Array;
  readonly load: Float32Array;
  readonly canopy: Float32Array;
  readonly i0: Float32Array;
  eccCrown = 0;
  private readonly t: CellTerms = newCellTerms();

  constructor(n: number, env: SpreadEnv) {
    this.env = env;
    this.have = new Uint8Array(n);
    this.fuel = new Uint8Array(n);
    this.head = new Float32Array(n);
    this.ecc = new Float32Array(n);
    this.crownPot = new Float32Array(n);
    this.crownCrit = new Float32Array(n);
    this.load = new Float32Array(n);
    this.canopy = new Float32Array(n);
    this.i0 = new Float32Array(n);
  }

  ensure(w: World, n: number): void {
    if (this.have[n]) return;
    this.have[n] = 1;
    const t = cellTerms(this.env, w, n, this.t);
    this.fuel[n] = t.fuel ? 1 : 0;
    this.head[n] = t.head;
    this.ecc[n] = t.ecc;
    this.crownPot[n] = t.crownPot;
    this.crownCrit[n] = t.crownCrit;
    this.load[n] = t.load;
    this.canopy[n] = t.canopy;
    this.i0[n] = t.i0;
    this.eccCrown = t.eccCrown;
  }
}

/**
 * How far the simulated front runs ahead of its mean crossing times, at the head and on the flanks
 * (measured against the simulation on uniform fuel: scripts/v2/project.ts lab).
 */
const LEAD_HEAD = 1.1,
  LEAD_FLANK = 1.4;

/** Surface and crown rate (cells/h) from cell b into n along stencil direction d. */
const edge = { rs: 0, rc: 0 };
function edgeRates(w: World, f: TermsField, b: number, n: number, d: number, crownSrc: boolean, srcFlame: number): void {
  const L = w.L;
  f.ensure(w, n);
  edge.rs = 0;
  edge.rc = 0;
  if (!f.fuel[n]) return;
  const cosT = cosResolved((DX[d] * f.env.wdx + DY[d] * f.env.wdy) / DIST[d], d);
  const sf = slopeFactor(L.elev[b], L.elev[n], DIST[d]);
  // A real front is led by its fastest strands: the simulation draws every crossing time at random
  // and a cell burns when the first of several paths arrives, so the front runs ahead of the mean
  // crossing time, a little at the head (few paths compete) and more on the flanks (many do).
  const c2 = cosT > 0 ? cosT * cosT : 0;
  const lead = LEAD_FLANK - (LEAD_FLANK - LEAD_HEAD) * c2 * c2 * c2 * c2;
  edge.rs = surfaceRunRate(f.head[n], f.ecc[n], cosT, sf, L.fline[n], srcFlame) * lead;
  if (crownSrc && f.crownPot[n] > 0) edge.rc = crownRunRate(f.crownPot[n], f.crownCrit[n], f.eccCrown, cosT, sf, L.fline[n]) * lead;
}

/** Cells the straight path of a knight move crosses. */
function knightVia(W: number, b: number, d: number): [number, number] {
  const bx = b % W,
    by = (b / W) | 0;
  const longX = Math.abs(DX[d]) === 2;
  const hx = longX ? DX[d] / 2 : 0,
    hy = longX ? 0 : DY[d] / 2;
  return [(by + hy) * W + bx + hx, (by + (longX ? DY[d] : hy)) * W + bx + (longX ? hx : DX[d])];
}

/**
 * Expected wait (hours) before a surface front gets across a road or fuel break: one try per source
 * per 3-hour step in the simulation, a few sources abreast.
 */
function roadDelay(w: World, n: number, env: SpreadEnv, d: number, srcFlame: number): number {
  const cosW = (DX[d] * env.wdx + DY[d] * env.wdy) / DIST[d];
  const p = roadBreachChance(env.windEff, cosW, srcFlame, (w.L.infra[n] & INFRA.FUELBREAK) !== 0);
  const eff = 1 - Math.pow(1 - p, 3);
  return eff <= 1e-4 ? Infinity : HOURS * (1 / eff - 1);
}

// ---------------------------------------------------------------- forward projection
export interface TownArrival {
  id: number;
  /** hours until the front is expected beside the town's homes (Infinity: not within the horizon) */
  hours: number;
  /** homes the front is expected to reach within the horizon */
  homes: number;
  /** it would arrive torching or as a crown fire */
  crown: boolean;
}

export interface SpreadProjection {
  /** hours from now until the front is expected at each cell (Infinity: not within the horizon) */
  arrival: Float32Array;
  /** expected flame length on arrival, m */
  flame: Float32Array;
  /** 1 where it is expected to arrive torching or as a crown fire */
  crown: Uint8Array;
  horizon: number;
  /** expected new area (ha) within 6, 12, 24 and 48 hours */
  area: [number, number, number, number];
  towns: TownArrival[];
  /** when it was made (to know when it is stale) */
  day: number;
  sub: number;
}

export interface ProjectOptions {
  /** hours ahead (default 48) */
  hours?: number;
  /** project one fire only (default: every burning fire the warden knows of) */
  fireId?: number;
  /** include fires nobody has reported yet (default false: the warden cannot project what is unknown) */
  includeUnreported?: boolean;
  /** project a hypothetical ignition at these cells instead of the burning fires */
  ignite?: number[];
  /** use these weather periods instead of today's weather and the forecast (design-day what-ifs) */
  design?: DesignCase;
}

/** The environment of each 3-hour period ahead, from today's weather and the published forecast. */
export function periodsAhead(w: World, hours: number): SpreadEnv[] {
  const n = Math.max(1, Math.ceil(hours / HOURS));
  const drought = droughtSeverity(w.climate.droughtIndex);
  const fc = forecast(w);
  const fmNow = medianFuelMoisture(w);
  const out: SpreadEnv[] = [];
  for (let p = 0; p < n; p++) {
    const sub = (w.sub + p) % SUBSTEPS_PER_DAY;
    const day = w.day + Math.floor((w.sub + p) / SUBSTEPS_PER_DAY);
    const f = fc.find((x) => x.day === day);
    if (!f || (day === w.day && w.sub > 0)) {
      // today: the weather that is actually blowing (or, past the forecast's reach, the last day of it)
      const last = fc[fc.length - 1];
      if (day === w.day || !last) {
        const env = spreadEnvFor(sub, w.weather, drought);
        if (w.weather.precip > 6) env.spread = 0;
        out.push(env);
        continue;
      }
      out.push(forecastEnv(sub, last, drought, fmNow));
      continue;
    }
    out.push(forecastEnv(sub, f, drought, fmNow));
  }
  return out;
}

function forecastEnv(sub: number, f: { windSpeed: number; windDir: number; windEventChance: number; rh: number; rainChance: number; fm: number }, drought: number, fmNow: number): SpreadEnv {
  const event = f.windEventChance >= 0.5;
  const env = spreadEnvFor(sub, { windSpeed: event ? Math.max(f.windSpeed, 11) : f.windSpeed, windDir: f.windDir, windEvent: event, rh: f.rh }, drought);
  // fuels follow the forecast air: every cell shifts by the forecast change in the valley's median
  env.fmAdd += f.fm - fmNow;
  if (f.rainChance >= 0.6) env.spread = 0;
  return env;
}

/**
 * Where fire is expected to be over the coming hours. Sources are the burning cells of the reported
 * fires (or of one fire, or a hypothetical ignition); every burning edge is taken to be awake, so
 * for a fire lying down at night this is what it can do when the day warms.
 */
export function projectSpread(w: World, opts: ProjectOptions = {}): SpreadProjection {
  const L = w.L;
  const W = w.W,
    H = w.H,
    N = w.N;
  const horizon = opts.hours ?? 48;
  const envs = opts.design ? [designEnv(w, opts.design)] : periodsAhead(w, horizon);
  const fields: Array<TermsField | undefined> = new Array(envs.length);
  const fieldAt = (p: number) => (fields[p] ??= new TermsField(N, envs[p]));
  const arrival = new Float32Array(N).fill(Infinity);
  const flame = new Float32Array(N);
  const crown = new Uint8Array(N);
  const heap = new MinHeap(1024);

  // a young fire is still building toward its full rate (see buildUp): the size and age it starts from
  let area0 = 0,
    age0 = 0;
  if (opts.ignite) {
    for (const c of opts.ignite) {
      if (c < 0 || c >= N || L.water[c] >= 2 || L.town[c] !== 0) continue;
      arrival[c] = 0;
      flame[c] = 0.4;
      heap.push(0, c);
      area0++;
    }
  } else {
    const known = new Set<number>();
    for (const fe of w.fires)
      if (fe.active && (opts.includeUnreported || fe.detected) && (opts.fireId === undefined || fe.id === opts.fireId)) {
        known.add(fe.id);
        area0 = Math.max(area0, fe.cause === 'prescribed' ? BUILD_AREA : fe.area);
        age0 = Math.max(age0, fireAgeSteps(w, fe));
      }
    for (const b of w.burning) {
      if (!known.has(L.fid[b]) || L.town[b] > 0) continue;
      arrival[b] = 0;
      flame[b] = L.fint[b];
      crown[b] = L.crown[b] === 1 ? 1 : 0;
      heap.push(0, b);
    }
  }

  const reached: number[] = [];
  const sizeAt: number[] = [area0];
  while (heap.size > 0) {
    const t = heap.peekKey();
    const b = heap.pop();
    if (t > arrival[b] + 1e-6) continue;
    if (t >= horizon) break;
    if (t > 0) reached.push(b);
    const bx = b % W,
      by = (b / W) | 0;
    const crownSrc = crown[b] === 1;
    const source = t === 0;
    // the simulation judges a fire's build-up once per step, from its size as the step begins
    const pNow = Math.floor(t / HOURS);
    while (sizeAt.length <= pNow) sizeAt.push(area0 + reached.length - (t > 0 ? 1 : 0));
    const building = sizeAt[pNow] < BUILD_AREA && age0 + pNow < 2;
    for (let d = 0; d < 16; d++) {
      const nx = bx + DX[d],
        ny = by + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (arrival[n] <= t) continue;
      if (L.water[n] >= 2 || L.pond[n] > 0.35 || L.town[n] !== 0) continue;
      if (!opts.ignite && L.fire[n] !== FIRE.NONE) continue;
      if (d >= 8) {
        if (L.infra[n] & (INFRA.ROAD | INFRA.FUELBREAK)) continue;
        const [c1, c2] = knightVia(W, b, d);
        if (!(arrival[c1] < Infinity || passableGround(w, c1)) || !(arrival[c2] < Infinity || passableGround(w, c2))) continue;
      }
      let tt = t;
      // a road or a fuel break holds a surface front for a while (or for good)
      if (!crownSrc && L.infra[n] & (INFRA.ROAD | INFRA.FUELBREAK)) {
        const p0 = Math.min(envs.length - 1, Math.floor(tt / HOURS));
        tt += roadDelay(w, n, envs[p0], d, flame[b]);
        if (!(tt < horizon)) continue;
      }
      // cross to the next cell centre through the periods ahead, keeping what a real front has already covered
      let frac = source && !opts.ignite ? 1 - L.fprog[n] : 1;
      let tArr = Infinity,
        rsArr = 0,
        rcArr = 0;
      let field: TermsField | undefined;
      for (let guard = 0; guard < 64 && tt < horizon; guard++) {
        const p = Math.min(envs.length - 1, Math.floor(tt / HOURS));
        field = fieldAt(p);
        edgeRates(w, field, b, n, d, crownSrc && tt - t < HOURS, flame[b]);
        if (!field.fuel[n]) break;
        let R = edge.rs > edge.rc ? edge.rs : edge.rc;
        if (R < R_MIN) R *= HOLD_VIGOR; // a front this slow holds and creeps
        else if (building) {
          const q = Math.floor(tt / HOURS);
          const k = buildUp(age0 + q, sizeAt[Math.min(q, sizeAt.length - 1)]);
          R *= k;
          edge.rs *= k;
          edge.rc *= k;
        }
        const pEnd = opts.design ? Infinity : (p + 1) * HOURS;
        if (R > 1e-5) {
          const need = (frac * DIST[d]) / R;
          if (tt + need <= pEnd) {
            tArr = tt + need;
            rsArr = edge.rs;
            rcArr = edge.rc > edge.rs ? edge.rc : 0;
            break;
          }
          frac -= ((pEnd - tt) * R) / DIST[d];
        } else if (opts.design) break;
        tt = pEnd;
      }
      if (!(tArr < arrival[n]) || tArr > horizon || !field) continue;
      arrival[n] = tArr;
      const bh = arrivalBehaviour(field.load[n], field.canopy[n], field.i0[n], rsArr, rcArr);
      flame[n] = bh.flame;
      crown[n] = bh.crown ? 1 : 0;
      heap.push(tArr, n);
    }
  }

  const area: [number, number, number, number] = [0, 0, 0, 0];
  for (const c of reached) {
    const t = arrival[c];
    if (t <= 6) area[0]++;
    if (t <= 12) area[1]++;
    if (t <= 24) area[2]++;
    if (t <= 48) area[3]++;
  }
  const towns: TownArrival[] = w.towns.map((t) => ({ id: t.id, hours: Infinity, homes: 0, crown: false }));
  // a home is reached when the front is expected on ground beside it
  for (let i = 0; i < N; i++) {
    const tid = L.town[i] - 1;
    if (tid < 0 || !towns[tid]) continue;
    const x = i % W,
      y = (i / W) | 0;
    let best = Infinity,
      cr = false;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d],
        ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (arrival[n] < best && arrival[n] > 0) {
        best = arrival[n];
        cr = crown[n] === 1;
      }
    }
    if (best <= horizon) {
      const ta = towns[tid];
      ta.homes++;
      if (best < ta.hours) ta.hours = best;
      if (cr) ta.crown = true;
    }
  }
  return { arrival, flame, crown, horizon, area, towns, day: w.day, sub: w.sub };
}

// ---------------------------------------------------------------- design days and the fireshed
/** A reference fire day: fixed wind, dead-fuel moisture and curing, the mid-afternoon hour. */
export interface DesignCase {
  name: string;
  /** 10 m wind, m/s (before the afternoon peak is applied) */
  windSpeed: number;
  /** direction the wind blows toward, radians */
  windDir: number;
  windEvent: boolean;
  /** dead fine-fuel moisture everywhere */
  fm: number;
}

/** Direction the valley's downslope wind events blow toward (as in climate.generateWeather). */
export function eventWindDir(w: World): number {
  return w.outletCell >= 0 && w.outletCell % w.W === 0 ? Math.PI : 0;
}

/**
 * The design days a town's exposure is measured against: the valley's dry downslope wind, and the
 * prevailing westerly on a hot afternoon swinging a little either way. Late-summer curing, dry
 * fuels, a drought year: the day a warden plans for, not the average day.
 */
export function designCases(w: World): DesignCase[] {
  const ev = eventWindDir(w);
  return [
    { name: `${w.climate.localWindName}`, windSpeed: 12, windDir: ev, windEvent: true, fm: 0.05 },
    { name: 'westerly', windSpeed: 7, windDir: 0, windEvent: false, fm: 0.06 },
    { name: 'south-westerly', windSpeed: 7, windDir: -0.55, windEvent: false, fm: 0.06 },
    { name: 'north-westerly', windSpeed: 7, windDir: 0.55, windEvent: false, fm: 0.06 },
  ];
}

/** Drought the design day assumes (the severity of a dry summer). */
export const DESIGN_DROUGHT = 0.7;
/** Live greenness the design day assumes: late summer, grass cured. */
export const DESIGN_GREEN = 0.08;
/** One burning period: the hours a fire runs on a design afternoon and evening. */
export const BURN_PERIOD = 12;

export function designEnv(w: World, c: DesignCase): SpreadEnv {
  void w;
  const env = spreadEnvFor(4, { windSpeed: c.windSpeed, windDir: c.windDir, windEvent: c.windEvent, rh: 0.15 }, DESIGN_DROUGHT);
  // the wind of the design day blows straight (no daily swing)
  env.wdx = Math.cos(c.windDir);
  env.wdy = Math.sin(c.windDir);
  env.fm = c.fm;
  env.green = DESIGN_GREEN;
  env.drought = DESIGN_DROUGHT;
  return env;
}

export interface TownExposure {
  id: number;
  homes: number;
  /** homes expected to be lost if a design-day fire reaches the town (before engines and luck) */
  exposed: number;
  /** ground from which a design-day fire reaches the town's homes within 6 h and within one burning period (ha) */
  area6: number;
  area12: number;
  /** share of the town's edge that would meet torching or crown fire */
  crownEdge: number;
  /** 0..100: exposure share scaled by how much ground can deliver fire to the town */
  risk: number;
}

export interface Fireshed {
  /** hours for a design-day fire starting at each cell to reach the nearest homes (Infinity beyond the cap) */
  hours: Float32Array;
  /** the town it would reach first (-1: none) */
  town: Int8Array;
  /** what each cell would do on the worst design day: 0 no fire, 1 flames a hand crew can face, 2 too hot for hand crews, 3 too hot for engines, 4 torching or crown fire */
  behaviour: Uint8Array;
  /** flame length on the worst design day, m */
  flame: Float32Array;
  towns: TownExposure[];
  day: number;
}

/** A new start's first 3-hour step runs at this fraction of its rate; what that costs a fire that outlasts it. */
const BUILD_FIRST = 0.35,
  START_GAIN = HOURS * BUILD_FIRST,
  START_LOSS = HOURS * (1 - BUILD_FIRST);
/** How many times, on average, each burning side exposes a house as a front passes. */
const EXPOSURES_PER_SIDE = 1.6;
const fuelScratch: CellFuel = { fine: 0, grassShare: 0, ladder: 0, canopy: 0, heavy: 0, green: 0 };

/** Beyond this many hours a cell is not part of any town's fireshed. */
export const FIRESHED_CAP = 36;

/**
 * For every cell, the time a fire starting there on a design day needs to reach homes, by a
 * backward search from the ground beside each town's houses; and for every town, what that means.
 */
export function computeFireshed(w: World, cases: DesignCase[] = designCases(w)): Fireshed {
  const L = w.L;
  const W = w.W,
    H = w.H,
    N = w.N;
  const hours = new Float32Array(N).fill(Infinity);
  const town = new Int8Array(N).fill(-1);
  const behaviour = new Uint8Array(N);
  const flame = new Float32Array(N);

  // targets: fuel-bearing ground beside a house
  const targets: Array<[number, number]> = [];
  const isTarget = new Int8Array(N).fill(-1);
  for (let i = 0; i < N; i++) {
    const tid = L.town[i] - 1;
    if (tid < 0) continue;
    const x = i % W,
      y = (i / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d],
        ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (L.town[n] !== 0 || L.water[n] >= 2 || L.pond[n] > 0.35 || isTarget[n] >= 0) continue;
      isTarget[n] = tid;
      targets.push([n, tid]);
    }
  }

  const heap = new MinHeap(4096);
  for (const c of cases) {
    const f = new TermsField(N, designEnv(w, c));
    const env = f.env;
    // what each cell does when a design fire arrives head-on: its flames, and whether it torches
    const dFlame = new Float32Array(N);
    const dCrown = new Uint8Array(N);
    const design = (n: number): void => {
      if (dFlame[n] !== 0) return;
      f.ensure(w, n);
      if (!f.fuel[n]) {
        dFlame[n] = -1;
        return;
      }
      const bh = arrivalBehaviour(f.load[n], f.canopy[n], f.i0[n], f.head[n], 0);
      dFlame[n] = Math.max(1e-3, bh.flame);
      dCrown[n] = bh.crown ? 1 : 0;
    };
    const hc = new Float32Array(N).fill(Infinity);
    heap.clear();
    for (const [n, tid] of targets) {
      f.ensure(w, n);
      if (!f.fuel[n]) continue;
      hc[n] = 0;
      if (0 < hours[n]) {
        hours[n] = 0;
        town[n] = tid;
      }
      heap.push(0, n);
    }
    while (heap.size > 0) {
      const t = heap.peekKey();
      const y0 = heap.pop();
      if (t > hc[y0] + 1e-6) continue;
      const yx = y0 % W,
        yy = (y0 / W) | 0;
      const yRoad = (L.infra[y0] & (INFRA.ROAD | INFRA.FUELBREAK)) !== 0;
      for (let d = 0; d < 16; d++) {
        // the cell X a fire would come FROM to enter y0 along direction d
        const xx = yx - DX[d],
          xy = yy - DY[d];
        if (xx < 0 || xy < 0 || xx >= W || xy >= H) continue;
        const x = xy * W + xx;
        if (hc[x] <= t) continue;
        if (L.water[x] >= 2 || L.pond[x] > 0.35 || L.town[x] !== 0) continue;
        if (d >= 8) {
          if (yRoad) continue;
          const [c1, c2] = knightVia(W, x, d);
          if (!passableGround(w, c1) || !passableGround(w, c2)) continue;
        }
        design(x);
        if (dFlame[x] < 0) continue; // nothing to burn at the origin
        const crownSrc = dCrown[x] === 1;
        edgeRates(w, f, x, y0, d, crownSrc, dFlame[x]);
        let R = edge.rs > edge.rc ? edge.rs : edge.rc;
        if (R < R_MIN) R *= HOLD_VIGOR;
        if (R <= 1e-5) continue;
        let tx = t + DIST[d] / R;
        if (yRoad && !crownSrc) tx += roadDelay(w, y0, env, d, dFlame[x]);
        if (!(tx < hc[x]) || tx > FIRESHED_CAP) continue;
        hc[x] = tx;
        heap.push(tx, x);
      }
    }
    for (let i = 0; i < N; i++) {
      if (hc[i] < hours[i]) hours[i] = hc[i];
      // what every piece of ground would do on this day, reached by the search or not
      if (L.water[i] < 2 && L.town[i] === 0) design(i);
      if (dFlame[i] > flame[i]) {
        flame[i] = dFlame[i];
        const fl = dFlame[i];
        behaviour[i] = dCrown[i] ? 4 : fl > 2.4 ? 3 : fl > 1.2 ? 2 : 1;
      }
    }
  }
  // A fire starting somewhere is not a front yet: it spends its first step at about a third of its
  // rate (fire.ts: buildUp). The search above timed an established fire; add what the start costs.
  for (let i = 0; i < N; i++) {
    const h = hours[i];
    if (h === Infinity || h === 0) continue;
    const t = h <= START_GAIN ? h / BUILD_FIRST : h + START_LOSS;
    hours[i] = t > FIRESHED_CAP ? Infinity : t;
  }
  // which town: the nearest town's homes, for cells inside some fireshed
  if (w.towns.length) {
    for (let i = 0; i < N; i++) {
      if (hours[i] === Infinity) continue;
      if (isTarget[i] >= 0) {
        town[i] = isTarget[i];
        continue;
      }
      const x = i % W,
        y = (i / W) | 0;
      let best = 0,
        bd = Infinity;
      for (const t of w.towns) {
        const dd = (t.x - x) * (t.x - x) + (t.y - y) * (t.y - y);
        if (dd < bd) {
          bd = dd;
          best = t.id;
        }
      }
      town[i] = best;
    }
  }

  const towns: TownExposure[] = w.towns.map((t) => ({ id: t.id, homes: 0, exposed: 0, area6: 0, area12: 0, crownEdge: 0, risk: 0 }));
  for (let i = 0; i < N; i++) {
    const tid = town[i];
    if (tid < 0 || !towns[tid] || L.town[i] !== 0) continue;
    if (hours[i] <= 6) towns[tid].area6++;
    if (hours[i] <= BURN_PERIOD) towns[tid].area12++;
  }
  const edgeN = towns.map(() => 0),
    edgeCrown = towns.map(() => 0);
  for (const [n, tid] of targets) {
    if (!(flame[n] > 0)) continue;
    edgeN[tid]++;
    if (behaviour[n] === 4) edgeCrown[tid]++;
  }
  for (let i = 0; i < N; i++) {
    const tid = L.town[i] - 1;
    if (tid < 0 || !towns[tid]) continue;
    const te = towns[tid];
    te.homes++;
    const fw = w.towns[tid].firewise;
    const x = i % W,
      y = (i / W) | 0;
    let safe = 1;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d],
        ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (!(flame[n] > 0) || L.town[n] !== 0) continue;
      // a front passing a house exposes it from each burning side for a step or two (the exponent
      // is fitted to what the simulation takes: scripts/v2/project.ts homes)
      const p = structureExposure(flame[n], cellFuel(w, n, fuelScratch, DESIGN_GREEN).grassShare) * (1 - 0.75 * fw);
      safe *= Math.pow(1 - p, EXPOSURES_PER_SIDE);
    }
    te.exposed += 1 - safe;
  }
  for (const te of towns) {
    te.crownEdge = edgeN[te.id] ? edgeCrown[te.id] / edgeN[te.id] : 0;
    te.risk = te.homes ? 100 * (te.exposed / te.homes) * clamp01(Math.sqrt(te.area12 / 1500)) : 0;
  }
  return { hours, town, behaviour, flame, towns, day: w.day };
}

/**
 * Take the towns' exposure to a design-day fire and keep it in the world's memory: the figure the
 * council's residents, the scenario objectives and the legacy score all read. Taken when a tenure
 * begins and at every year's end.
 */
export function refreshExposure(w: World, endOfYear = false): void {
  const fs = computeFireshed(w);
  let homes = 0,
    exposed = 0;
  for (const t of fs.towns) {
    homes += t.homes;
    exposed += t.exposed;
  }
  const now = homes ? exposed / homes : 0;
  const prev = w.memory.exposure;
  const history = prev ? prev.history.slice(-60) : [];
  if (endOfYear || !prev) history.push(Math.round(now * 1000) / 1000);
  if (endOfYear) discover(w, 'fireshed');
  w.memory.exposure = {
    start: prev ? prev.start : now,
    now,
    year: w.year,
    towns: fs.towns.map((t) => ({ id: t.id, homes: t.homes, exposed: Math.round(t.exposed * 10) / 10, risk: Math.round(t.risk), area12: t.area12, crownEdge: Math.round(t.crownEdge * 100) / 100 })),
    history,
  };
}
