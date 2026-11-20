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
import type { AidTeam, Crew, FireEvent, Project } from '../types.ts';
import { COST, EMERGENCY_CREDIT, WORK } from '../economyParams.ts';
import type { World } from '../world.ts';
import { burnCrewsNeeded, burnOutlook, completeProjectCell, igniteProjectBurn, projectWorkCell } from './projects.ts';
import { cellFuel } from './fuels.ts';
import { FLAME_LIMIT } from './fire.ts';
import { droughtSeverity } from './climate.ts';
import { makeCrew } from '../gen/crews.ts';
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
      const trees = L.fir[to] + L.pine[to] + 0.6 * L.aspen[to];
      // open, gentle grass and shrub country can be driven (~8 km/h); timber and slopes crawl
      if (L.slope[to] < 0.2 && trees < 0.3) return d * 0.012 * (1 + 6 * L.slope[to]) * (1 + L.shrub[to]) + (L.flowAcc[to] > 1000 ? 0.5 : 0);
      return d * 0.035 * (1 + 10 * L.slope[to]) * (1 + 0.8 * (L.shrub[to] + trees)) + (L.flowAcc[to] > 1000 ? 0.5 : 0);
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
          danger = Math.max(danger, L.crown[n] === 1 ? 99 : L.fint[n]);
        }
      }
      if (adj) out.push({ cell: i, danger });
    }
  return out;
}

