/**
 * Human geography: town sites, the reservoir, structures, roads, stations,
 * the sawmill, lookout tower, campground, initial land-use zones, and named
 * landmarks.
 */
import type { Rng } from '../rng.ts';
import { DX8, DY8, astar, clamp01 } from '../grid.ts';
import { INFRA, ZONE } from '../types.ts';
import type { Landmark, Town } from '../types.ts';
import type { World } from '../world.ts';
import type { TerrainInfo } from './terrain.ts';
import type { NameBank } from './names.ts';

export const RIVER_ACC = 1400; // flow accumulation for a mapped river channel
export const STREAM_ACC = 55; // smallest mapped stream

/** Multi-source BFS distance (in cells, 8-neighbour Chebyshev-ish) from mask cells. */
export function distanceField(w: World, isSource: (i: number) => boolean, maxD = 255): Uint8Array {
  const { W, H, N } = w;
  const dist = new Uint8Array(N).fill(maxD);
  const q = new Int32Array(N);
  let qh = 0,
    qt = 0;
  for (let i = 0; i < N; i++)
    if (isSource(i)) {
      dist[i] = 0;
      q[qt++] = i;
    }
  while (qh < qt) {
    const c = q[qh++];
    const d = dist[c];
    if (d + 1 >= maxD) continue;
    const cx = c % W,
      cy = (c / W) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = cx + DX8[k],
        ny = cy + DY8[k];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (dist[ni] > d + 1) {
        dist[ni] = d + 1;
        q[qt++] = ni;
      }
    }
  }
  return dist;
}

export function chooseTownSites(w: World, info: TerrainInfo, rng: Rng, count: number): number[] {
  const L = w.L;
  const { W, H } = w;
  const riverDist = distanceField(w, (i) => L.flowAcc[i] >= RIVER_ACC, 60);
  const lakeDist = distanceField(w, (i) => L.water[i] !== 0, 20);
  // flatness score: fraction of gentle cells in radius 4
  const score = new Float32Array(w.N).fill(-Infinity);
  for (let y = 10; y < H - 10; y++)
    for (let x = 10; x < W - 10; x++) {
      const i = y * W + x;
      if (L.water[i] || L.slope[i] > 0.07 || L.flowAcc[i] > 400 || lakeDist[i] < 3) continue;
      if (riverDist[i] > 9) continue;
      let flat = 0,
        tot = 0;
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const j = (y + dy) * W + (x + dx);
          tot++;
          if (L.slope[j] < 0.09 && !L.water[j]) flat++;
        }
      score[i] = flat / tot - riverDist[i] * 0.015 + rng.range(0, 0.05);
    }
  // target positions along the valley (0 = head, 1 = outlet)
  const targets = count === 1 ? [0.7] : count === 2 ? [0.72, 0.38] : count === 3 ? [0.75, 0.48, 0.2] : [0.78, 0.56, 0.34, 0.14];
  const chosen: number[] = [];
  for (const t of targets) {
    const along = t + rng.range(-0.04, 0.04);
    const tx = info.flip ? Math.round((1 - along) * (W - 1)) : Math.round(along * (W - 1));
    let best = -1,
      bestS = -Infinity;
    for (let y = 10; y < H - 10; y++)
      for (let x = Math.max(10, tx - 18); x <= Math.min(W - 11, tx + 18); x++) {
        const i = y * W + x;
        if (score[i] === -Infinity) continue;
        let tooClose = false;
        for (const c of chosen) {
          const dx = (c % W) - x,
            dy = ((c / W) | 0) - y;
          if (dx * dx + dy * dy < 30 * 30) tooClose = true;
        }
        if (tooClose) continue;
        const s = score[i] - Math.abs(x - tx) * 0.01;
        if (s > bestS) {
          bestS = s;
          best = i;
        }
      }
    if (best >= 0) chosen.push(best);
  }
  return chosen;
}

