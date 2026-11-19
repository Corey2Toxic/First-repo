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
import { diurnal } from './climate.ts';
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
  const heavyAvail = 0.25 + 0.5 * smoothstep(0.25, 0.9, w.climate.droughtIndex);
  L.ftime[i] = Math.min(48, 3 + L.litter[i] * 0.25 + f.heavy * heavyAvail + (crown ? 3 : 0));
  w.burning.push(i);
  fe.area++;
  if (crown) fe.crownArea++;
  if (I > fe.maxIntensity) fe.maxIntensity = I;
  const x = i % w.W,
    y = (i / w.W) | 0;
  if (x < fe.minX) fe.minX = x;
  if (y < fe.minY) fe.minY = y;
  if (x > fe.maxX) fe.maxX = x;
  if (y > fe.maxY) fe.maxY = y;
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

/** Rate of spread (cells/hour) from burning cell b into neighbour n (direction d). */
function spreadRate(ctx: StepCtx, b: number, n: number, d: number, vigor: number, crownSrc: boolean): number {
  const w = ctx.w;
  const L = w.L;
  const f = tmpFuel;
  cellFuel(w, n, f);
  if (f.fine < 0.5) return 0;
  const fm = Math.max(0.02, L.fm[n] + ctx.fmAdd + f.green * (0.06 + 0.06 * f.grassShare));
  // cured grass has a low moisture of extinction; litter and duff a higher one
  const mx = 0.15 + 0.13 * (1 - f.grassShare);
  const damp = moistureDamping(fm / mx);
  const dist = DIST8[d];
  const canopyCov = L.pine[n] + L.fir[n] + L.aspen[n] * 0.6;
  const windMid = ctx.windEff * (1 - 0.55 * Math.min(1, canopyCov));
  const cosT = (DX8[d] * ctx.wdx + DY8[d] * ctx.wdy) / dist;
  const wf = Math.exp(0.22 * windMid * cosT);
  const tanPhi = (L.elev[n] - L.elev[b]) / (dist * 100);
  const sf = tanPhi > 0 ? Math.exp(3.2 * Math.min(tanPhi, 0.8)) : Math.exp(1.2 * Math.max(tanPhi, -0.8));
  // base rates (cells/hour = 100 m/h) are deliberately below free-burning values to stand in
  // for sub-cell fuel discontinuities (rocks, trails, moist draws) the grid cannot resolve
  const R0 = (0.024 + 0.17 * f.grassShare + 0.03 * L.shrub[n]) * smoothstep(0.5, 6, f.fine);
  let R = R0 * damp * wf * sf * ctx.spread;
  if (crownSrc && f.canopy > 0.3) {
    const crownDamp = clamp01(1 - fm / 0.2) * (1 - 0.55 * f.green * (1 - f.grassShare));
    const Rc = (0.1 + 0.12 * ctx.windEff) * crownDamp * f.canopy * Math.pow(Math.max(wf, 0.05), 0.6) * Math.pow(sf, 0.7);
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
    const tau = r.exponential(DIST8[d] / R);
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
    scheduleFrom(ctx, b, 0, vigor);
  }

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
  const floor = 0.06 + 0.07 * smoothstep(0.3, 0.9, w.climate.droughtIndex);
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
    if (hooks.onEscape) hooks.onEscape(fe);
  }
}

// per-world cache of project unit membership (ids restart in every new game)
const projectSets = new WeakMap<World, Map<number, Set<number>>>();
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
    const tid = L.town[i] - 1;
    L.town[i] = -(tid + 1);
    const t = w.towns[tid];
    if (t) {
      t.structures = Math.max(0, t.structures - 1);
      t.lostStructures++;
    }
    w.counters.yearStructuresLost++;
    w.counters.totalStructuresLost++;
    if (fe) {
      fe.structuresLost++;
      if (hooks.onStructureLost) hooks.onStructureLost(tid, i, fe);
    }
    w.dirty.infra++;
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
function updateFireEvents(w: World, hooks: FireStepHooks): void {
  const L = w.L;
  const counts = new Map<number, number>();
  for (const b of w.burning) counts.set(L.fid[b], (counts.get(L.fid[b]) ?? 0) + 1);
  for (const fe of w.fires) {
    if (!fe.active) continue;
    fe.burning = counts.get(fe.id) ?? 0;
    if (fe.burning === 0) {
      fe.active = false;
      fe.outDay = w.day;
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
        if (fe) started.push(fe);
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
        if (fe) started.push(fe);
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
      fe.response = defaultResponse(w, oi, fe.cause);
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
