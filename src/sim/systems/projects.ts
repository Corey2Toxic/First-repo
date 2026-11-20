/**
 * Fuel-treatment projects: mechanical thinning, prescribed burning,
 * planting and shaded fuel breaks. Projects are queued by the player and
 * worked by hand crews when no fire needs them. Burns wait for a weather
 * "prescription" window, then crews cut a control line around the unit,
 * light it, and hold it — mostly.
 */
import { DX8, DY8, clamp01 } from '../grid.ts';
import { FIRE, INFRA, SP, ZONE } from '../types.ts';
import type { FireEvent, Project, ProjectKind } from '../types.ts';
import { COST, REVENUE } from '../economyParams.ts';
import { cellFuel } from './fuels.ts';
import { R_MIN, frontBehaviour, forgetProjectUnit, igniteCell, isBurnable, projectContains, spreadEnvFor, startFire, surfaceHeadRate } from './fire.ts';
import type { CellFuel } from './fuels.ts';
import { droughtSeverity } from './climate.ts';
import { forecast } from '../forecast.ts';
import type { World } from '../world.ts';

export const PROJECT_NAMES: Record<ProjectKind, string> = {
  thin: 'Thinning',
  burn: 'Prescribed burn',
  plant: 'Planting',
  fuelbreak: 'Fuel break',
};

export function projectCostPerCell(kind: ProjectKind, w?: World): number {
  // (v2: a fuel treatment disposes of its own slash and its price includes that; the slash policy
  // governs the mill's harvest only)
  void w;
  return kind === 'thin' ? COST.thin : kind === 'burn' ? COST.burn : kind === 'plant' ? COST.plant : COST.fuelbreak;
}

/** Which cells of a selection a project may treat. */
export function validProjectCells(w: World, kind: ProjectKind, cells: number[]): number[] {
  const L = w.L;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const i of cells) {
    if (seen.has(i) || i < 0 || i >= w.N) continue;
    seen.add(i);
    if (L.water[i] >= 2 || L.pond[i] > 0.35 || L.town[i] !== 0 || L.fire[i] === FIRE.BURNING) continue;
    if (L.infra[i] & (INFRA.STATION | INFRA.MILL | INFRA.TOWER | INFRA.CAMP)) continue;
    const can = L.aspen[i] + L.pine[i] + L.fir[i];
    if (kind === 'thin' && can + L.shrub[i] < 0.12) continue;
    if (kind === 'plant' && can > 0.45) continue;
    if (kind === 'burn' && cellFuel(w, i).fine < 1) continue;
    out.push(i);
  }
  return out;
}

function nearestTownName(w: World, x: number, y: number): string {
  let best = '',
    bd = Infinity;
  for (const m of w.landmarks) {
    const d = Math.hypot(m.x - x, m.y - y);
    if (d < bd) {
      bd = d;
      best = m.name;
    }
  }
  return best;
}

/** Largest burn unit one operation can fire and hold (ha). Larger selections become several units. */
export const MAX_BURN_UNIT = 300;

/**
 * Queue a treatment on the valid cells of a selection. A prescribed burn larger than MAX_BURN_UNIT
 * is split into contiguous units of at most that size (v1.x let one crew light and "hold" a
 * 5,000-ha unit). Returns the projects created (empty when nothing in the selection can be treated).
 */
