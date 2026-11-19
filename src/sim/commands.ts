/**
 * Player commands. Every action the player can take is a plain, serializable
 * command applied through `applyCommand`, which validates it against the
 * world, charges its cost, and logs it (enabling replays and tests).
 */
import { astar } from './grid.ts';
import { FIRE, INFRA, SP, ZONE } from './types.ts';
import type { CrewKind, FireResponse, Policies, ProjectKind } from './types.ts';
import { COST, CREW_COST } from './economyParams.ts';
import { cancelProject, createProject, zoneConflict } from './systems/projects.ts';
import { assignToFire, crewCell, fireById, planPath, releaseProject } from './systems/crews.ts';
import { makeCrew } from './gen/crews.ts';
import { layRoad, roadCost } from './gen/settle.ts';
import { beaverSiteScore } from './gen/wildlife.ts';
import { NameBank } from './gen/names.ts';
import { handleReviewCommand } from './systems/council.ts';
import type { World } from './world.ts';

export type Command =
  | { t: 'zone'; cells: number[]; zone: number }
  | { t: 'project'; kind: ProjectKind; cells: number[]; species?: number }
  | { t: 'cancelProject'; id: number }
  | { t: 'fireResponse'; fireId: number; response: FireResponse }
  | { t: 'sendCrew'; crewId: number; fireId?: number; projectId?: number; cell?: number }
  | { t: 'recallCrew'; crewId: number }
  | { t: 'fireline'; cells: number[]; crewId?: number }
  | { t: 'airdrop'; cells: number[] }
  | { t: 'build'; what: 'tower' | 'camp'; cell: number }
  | { t: 'road'; from: number; to: number }
  | { t: 'hire'; kind: CrewKind; townId?: number }
  | { t: 'dismiss'; crewId: number }
  | { t: 'policy'; key: keyof Policies; value: string | boolean }
  | { t: 'reintroduceWolves'; cell: number }
  | { t: 'relocateBeavers'; cell: number }
  | { t: 'petition'; id: number; accept: boolean }
  | { t: 'closeReview' };

export interface CommandResult {
  ok: boolean;
  msg: string;
  cost?: number;
}

const fail = (msg: string): CommandResult => ({ ok: false, msg });

/** Estimate a command's up-front cost without applying it (for UI previews). */
export function estimateCost(w: World, cmd: Command): number {
  switch (cmd.t) {
    case 'airdrop':
      return Math.ceil(cmd.cells.length / 10) * COST.retardantDrop;
    case 'build':
      return cmd.what === 'tower' ? COST.tower : COST.camp;
    case 'hire':
      return CREW_COST[cmd.kind].hire;
    case 'reintroduceWolves':
      return COST.wolfReintro;
    case 'relocateBeavers':
      return COST.beaverRelocation;
    case 'road': {
      const p = astar(w.W, w.H, cmd.from, cmd.to, roadCostNoWild(w), 1, 60000);
      if (!p) return Infinity;
      return p.filter((c) => !(w.L.infra[c] & INFRA.ROAD)).length * COST.road;
    }
    default:
      return 0;
  }
}

function roadCostNoWild(w: World) {
  const base = roadCost(w);
  return (a: number, b: number, d: boolean) => (w.L.zone[b] === ZONE.WILDERNESS || w.L.town[b] < 0 ? Infinity : base(a, b, d));
}

/** Allowed values for every policy (the UI offers exactly these). */
export const POLICY_VALUES: { [K in keyof Policies]: ReadonlyArray<Policies[K]> } = {
  fireBan: ['auto', 'summer', 'never'],
  wolfPolicy: ['protected', 'managed', 'bounty'],
  hunting: ['none', 'moderate', 'heavy'],
  grazing: ['none', 'light', 'heavy'],
  harvest: ['low', 'medium', 'high'],
  harvestMethod: ['selective', 'clearcut'],
  slash: ['leave', 'pileburn'],
  buildingCode: ['standard', 'firewise'],
  growthBoundary: [false, true],
  airPatrol: [false, true],
  autoDispatch: [false, true],
  salvage: [false, true],
  smokeRules: [false, true],
};
const PROJECT_KINDS: readonly ProjectKind[] = ['thin', 'burn', 'plant', 'fuelbreak'];
const RESPONSES: readonly FireResponse[] = ['suppress', 'contain', 'monitor'];
const CREW_KINDS: readonly CrewKind[] = ['hand', 'engine', 'heli'];
const ZONES = Object.values(ZONE) as number[];
const MAX_CELLS = 250_000;

