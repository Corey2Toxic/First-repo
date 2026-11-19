/**
 * Initial wildlife: deer herds on spring range, wolf packs in remote country,
 * beaver colonies on gentle wooded streams.
 */
import type { Rng } from '../rng.ts';
import type { World } from '../world.ts';
import type { NameBank } from './names.ts';
import { distanceField } from './settle.ts';

export function beaverSiteScore(w: World, i: number): number {
  const L = w.L;
  const acc = L.flowAcc[i];
  if (L.water[i] || acc < 70 || acc > 1300 || L.slope[i] > 0.07 || L.town[i]) return 0;
  const x = i % w.W,
    y = (i / w.W) | 0;
  let food = 0;
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const xx = x + dx,
        yy = y + dy;
      if (!w.inside(xx, yy)) continue;
      const j = yy * w.W + xx;
      food += L.aspen[j] * 1.4 + L.shrub[j] * 0.8;
    }
  return food / 49;
}

export function initWildlife(w: World, rng: Rng, names: NameBank): void {
  const L = w.L;
  const townDist = distanceField(w, (i) => L.town[i] !== 0, 80);
  const cfg = w.config;
  // Deer herds
  let tries = 0;
  while (w.herds.length < cfg.herds && tries++ < 5000) {
    const i = rng.int(w.N);
    if (L.water[i] || townDist[i] < 6) continue;
    const forage = L.grass[i] + L.shrub[i] * 0.8 + L.aspen[i] * 0.5;
    if (forage < 0.45 || L.elev[i] > 2500 || L.slope[i] > 0.4) continue;
    const x = (i % w.W) + 0.5,
      y = ((i / w.W) | 0) + 0.5;
    w.herds.push({ id: w.nextId(), x, y, px: x, py: y, n: rng.intRange(26, 48), cond: rng.range(0.6, 0.8), fed: 1 });
  }
  // Wolf packs in remote terrain
  tries = 0;
  while (w.packs.length < cfg.wolves && tries++ < 5000) {
    const i = rng.int(w.N);
    if (L.water[i] || townDist[i] < 32 || L.elev[i] > 2700) continue;
    const x = (i % w.W) + 0.5,
      y = ((i / w.W) | 0) + 0.5;
    if (w.packs.some((p) => Math.hypot(p.tx - x, p.ty - y) < 38)) continue;
    w.packs.push({
      id: w.nextId(),
      name: names.packName(),
      x,
      y,
      px: x,
      py: y,
      n: rng.intRange(3, 5),
      tx: x,
      ty: y,
      hunger: 0.3,
      targetHerd: -1,
      kills: 0,
      founded: 0,
    });
  }
  // Beaver colonies
  const cands: Array<[number, number]> = [];
  for (let i = 0; i < w.N; i++) {
    if (townDist[i] < 7) continue;
    const s = beaverSiteScore(w, i);
    if (s > 0.18) cands.push([s + rng.range(0, 0.15), i]);
  }
  cands.sort((a, b) => b[0] - a[0]);
  for (const [, i] of cands) {
    if (w.colonies.length >= cfg.beavers) break;
    const x = i % w.W,
      y = (i / w.W) | 0;
    if (w.colonies.some((c) => Math.hypot((c.cell % w.W) - x, ((c.cell / w.W) | 0) - y) < 14)) continue;
    w.colonies.push({ id: w.nextId(), cell: i, n: rng.intRange(3, 6), food: 0.6, dam: 0.5, years: rng.intRange(1, 6), active: true, abandonedDay: -1 });
  }
}
