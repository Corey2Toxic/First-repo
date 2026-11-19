/**
 * Towns: smoke exposure, fire threat, firewise readiness, yearly growth into
 * the forest edge (the wildland–urban interface), rebuilding, and the mill.
 */
import { DX8, DY8, clamp01 } from '../grid.ts';
import { FIRE, INFRA, ZONE } from '../types.ts';
import type { Town } from '../types.ts';
import { COST } from '../economyParams.ts';
import { hazardIndex } from './fuels.ts';
import type { World } from '../world.ts';

export function townsDaily(w: World): void {
  const L = w.L;
  for (const t of w.towns) {
    let s = 0;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const x = t.x + dx,
          y = t.y + dy;
        if (w.inside(x, y)) s = Math.max(s, L.smoke[y * w.W + x]);
      }
    t.smokeToday = clamp01(s);
    if (s > 0.15) {
      t.smokeDays++;
      w.counters.yearSmokeDays++;
    }
    // threat: nearest detected active fire edge
    let threat = 0;
    for (const f of w.fires) {
      if (!f.active || !f.detected) continue;
      const cx = (f.minX + f.maxX) / 2,
        cy = (f.minY + f.maxY) / 2;
      const rad = Math.max(f.maxX - f.minX, f.maxY - f.minY) / 2;
      const d = Math.max(0, Math.hypot(t.x - cx, t.y - cy) - rad - Math.sqrt(t.structures) * 0.6);
      threat = Math.max(threat, clamp01(1 - d / 15));
    }
    t.threat = threat;
    if (threat > 0.5) w.memory.nearTownFireDays++;
  }
}

/** Cells within `BUFFER_REACH` (1 km) of a town's houses: the ring a Community Buffer protects. */
export const BUFFER_REACH = 10;

/**
 * Chebyshev distance (cells) from each cell near the town to its nearest house of that town, up to
 * BUFFER_REACH; -1 elsewhere. A pure function of the town layer, recomputed when needed.
 */