const isCell = (w: World, i: unknown): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < w.N;
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Structural validation of a command before anything is applied. Commands come from the UI,
 * but also from replays, bots and tests, so nothing about their shape is trusted: an invalid
 * command is refused with no side effects instead of poisoning the world (v1.0 applied policy
 * values unchecked — grazing 'extreme' turned 21,673 cells into NaN — and an off-grid crew target
 * hung the path-finder).
 */
export function validateCommand(w: World, cmd: Command): string | null {
  if (!cmd || typeof cmd !== 'object') return 'Malformed command.';
  const cellsOk = (cells: unknown) => Array.isArray(cells) && cells.length <= MAX_CELLS && cells.every((c) => isCell(w, c));
  switch (cmd.t) {
    case 'zone':
      if (!ZONES.includes(cmd.zone)) return 'Unknown zone.';
      return cellsOk(cmd.cells) ? null : 'Invalid cells.';
    case 'project':
      if (!PROJECT_KINDS.includes(cmd.kind)) return 'Unknown treatment.';
      if (cmd.species !== undefined && ![SP.ASPEN, SP.PINE, SP.FIR].includes(cmd.species as 2 | 3 | 4)) return 'Unknown species.';
      return cellsOk(cmd.cells) ? null : 'Invalid cells.';
    case 'cancelProject':
    case 'dismiss':
    case 'recallCrew':
      return isId((cmd as { id?: number; crewId?: number }).id ?? (cmd as { crewId?: number }).crewId) ? null : 'Invalid id.';
    case 'fireResponse':
      if (!RESPONSES.includes(cmd.response)) return 'Unknown response.';
      return isId(cmd.fireId) ? null : 'Invalid fire.';
    case 'sendCrew':
      if (!isId(cmd.crewId)) return 'Invalid crew.';
      if (cmd.fireId !== undefined && !isId(cmd.fireId)) return 'Invalid fire.';
      if (cmd.projectId !== undefined && !isId(cmd.projectId)) return 'Invalid project.';
      if (cmd.cell !== undefined && !isCell(w, cmd.cell)) return 'That place is off the map.';
      return null;
    case 'fireline':
      if (cmd.crewId !== undefined && !isId(cmd.crewId)) return 'Invalid crew.';
      return cellsOk(cmd.cells) ? null : 'Invalid cells.';
    case 'airdrop':
      return cellsOk(cmd.cells) ? null : 'Invalid cells.';
    case 'build':
      if (cmd.what !== 'tower' && cmd.what !== 'camp') return 'Unknown structure.';
      return isCell(w, cmd.cell) ? null : 'That place is off the map.';
    case 'road':
      return isCell(w, cmd.from) && isCell(w, cmd.to) ? null : 'That place is off the map.';
    case 'hire':
      if (!CREW_KINDS.includes(cmd.kind)) return 'Unknown crew type.';
      if (cmd.townId !== undefined && !(Number.isInteger(cmd.townId) && cmd.townId >= 0 && cmd.townId < w.towns.length)) return 'No such town.';
      return null;
    case 'policy': {
      if (!Object.prototype.hasOwnProperty.call(POLICY_VALUES, cmd.key)) return 'Unknown policy.';
      const allowed = POLICY_VALUES[cmd.key] as ReadonlyArray<string | boolean>;
      return allowed.includes(cmd.value) ? null : 'That is not an option for this policy.';
    }
    case 'reintroduceWolves':
    case 'relocateBeavers':
      return isCell(w, cmd.cell) ? null : 'That place is off the map.';
    case 'petition':
      return isId(cmd.id) && typeof cmd.accept === 'boolean' ? null : 'Invalid petition answer.';
    case 'closeReview':
      return null;
    default:
      return 'Unknown command.';
  }
}

export function applyCommand(w: World, cmd: Command): CommandResult {
  const invalid = validateCommand(w, cmd);
  if (invalid) return fail(invalid);
  const res = apply(w, cmd);
  if (res.ok) w.commandLog.push({ day: w.day, sub: w.sub, cmd });
  if (w.commandLog.length > 5000) w.commandLog.splice(0, w.commandLog.length - 5000);
  return res;
}