export function createProjects(w: World, kind: ProjectKind, cells: number[], species: number = SP.PINE): Project[] {
  const valid = validProjectCells(w, kind, cells).sort((a, b) => a - b);
  if (valid.length === 0) return [];
  const units: number[][] = [];
  if (kind !== 'burn' || valid.length <= MAX_BURN_UNIT) units.push(valid);
  else {
    // grow compact blobs outward from the lowest remaining cell
    const left = new Set(valid);
    for (const seed of valid) {
      if (!left.has(seed)) continue;
      const unit: number[] = [];
      const queue = [seed];
      left.delete(seed);
      while (queue.length && unit.length < MAX_BURN_UNIT) {
        const c = queue.shift()!;
        unit.push(c);
        const x = c % w.W,
          y = (c / w.W) | 0;
        for (let d = 0; d < 8; d += 2) {
          const nx = x + DX8[d],
            ny = y + DY8[d];
          if (!w.inside(nx, ny)) continue;
          const n = ny * w.W + nx;
          if (left.has(n)) {
            left.delete(n);
            queue.push(n);
          }
        }
      }
      // cells queued but not taken go back for the next unit
      for (const c of queue) left.add(c);
      units.push(unit.sort((a, b) => a - b));
    }
  }
  const out: Project[] = [];
  for (const unit of units) {
    let sx = 0,
      sy = 0;
    for (const c of unit) {
      sx += c % w.W;
      sy += (c / w.W) | 0;
    }
    const cx = sx / unit.length,
      cy = sy / unit.length;
    const pr: Project = {
      id: w.nextId(),
      kind,
      unit,
      todo: unit.slice(),
      done: 0,
      progress: 0,
      status: 'queued',
      species,
      createdDay: w.day,
      doneDay: -1,
      costPerCell: projectCostPerCell(kind, w),
      spent: 0,
      label: `${PROJECT_NAMES[kind]} near ${nearestTownName(w, cx, cy)} (${unit.length} ha)`,
      fireId: -1,
      burnDays: 0,
      waitDays: 0,
      cx,
      cy,
    };
    w.projects.push(pr);
    out.push(pr);
  }
  return out;
}

/** Queue one treatment (the first unit if the selection had to be split). */
export function createProject(w: World, kind: ProjectKind, cells: number[], species: number = SP.PINE): Project | null {
  return createProjects(w, kind, cells, species)[0] ?? null;
}

export function cancelProject(w: World, pr: Project): void {
  if (pr.status === 'burning') return; // can't un-light a fire
  pr.status = 'cancelled';
  for (const c of w.crews) if (c.task?.projectId === pr.id) c.task = null;
}