/** Dam the river upstream of the main town to create the water-supply reservoir. */
export function makeReservoir(w: World, info: TerrainInfo, mainTown: number, towns: number[]): void {
  const L = w.L;
  const { W, H, N } = w;
  const mx = mainTown % W;
  const upstreamDir = info.flip ? 1 : -1; // head direction in x
  // candidate dam cells: river cells 10..32 cells upstream of the main town
  const cands: number[] = [];
  for (let i = 0; i < N; i++) {
    if (L.flowAcc[i] < RIVER_ACC || L.water[i]) continue;
    const dx = (i % W - mx) * upstreamDir;
    if (dx < 10 || dx > 34) continue;
    let ok = true;
    for (const t of towns) {
      const ddx = (t % W) - (i % W),
        ddy = ((t / W) | 0) - ((i / W) | 0);
      if (ddx * ddx + ddy * ddy < 11 * 11) ok = false;
    }
    if (ok) cands.push(i);
  }
  // upstream membership via reverse flow graph
  const children: number[][] = [];
  let bestCells: number[] = [];
  let bestDam = -1,
    bestScore = -Infinity;
  const kids = (c: number): number[] => {
    if (!children[c]) {
      const out: number[] = [];
      const cx = c % W,
        cy = (c / W) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX8[d],
          ny = cy + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (L.flowTo[ni] === c) out.push(ni);
      }
      children[c] = out;
    }
    return children[c];
  };
  for (let k = 0; k < cands.length; k += Math.max(1, Math.floor(cands.length / 40))) {
    const dam = cands[k];
    const de = L.elev[dam];
    for (const height of [8, 12, 16, 20, 26]) {
      const level = de + height;
      const cells: number[] = [];
      const stack = [dam];
      const seen = new Set<number>([dam]);
      while (stack.length && cells.length < 400) {
        const c = stack.pop()!;
        if (c !== dam) cells.push(c);
        for (const ch of kids(c)) {
          if (seen.has(ch)) continue;
          seen.add(ch);
          const ddx = (ch % W) - (dam % W),
            ddy = ((ch / W) | 0) - ((dam / W) | 0);
          if (ddx * ddx + ddy * ddy > 28 * 28) continue;
          if (L.elev[ch] < level) stack.push(ch);
        }
      }
      if (cells.length >= 45 && cells.length <= 220) {
        const s = -Math.abs(cells.length - 110) * 0.01 - height * 0.02;
        if (s > bestScore) {
          bestScore = s;
          bestDam = dam;
          bestCells = cells.map((c) => c);
          (bestCells as number[] & { level?: number }).level = level;
        }
        break;
      }
    }
  }
  if (bestDam < 0) return;
  const level = (bestCells as number[] & { level?: number }).level ?? L.elev[bestDam] + 12;
  // smooth the reservoir outline: include gentle neighbours below level
  const set = new Set(bestCells);
  for (const c of bestCells) {
    const cx = c % W,
      cy = (c / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = cx + DX8[d],
        ny = cy + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (ni !== bestDam && L.elev[ni] < level - 1 && !L.water[ni]) set.add(ni);
    }
  }
  for (const c of set) {
    L.water[c] = 3;
    L.elev[c] = level;
  }
  w.reservoirCells = Array.from(set).sort((a, b) => a - b);
  w.damCell = bestDam;
  L.infra[bestDam] |= INFRA.DAM | INFRA.ROAD;
  w.reservoirLevel = 0.8;
}

export function placeStructures(w: World, town: Town, rng: Rng, count: number): void {
  const L = w.L;
  const { W, H } = w;
  const tid = town.id + 1;
  const start = town.y * W + town.x;
  const frontier: Array<[number, number]> = [[0, start]];
  const seen = new Set<number>([start]);
  let placed = 0;
  while (frontier.length && placed < count) {
    frontier.sort((a, b) => a[0] - b[0]);
    const [, c] = frontier.shift()!;
    if (L.water[c] || L.slope[c] > 0.16 || L.town[c] || L.flowAcc[c] > RIVER_ACC) continue;
    L.town[c] = tid;
    placed++;
    const cx = c % W,
      cy = (c / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = cx + DX8[d],
        ny = cy + DY8[d];
      if (nx < 1 || ny < 1 || nx >= W - 1 || ny >= H - 1) continue;
      const ni = ny * W + nx;
      if (seen.has(ni)) continue;
      seen.add(ni);
      const dx = nx - town.x,
        dy = ny - town.y;
      const cost = Math.sqrt(dx * dx + dy * dy) + L.slope[ni] * 25 + rng.range(0, 1.6) + ((L.infra[ni] & INFRA.ROAD) ? -0.8 : 0);
      frontier.push([cost, ni]);
    }
  }
  town.structures = placed;
  // clear vegetation under structures (yards keep some grass and trees)
  for (let i = 0; i < w.N; i++) {
    if (L.town[i] !== tid) continue;
    L.pine[i] *= 0.25;
    L.fir[i] *= 0.15;
    L.aspen[i] *= 0.3;
    L.shrub[i] *= 0.3;
    L.grass[i] = Math.min(L.grass[i], 0.35);
    L.litter[i] *= 0.3;
    L.dead[i] *= 0.2;
    L.snag[i] = 0;
  }
}