function apply(w: World, cmd: Command): CommandResult {
  const L = w.L;
  switch (cmd.t) {
    case 'zone': {
      let n = 0;
      for (const i of cmd.cells) {
        if (i < 0 || i >= w.N || L.water[i] >= 2 || L.town[i] !== 0) continue;
        if (cmd.zone === ZONE.WILDERNESS && L.infra[i] & (INFRA.ROAD | INFRA.CAMP | INFRA.STATION | INFRA.MILL)) continue;
        if (L.zone[i] !== cmd.zone) {
          L.zone[i] = cmd.zone;
          n++;
        }
      }
      if (n === 0) return fail('Nothing to rezone there.');
      w.dirty.zone++;
      return { ok: true, msg: `${n} ha rezoned.` };
    }
    case 'project': {
      const cells = zoneConflict(w, cmd.kind, cmd.cells) ? cmd.cells.filter((c) => L.zone[c] !== ZONE.WILDERNESS) : cmd.cells;
      const pr = createProject(w, cmd.kind, cells, cmd.species);
      if (!pr) return fail('No suitable ground for that treatment in the selection.');
      return { ok: true, msg: `${pr.label} queued — est. $${Math.round(pr.costPerCell * pr.unit.length).toLocaleString()}.`, cost: pr.costPerCell * pr.unit.length };
    }
    case 'cancelProject': {
      const pr = w.projects.find((p) => p.id === cmd.id);
      if (!pr) return fail('No such project.');
      if (pr.status === 'burning') return fail('A burn in progress cannot be called off.');
      cancelProject(w, pr);
      return { ok: true, msg: `${pr.label} cancelled.` };
    }
    case 'fireResponse': {
      const fe = fireById(w, cmd.fireId);
      if (!fe || !fe.active) return fail('That fire is out.');
      if (fe.cause === 'prescribed') return fail('Prescribed burns are managed by their crews.');
      if (fe.inBuffer && cmd.response === 'monitor') return fail('Fires in a Community Buffer are always fought.');
      fe.response = cmd.response;
      if (cmd.response === 'monitor') for (const c of w.crews) if (c.task?.fireId === fe.id && !c.manual) c.task = null;
      return { ok: true, msg: `${fe.name}: response set to ${cmd.response}.` };
    }
    case 'sendCrew': {
      const c = w.crews.find((x) => x.id === cmd.crewId);
      if (!c) return fail('No such crew.');
      const held = c.task?.projectId !== undefined ? w.projects.find((p) => p.id === c.task!.projectId) : undefined;
      if (held && held.status === 'burning') return fail(`${c.name} is holding a burn and cannot leave.`);
      if (cmd.fireId !== undefined) {
        const fe = fireById(w, cmd.fireId);
        if (!fe || !fe.active) return fail('That fire is out.');
        if (!fe.detected) return fail('No one knows about that fire yet.');
        if (!assignToFire(w, c, fe, true)) return fail(`${c.name} cannot reach the fire.`);
        return { ok: true, msg: `${c.name} dispatched to the ${fe.name}.` };
      }
      if (cmd.projectId !== undefined) {
        const pr = w.projects.find((p) => p.id === cmd.projectId);
        if (!pr || pr.status === 'done' || pr.status === 'cancelled') return fail('No active project there.');
        if (c.kind !== 'hand') return fail('Only hand crews carry out treatments.');
        const goal = Math.round(pr.cy) * w.W + Math.round(pr.cx);
        if (!planPath(w, c, goal)) return fail(`${c.name} cannot reach the project.`);
        if (c.task?.projectId !== pr.id) releaseProject(w, c);
        c.task = { kind: 'project', projectId: pr.id };
        c.manual = true;
        c.state = 'moving';
        return { ok: true, msg: `${c.name} assigned to ${pr.label}.` };
      }
      if (cmd.cell !== undefined) {
        if (!planPath(w, c, cmd.cell)) return fail(`${c.name} cannot get there.`);
        releaseProject(w, c);
        c.task = { kind: 'move', targetX: cmd.cell % w.W, targetY: (cmd.cell / w.W) | 0 };
        c.manual = true;
        c.state = 'moving';
        return { ok: true, msg: `${c.name} moving.` };
      }
      return fail('Nowhere to send them.');
    }
    case 'recallCrew': {
      const c = w.crews.find((x) => x.id === cmd.crewId);
      if (!c) return fail('No such crew.');
      const pr = c.task?.projectId !== undefined ? w.projects.find((p) => p.id === c.task!.projectId) : undefined;
      if (pr && pr.status === 'burning') return fail(`${c.name} is holding a burn and cannot leave.`);
      releaseProject(w, c);
      c.task = null;
      c.manual = false;
      if (planPath(w, c, c.home)) c.state = 'returning';
      return { ok: true, msg: `${c.name} recalled to station.` };
    }
    case 'fireline': {
      const cells = cmd.cells.filter((i) => i >= 0 && i < w.N && L.water[i] < 2 && L.fire[i] !== FIRE.BURNING);
      if (cells.length === 0) return fail('Cannot cut line there.');
      let c = cmd.crewId !== undefined ? w.crews.find((x) => x.id === cmd.crewId) : undefined;
      if (!c) {
        // nearest available hand crew (idle first, then busy on projects)
        const first = cells[0];
        const fx = first % w.W,
          fy = (first / w.W) | 0;
        const holdingBurn = (x: (typeof w.crews)[number]) => x.task?.kind === 'project' && w.projects.some((p) => p.id === x.task!.projectId && p.status === 'burning');
        const pool = w.crews.filter((x) => x.kind !== 'heli' && (x.state === 'idle' || (x.task?.kind === 'project' && !x.manual && !holdingBurn(x))));
        pool.sort((a, b) => Math.hypot(a.x - fx, a.y - fy) - Math.hypot(b.x - fx, b.y - fy));
        c = pool[0];
      }
      if (!c) return fail('No ground crew is free. Recall one first.');
      const held = c.task?.projectId !== undefined ? w.projects.find((p) => p.id === c.task!.projectId) : undefined;
      if (held && held.status === 'burning') return fail(`${c.name} is holding a burn and cannot leave.`);
      if (!planPath(w, c, cells[0])) return fail(`${c.name} cannot reach the line.`);
      releaseProject(w, c);
      c.task = { kind: 'line', cells };
      c.manual = true;
      c.state = 'moving';
      return { ok: true, msg: `${c.name} cutting ${cells.length} cells of fireline.` };
    }
    case 'airdrop': {
      const cells = cmd.cells.filter((i) => i >= 0 && i < w.N && L.water[i] < 2);
      if (cells.length === 0) return fail('Nothing to drop on.');
      const drops = Math.ceil(cells.length / 10);
      const cost = drops * COST.retardantDrop;
      for (const i of cells) {
        L.retard[i] = 1;
        if (L.fire[i] === FIRE.BURNING && L.fint[i] < 0.9) L.fint[i] *= 0.4;
      }
      w.spend('Aviation', cost);
      w.dirty.infra++;
      w.dirty.fire++;
      return { ok: true, msg: `Air tanker laid ${cells.length} cells of retardant (${drops} drop${drops > 1 ? 's' : ''}).`, cost };
    }
    case 'build': {
      const i = cmd.cell;
      if (i < 0 || i >= w.N || L.water[i] >= 2 || L.town[i] !== 0) return fail('Cannot build there.');
      if (cmd.what === 'tower') {
        if (w.towers.some((t) => Math.hypot((t % w.W) - (i % w.W), ((t / w.W) | 0) - ((i / w.W) | 0)) < 12))
          return fail('Too close to an existing lookout.');
        L.infra[i] |= INFRA.TOWER;
        w.towers.push(i);
        w.spend('Infrastructure', COST.tower);
        w.dirty.infra++;
        return { ok: true, msg: 'Lookout tower built.', cost: COST.tower };
      }
      // campground needs road access
      let nearRoad = false;
      for (let dy = -4; dy <= 4 && !nearRoad; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const x = (i % w.W) + dx,
            y = ((i / w.W) | 0) + dy;
          if (w.inside(x, y) && L.infra[y * w.W + x] & INFRA.ROAD) {
            nearRoad = true;
            break;
          }
        }
      if (!nearRoad) return fail('Campgrounds need a road within 400 m.');
      if (L.zone[i] === ZONE.WILDERNESS) return fail('No developed campgrounds in wilderness.');
      // one campground per site: v1.0 let ten be stacked on one hectare for ten times the visitors
      if (w.camps.some((c) => Math.hypot((c % w.W) - (i % w.W), ((c / w.W) | 0) - ((i / w.W) | 0)) < 4))
        return fail('Too close to an existing campground.');
      L.infra[i] |= INFRA.CAMP;
      w.camps.push(i);
      w.spend('Infrastructure', COST.camp);
      w.dirty.infra++;
      return { ok: true, msg: 'Campground built.', cost: COST.camp };
    }
    case 'road': {
      const p = astar(w.W, w.H, cmd.from, cmd.to, roadCostNoWild(w), 1, 60000);
      if (!p) return fail('No buildable route (roads cannot enter Wilderness).');
      const newCells = p.filter((c) => !(L.infra[c] & INFRA.ROAD)).length;
      if (newCells === 0) return fail('That road already exists.');
      const cost = newCells * COST.road;
      layRoad(w, cmd.from, p);
      w.spend('Infrastructure', cost);
      w.memory.roadsBuilt = (w.memory.roadsBuilt ?? 0) + newCells;
      return { ok: true, msg: `${(newCells / 10).toFixed(1)} km of road built.`, cost };
    }
    case 'hire': {
      const town = w.towns[cmd.townId ?? 0] ?? w.towns[0];
      if (!town) return fail('No town to base a crew in.');
      const names = new NameBank(w.rng.misc.fork('crew' + w.crews.length));
      const n = w.crews.filter((c) => c.kind === cmd.kind).length + 1;
      const crew = makeCrew(w, cmd.kind, town.station, names.crewName(cmd.kind, n));
      w.crews.push(crew);
      w.spend('Crew wages', CREW_COST[cmd.kind].hire);
      return { ok: true, msg: `${crew.name} hired at ${town.name}.`, cost: CREW_COST[cmd.kind].hire };
    }
    case 'dismiss': {
      const k = w.crews.findIndex((c) => c.id === cmd.crewId);
      if (k < 0) return fail('No such crew.');
      const c = w.crews[k];
      if (c.state !== 'idle') return fail(`${c.name} is out on assignment.`);
      w.crews.splice(k, 1);
      return { ok: true, msg: `${c.name} disbanded.` };
    }
    case 'policy': {
      const before = w.policies[cmd.key];
      (w.policies as unknown as Record<string, unknown>)[cmd.key] = cmd.value;
      if (before !== cmd.value) w.memory.policyChanges = (w.memory.policyChanges ?? 0) + 1;
      if (cmd.key === 'buildingCode' && cmd.value === 'firewise' && before !== 'firewise') w.memory.codeAdoptedDay = w.day;
      return { ok: true, msg: `Policy updated.` };
    }
    case 'reintroduceWolves': {
      const i = cmd.cell;
      if (i < 0 || i >= w.N || L.water[i] >= 2) return fail('Choose dry ground.');
      const x = (i % w.W) + 0.5,
        y = ((i / w.W) | 0) + 0.5;
      for (const t of w.towns) if (Math.hypot(t.x - x, t.y - y) < 16) return fail('Too close to town for a release site.');
      if (w.packs.some((p) => Math.hypot(p.tx - x, p.ty - y) < 26)) return fail('A pack already holds that territory.');
      const names = new NameBank(w.rng.misc.fork('pack' + w.packs.length));
      w.packs.push({ id: w.nextId(), name: names.packName(), x, y, px: x, py: y, n: 5, tx: x, ty: y, hunger: 0.4, targetHerd: -1, kills: 0, founded: w.day });
      w.spend('Wildlife', COST.wolfReintro);
      w.memory.wolfReintroYear = w.year;
      w.memory.wolfReleases = (w.memory.wolfReleases ?? 0) + 1;
      return { ok: true, msg: 'Five wolves released.', cost: COST.wolfReintro };
    }
    case 'relocateBeavers': {
      const i = cmd.cell;
      const s = beaverSiteScore(w, i);
      if (s < 0.08) return fail('Beavers need a gentle stream with willow or aspen nearby.');
      if (w.colonies.some((c) => c.active && c.cell === i)) return fail('Already occupied.');
      w.colonies.push({ id: w.nextId(), cell: i, n: 4, food: 0.6, dam: 0.1, years: 0, active: true, abandonedDay: -1 });
      w.spend('Wildlife', COST.beaverRelocation);
      return { ok: true, msg: 'A beaver family has been released.', cost: COST.beaverRelocation };
    }
    case 'petition':
    case 'closeReview':
      // handled by the council system (factions.ts) which owns review state
      return handleReviewCommand(w, cmd);
  }
}

export function crewsAt(w: World, cell: number, r = 1.5) {
  const x = (cell % w.W) + 0.5,
    y = ((cell / w.W) | 0) + 0.5;
  return w.crews.filter((c) => Math.hypot(c.x - x, c.y - y) <= r);
}

export { crewCell };
