/**
 * Crews: hand crews, engines and helicopters. Each crew is a small state
 * machine (idle → moving → working → returning) driven either by the
 * automatic dispatcher or by player orders. Ground crews path-find over the
 * terrain (roads are fast, steep brush is slow, they will not walk into
 * fire), build fireline around the flanks of fires and mop up; engines
 * defend houses; helicopters shuttle water from the nearest lake, river or
 * beaver pond.
 */
import { DX8, DY8, astar, clamp01 } from '../grid.ts';
import { FIRE, INFRA, SUBSTEPS_PER_DAY } from '../types.ts';
import type { Crew, FireEvent, Project } from '../types.ts';
import { COST, WORK } from '../economyParams.ts';
import type { World } from '../world.ts';
import { igniteProjectBurn, projectWorkCell, completeProjectCell, burnWindowOpen } from './projects.ts';
import { cellFuel } from './fuels.ts';
import type { CellFuel } from './fuels.ts';

const HOURS = 24 / SUBSTEPS_PER_DAY;

export function isDayShift(w: World): boolean {
  return w.sub >= 2 && w.sub <= 5; // 06:00–18:00
}

/**
 * Travel time in hours per 100 m cell. v1.0 moved engines at ~3 km/h on roads, hand crews at
 * 50–140 m/h across country and helicopters at 6 km/h, so initial attack routinely arrived a day
 * late. Reference speeds used now: engines and crew carriers ~30 km/h on mountain roads; engines
 * crawl across gentle open ground (~3 km/h) and cannot climb steep ground; hand crews hike
 * ~2.5 km/h on open level ground, slower uphill and through brush or young thickets; wading a
 * river costs time. Helicopters fly (see `travel`).
 */
export const ROAD_HOURS_PER_CELL = 0.0035;
function stepCost(w: World, kind: Crew['kind']) {
  const L = w.L;
  return (from: number, to: number, diag: boolean): number => {
    if (L.water[to] >= 2 || L.pond[to] > 0.35) return Infinity;
    if (L.fire[to] === FIRE.BURNING) return Infinity;
    const d = diag ? Math.SQRT2 : 1;
    const road = (L.infra[to] & INFRA.ROAD) !== 0 && (L.infra[from] & INFRA.ROAD) !== 0;
    if (road) return ROAD_HOURS_PER_CELL * d;
    if (kind === 'engine') {
      if (L.slope[to] > 0.35) return Infinity;
      return d * 0.035 * (1 + 10 * L.slope[to]) * (1 + 0.8 * (L.shrub[to] + L.fir[to] + L.pine[to])) + (L.flowAcc[to] > 1000 ? 0.5 : 0);
    }
    return d * 0.04 * (1 + 5 * L.slope[to]) * (1 + 0.8 * (L.shrub[to] + L.fir[to])) + (L.flowAcc[to] > 1000 ? 0.3 : 0);
  };
}
/** Helicopter cruise speed, cells (100 m) per hour: ~160 km/h. */
const HELI_SPEED = 1600;

export function crewCell(w: World, c: Crew): number {
  const x = Math.max(0, Math.min(w.W - 1, Math.floor(c.x))),
    y = Math.max(0, Math.min(w.H - 1, Math.floor(c.y)));
  return y * w.W + x;
}

/** Plan a path for a crew to a goal cell; returns false if unreachable. */
export function planPath(w: World, c: Crew, goal: number): boolean {
  if (c.kind === 'heli') {
    c.path = [goal];
    return true;
  }
  const start = crewCell(w, c);
  if (start === goal) {
    c.path = [];
    return true;
  }
  // heuristic scale = cheapest step (a road) keeps A* admissible, so crews really use roads
  const p = astar(w.W, w.H, start, goal, stepCost(w, c.kind), ROAD_HOURS_PER_CELL, 160000);
  if (!p) return false;
  c.path = p;
  return true;
}

