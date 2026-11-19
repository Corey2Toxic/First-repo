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
import { startFire, igniteCell, projectContains, forgetProjectUnit } from './fire.ts';
import type { World } from '../world.ts';

export const PROJECT_NAMES: Record<ProjectKind, string> = {
  thin: 'Thinning',
  burn: 'Prescribed burn',
  plant: 'Planting',
  fuelbreak: 'Fuel break',
};

export function projectCostPerCell(kind: ProjectKind, w?: World): number {
  const base = kind === 'thin' ? COST.thin : kind === 'burn' ? COST.burn : kind === 'plant' ? COST.plant : COST.fuelbreak;
  const extra = kind === 'thin' && w?.policies.slash === 'pileburn' ? COST.pileBurnPerHa : 0;
  return base + extra;
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

export function createProject(w: World, kind: ProjectKind, cells: number[], species: number = SP.PINE): Project | null {
  const unit = validProjectCells(w, kind, cells).sort((a, b) => a - b);
  if (unit.length === 0) return null;
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
  return pr;
}

export function cancelProject(w: World, pr: Project): void {
  if (pr.status === 'burning') return; // can't un-light a fire
  pr.status = 'cancelled';
  for (const c of w.crews) if (c.task?.projectId === pr.id) c.task = null;
}

/** Nearest untreated cell of a project to a given cell. */
export function projectWorkCell(w: World, pr: Project, from: number): number {
  if (pr.kind === 'burn') return Math.round(pr.cy) * w.W + Math.round(pr.cx);
  let best = -1,
    bd = Infinity;
  const fx = from % w.W,
    fy = (from / w.W) | 0;
  for (const c of pr.todo) {
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
  L.fir[i] *= youngF ? 0.15 : 0.6;
  L.pine[i] *= youngP ? 0.35 : 0.82;
  L.aspen[i] *= 0.9;
  const slash = 10 + 8 * (L.pine[i] + L.fir[i]);
  L.slash[i] += w.policies.slash === 'pileburn' ? slash * 0.25 : slash;
  L.lastTreat[i] = w.yearF;
  // thinned stands: older, fewer, bigger trees → mean ages rise
  if (youngF) L.ageF[i] = Math.max(L.ageF[i], 45);
  if (youngP) L.ageP[i] = Math.max(L.ageP[i], 35);
  w.earn('Biomass', REVENUE.biomass);
  w.dirty.veg++;
}

export function applyPlanting(w: World, i: number, species: number): void {
  const L = w.L;
  const add = 0.09;
  if (species === SP.ASPEN) {
    L.aspen[i] += add;
    L.aroot[i] = clamp01(L.aroot[i] + 0.3);
    L.ageA[i] = Math.min(L.ageA[i], 1);
  } else if (species === SP.FIR) {
    L.fir[i] += add;
    L.ageF[i] = Math.min(L.ageF[i], 1);
  } else {
    L.pine[i] += add;
    L.ageP[i] = Math.min(L.ageP[i], 1);
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

export function burnWindowOpen(w: World, pr: Project): boolean {
  const wx = w.weather;
  if (wx.dangerClass > 1 || wx.windSpeed > 6.5 || wx.precip > 1 || wx.windEvent) return false;
  const fm = unitFuelMoisture(w, pr);
  if (fm < 0.075 || fm > 0.22) return false;
  let snowy = 0;
  for (let k = 0; k < pr.unit.length; k += 5) if (w.L.snow[pr.unit[k]] > 5) snowy++;
  return snowy < pr.unit.length / 25;
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

export function igniteProjectBurn(w: World, pr: Project): FireEvent | null {
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
  for (const c of unitRing(w, pr)) L.fline[c] = Math.max(L.fline[c], 0.9);
  // light a pattern of ignition points across the unit
  const r = w.rng.fire;
  let fe: FireEvent | null = null;
  const pts = pr.unit.filter((_, k) => k % 12 === 0);
  for (const c of pts) {
    if (L.fire[c] !== FIRE.NONE) continue;
    if (!fe) {
      fe = startFire(w, c, 'prescribed', pr.id);
      if (fe) {
        fe.name = pr.label.replace(/^Prescribed burn near /, '').replace(/ \(\d+ ha\)$/, '') + ' Rx Burn';
      }
    } else if (r.next() < 0.8) igniteCell(w, c, fe, 0.15, false);
  }
  if (!fe) return null;
  pr.status = 'burning';
  pr.fireId = fe.id;
  pr.burnDays = 0;
  w.memory.rxSmokeDays++;
  w.dirty.fire++;
  return fe;
}

/** Daily burn management: strip-light unburned parts, finish when out. */
export function projectsDaily(w: World): void {
  const L = w.L;
  for (const pr of w.projects) {
    if (pr.kind !== 'burn') continue;
    if (pr.status === 'waiting' || pr.status === 'active') pr.waitDays++;
    if (pr.status !== 'burning') continue;
    pr.burnDays++;
    const fe = w.fires.find((f) => f.id === pr.fireId);
    if (!fe || !fe.active) {
      finishBurn(w, pr);
      continue;
    }
    if (pr.burnDays <= 4 && w.weather.dangerClass <= 2 && w.weather.windSpeed < 8) {
      // strip-ignite more of the unit
      const unburned = pr.unit.filter((c) => L.fire[c] === FIRE.NONE && w.yearF - L.lastBurn[c] > 0.2);
      for (let k = 0; k < unburned.length; k += 6) igniteCell(w, unburned[k], fe, 0.14, false);
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
  const cost = pr.costPerCell * pr.unit.length;
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
      if (r.next() < 0.3 * holding && L.fint[b] < 0.8) {
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