export function roadCost(w: World) {
  const L = w.L;
  return (from: number, to: number, diag: boolean): number => {
    const wt = L.water[to];
    if (wt === 2 || wt === 3) return Infinity;
    const d = diag ? Math.SQRT2 : 1;
    const grade = Math.abs(L.elev[to] - L.elev[from]) / (d * 100);
    let c = d * (1 + 3 * grade + 70 * grade * grade);
    if (wt === 1 || L.flowAcc[to] >= RIVER_ACC) c += 14;
    if (L.infra[to] & INFRA.ROAD) c *= 0.45;
    if (L.town[to]) c *= 0.8;
    return c;
  };
}

export function layRoad(w: World, path: number[] | null): number {
  if (!path) return 0;
  let n = 0;
  for (const c of path) {
    if (!(w.L.infra[c] & INFRA.ROAD)) n++;
    w.L.infra[c] |= INFRA.ROAD;
  }
  return n;
}

export function buildInitialRoads(w: World, info: TerrainInfo, rng: Rng): void {
  const L = w.L;
  const { W, H } = w;
  const cost = roadCost(w);
  // Highway: from the outlet edge through every town (ordered toward the head).
  const outX = info.flip ? 0 : W - 1;
  let outY = Math.round(info.centerline[outX]);
  let bestE = Infinity;
  for (let y = Math.max(1, outY - 12); y < Math.min(H - 1, outY + 12); y++) {
    const i = y * W + outX;
    if (L.water[i] === 0 && L.elev[i] < bestE && L.flowAcc[i] < RIVER_ACC) {
      bestE = L.elev[i];
      outY = y;
    }
  }
  const outlet = outY * W + outX;
  w.outletCell = outlet;
  const ordered = [...w.towns].sort((a, b) => (info.flip ? a.x - b.x : b.x - a.x));
  let prev = outlet;
  for (const t of ordered) {
    const goal = t.y * W + t.x;
    layRoad(w, astar(W, H, prev, goal, cost, 1));
    prev = goal;
  }
  // Forest roads up side valleys from each town.
  for (const t of w.towns) {
    const nRoads = t.id === 0 ? 3 : 2;
    for (let r = 0; r < nRoads; r++) {
      let best = -1,
        bestS = -Infinity;
      for (let k = 0; k < 600; k++) {
        const ang = rng.range(0, Math.PI * 2),
          dist = rng.range(16, 38);
        const x = Math.round(t.x + Math.cos(ang) * dist),
          y = Math.round(t.y + Math.sin(ang) * dist);
        if (x < 3 || y < 3 || x >= W - 3 || y >= H - 3) continue;
        const i = y * W + x;
        if (L.water[i] || L.infra[i] & INFRA.ROAD) continue;
        const forest = L.pine[i] + L.fir[i] + L.aspen[i];
        const valleyish = L.flowAcc[i] > 40 && L.flowAcc[i] < 900 ? 0.4 : 0;
        const s = forest + valleyish - L.slope[i] * 2 + rng.range(0, 0.3);
        if (s > bestS) {
          bestS = s;
          best = i;
        }
      }
      if (best >= 0) layRoad(w, astar(W, H, t.y * W + t.x, best, cost, 1));
    }
  }
}