/** Nearest untreated cell of a project to a given cell. */
export function projectWorkCell(w: World, pr: Project, from: number): number {
  let best = -1,
    bd = Infinity;
  const fx = from % w.W,
    fy = (from / w.W) | 0;
  // a burn is staged from the edge of its unit nearest the crew (v1.x sent the crew to the unit's
  // centroid, which for a unit round a lake or a beaver pond is water nobody can reach)
  for (const c of pr.kind === 'burn' ? pr.unit : pr.todo) {
    const d = Math.abs((c % w.W) - fx) + Math.abs(((c / w.W) | 0) - fy);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

export function completeProjectCell(w: World, pr: Project, cell: number, skipped: boolean): void {
  const k = pr.todo.indexOf(cell);
  if (k >= 0) pr.todo.splice(k, 1);
  if (!skipped) {
    w.spend('Fuel treatments', pr.costPerCell);
    pr.spent += pr.costPerCell;
    pr.done++;
    if (pr.kind === 'thin') applyThinning(w, cell);
    else if (pr.kind === 'plant') applyPlanting(w, cell, pr.species);
    else if (pr.kind === 'fuelbreak') applyFuelbreak(w, cell);
    w.counters.yearTreated++;
  }
  if (pr.todo.length === 0 && pr.kind !== 'burn') {
    pr.status = 'done';
    pr.doneDay = w.day;
  }
}

export function applyThinning(w: World, i: number): void {
  const L = w.L;
  const youngF = L.ageF[i] < 60,
    youngP = L.ageP[i] < 40;
  L.shrub[i] *= 0.3;
  L.under[i] *= 0.1;
  L.fir[i] *= youngF ? 0.15 : 0.6;
  L.pine[i] *= youngP ? 0.35 : 0.82;
  L.aspen[i] *= 0.9;
  // The crew chips or piles and burns what it cuts: a little residue is left and the ladder is gone.
  // (v1.x left 10-18 t/ha of slash by default, so a thinned stand burned hotter and crowned more
  // readily for 4-10 years while counting as treated.)
  L.slash[i] += 1.5;
  L.dead[i] *= 0.8;
  L.lastTreat[i] = w.yearF;
  // thinned stands: older, fewer, bigger trees → mean ages rise
  if (youngF) L.ageF[i] = Math.max(L.ageF[i], 45);
  if (youngP) L.ageP[i] = Math.max(L.ageP[i], 35);
  w.earn('Biomass', REVENUE.biomass);
  w.dirty.veg++;
}

/**
 * Seedlings join the cell's cohort of that species as a young cohort: the mean age is weighted by
 * cover, exactly as natural recruits are (vegetation.ts). v1.0 reset the mean age of every tree of
 * that species in the cell to at most 1 year, so planting under a 170-year stand made it 1 year old
 * and planting the eligible open old stands halved the valley's old growth (D4).
 */
export function plantedAge(cover: number, age: number, add: number, seedlingAge = 1): number {
  return cover + add > 0 ? (cover * age + add * seedlingAge) / (cover + add) : seedlingAge;
}

export function applyPlanting(w: World, i: number, species: number): void {
  const L = w.L;
  const add = 0.09;
  if (species === SP.ASPEN) {
    L.ageA[i] = plantedAge(L.aspen[i], L.ageA[i], add);
    L.aspen[i] += add;
    L.aroot[i] = clamp01(L.aroot[i] + 0.3);
  } else if (species === SP.FIR) {
    L.ageF[i] = plantedAge(L.fir[i], L.ageF[i], add);
    L.fir[i] += add;
  } else {
    L.ageP[i] = plantedAge(L.pine[i], L.ageP[i], add);
    L.pine[i] += add;
  }
  L.lastTreat[i] = w.yearF;
  w.dirty.veg++;
}

export function applyFuelbreak(w: World, i: number): void {
  const L = w.L;
  L.fir[i] *= 0.1;
  L.pine[i] *= 0.35; // shaded fuel break keeps some big pines
  L.aspen[i] *= 0.6;
  L.shrub[i] *= 0.1;
  L.under[i] = 0;
  L.litter[i] *= 0.25;
  L.dead[i] *= 0.3;
  L.snag[i] *= 0.2;
  L.slash[i] = 0;
  L.infra[i] |= INFRA.FUELBREAK;
  L.lastTreat[i] = w.yearF;
  w.dirty.veg++;
  w.dirty.infra++;
}

/** Fuel breaks are mowed and limbed every year; costs accrue in the economy. */
export function maintainFuelbreaks(w: World): number {
  const L = w.L;
  let n = 0;
  for (let i = 0; i < w.N; i++) {
    if (!(L.infra[i] & INFRA.FUELBREAK)) continue;
    n++;
    L.shrub[i] = Math.min(L.shrub[i], 0.08);
    L.under[i] = Math.min(L.under[i], 0.05);
    L.fir[i] = Math.min(L.fir[i], 0.05);
    L.pine[i] = Math.min(L.pine[i], 0.25);
    L.litter[i] = Math.min(L.litter[i], 3);
    L.dead[i] = Math.min(L.dead[i], 4);
    L.slash[i] = 0;
  }
  return n;
}

// ------------------------------------------------------------ prescribed burns
export function unitFuelMoisture(w: World, pr: Project): number {
  let s = 0,
    n = 0;
  for (let k = 0; k < pr.unit.length; k += Math.max(1, Math.floor(pr.unit.length / 30))) {
    s += w.L.fm[pr.unit[k]];
    n++;
  }
  return n ? s / n : 0.3;
}

/** Hand crews needed to light and hold a unit: one to 80 ha, two to 200, three beyond. */
export function burnCrewsNeeded(pr: Project): number {
  return pr.unit.length <= 80 ? 1 : pr.unit.length <= 200 ? 2 : 3;
}

export interface BurnOutlook {
  /** share of the unit where fire would carry this afternoon (0..1) */
  carry: number;
  /** share of the unit where it would torch or flame beyond what a crew can hold (0..1) */
  hot: number;
  /** why the burn is out of prescription today, or '' when it can be lit */
  problem: string;
}

const outlookFuel: CellFuel = { fine: 0, grassShare: 0, ladder: 0, canopy: 0, heavy: 0, green: 0 };

/**
 * The burn boss's go/no-go for today: will fire carry across the unit this afternoon, and will it
 * stay on the ground? Uses the fire model's own rates and crowning rule on a sample of the unit, so
 * the prescription and the fire agree (v1.x's window admitted fuel up to 22 % moisture, far too damp
 * for its own fire model to carry: spring burns covered a median 6–22 % of their units).
 */
export function burnOutlook(w: World, pr: Project): BurnOutlook {
  const L = w.L;
  const wx = w.weather;
  const drought = droughtSeverity(w.climate.droughtIndex);
  // mid-afternoon, the hour the unit is fired for
  const env = spreadEnvFor(4, wx, drought);
  let n = 0,
    carry = 0,
    hot = 0,
    snowy = 0;
  const step = Math.max(1, Math.floor(pr.unit.length / 40));
  for (let k = 0; k < pr.unit.length; k += step) {
    const c = pr.unit[k];
    n++;
    if (L.snow[c] > 5) {
      snowy++;
      continue;
    }
    const f = cellFuel(w, c, outlookFuel);
    // a strip-fired unit burns mostly as backing and flanking fire: about a third of the head rate
    const head = (surfaceHeadRate(w, c, f, env.windEff, L.fm[c] + env.fmAdd) / 100) * env.spread;
    if (head >= 4 * R_MIN) carry++;
    const b = frontBehaviour(w, c, f, head * 0.35, 0);
    if (b.crown || b.flame > 1.6) hot++;
  }
  const out: BurnOutlook = { carry: n ? carry / n : 0, hot: n ? hot / n : 0, problem: '' };
  if (snowy > n * 0.2) out.problem = 'Snow on the unit.';
  else if (wx.precip > 1) out.problem = 'Rain today.';
  else if (wx.windEvent || wx.windSpeed > 6.5) out.problem = 'Too windy to hold a burn.';
  else if (wx.dangerClass > 1) out.problem = 'Fire danger is too high.';
  else if (out.hot > 0.12) out.problem = 'Too dry: parts of the unit would torch.';
  else if (out.carry < 0.55) out.problem = 'Fuels are too damp to carry fire.';
  else if (w.policies.smokeRules && wx.dispersion < 0.5) out.problem = 'Poor smoke dispersal (smoke rules).';
  else if (forecast(w, 2).some((d) => d.windEventChance >= 0.5)) out.problem = 'A wind event is forecast.';
  return out;
}

export function burnWindowOpen(w: World, pr: Project): boolean {
  return burnOutlook(w, pr).problem === '';
}

/** Cells surrounding a unit (outside it) — where the control line goes. */
export function unitRing(w: World, pr: Project): number[] {
  const inUnit = new Set(pr.unit);
  const ring = new Set<number>();
  for (const c of pr.unit) {
    const x = c % w.W,
      y = (c / w.W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d],
        ny = y + DY8[d];
      if (!w.inside(nx, ny)) continue;
      const n = ny * w.W + nx;
      if (!inUnit.has(n)) ring.add(n);
    }
  }
  return Array.from(ring).sort((a, b) => a - b);
}

/** Ignition points one hand crew lays in a day of firing. */
export const FIRING_POINTS_PER_CREW = 14;

/** Light up to `points` evenly spread unburned cells of the unit. Returns how many were lit. */
function fireUnit(w: World, pr: Project, fe: FireEvent, points: number): number {
  const L = w.L;
  const unburned = pr.unit.filter((c) => L.fire[c] === FIRE.NONE && w.yearF - L.lastBurn[c] > 0.2);
  if (unburned.length === 0 || points <= 0) return 0;
  const stride = Math.max(1, Math.floor(unburned.length / points));
  let lit = 0;
  // start mid-stride so successive days do not re-walk the same lattice
  for (let k = (pr.burnDays * 3) % stride; k < unburned.length && lit < points; k += stride) {
    igniteCell(w, unburned[k], fe, 0.4, false);
    lit++;
  }
  return lit;
}

export function igniteProjectBurn(w: World, pr: Project, crews = 1): FireEvent | null {
  const L = w.L;
  // the unit was checked when it was planned; homes or facilities built since
  // then are taken out of it (fire reaching them is then an escape)
  const unit = pr.unit.filter((c) => L.town[c] === 0 && !(L.infra[c] & (INFRA.STATION | INFRA.MILL | INFRA.TOWER | INFRA.CAMP)));
  if (unit.length < pr.unit.length) {
    pr.unit = unit;
    forgetProjectUnit(w, pr.id);
  }
  if (unit.length === 0) {
    pr.status = 'cancelled'; // built over before it could be burned
    return null;
  }
  for (const c of unitRing(w, pr)) L.fline[c] = 1;
  const first = pr.unit.find((c) => L.fire[c] === FIRE.NONE && isBurnable(w, c));
  if (first === undefined) return null;
  const fe = startFire(w, first, 'prescribed', pr.id);
  if (!fe) return null;
  fe.name = pr.label.replace(/^Prescribed burn near /, '').replace(/ \(\d+ ha\)$/, '') + ' Rx Burn';
  pr.status = 'burning';
  pr.fireId = fe.id;
  pr.burnDays = 0;
  fireUnit(w, pr, fe, FIRING_POINTS_PER_CREW * Math.max(1, crews) - 1);
  w.memory.rxSmokeDays++;
  w.dirty.fire++;
  return fe;
}

/** Daily burn management: strip-light unburned parts, finish when out. */
export function projectsDaily(w: World): void {
  for (const pr of w.projects) {
    if (pr.kind !== 'burn') continue;
    if (pr.status === 'waiting' || pr.status === 'active' || pr.status === 'queued') pr.waitDays++;
    if (pr.status !== 'burning') continue;
    pr.burnDays++;
    const fe = w.fires.find((f) => f.id === pr.fireId);
    if (!fe || !fe.active) {
      finishBurn(w, pr);
      continue;
    }
    // once a burn has escaped, crews stop lighting and fight it (v1.x went on strip-lighting)
    if (fe.cause !== 'prescribed') continue;
    const crews = w.crews.filter((c) => c.task?.projectId === pr.id && c.state !== 'moving').length;
    if (crews > 0 && pr.burnDays <= 8 && w.weather.dangerClass <= 2 && w.weather.windSpeed < 8 && !w.weather.windEvent && w.weather.precip < 1) {
      fireUnit(w, pr, fe, FIRING_POINTS_PER_CREW * crews);
    }
  }
}

function finishBurn(w: World, pr: Project): void {
  const L = w.L;
  let burned = 0;
  for (const c of pr.unit) {
    if (w.yearF - L.lastBurn[c] < 0.1) {
      burned++;
      L.lastTreat[c] = w.yearF;
    }
  }
  pr.done = burned;
  pr.todo = [];
  pr.status = 'done';
  pr.doneDay = w.day;
  // charged for the ground that burned, plus the line and the standby for the rest
  // (v1.x billed the whole unit when a median 41 % of it burned)
  const cost = pr.costPerCell * burned + 0.15 * pr.costPerCell * (pr.unit.length - burned);
  w.spend('Fuel treatments', cost);
  pr.spent += cost;
  w.counters.yearRxBurned += burned;
  w.counters.totalRx += burned;
  for (const c of w.crews) if (c.task?.projectId === pr.id) c.task = null;
}

/** Each sub-step: crews holding a burn catch spots just outside the unit. */
export function holdBurns(w: World): void {
  const L = w.L;
  const r = w.rng.fire;
  for (const pr of w.projects) {
    if (pr.status !== 'burning') continue;
    const holding = w.crews.filter((c) => c.task?.projectId === pr.id && c.state === 'working').length;
    if (holding === 0) continue;
    for (const b of w.burning) {
      if (L.fid[b] !== pr.fireId) continue;
      if (projectContains(w, pr.id, b)) continue;
      if (r.next() < 0.3 * holding && L.fint[b] < 1.5) {
        L.ftime[b] = Math.min(L.ftime[b], 0.01);
        L.fint[b] = 0.05;
      }
    }
  }
}

/** Planting and thinning are not allowed in wilderness; flag the conflict. */
export function zoneConflict(w: World, kind: ProjectKind, cells: number[]): boolean {
  if (kind === 'burn') return false;
  return cells.some((c) => w.L.zone[c] === ZONE.WILDERNESS);
}