/** Advance along the path using up to `hours`; returns hours left over. */
function travel(w: World, c: Crew, hours: number): number {
  if (c.kind === 'heli') {
    if (c.path.length === 0) return hours;
    const g = c.path[0];
    const gx = (g % w.W) + 0.5,
      gy = ((g / w.W) | 0) + 0.5;
    const dist = Math.hypot(gx - c.x, gy - c.y);
    const speed = HELI_SPEED;
    const t = dist / speed;
    if (t <= hours) {
      c.x = gx;
      c.y = gy;
      c.path = [];
      return hours - t;
    }
    c.x += ((gx - c.x) / dist) * speed * hours;
    c.y += ((gy - c.y) / dist) * speed * hours;
    return 0;
  }
  const cost = stepCost(w, c.kind);
  let left = hours;
  while (c.path.length > 0 && left > 0) {
    const from = crewCell(w, c);
    const next = c.path[0];
    const diag = (next % w.W) !== (from % w.W) && ((next / w.W) | 0) !== ((from / w.W) | 0);
    let t = cost(from, next, diag);
    if (!isFinite(t)) {
      // path blocked by fire or flooding — replan next tick
      c.path = [];
      break;
    }
    t = Math.max(0.01, t);
    if (t > left) {
      // partial progress: carry fractional position for smooth rendering
      const k = left / t;
      c.x += ((next % w.W) + 0.5 - c.x) * k;
      c.y += (((next / w.W) | 0) + 0.5 - c.y) * k;
      left = 0;
      break;
    }
    left -= t;
    c.x = (next % w.W) + 0.5;
    c.y = ((next / w.W) | 0) + 0.5;
    c.path.shift();
  }
  return left;
}

function goHome(w: World, c: Crew): void {
  c.task = null;
  c.manual = false;
  c.workCell = -1;
  if (crewCell(w, c) === c.home) {
    c.state = 'idle';
    c.path = [];
    return;
  }
  if (planPath(w, c, c.home)) c.state = 'returning';
  else {
    // stranded: teleport home (flown out)
    c.x = (c.home % w.W) + 0.5;
    c.y = ((c.home / w.W) | 0) + 0.5;
    c.state = 'idle';
  }
}

// ------------------------------------------------------------ fire geometry
interface Perim {
  cell: number;
  danger: number; // adjacent intensity
}

/** Unburned, burnable cells next to this fire near (x, y), within radius r. */
function localPerimeter(w: World, fe: FireEvent, x: number, y: number, r: number): Perim[] {
  const L = w.L;
  const out: Perim[] = [];
  const x0 = Math.max(1, Math.floor(x - r)),
    x1 = Math.min(w.W - 2, Math.ceil(x + r));
  const y0 = Math.max(1, Math.floor(y - r)),
    y1 = Math.min(w.H - 2, Math.ceil(y + r));
  for (let yy = y0; yy <= y1; yy++)
    for (let xx = x0; xx <= x1; xx++) {
      const i = yy * w.W + xx;
      if (L.fire[i] !== FIRE.NONE || L.water[i] >= 2 || L.town[i] > 0) continue;
      let adj = false,
        danger = 0;
      for (let d = 0; d < 8; d++) {
        const n = i + DY8[d] * w.W + DX8[d];
        if (L.fire[n] === FIRE.BURNING && L.fid[n] === fe.id) {
          adj = true;
          danger = Math.max(danger, L.crown[n] ? 2 : L.fint[n]);
        }
      }
      if (adj) out.push({ cell: i, danger });
    }
  return out;
}

/** Nearest perimeter point of a fire to (x, y), scanning its burning cells. */
function nearestPerimeter(w: World, fe: FireEvent, x: number, y: number, maxDanger = 0.85): number {
  const L = w.L;
  let best = -1,
    bd = Infinity;
  for (const b of w.burning) {
    if (L.fid[b] !== fe.id) continue;
    const bx = b % w.W,
      by = (b / w.W) | 0;
    if (L.crown[b] || L.fint[b] > maxDanger) continue;
    for (let d = 0; d < 8; d += 2) {
      const nx = bx + DX8[d],
        ny = by + DY8[d];
      if (!w.inside(nx, ny)) continue;
      const n = ny * w.W + nx;
      if (L.fire[n] !== FIRE.NONE || L.water[n] >= 2) continue;
      const dd = (nx - x) * (nx - x) + (ny - y) * (ny - y);
      if (dd < bd) {
        bd = dd;
        best = n;
      }
    }
  }
  return best;
}