export function placeInfrastructure(w: World, rng: Rng, names: NameBank): void {
  const L = w.L;
  const { W, H } = w;
  const cost = roadCost(w);
  // Crew stations next to each town centre.
  for (const t of w.towns) {
    const c = t.y * W + t.x;
    let st = c;
    for (let r = 1; r < 6 && st === c; r++)
      for (let dy = -r; dy <= r && st === c; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const i = (t.y + dy) * W + (t.x + dx);
          if (L.infra[i] & INFRA.ROAD && !L.water[i]) {
            st = i;
            break;
          }
        }
    t.station = st;
    L.infra[st] |= INFRA.STATION;
  }
  // Sawmill in the second town (or the only town).
  const millTown = w.towns.length > 1 ? w.towns[1] : w.towns[0];
  millTown.mill = true;
  L.infra[millTown.station] |= INFRA.MILL;

  // Lookout tower on a commanding summit near the main town.
  const main = w.towns[0];
  let tower = -1,
    tScore = -Infinity;
  for (let y = 4; y < H - 4; y++)
    for (let x = 4; x < W - 4; x++) {
      const dx = x - main.x,
        dy = y - main.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 10 || d > 45) continue;
      const i = y * W + x;
      if (L.water[i]) continue;
      const s = L.elev[i] - d * 9 + rng.range(0, 30);
      if (s > tScore) {
        tScore = s;
        tower = i;
      }
    }
  if (tower >= 0) {
    L.infra[tower] |= INFRA.TOWER;
    w.towers.push(tower);
    layRoad(w, astar(W, H, main.station, tower, cost, 1));
  }

  // Campground at the most accessible lake shore (not the reservoir).
  const roadDist = distanceField(w, (i) => (L.infra[i] & INFRA.ROAD) !== 0, 80);
  let camp = -1,
    cScore = -Infinity;
  for (let i = 0; i < w.N; i++) {
    if (L.water[i] || L.slope[i] > 0.2) continue;
    const x = i % W,
      y = (i / W) | 0;
    let shore = false;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d],
        ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (L.water[ny * W + nx] === 2) shore = true;
    }
    if (!shore) continue;
    const s = -roadDist[i] + rng.range(0, 4);
    if (s > cScore) {
      cScore = s;
      camp = i;
    }
  }
  if (camp < 0) {
    // fall back to a river bank near the mill town
    for (let r = 4; r < 20 && camp < 0; r++)
      for (let k = 0; k < 40; k++) {
        const a = rng.range(0, Math.PI * 2);
        const x = Math.round(millTown.x + Math.cos(a) * r),
          y = Math.round(millTown.y + Math.sin(a) * r);
        if (!w.inside(x, y)) continue;
        const i = y * W + x;
        if (!L.water[i] && !L.town[i] && L.slope[i] < 0.15) {
          camp = i;
          break;
        }
      }
  }
  if (camp >= 0) {
    L.infra[camp] |= INFRA.CAMP;
    w.camps.push(camp);
    let nearestTown = w.towns[0];
    let nd = Infinity;
    for (const t of w.towns) {
      const d = Math.hypot(t.x - (camp % W), t.y - ((camp / W) | 0));
      if (d < nd) {
        nd = d;
        nearestTown = t;
      }
    }
    layRoad(w, astar(W, H, nearestTown.station, camp, cost, 1));
  }
  void names;
}

export function initialZones(w: World): void {
  const L = w.L;
  const townDist = distanceField(w, (i) => L.town[i] !== 0, 60);
  const roadDist = distanceField(w, (i) => (L.infra[i] & INFRA.ROAD) !== 0, 30);
  const campDist = distanceField(w, (i) => (L.infra[i] & INFRA.CAMP) !== 0, 30);
  for (let i = 0; i < w.N; i++) {
    if (L.water[i] || L.town[i]) continue;
    const can = L.aspen[i] + L.pine[i] + L.fir[i];
    if (campDist[i] <= 5) {
      L.zone[i] = ZONE.RECREATION;
    } else if (L.grass[i] > 0.35 && can < 0.3 && townDist[i] < 26 && L.slope[i] < 0.25) {
      L.zone[i] = ZONE.RANGE;
    } else if (L.pine[i] + L.fir[i] > 0.42 && roadDist[i] <= 5 && townDist[i] > 4 && L.elev[i] < 2650) {
      L.zone[i] = ZONE.TIMBER;
    }
  }
}