/** Nearest perimeter point of a fire to (x, y), scanning its burning cells. */
function nearestPerimeter(w: World, fe: FireEvent, x: number, y: number, maxDanger: number = FLAME_LIMIT.hand): number {
  const L = w.L;
  let best = -1,
    bd = Infinity;
  for (const b of w.burning) {
    if (L.fid[b] !== fe.id) continue;
    const bx = b % w.W,
      by = (b / w.W) | 0;
    if (L.crown[b] === 1 || L.fint[b] > maxDanger) continue;
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

/** Put a burning cell out. `by`: 1 a hand crew, 2 an engine, 3 a water drop (kept for the fire's report). */
function extinguish(w: World, i: number, fe: FireEvent | undefined, by: 1 | 2 | 3): void {
  // a burning house is beyond a hose line or a bucket: cutting its burn time would only bring its
  // loss forward (v1.0 did exactly that). Crews protect houses before they catch (structureProtection).
  if (w.L.town[i] > 0) return;
  // cut the remaining burn time: the cell burns out next step at its current severity
  if (w.L.ftime[i] > 0.01 && fe) fe.knocked = (fe.knocked ?? 0) + 1;
  w.L.ftime[i] = Math.min(w.L.ftime[i], 0.01);
  w.L.fint[i] = Math.min(w.L.fint[i], 0.05);
  w.L.fstop[i] = by;
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

/** Distance (cells) from a fire's centre to the nearest road, capped at 40. */
function roadGap(w: World, fe: FireEvent): number {
  const cx = (fe.minX + fe.maxX) / 2,
    cy = (fe.minY + fe.maxY) / 2;
  const r = nearestRoadTo(w, cx, cy);
  if (!(w.L.infra[r] & INFRA.ROAD)) return 40;
  const rad = Math.max(fe.maxX - fe.minX, fe.maxY - fe.minY) / 2;
  return Math.max(0, Math.hypot((r % w.W) - cx, ((r / w.W) | 0) - cy) - rad);
}

/**
 * Open edge of every active fire: burning cells with unburned ground beside them that no line holds,
 * and how many of those are advancing fronts. This is the work a fire still asks of its crews.
 */
export function openEdges(w: World): Map<number, { open: number; flaming: number }> {
  const L = w.L;
  const out = new Map<number, { open: number; flaming: number }>();
  for (const b of w.burning) {
    if (L.town[b] > 0) continue;
    const bx = b % w.W,
      by = (b / w.W) | 0;
    let open = false;
    for (let d = 0; d < 8 && !open; d++) {
      const nx = bx + DX8[d],
        ny = by + DY8[d];
      if (!w.inside(nx, ny)) continue;
      const n = ny * w.W + nx;
      if (L.fire[n] === FIRE.NONE && L.water[n] < 2 && L.pond[n] <= 0.35 && L.fline[n] < 0.6 && L.flowAcc[n] <= 1000) open = true;
    }
    if (!open) continue;
    let e = out.get(L.fid[b]);
    if (!e) {
      e = { open: 0, flaming: 0 };
      out.set(L.fid[b], e);
    }
    e.open++;
    if (L.fphase[b] === 0) e.flaming++;
  }
  return out;
}

/** How many crews of a kind a fire should have, from the edge it still has open. */
function crewsWanted(fe: FireEvent, kind: Crew['kind'], open: number, townDist: number): number {
  if (kind === 'hand') {
    // "confine": hold the side toward homes only
    if (fe.response === 'contain') return townDist > 20 ? 0 : 2;
    return Math.max(2, Math.min(12, 1 + Math.ceil(open / 8))) + (fe.inBuffer ? 1 : 0);
  }
  if (kind === 'engine') return 2 + (fe.inBuffer ? 1 : 0);
  return open > 60 ? 2 : 1;
}

/**
 * Assign crews to fires that need them, by priority. v2: the number of crews follows the edge a fire
 * still has open (v1.x sent one hand crew to anything under 64 ha), and crews are pulled from a fire
 * that is lined or far less urgent when a more dangerous one is short (v1.x never moved a crew
 * between fires: in one audited run every crew stayed on a backcountry fire while 62 homes burned).
 * Mutual-aid crews work only the fire they were called for.
 */
export function autoDispatch(w: World): void {
  if (!w.policies.autoDispatch) return;
  const fires = w.fires.filter((f) => f.active && f.detected && f.response !== 'monitor' && f.cause !== 'prescribed');
  if (fires.length === 0) return;
  const edges = openEdges(w);
  const scored = fires
    .map((fe) => {
      const th = fireThreat(w, fe);
      const e = edges.get(fe.id) ?? { open: 0, flaming: 0 };
      // fires in a Community Buffer come first, whatever their size
      const score = (fe.response === 'suppress' ? 1 : 0.5) * (40 / (5 + th.dist)) + Math.sqrt(fe.area) * 0.2 + (fe.inBuffer ? 25 : 0);
      return { fe, th, e, score };
    })
    .sort((a, b) => b.score - a.score || a.fe.id - b.fe.id);
  const assigned = (fe: FireEvent, kind: Crew['kind']) => w.crews.filter((c) => c.task?.fireId === fe.id && c.kind === kind).length;
  const mayWork = (c: Crew, fe: FireEvent) => c.aid === undefined || c.aid === fe.id;
  // idle crews, crews heading home from a finished job, and crews on routine project work
  const isFree = (c: Crew) => {
    if (c.manual || c.fatigue > 0.95) return false;
    if (c.state === 'idle' || (c.state === 'returning' && !c.task)) return true;
    if (c.task?.kind !== 'project') return false;
    const pr = w.projects.find((p) => p.id === c.task!.projectId);
    return !(pr && pr.status === 'burning'); // never abandon a burn in progress
  };
  const scoreOf = new Map<number, (typeof scored)[number]>();
  for (const sc of scored) scoreOf.set(sc.fe.id, sc);
  const tried = new Set<Crew>();
  // fires in priority order; each gets the nearest free crews of each kind
  for (const { fe, th, e, score } of scored) {
    const cx = (fe.minX + fe.maxX) / 2,
      cy = (fe.minY + fe.maxY) / 2;
    for (const kind of ['hand', 'engine', 'heli'] as const) {
      if (kind === 'engine' && th.dist > 16 && !fe.inBuffer && roadGap(w, fe) > 6) continue; // engines defend homes and roadsides
      const want = crewsWanted(fe, kind, e.open, th.dist);
      let have = assigned(fe, kind);
      while (have < want) {
        let best: Crew | null = null,
          bd = Infinity;
        for (const c of w.crews) {
          if (c.kind !== kind || tried.has(c) || !isFree(c) || !mayWork(c, fe)) continue;
          const d = Math.hypot(c.x - cx, c.y - cy);
          if (d < bd) {
            bd = d;
            best = c;
          }
        }
        if (!best) break;
        tried.add(best);
        if (assignToFire(w, best, fe)) have++;
      }
      // still short of a working minimum: take crews off a fire that is lined, or far less urgent
      const floor = Math.min(want, kind === 'hand' ? 2 : 1);
      while (have < floor) {
        let best: Crew | null = null,
          bd = Infinity;
        for (const c of w.crews) {
          if (c.kind !== kind || c.manual || tried.has(c) || c.aid !== undefined || c.task?.kind !== 'suppress' || c.task.fireId === fe.id) continue;
          const other = scoreOf.get(c.task.fireId!);
          if (!other) continue;
          const lined = other.e.open === 0;
          if (!lined && other.score > score * 0.5) continue;
          const d = Math.hypot(c.x - cx, c.y - cy);
          if (d < bd) {
            bd = d;
            best = c;
          }
        }
        if (!best) break;
        tried.add(best);
        if (assignToFire(w, best, fe)) have++;
      }
    }
  }
}

/**
 * Dawn: a fire with no flaming edge left that is (nearly) all lined keeps one hand crew on patrol and
 * releases the rest (v1.0 kept every crew on a fire until its last ember was out, tying up the whole
 * roster for weeks on smouldering fires).
 */
function releaseFromContainedFires(w: World): void {
  const edges = openEdges(w);
  for (const fe of w.fires) {
    if (!fe.active || fe.cause === 'prescribed') continue;
    const e = edges.get(fe.id);
    if (e && (e.flaming > 0 || e.open > 2)) continue;
    const on = w.crews.filter((c) => c.task?.fireId === fe.id && !c.manual).sort((a, b) => a.id - b.id);
    const keep = on.find((c) => c.kind === 'hand') ?? null;
    for (const c of on) if (c !== keep) goHome(w, c);
  }
}

/** How many hand crews a project can usefully take. */
export function projectCrewCap(pr: Project): number {
  if (pr.kind === 'burn') return burnCrewsNeeded(pr);
  return Math.max(1, Math.min(3, Math.ceil(pr.todo.length / 40)));
}

/** Why a project cannot be worked today ('' if it can): funds, snow, or a burn out of prescription. */
export function projectBlocked(w: World, pr: Project): string {
  if (pr.kind === 'burn') return burnOutlook(w, pr).problem;
  if (w.economy.funds < pr.costPerCell) return 'Waiting for funds.';
  let snowy = 0,
    n = 0;
  for (let k = 0; k < pr.todo.length; k += Math.max(1, Math.floor(pr.todo.length / 12))) {
    n++;
    if (w.L.snow[pr.todo[k]] > 20) snowy++;
  }
  return n > 0 && snowy > n / 2 ? 'Under snow.' : '';
}

/**
 * Give idle hand crews treatment work (fires take precedence). v2: crews go down the list in
 * priority order and take the first project that can actually be worked today, several crews to a
 * large one. A project nobody can reach, or a burn outside its prescription, is passed over with a
 * note instead of blocking everything behind it. (v1.x gave every idle crew the first queued
 * project and stopped there: one burn whose centre lay on a beaver pond froze all treatment for the
 * rest of a tenure in 2 of 3 audited long runs, and a crew given a burn stood on it for months
 * waiting for weather while thinning queued behind it never started.)
 */
export function assignProjects(w: World): void {
  const idle = w.crews.filter((c) => c.state === 'idle' && c.kind === 'hand' && c.fatigue <= 0.9 && c.aid === undefined);
  if (idle.length === 0) return;
  const open = w.projects.filter((p) => p.status === 'queued' || p.status === 'active' || p.status === 'waiting');
  if (open.length === 0) return;
  open.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id - b.id);
  const crewsOn = (p: Project) => w.crews.filter((o) => o.task?.projectId === p.id).length;
  for (const pr of open) {
    if (idle.length === 0) break;
    const on = crewsOn(pr);
    const problem = projectBlocked(w, pr);
    if (problem) {
      pr.note = problem;
      if (on === 0 && pr.status === 'active') pr.status = pr.kind === 'burn' ? 'waiting' : 'queued';
      continue;
    }
    let room = projectCrewCap(pr) - on;
    if (room <= 0) continue;
    // a burn is lit only with its full holding force
    if (pr.kind === 'burn' && idle.length < room) {
      pr.note = `Needs ${burnCrewsNeeded(pr)} free hand crews.`;
      continue;
    }
    let reached = on > 0;
    const cands = idle.slice().sort((a, b) => Math.hypot(a.x - pr.cx, a.y - pr.cy) - Math.hypot(b.x - pr.cx, b.y - pr.cy) || a.id - b.id);
    for (const c of cands) {
      if (room <= 0) break;
      const cell = projectWorkCell(w, pr, crewCell(w, c));
      if (cell < 0 || !planPath(w, c, cell)) continue;
      c.task = { kind: 'project', projectId: pr.id };
      c.state = 'moving';
      c.workCell = cell;
      idle.splice(idle.indexOf(c), 1);
      room--;
      reached = true;
      if (pr.status === 'queued' || pr.status === 'waiting') pr.status = 'active';
    }
    pr.note = reached ? '' : 'No crew can reach this ground.';
  }
}

// ------------------------------------------------------------ per-tick crew update
export interface CrewHooks {
  onCrewRetreat?: (c: Crew, fe: FireEvent) => void;
  onBurnIgnited?: (pr: Project, fe: FireEvent) => void;
  onAidRequested?: (team: AidTeam, fe: FireEvent) => void;
  onAidArrived?: (team: AidTeam, fe: FireEvent) => void;
  onAidReleased?: (team: AidTeam, fe: FireEvent | undefined, unpaid?: boolean) => void;
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
    // Fatigue comes from fire duty and recovers off it. Routine treatment work is a day job: it
    // neither tires a crew nor (v1.x) pins its fatigue at 1.0 after four days, which made the
    // dispatcher skip exactly the crews that were out in the woods when a fire was reported.
    const onFire = c.task?.kind === 'suppress' || c.task?.kind === 'line';
    if (c.state === 'working' && onFire) c.fatigue = clamp01(c.fatigue + 0.03);
    else if (c.state !== 'working' || !day) c.fatigue = clamp01(c.fatigue - 0.05);
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

function chargeFire(w: World, fe: FireEvent | undefined, hours: number, kind: Crew['kind'], aid = false): void {
  if (aid) return; // an outside team is paid by the day (aidDaily)
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
  // (v2: the night shift works any fire, at reduced output, until the crew is spent: night is when a
  // fire lies down and line holds)
  const initialAttack = c.fatigue < 0.8;
  // crews that hold position overnight are resting, and recover (v1.0 counted them as working)
  if ((!day && c.kind === 'heli') || (!day && c.kind === 'hand' && !initialAttack)) {
    c.state = 'resting';
    return;
  }
  if (c.kind === 'heli') return heliTick(w, c, fe, hours);
  // hand crews are paid for the shift they work; an engine for the hours it pumps or stands guard
  // by day (v1.x billed a parked engine overtime round the clock for weeks)
  if (c.kind === 'hand') chargeFire(w, fe, hours, c.kind, c.aid !== undefined);
  c.hoursWorked += hours;
  if (c.kind === 'engine') {
    // direct attack on low-intensity fire within hose reach, working along the edge ("pump and
    // roll" across open grass, where an engine knocks down several times more edge than in timber);
    // engines near a threatened town also protect houses (see structureProtection)
    let done = 0;
    let budget = WORK.mopUp.engine * (hours / HOURS);
    let ex = c.x,
      ey = c.y;
    for (let guard = 0; guard < 40 && budget > 0; guard++) {
      let best = -1,
        bd = Infinity;
      const cx = Math.floor(ex),
        cy = Math.floor(ey);
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const x = cx + dx,
            y = cy + dy;
          if (!w.inside(x, y)) continue;
          const i = y * w.W + x;
          if (L.fire[i] !== FIRE.BURNING || L.fid[i] !== fe.id || L.fint[i] >= FLAME_LIMIT.engine || L.town[i] > 0) continue;
          const dd = dx * dx + dy * dy;
          if (dd < bd) {
            bd = dd;
            best = i;
          }
        }
      if (best < 0) break;
      extinguish(w, best, fe, 2);
      done++;
      budget -= attackEffort(w, best);
      // drive along the edge where the ground allows it
      const trees = L.fir[best] + L.pine[best] + 0.6 * L.aspen[best];
      if (L.slope[best] < 0.2 && trees < 0.3) {
        ex = (best % w.W) + 0.5;
        ey = ((best / w.W) | 0) + 0.5;
      }
    }
    c.x = ex;
    c.y = ey;
    if (done > 0 || day) chargeFire(w, fe, hours, c.kind, c.aid !== undefined);
    // nothing in reach: drive to the road nearest the fire's edge — unless holding a threatened town
    const th = fireThreat(w, fe);
    if (done === 0 && th.dist > 6) {
      const edge = nearestPerimeter(w, fe, c.x, c.y, FLAME_LIMIT.engine);
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
    const cand = localPerimeter(w, fe, px, py, 3).filter((p) => p.danger <= FLAME_LIMIT.hand && L.fline[p.cell] < 0.6);
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
      if (L.fire[i] === FIRE.BURNING && L.fid[i] === fe.id && L.fint[i] < 0.6) {
        extinguish(w, i, fe, 1);
        mop--;
      }
    }
  c.x = px;
  c.y = py;
  // nothing workable nearby? relocate along the perimeter, or retreat from crown fire
  if (built === 0) {
    const near = localPerimeter(w, fe, cx, cy, 3);
    if (near.some((p) => p.danger > FLAME_LIMIT.hand)) {
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

/** Relative effort for an engine to knock down one burning cell: quick in grass, slow in timber. */
function attackEffort(w: World, i: number): number {
  const f = cellFuel(w, i, lineFuel);
  return 0.35 + 0.65 * (1 - f.grassShare);
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
  chargeFire(w, fe, hours, 'heli', c.aid !== undefined);
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
          if (L.fint[i] < FLAME_LIMIT.engine && L.crown[i] !== 1) extinguish(w, i, fe, 3);
          else L.fint[i] *= 0.6;
        }
      }
    c.x = bx + 0.5;
    c.y = by + 0.5;
  }
  w.dirty.fire++;
}

/**
 * A crew cutting a line the warden drew. v2: the crew walks the line (v1.x moved it from cell to
 * cell for free, up any slope), each cell costs effort by fuel and slope, the night shift works at
 * reduced output, and the crew goes back to the dispatcher's pool when the line is done.
 */
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
  let budget = WORK.lineCells.hand * (1 - 0.5 * c.fatigue) * (day ? 1 : 0.6);
  let worked = false;
  let guard = 0;
  while (budget > 0 && cells.length > 0 && guard++ < 40) {
    const i = cells[0];
    if (L.water[i] >= 2 || L.fire[i] === FIRE.BURNING || L.fline[i] >= 1) {
      cells.shift();
      continue;
    }
    const here = crewCell(w, c);
    const dx = Math.abs((i % w.W) - (here % w.W)),
      dy = Math.abs(((i / w.W) | 0) - ((here / w.W) | 0));
    if (dx > 1 || dy > 1) {
      if (!planPath(w, c, i)) {
        cells.shift(); // cannot get there: leave a gap
        continue;
      }
      c.state = 'moving';
      break;
    }
    budget -= lineEffort(w, i) * (1 + 3 * L.slope[i]);
    L.fline[i] = 1;
    c.x = (i % w.W) + 0.5;
    c.y = ((i / w.W) | 0) + 0.5;
    cells.shift();
    worked = true;
  }
  if (worked) {
    w.spend('Suppression', COST.suppressionHour * HOURS);
    w.dirty.fire++;
  }
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
    // 09:00: light the unit if it is in prescription and its whole holding force is on site. If it
    // has fallen out of prescription the crews go back to other work (v1.x parked them on the unit
    // until the weather came round: half of all crew time in a treatment-heavy game).
    if (w.sub !== 3) return;
    const out = burnOutlook(w, pr);
    if (out.problem) {
      pr.note = out.problem;
      pr.status = 'waiting';
      for (const o of w.crews) if (o.task?.projectId === pr.id && !o.manual) goHome(w, o);
      return;
    }
    const here = w.crews.filter((o) => o.task?.projectId === pr.id && o.state === 'working').length;
    if (here >= burnCrewsNeeded(pr)) {
      const fe = igniteProjectBurn(w, pr, here);
      if (fe && hooks.onBurnIgnited) hooks.onBurnIgnited(pr, fe);
    }
    return;
  }
  if (!day) {
    c.state = 'resting';
    return;
  }
  if (w.economy.funds < pr.costPerCell) {
    pr.status = 'waiting';
    return;
  }
  pr.status = 'active';
  const rate = pr.kind === 'thin' ? WORK.thinCells : pr.kind === 'plant' ? WORK.plantCells : WORK.breakCells;
  let budget = rate * (1 - 0.4 * c.fatigue);
  let guard = 0;
  while (budget > 0 && guard++ < 10) {
    // (another crew on the same project may have finished this crew's cell)
    if (c.workCell >= 0 && !pr.todo.includes(c.workCell)) c.workCell = -1;
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

// ------------------------------------------------------------ mutual aid (v2)
/** What an outside incident team brings. */
export const AID_TEAM: ReadonlyArray<[Crew['kind'], string]> = [
  ['hand', 'Ridgeline Hotshots'],
  ['hand', 'Sawtooth Hotshots'],
  ['hand', 'Cinder Butte Crew'],
  ['hand', 'Three Rivers Crew'],
  ['engine', 'Strike Engine 41'],
  ['engine', 'Strike Engine 52'],
  ['heli', 'Helitack 7'],
];
/** At most this many teams can be in the valley at once: the region has other fires. */
export const AID_MAX_TEAMS = 2;

export function aidFor(w: World, fireId: number): AidTeam | undefined {
  return w.aid.find((a) => a.fireId === fireId && !a.released);
}

/** Why a team cannot be called to this fire now, or '' if it can. */
export function aidProblem(w: World, fe: FireEvent | undefined): string {
  if (!fe || !fe.active) return 'That fire is out.';
  if (!fe.detected) return 'No one knows about that fire yet.';
  if (fe.cause === 'prescribed') return 'A prescribed burn is held by its own crews.';
  if (aidFor(w, fe.id)) return 'A team is already assigned to that fire.';
  if (w.aid.filter((a) => !a.released).length >= AID_MAX_TEAMS) return 'No more teams are available: the region has other fires.';
  return '';
}

/**
 * Call an outside incident team to a fire. It reports the next morning (the morning after if called
 * in the evening; a day later still when drought has the whole region burning), works only that
 * fire, and is paid by the day until it is released.
 */
export function requestAid(w: World, fe: FireEvent, auto = false): AidTeam {
  const stretched = droughtSeverity(w.climate.droughtIndex) > 0.75 ? 1 : 0;
  const team: AidTeam = { fireId: fe.id, requestedDay: w.day, arriveDay: w.day + (w.sub <= 5 ? 1 : 2) + stretched, arrived: false, released: false, releasedDay: -1, crewIds: [], cost: COST.aidMobilize, auto };
  w.aid.push(team);
  w.spend('Mutual aid', COST.aidMobilize);
  fe.cost += COST.aidMobilize;
  return team;
}

export function releaseAid(w: World, team: AidTeam): void {
  if (team.released) return;
  team.released = true;
  team.releasedDay = w.day;
  for (let k = w.crews.length - 1; k >= 0; k--) if (team.crewIds.includes(w.crews[k].id)) w.crews.splice(k, 1);
}

/** Standing order: call a team when an escaped fire threatens a town (policy mutualAid 'auto'). */
function autoAidWanted(w: World, fe: FireEvent, open: number): boolean {
  if (fe.response === 'monitor' || fe.cause === 'prescribed' || !fe.detected) return false;
  if (fe.area < 150 || open < 15) return false;
  return fireThreat(w, fe).dist < 45 || fe.inBuffer === true;
}

function aidDaily(w: World, hooks: CrewHooks): void {
  const edges = openEdges(w);
  for (const team of w.aid) {
    if (team.released) continue;
    const fe = fireById(w, team.fireId);
    const e = edges.get(team.fireId);
    // demobilise when the fire is out, or lined and quiet
    if (!fe || !fe.active || (team.arrived && (!e || (e.flaming === 0 && e.open <= 2)))) {
      releaseAid(w, team);
      if (hooks.onAidReleased) hooks.onAidReleased(team, fe);
      continue;
    }
    if (!team.arrived && w.day >= team.arriveDay) {
      team.arrived = true;
      // report at the station nearest the fire
      const cx = (fe.minX + fe.maxX) / 2,
        cy = (fe.minY + fe.maxY) / 2;
      let st = w.towns[0]?.station ?? 0,
        bd = Infinity;
      for (const t of w.towns) {
        const d = Math.hypot(t.x - cx, t.y - cy);
        if (d < bd) {
          bd = d;
          st = t.station;
        }
      }
      for (const [kind, name] of AID_TEAM) {
        const c = makeCrew(w, kind, st, name);
        c.aid = fe.id;
        w.crews.push(c);
        team.crewIds.push(c.id);
      }
      if (hooks.onAidArrived) hooks.onAidArrived(team, fe);
    }
    if (team.arrived) {
      // the county pays emergency bills only so far into the red: then the team goes home
      // (v2's first builds had no limit, and a standing order could bankrupt a warden in one summer)
      if (w.economy.funds - COST.aidPerDay < -EMERGENCY_CREDIT) {
        releaseAid(w, team);
        if (hooks.onAidReleased) hooks.onAidReleased(team, fe, true);
        continue;
      }
      w.spend('Mutual aid', COST.aidPerDay);
      team.cost += COST.aidPerDay;
      fe.cost += COST.aidPerDay;
    }
  }
  if (w.policies.mutualAid === 'auto') {
    for (const fe of w.fires) {
      if (!fe.active || aidProblem(w, fe)) continue;
      // a standing order never spends the service into debt: below a week's bills in hand, the warden decides
      if (w.economy.funds < COST.aidMobilize + 5 * COST.aidPerDay) continue;
      if (autoAidWanted(w, fe, edges.get(fe.id)?.open ?? 0)) {
        const team = requestAid(w, fe, true);
        if (hooks.onAidRequested) hooks.onAidRequested(team, fe);
      }
    }
  }
}

/** Daily bookkeeping: dispatch, recall crews from finished fires, project assignment. */
export function crewsDaily(w: World, hooks: CrewHooks = {}): void {
  aidDaily(w, hooks);
  releaseFromContainedFires(w);
  autoDispatch(w);
  assignProjects(w);
  // manual "standby" crews with no task return home at dawn
  for (const c of w.crews) {
    if (c.state === 'working' && !c.task) goHome(w, c);
    const fe = c.task?.fireId !== undefined ? fireById(w, c.task.fireId) : undefined;
    if (c.task?.kind === 'suppress' && (!fe || !fe.active)) goHome(w, c);
  }
}