function nearestWater(w: World, x: number, y: number, maxR = 22): number {
  const L = w.L;
  let best = -1,
    bd = Infinity;
  const x0 = Math.max(0, Math.floor(x - maxR)),
    x1 = Math.min(w.W - 1, Math.ceil(x + maxR));
  const y0 = Math.max(0, Math.floor(y - maxR)),
    y1 = Math.min(w.H - 1, Math.ceil(y + maxR));
  for (let yy = y0; yy <= y1; yy++)
    for (let xx = x0; xx <= x1; xx++) {
      const i = yy * w.W + xx;
      if (!(L.water[i] >= 2 || L.pond[i] > 0.3 || L.flowAcc[i] > 1500)) continue;
      const d = (xx - x) * (xx - x) + (yy - y) * (yy - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
  return best;
}

function extinguish(w: World, i: number): void {
  // a burning house is beyond a hose line or a bucket: cutting its burn time would only bring its
  // loss forward (v1.0 did exactly that). Crews protect houses before they catch (structureProtection).
  if (w.L.town[i] > 0) return;
  // cut the remaining burn time: the cell burns out next step at its current severity
  w.L.ftime[i] = Math.min(w.L.ftime[i], 0.01);
  w.L.fint[i] = Math.min(w.L.fint[i], 0.05);
}

export function fireThreat(w: World, fe: FireEvent): { town: number; dist: number } {
  let town = -1,
    dist = Infinity;
  const cx = (fe.minX + fe.maxX) / 2,
    cy = (fe.minY + fe.maxY) / 2;
  const rad = Math.max(fe.maxX - fe.minX, fe.maxY - fe.minY) / 2;
  for (const t of w.towns) {
    const d = Math.max(0, Math.hypot(t.x - cx, t.y - cy) - rad - Math.sqrt(t.structures) * 0.6);
    if (d < dist) {
      dist = d;
      town = t.id;
    }
  }
  return { town, dist };
}

// ------------------------------------------------------------ dispatch
export function fireById(w: World, id: number): FireEvent | undefined {
  for (let k = w.fires.length - 1; k >= 0; k--) if (w.fires[k].id === id) return w.fires[k];
  return undefined;
}

/**
 * A crew taken off a treatment puts it back in the queue for the next free crew (v1.0 left it
 * 'active' with nobody on it, so it was never picked up again). Burns being held are never left.
 */
export function releaseProject(w: World, c: Crew): void {
  if (c.task?.kind !== 'project') return;
  const pr = w.projects.find((p) => p.id === c.task!.projectId);
  if (pr && (pr.status === 'active' || pr.status === 'waiting')) pr.status = 'queued';
}

export function assignToFire(w: World, c: Crew, fe: FireEvent, manual = false): boolean {
  const cx = (fe.minX + fe.maxX) / 2,
    cy = (fe.minY + fe.maxY) / 2;
  let goal: number;
  if (c.kind === 'engine') {
    const th = fireThreat(w, fe);
    const t = th.town >= 0 ? w.towns[th.town] : null;
    if (t && th.dist < 14) goal = townEdgeToward(w, t.id, cx, cy);
    else goal = nearestRoadTo(w, cx, cy);
  } else if (c.kind === 'heli') {
    goal = Math.round(cy) * w.W + Math.round(cx);
  } else {
    const home = c.home;
    goal = nearestPerimeter(w, fe, home % w.W, (home / w.W) | 0);
    if (goal < 0) goal = Math.round(cy) * w.W + Math.round(cx);
  }
  // plan first: a crew that cannot reach the fire keeps whatever it was doing
  if (!planPath(w, c, goal)) return false;
  // a project left behind goes back in the queue for the next free crew (v1.0 left it 'active'
  // with nobody on it, so it was never picked up again)
  releaseProject(w, c);
  c.task = { kind: 'suppress', fireId: fe.id };
  c.manual = manual;
  c.workCell = -1;
  c.state = 'moving';
  return true;
}

function townEdgeToward(w: World, townId: number, x: number, y: number): number {
  const L = w.L;
  let best = -1,
    bd = Infinity;
  const t = w.towns[townId];
  const r = 6 + Math.sqrt(t.structures);
  for (let yy = Math.max(0, Math.floor(t.y - r)); yy <= Math.min(w.H - 1, Math.ceil(t.y + r)); yy++)
    for (let xx = Math.max(0, Math.floor(t.x - r)); xx <= Math.min(w.W - 1, Math.ceil(t.x + r)); xx++) {
      const i = yy * w.W + xx;
      if (L.town[i] !== townId + 1) continue;
      const d = Math.hypot(xx - x, yy - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
  return best >= 0 ? best : t.station;
}

function nearestRoadTo(w: World, x: number, y: number): number {
  const L = w.L;
  let best = -1,
    bd = Infinity;
  for (let r = 1; r < 40 && best < 0; r += 3)
    for (let yy = Math.max(0, Math.floor(y - r)); yy <= Math.min(w.H - 1, Math.ceil(y + r)); yy++)
      for (let xx = Math.max(0, Math.floor(x - r)); xx <= Math.min(w.W - 1, Math.ceil(x + r)); xx++) {
        const i = yy * w.W + xx;
        if (!(L.infra[i] & INFRA.ROAD) || L.fire[i] !== FIRE.NONE) continue;
        const d = Math.hypot(xx - x, yy - y);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
  return best >= 0 ? best : Math.round(y) * w.W + Math.round(x);
}

/** Assign idle crews to fires that need them, by priority. */
export function autoDispatch(w: World): void {
  if (!w.policies.autoDispatch) return;
  const fires = w.fires.filter((f) => f.active && f.detected && f.response !== 'monitor' && f.cause !== 'prescribed');
  if (fires.length === 0) return;
  const scored = fires
    .map((fe) => {
      const th = fireThreat(w, fe);
      // fires in a Community Buffer come first, whatever their size
      return { fe, th, score: (fe.response === 'suppress' ? 1 : 0.5) * (40 / (5 + th.dist)) + Math.sqrt(fe.area) * 0.2 + (fe.inBuffer ? 25 : 0) };
    })
    .sort((a, b) => b.score - a.score);
  const assigned = (fe: FireEvent, kind?: Crew['kind']) =>
    w.crews.filter((c) => c.task?.fireId === fe.id && (!kind || c.kind === kind)).length;
  for (const c of w.crews) {
    // idle crews, crews heading home from a finished job, and crews on routine project work
    const free = c.state === 'idle' || (c.state === 'returning' && !c.task) || (c.task?.kind === 'project' && !c.manual);
    if (!free) continue;
    if (c.manual) continue;
    if (c.fatigue > 0.95) continue;
    for (const { fe, th } of scored) {
      if (c.kind === 'engine' && th.dist > 16 && !fe.inBuffer) continue; // engines defend homes and roadsides
      if (fe.response === 'contain' && c.kind === 'hand' && th.dist > 20) continue;
      const want = (c.kind === 'hand' ? Math.min(4, 1 + Math.floor(Math.sqrt(fe.area) / 8)) : c.kind === 'engine' ? 2 : 1) + (fe.inBuffer && c.kind !== 'heli' ? 1 : 0);
      if (assigned(fe, c.kind) >= want) continue;
      // projects yield to fires
      const pr = c.task?.kind === 'project' ? w.projects.find((p) => p.id === c.task!.projectId) : undefined;
      if (pr && pr.status === 'burning') continue; // never abandon a burn in progress
      if (assignToFire(w, c, fe)) break;
    }
  }
}

/** Give idle hand crews queued projects (fires take precedence). */
export function assignProjects(w: World): void {
  for (const c of w.crews) {
    if (c.state !== 'idle' || c.kind !== 'hand' || c.fatigue > 0.95) continue;
    const pr = w.projects.find((p) => (p.status === 'queued' || p.status === 'waiting') && !w.crews.some((o) => o.task?.projectId === p.id));
    if (!pr) return;
    const cell = projectWorkCell(w, pr, crewCell(w, c));
    if (cell < 0) continue;
    if (!planPath(w, c, cell)) continue;
    c.task = { kind: 'project', projectId: pr.id };
    c.state = 'moving';
    c.workCell = cell;
    if (pr.status === 'queued') pr.status = 'active';
  }
}

// ------------------------------------------------------------ per-tick crew update
export interface CrewHooks {
  onCrewRetreat?: (c: Crew, fe: FireEvent) => void;
  onBurnIgnited?: (pr: Project, fe: FireEvent) => void;
}

/**
 * Initial attack: the dispatcher runs every sub-step while any reported fire is burning, so crews
 * roll within the same 3-hour step a fire is reported (v1.0 dispatched only at midnight, a median
 * 15 h after the report, and most fires were found mid-afternoon).
 */
function dispatchIfNeeded(w: World): void {
  if (!w.policies.autoDispatch || w.burning.length === 0) return;
  for (const fe of w.fires) {
    if (fe.active && fe.detected && fe.response !== 'monitor' && fe.cause !== 'prescribed') {
      autoDispatch(w);
      return;
    }
  }
}

export function crewsSubstep(w: World, hooks: CrewHooks = {}): void {
  const day = isDayShift(w);
  dispatchIfNeeded(w);
  for (const c of w.crews) {
    c.px = c.x;
    c.py = c.y;
    // fatigue accrues while working, recovers while idle
    if (c.state === 'working') c.fatigue = clamp01(c.fatigue + 0.03);
    else c.fatigue = clamp01(c.fatigue - 0.05);
    const t = c.task;
    if (c.state === 'idle') continue;
    if (c.state === 'returning') {
      travel(w, c, HOURS);
      if (c.path.length === 0) {
        c.state = 'idle';
        c.x = (c.home % w.W) + 0.5;
        c.y = ((c.home / w.W) | 0) + 0.5;
      }
      continue;
    }
    if (!t) {
      goHome(w, c);
      continue;
    }
    if (t.kind === 'suppress') suppressTick(w, c, day, hooks);
    else if (t.kind === 'project') projectTick(w, c, day, hooks);
    else if (t.kind === 'line') lineTick(w, c, day);
    else if (t.kind === 'move') {
      travel(w, c, HOURS);
      if (c.path.length === 0) {
        c.state = 'working';
        c.task = null; // stand by here
      }
    }
  }
}

function chargeFire(w: World, fe: FireEvent | undefined, hours: number, kind: Crew['kind']): void {
  const rate = COST.suppressionHour * (kind === 'heli' ? 3.5 : kind === 'engine' ? 1.2 : 1);
  const amt = rate * hours;
  w.spend('Suppression', amt);
  if (fe) fe.cost += amt;
}

function suppressTick(w: World, c: Crew, day: boolean, hooks: CrewHooks): void {
  const L = w.L;
  const fe = fireById(w, c.task!.fireId!);
  if (!fe || !fe.active) {
    goHome(w, c);
    return;
  }
  // monitor-only fires do not get ground crews unless ordered manually
  if (fe.response === 'monitor' && !c.manual) {
    goHome(w, c);
    return;
  }
  let hours = HOURS;
  if (c.path.length > 0) {
    hours = travel(w, c, hours);
    c.state = c.path.length > 0 ? 'moving' : 'working';
    if (hours <= 0.2) return;
  }
  c.state = 'working';
  // night: helicopters are grounded; hand crews keep working a small fire through its first night
  // (initial attack — the calm, damp night is the best time to hold it) but rest on large ones;
  // engines keep defending houses
  const initialAttack = fe.area <= 40 && c.fatigue < 0.75;
  if (!day && c.kind === 'heli') return;
  if (!day && c.kind === 'hand' && !initialAttack) return;
  if (c.kind === 'heli') return heliTick(w, c, fe, hours);
  chargeFire(w, fe, hours, c.kind);
  c.hoursWorked += hours;
  if (c.kind === 'engine') {
    // direct attack on low-intensity fire within hose reach, protect houses (see structureProtection)
    let done = 0;
    const cx = Math.floor(c.x),
      cy = Math.floor(c.y);
    const cap = WORK.mopUp.engine * (hours / HOURS);
    for (let r = 0; r <= 3 && done < cap; r++)
      for (let dy = -r; dy <= r && done < cap; dy++)
        for (let dx = -r; dx <= r && done < cap; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx,
            y = cy + dy;
          if (!w.inside(x, y)) continue;
          const i = y * w.W + x;
          if (L.fire[i] === FIRE.BURNING && L.fid[i] === fe.id && L.fint[i] < 0.6) {
            extinguish(w, i);
            done++;
          }
        }
    // nothing in reach: drive to the road nearest the fire's edge — unless holding a threatened town
    const th = fireThreat(w, fe);
    if (done === 0 && th.dist > 6) {
      const edge = nearestPerimeter(w, fe, c.x, c.y, 0.6);
      const goal = edge >= 0 ? nearestRoadTo(w, edge % w.W, (edge / w.W) | 0) : nearestRoadTo(w, (fe.minX + fe.maxX) / 2, (fe.minY + fe.maxY) / 2);
      if (goal !== crewCell(w, c)) planPath(w, c, goal);
    }
    return;
  }
  // hand crew: walk the perimeter cutting line, mop up behind. Line goes in fastest in grass
  // (a scraped strip) and slowest through brush, young thickets and slash.
  const cx = c.x,
    cy = c.y;
  let budget = WORK.lineCells.hand * (1 - 0.5 * c.fatigue) * (hours / HOURS) * (day ? 1 : 0.6);
  let built = 0;
  let px = cx,
    py = cy;
  let guard = 0;
  while (budget > 0 && guard++ < 30) {
    const cand = localPerimeter(w, fe, px, py, 3).filter((p) => p.danger <= 0.85 && L.fline[p.cell] < 0.6);
    if (cand.length === 0) break;
    cand.sort((a, b) => {
      const da = Math.hypot((a.cell % w.W) + 0.5 - px, ((a.cell / w.W) | 0) + 0.5 - py);
      const db = Math.hypot((b.cell % w.W) + 0.5 - px, ((b.cell / w.W) | 0) + 0.5 - py);
      return da - db;
    });
    const target = cand[0].cell;
    L.fline[target] = 1;
    px = (target % w.W) + 0.5;
    py = ((target / w.W) | 0) + 0.5;
    budget -= lineEffort(w, target);
    built++;
    w.dirty.fire++;
  }
  // mop up smouldering edge cells next to line
  let mop = WORK.mopUp.hand;
  for (let dy = -2; dy <= 2 && mop > 0; dy++)
    for (let dx = -2; dx <= 2 && mop > 0; dx++) {
      const x = Math.floor(px) + dx,
        y = Math.floor(py) + dy;
      if (!w.inside(x, y)) continue;
      const i = y * w.W + x;
      if (L.fire[i] === FIRE.BURNING && L.fid[i] === fe.id && L.fint[i] < 0.3) {
        extinguish(w, i);
        mop--;
      }
    }
  c.x = px;
  c.y = py;
  // nothing workable nearby? relocate along the perimeter, or retreat from crown fire
  if (built === 0) {
    const near = localPerimeter(w, fe, cx, cy, 3);
    if (near.some((p) => p.danger > 0.85)) {
      if (hooks.onCrewRetreat) hooks.onCrewRetreat(c, fe);
    }
    const goal = nearestPerimeter(w, fe, cx, cy);
    if (goal >= 0 && goal !== crewCell(w, c)) {
      if (!planPath(w, c, goal)) goHome(w, c);
      else c.state = 'moving';
    } else if (goal < 0) {
      // the whole edge is too hot to approach: pull back toward home and wait
      if (crewCell(w, c) !== c.home) goHome(w, c);
    }
  }
}

/** Relative effort to cut one cell of line: ~0.45 in cured grass, 1 in litter, up to ~1.9 in heavy brush or slash. */
const lineFuel: CellFuel = { fine: 0, grassShare: 0, ladder: 0, canopy: 0, heavy: 0, green: 0 };
function lineEffort(w: World, i: number): number {
  const L = w.L;
  const f = cellFuel(w, i, lineFuel);
  const heavy = clamp01(L.shrub[i] + L.slash[i] / 25 + 0.5 * L.fir[i] * (L.ageF[i] < 40 ? 1 : 0.3));
  return 0.45 + 0.55 * (1 - f.grassShare) + 0.9 * heavy;
}

function heliTick(w: World, c: Crew, fe: FireEvent, hours: number): void {
  const L = w.L;
  const cx = (fe.minX + fe.maxX) / 2,
    cy = (fe.minY + fe.maxY) / 2;
  const water = nearestWater(w, cx, cy, 24);
  if (water < 0) return; // no dip site within range
  const dist = Math.hypot((water % w.W) - cx, ((water / w.W) | 0) - cy);
  const drops = Math.round((dist < 6 ? WORK.drops.near : dist < 14 ? WORK.drops.far : 1) * (hours / HOURS));
  chargeFire(w, fe, hours, 'heli');
  c.hoursWorked += hours;
  // target the hottest edge nearest a threatened town, else the head of the fire
  const th = fireThreat(w, fe);
  const t = th.town >= 0 ? w.towns[th.town] : null;
  const ref = t && th.dist < 20 ? [t.x, t.y] : [cx + Math.cos(w.weather.windDir) * 50, cy + Math.sin(w.weather.windDir) * 50];
  const targets = w.burning
    .filter((b) => L.fid[b] === fe.id)
    .sort((a, b) => Math.hypot((a % w.W) - ref[0], ((a / w.W) | 0) - ref[1]) - Math.hypot((b % w.W) - ref[0], ((b / w.W) | 0) - ref[1]));
  for (let k = 0; k < drops && k < targets.length; k++) {
    const b = targets[k];
    const bx = b % w.W,
      by = (b / w.W) | 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!w.inside(bx + dx, by + dy)) continue;
        const i = (by + dy) * w.W + bx + dx;
        L.wet[i] = Math.max(L.wet[i], 0.85);
        if (L.fire[i] === FIRE.BURNING) {
          if (L.fint[i] < 0.75 && !L.crown[i]) extinguish(w, i);
          else L.fint[i] *= 0.6;
        }
      }
    c.x = bx + 0.5;
    c.y = by + 0.5;
  }
  w.dirty.fire++;
}

function lineTick(w: World, c: Crew, day: boolean): void {
  const L = w.L;
  const cells = c.task!.cells ?? [];
  if (c.path.length > 0) {
    const left = travel(w, c, HOURS);
    if (c.path.length > 0 || left < 0.3) {
      c.state = 'moving';
      return;
    }
  }
  c.state = 'working';
  if (!day) return;
  let budget = WORK.lineCells[c.kind] || 4;
  while (budget > 0 && cells.length > 0) {
    const i = cells.shift()!;
    if (L.water[i] >= 2 || L.fire[i] === FIRE.BURNING) continue;
    L.fline[i] = 1;
    c.x = (i % w.W) + 0.5;
    c.y = ((i / w.W) | 0) + 0.5;
    budget--;
  }
  w.spend('Suppression', COST.suppressionHour * HOURS * 0.6);
  w.dirty.fire++;
  if (cells.length === 0) goHome(w, c);
}

function projectTick(w: World, c: Crew, day: boolean, hooks: CrewHooks): void {
  const pr = w.projects.find((p) => p.id === c.task!.projectId);
  if (!pr || pr.status === 'done' || pr.status === 'cancelled') {
    goHome(w, c);
    return;
  }
  if (c.path.length > 0) {
    const left = travel(w, c, HOURS);
    if (c.path.length > 0 || left < 0.3) {
      c.state = 'moving';
      return;
    }
  }
  c.state = 'working';
  if (pr.kind === 'burn') {
    if (pr.status === 'burning') return; // holding the line (see projects.ts)
    if (w.sub === 3 && burnWindowOpen(w, pr)) {
      const fe = igniteProjectBurn(w, pr);
      if (fe && hooks.onBurnIgnited) hooks.onBurnIgnited(pr, fe);
    } else pr.status = 'waiting';
    return;
  }
  if (!day) return;
  if (w.economy.funds < pr.costPerCell) {
    pr.status = 'waiting';
    return;
  }
  pr.status = 'active';
  const rate = pr.kind === 'thin' ? WORK.thinCells : pr.kind === 'plant' ? WORK.plantCells : WORK.breakCells;
  let budget = rate * (1 - 0.4 * c.fatigue);
  let guard = 0;
  while (budget > 0 && guard++ < 10) {
    const cell = c.workCell >= 0 ? c.workCell : projectWorkCell(w, pr, crewCell(w, c));
    if (cell < 0) {
      pr.status = 'done';
      pr.doneDay = w.day;
      goHome(w, c);
      return;
    }
    // must be on or next to the work cell; otherwise walk there
    const here = crewCell(w, c);
    const dx = Math.abs((cell % w.W) - (here % w.W)),
      dy = Math.abs(((cell / w.W) | 0) - ((here / w.W) | 0));
    if (dx > 1 || dy > 1) {
      if (!planPath(w, c, cell)) {
        completeProjectCell(w, pr, cell, true); // unreachable cell: skip it
        c.workCell = -1;
        continue;
      }
      c.workCell = cell;
      c.state = 'moving';
      return;
    }
    const portion = Math.min(1, budget);
    pr.progress += portion;
    budget -= portion;
    if (pr.progress >= 1) {
      pr.progress -= 1;
      completeProjectCell(w, pr, cell, false);
      c.workCell = -1;
      c.x = (cell % w.W) + 0.5;
      c.y = ((cell / w.W) | 0) + 0.5;
    }
  }
}

/** Daily bookkeeping: dispatch, recall crews from finished fires, project assignment. */
export function crewsDaily(w: World): void {
  autoDispatch(w);
  assignProjects(w);
  // manual "standby" crews with no task return home at dawn
  for (const c of w.crews) {
    if (c.state === 'working' && !c.task) goHome(w, c);
    const fe = c.task?.fireId !== undefined ? fireById(w, c.task.fireId) : undefined;
    if (c.task?.kind === 'suppress' && (!fe || !fe.active)) goHome(w, c);
  }
}
