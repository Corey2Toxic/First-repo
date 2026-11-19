/**
 * Towns: smoke exposure, fire threat, firewise readiness, yearly growth into
 * the forest edge (the wildland–urban interface), rebuilding, and the mill.
 */
import { DX8, DY8, clamp01 } from '../grid.ts';
import { FIRE, INFRA, ZONE } from '../types.ts';
import type { Town } from '../types.ts';
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

/** Fraction of the town's surroundings with low fuel hazard (treated or naturally light). */
function surroundingsSafety(w: World, t: Town): number {
  const L = w.L;
  const tid = t.id + 1;
  let n = 0,
    safe = 0;
  const r = 5 + Math.sqrt(t.structures) * 0.8;
  for (let y = Math.max(0, Math.floor(t.y - r - 5)); y <= Math.min(w.H - 1, Math.ceil(t.y + r + 5)); y++)
    for (let x = Math.max(0, Math.floor(t.x - r - 5)); x <= Math.min(w.W - 1, Math.ceil(t.x + r + 5)); x++) {
      const i = y * w.W + x;
      if (L.town[i] || L.water[i]) continue;
      // within 4 cells of a structure of this town?
      let near = false;
      for (let d = 0; d < 8 && !near; d++)
        for (let k = 1; k <= 4; k++) {
          const xx = x + DX8[d] * k,
            yy = y + DY8[d] * k;
          if (w.inside(xx, yy) && L.town[yy * w.W + xx] === tid) {
            near = true;
            break;
          }
        }
      if (!near) continue;
      n++;
      const treated = w.yearF - L.lastTreat[i] < 8 || w.yearF - L.lastBurn[i] < 6;
      if (treated || hazardIndex(w, i) < 0.28) safe++;
    }
  return n ? safe / n : 0.5;
}

export function updateFirewise(w: World): void {
  const code = w.policies.buildingCode === 'firewise' ? 1 : 0;
  for (const t of w.towns) {
    const s = surroundingsSafety(w, t);
    t.firewise = clamp01(0.1 + 0.32 * code + 0.5 * s);
  }
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
    for (const i of burnt) {
      if (r.next() < 0.55) {
        // never rebuild on a cell a live fire still holds; clear any stale fire state so the
        // new house can burn again (a BURNT cell is skipped by every spread path)
        if (L.fire[i] === FIRE.BURNING) continue;
        L.fire[i] = FIRE.NONE;
        L.fid[i] = -1;
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
    const lost = t.lostStructures > 0 ? Math.min(0.3, (w.counters.yearStructuresLost / Math.max(1, t.structures)) * 0.5) : 0;
    const smoke = Math.min(0.03, t.smokeDays * 0.0008);
    const water = Math.min(0.02, w.counters.yearWaterShortDays * 0.0004);
    let g = 0.004 + 0.03 * (jobs - 0.5) + 0.012 * amen + 0.012 * t.growthPressure - lost - smoke - water;
    if (w.policies.growthBoundary) g *= 0.6;
    g += r.normal(0, 0.004);
    t.population = Math.max(80, Math.round(t.population * (1 + g)));
    const want = Math.ceil(t.population / 38);
    if (want > t.structures + burnt.length * 0.5) expandTown(w, t, want - t.structures);
    t.smokeDays = 0;
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
      const score = -dist * 0.15 + can * 1.2 + (L.infra[i] & INFRA.ROAD ? 0.8 : 0) - L.slope[i] * 6 + w.rng.human.next() * 0.6;
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