function townRing(w: World, t: Town): Map<number, number> {
  const L = w.L;
  const tid = t.id + 1;
  const out = new Map<number, number>();
  const r = 6 + Math.sqrt(t.structures) * 1.2 + BUFFER_REACH;
  let frontier: number[] = [];
  for (let y = Math.max(0, Math.floor(t.y - r)); y <= Math.min(w.H - 1, Math.ceil(t.y + r)); y++)
    for (let x = Math.max(0, Math.floor(t.x - r)); x <= Math.min(w.W - 1, Math.ceil(t.x + r)); x++) {
      const i = y * w.W + x;
      if (L.town[i] === tid) {
        out.set(i, 0);
        frontier.push(i);
      }
    }
  for (let d = 1; d <= BUFFER_REACH && frontier.length; d++) {
    const next: number[] = [];
    for (const c of frontier) {
      const cx = c % w.W,
        cy = (c / w.W) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX8[k],
          ny = cy + DY8[k];
        if (!w.inside(nx, ny)) continue;
        const n = ny * w.W + nx;
        if (out.has(n)) continue;
        out.set(n, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  return out;
}

const isTreated = (w: World, i: number) => w.yearF - w.L.lastTreat[i] < 8 || w.yearF - w.L.lastBurn[i] < 6;

/**
 * Town readiness from its surroundings:
 *  - `near`: share of land within 400 m of houses that is treated or naturally light (as in v1.0);
 *  - `buffer`: how much of the 1 km ring is a treated Community Buffer (zoned, and treated or kept
 *    light). A designated, maintained buffer is what the tutorial and the zone tooltip promise:
 *    v1.0 never read the zone at all.
 */
export function surroundingsSafety(w: World, t: Town): { near: number; buffer: number } {
  const L = w.L;
  let n = 0,
    safe = 0,
    ring = 0,
    buf = 0;
  for (const [i, d] of townRing(w, t)) {
    if (d === 0 || L.town[i] || L.water[i]) continue;
    const light = isTreated(w, i) || hazardIndex(w, i) < 0.28;
    if (d <= 4) {
      n++;
      if (light) safe++;
    }
    ring++;
    if (L.zone[i] === ZONE.BUFFER && light) buf++;
  }
  return { near: n ? safe / n : 0.5, buffer: ring ? clamp01(buf / (0.35 * ring)) : 0 };
}

export function updateFirewise(w: World): void {
  const code = w.policies.buildingCode === 'firewise' ? 1 : 0;
  for (const t of w.towns) {
    const s = surroundingsSafety(w, t);
    t.firewise = clamp01(0.1 + 0.32 * code + 0.45 * s.near + 0.15 * s.buffer);
  }
}

/**
 * Year end: treated Community Buffer within 1 km of houses is kept treated — brush cleared, litter
 * raked, young fir cut back — at a per-hectare cost. Returns hectares maintained.
 */
export function maintainBuffers(w: World): number {
  const L = w.L;
  let n = 0;
  const seen = new Set<number>();
  for (const t of w.towns)
    for (const [i, d] of townRing(w, t)) {
      if (d === 0 || seen.has(i) || L.zone[i] !== ZONE.BUFFER || L.town[i] || L.water[i]) continue;
      seen.add(i);
      if (!isTreated(w, i)) continue;
      L.litter[i] *= 0.7;
      L.shrub[i] *= 0.7;
      L.slash[i] *= 0.5;
      if (L.ageF[i] < 30) L.fir[i] *= 0.8;
      L.lastTreat[i] = w.yearF;
      n++;
    }
  if (n) {
    w.spend('Fuel treatments', n * COST.bufferUpkeep);
    w.dirty.veg++;
  }
  return n;
}

/**
 * The one place a home is lost (fire or debris flow): town sign, counts, the valley's yearly and
 * total losses and the town's own yearly loss all move together. v1.0 kept two copies of this and
 * the debris-flow copy never reached the score, the yearly stats or the council's review (D14).
 */
export function loseStructure(w: World, i: number): number {
  const L = w.L;
  const tid = L.town[i] - 1;
  if (tid < 0) return -1;
  L.town[i] = -(tid + 1);
  const t = w.towns[tid];
  if (t) {
    t.structures = Math.max(0, t.structures - 1);
    t.lostStructures++;
    t.yearLost = (t.yearLost ?? 0) + 1;
  }
  w.counters.yearStructuresLost++;
  w.counters.totalStructuresLost++;
  w.dirty.infra++;
  return tid;
}

/** Yearly town growth, rebuilding and expansion into the forest edge. */
export function townsYearly(w: World): void {
  const L = w.L;
  const e = w.economy;
  const r = w.rng.human;
  for (const t of w.towns) {
    // rebuild part of what burned
    const burnt: number[] = [];
    for (let i = 0; i < w.N; i++) if (L.town[i] === -(t.id + 1)) burnt.push(i);
    // the town's own losses this year, measured before anything is rebuilt
    const yearLost = t.yearLost ?? 0;
    const before = t.structures + yearLost;
    for (const i of burnt) {
      // a ruin still held by a burning fire waits until that fire is out and has released it
      if (L.fire[i] !== FIRE.NONE) continue;
      if (r.next() < 0.55) {
        L.town[i] = t.id + 1;
        t.structures++;
        w.spend('Other', 0);
      }
    }
    const jobs =
      0.45 +
      (t.mill ? (e.millOpen ? 0.25 : -0.2) : 0) +
      Math.min(0.25, e.visitorsLastYear / 200000) +
      (w.policies.grazing === 'none' ? -0.03 : 0.03);
    const amen = (w.memory.scenic ?? 0.5) - 0.5;
    // people leave a town that burned this year, in proportion to its own losses (v1.0 charged any
    // town that had ever lost a home with the whole valley's losses: up to -30 % for no loss, D17)
    const lost = Math.min(0.3, (yearLost / Math.max(1, before)) * 0.5);
    const smoke = Math.min(0.03, t.smokeDays * 0.0008);
    const water = Math.min(0.02, w.counters.yearWaterShortDays * 0.0004);
    let g = 0.004 + 0.03 * (jobs - 0.5) + 0.012 * amen + 0.012 * t.growthPressure - lost - smoke - water;
    if (w.policies.growthBoundary) g *= 0.6;
    g += r.normal(0, 0.004);
    t.population = Math.max(80, Math.round(t.population * (1 + g)));
    const want = Math.ceil(t.population / 38);
    if (want > t.structures + burnt.length * 0.5) expandTown(w, t, want - t.structures);
    t.smokeDays = 0;
    t.yearLost = 0;
  }
  // mill closure after years of short supply
  if (e.millOpen && e.millStrain >= 3) {
    e.millOpen = false;
    const mt = w.towns.find((x) => x.mill);
    if (mt) mt.population = Math.round(mt.population * 0.85);
    w.memory.millClosedYear = w.year;
  }
}

function expandTown(w: World, t: Town, count: number): void {
  const L = w.L;
  const tid = t.id + 1;
  const boundaryR = 4 + Math.sqrt(t.structures + 20) * 1.1;
  // nobody builds inside a burn unit that is still waiting for its window
  const planned = new Set<number>();
  for (const pr of w.projects) if (pr.kind === 'burn' && pr.status !== 'done' && pr.status !== 'cancelled') for (const c of pr.unit) planned.add(c);
  const cands: Array<[number, number]> = [];
  for (let y = Math.max(1, t.y - 25); y < Math.min(w.H - 1, t.y + 25); y++)
    for (let x = Math.max(1, t.x - 25); x < Math.min(w.W - 1, t.x + 25); x++) {
      const i = y * w.W + x;
      if (L.town[i] || L.water[i] || L.slope[i] > 0.18 || L.flowAcc[i] > 1200 || L.zone[i] === ZONE.WILDERNESS) continue;
      if (L.fire[i] !== FIRE.NONE || planned.has(i)) continue;
      let adj = false;
      for (let d = 0; d < 8; d++) if (L.town[i + DY8[d] * w.W + DX8[d]] === tid) adj = true;
      if (!adj) continue;
      const dist = Math.hypot(x - t.x, y - t.y);
      if (w.policies.growthBoundary && dist > boundaryR) continue;
      // people like to build among the trees and near roads: the WUI grows
      const can = L.aspen[i] + L.pine[i] + L.fir[i];
      // a designated Community Buffer is kept as defensible space: new homes go elsewhere first
      const score = -dist * 0.15 + can * 1.2 + (L.infra[i] & INFRA.ROAD ? 0.8 : 0) - L.slope[i] * 6 + w.rng.human.next() * 0.6 - (L.zone[i] === ZONE.BUFFER ? 2 : 0);
      cands.push([score, i]);
    }
  cands.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < Math.min(count, cands.length, 6); k++) {
    const i = cands[k][1];
    L.town[i] = tid;
    L.zone[i] = ZONE.NONE;
    L.shrub[i] *= 0.4;
    L.fir[i] *= 0.4;
    L.litter[i] *= 0.6;
    t.structures++;
  }
  if (count > 0) {
    w.dirty.infra++;
    w.dirty.zone++;
  }
}