export function nameLandmarks(w: World, names: NameBank, info: TerrainInfo): void {
  const L = w.L;
  const { W, H } = w;
  const marks: Landmark[] = [];
  // Peaks: local maxima within radius 10 in the upper elevations.
  const sorted = Array.from(L.elev).sort((a, b) => a - b);
  const p70 = sorted[Math.floor(sorted.length * 0.7)];
  const peaks: Array<[number, number]> = [];
  for (let y = 3; y < H - 3; y++)
    for (let x = 3; x < W - 3; x++) {
      const i = y * W + x;
      const e = L.elev[i];
      if (e < p70) continue;
      let isMax = true;
      for (let dy = -10; dy <= 10 && isMax; dy++)
        for (let dx = -10; dx <= 10; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          if (L.elev[yy * W + xx] > e) {
            isMax = false;
            break;
          }
        }
      if (isMax) peaks.push([e, i]);
    }
  peaks.sort((a, b) => b[0] - a[0]);
  for (const [e, i] of peaks.slice(0, 12)) {
    marks.push({ kind: 'peak', name: names.peak(), x: i % W, y: (i / W) | 0, elev: e, importance: e > peaks[0][0] - 250 ? 3 : 2 });
  }
  // Lakes (connected components of water=2) and the reservoir.
  const seen = new Uint8Array(w.N);
  for (let i = 0; i < w.N; i++) {
    if (seen[i] || L.water[i] !== 2) continue;
    const comp: number[] = [];
    const st = [i];
    seen[i] = 1;
    while (st.length) {
      const c = st.pop()!;
      comp.push(c);
      const cx = c % W,
        cy = (c / W) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX8[d],
          ny = cy + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (!seen[ni] && L.water[ni] === 2) {
          seen[ni] = 1;
          st.push(ni);
        }
      }
    }
    let sx = 0,
      sy = 0;
    for (const c of comp) {
      sx += c % W;
      sy += (c / W) | 0;
    }
    marks.push({ kind: 'lake', name: names.lake(), x: sx / comp.length, y: sy / comp.length, importance: comp.length > 12 ? 2 : 1 });
  }
  if (w.reservoirCells.length) {
    let sx = 0,
      sy = 0;
    for (const c of w.reservoirCells) {
      sx += c % W;
      sy += (c / W) | 0;
    }
    marks.push({
      kind: 'lake',
      name: names.reservoir(),
      x: sx / w.reservoirCells.length,
      y: sy / w.reservoirCells.length,
      importance: 3,
    });
  }
  // Main river label near the middle of the valley.
  const midX = Math.round(W / 2);
  let ry = Math.round(info.centerline[midX]);
  let bestAcc = 0;
  for (let y = 0; y < H; y++) {
    const a = L.flowAcc[y * W + midX];
    if (a > bestAcc) {
      bestAcc = a;
      ry = y;
    }
  }
  marks.push({ kind: 'creek', name: names.river(), x: midX, y: ry, importance: 3 });
  // Tributaries: cells where a sizeable stream joins a much bigger one.
  const tribs: Array<[number, number]> = [];
  for (let i = 0; i < w.N; i++) {
    const a = L.flowAcc[i];
    if (a < 260) continue;
    const t = L.flowTo[i];
    if (t < 0) continue;
    if (L.flowAcc[t] > a * 2.2 && L.flowAcc[t] >= RIVER_ACC * 0.6) tribs.push([a, i]);
  }
  tribs.sort((a, b) => b[0] - a[0]);
  const usedPts: number[] = [];
  for (const [a, i0] of tribs) {
    if (usedPts.length >= 9) break;
    // walk upstream along the biggest contributor to find a label point
    let c = i0;
    for (let s = 0; s < 9; s++) {
      const cx = c % W,
        cy = (c / W) | 0;
      let best = -1,
        bestA = 0;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX8[d],
          ny = cy + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (L.flowTo[ni] === c && L.flowAcc[ni] > bestA) {
          bestA = L.flowAcc[ni];
          best = ni;
        }
      }
      if (best < 0 || bestA < 40) break;
      c = best;
    }
    const x = c % W,
      y = (c / W) | 0;
    if (usedPts.some((u) => Math.hypot((u % W) - x, ((u / W) | 0) - y) < 14)) continue;
    usedPts.push(c);
    marks.push({ kind: 'creek', name: names.creek(), x, y, importance: a > 800 ? 2 : 1 });
  }
  // Ridges/basins: label a few high flat benches as basins and long crests as ridges.
  for (let k = 0; k < 4; k++) {
    let best = -1,
      bs = -Infinity;
    for (let tries = 0; tries < 300; tries++) {
      const x = 6 + Math.floor(((tries * 7919 + k * 104729) % (W - 12)));
      const y = 6 + Math.floor(((tries * 6271 + k * 1299709) % (H - 12)));
      const i = y * W + x;
      if (L.water[i]) continue;
      if (marks.some((m) => Math.hypot(m.x - x, m.y - y) < 18)) continue;
      const s = L.elev[i] / 1000 - L.slope[i] * 3 + (k % 2 === 0 ? L.twi[i] : L.slope[i] * 2);
      if (s > bs) {
        bs = s;
        best = i;
      }
    }
    if (best >= 0)
      marks.push({
        kind: k % 2 === 0 ? 'basin' : 'ridge',
        name: k % 2 === 0 ? names.basin() : names.ridge(),
        x: best % W,
        y: (best / W) | 0,
        importance: 1,
      });
  }
  for (const t of w.towns) marks.push({ kind: 'town', name: t.name, x: t.x, y: t.y, importance: 3 });
  w.landmarks = marks;
}

export function clamp01Array(a: Float32Array): void {
  for (let i = 0; i < a.length; i++) a[i] = clamp01(a[i]);
}
