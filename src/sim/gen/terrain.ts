/**
 * Terrain generation.
 *
 * The valley is grown, not painted: we run a small landscape-evolution model
 * (tectonic uplift balanced by stream-power river incision, Braun & Willett
 * 2013 implicit scheme, plus hillslope diffusion) on a half-resolution grid
 * whose only outlet is one map edge. The result is a single watershed with a
 * trunk river and properly dendritic tributaries. It is then upsampled,
 * detailed with noise, and the trunk is widened into a glacial U-shaped floor
 * where towns can sit. Elevations are metres; cells are 100 m.
 */
import { Simplex2 } from '../noise.ts';
import type { Rng } from '../rng.ts';
import { DX8, DY8, DIST8, MinHeap, smoothstep, lerp } from '../grid.ts';
import type { World } from '../world.ts';

export interface TerrainInfo {
  flip: boolean; // true = outlet on the west edge
  outletElev: number;
  headElev: number;
  centerline: Float32Array; // y (cells) of valley centre for each x
}

export function generateTerrain(w: World, rng: Rng): TerrainInfo {
  const W = w.W,
    H = w.H;
  const nA = new Simplex2(rng),
    nB = new Simplex2(rng),
    nC = new Simplex2(rng),
    nD = new Simplex2(rng);
  const flip = rng.chance(0.5);
  const freq = rng.range(0.5, 1.15);
  const phase = rng.range(0, Math.PI * 2);
  const amp = rng.range(0.04, 0.1);
  const outletElev = 1180 + rng.range(-60, 60);
  const topElev = 3250 + rng.range(-150, 180);
  const aspect = W / H;

  const centerline = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const u = x / (W - 1);
    centerline[x] = (0.5 + amp * Math.sin(Math.PI * 2 * freq * u + phase) + 0.05 * nA.fbm(u * 2.2, 3.1, 3)) * H;
  }

  // ---------- 1. landscape evolution on a half-resolution grid ----------
  const W2 = Math.ceil(W / 2),
    H2 = Math.ceil(H / 2),
    N2 = W2 * H2;
  const U = new Float32Array(N2);
  const h = new Float32Array(N2);
  for (let y = 0; y < H2; y++) {
    const v = y / (H2 - 1);
    for (let x = 0; x < W2; x++) {
      const u = x / (W2 - 1);
      const along = flip ? 1 - u : u; // 0 = head, 1 = outlet
      const yc = centerline[Math.min(W - 1, x * 2)] / H;
      const d = Math.abs(v - yc);
      const cross = smoothstep(0.015, 0.36, d);
      const qx = u * aspect * 2 + 0.4 * nB.fbm(u * 2.5, v * 2.5, 3);
      const qy = v * 2 + 0.4 * nB.fbm(u * 2.5 + 4.1, v * 2.5 + 9.7, 3);
      const n1 = nC.fbm(qx * 1.4, qy * 1.4, 4) * 0.5 + 0.5;
      const n2 = nD.ridged(qx * 2.2, qy * 2.2, 4);
      const head = smoothstep(0.22, 0.0, along);
      U[y * W2 + x] = 0.12 + (0.25 + 1.6 * cross + 0.9 * head) * (0.45 + 0.8 * n1 + 0.35 * n2);
      h[y * W2 + x] = U[y * W2 + x] * 2 + rng.range(0, 0.05);
    }
  }
  const outletX2 = flip ? 0 : W2 - 1;
  const outletY2 = Math.round(centerline[flip ? 0 : W - 1] / 2);
  const isOutlet = new Uint8Array(N2);
  for (let dy = -1; dy <= 1; dy++) {
    const y = Math.min(H2 - 1, Math.max(0, outletY2 + dy));
    isOutlet[y * W2 + outletX2] = 1;
  }
  evolve(h, U, isOutlet, W2, H2, 140);

  // normalise
  let hmax = 0;
  for (let i = 0; i < N2; i++) hmax = Math.max(hmax, h[i]);
  for (let i = 0; i < N2; i++) h[i] /= hmax;

  // ---------- 2. upsample (Catmull-Rom) and convert to metres ----------
  const elev = w.L.elev;
  const at = (x: number, y: number) => h[Math.min(H2 - 1, Math.max(0, y)) * W2 + Math.min(W2 - 1, Math.max(0, x))];
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number) =>
    p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  for (let y = 0; y < H; y++) {
    const sy = y / 2 - 0.25;
    const y0 = Math.floor(sy),
      ty = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = x / 2 - 0.25;
      const x0 = Math.floor(sx),
        tx = sx - x0;
      const r = [0, 0, 0, 0];
      for (let k = -1; k <= 2; k++) r[k + 1] = cr(at(x0 - 1, y0 + k), at(x0, y0 + k), at(x0 + 1, y0 + k), at(x0 + 2, y0 + k), tx);
      const v = Math.max(0, cr(r[0], r[1], r[2], r[3], ty));
      // gentle non-linearity: broad valleys, steeper upper slopes
      const shaped = Math.pow(v, 0.78);
      const u = x / (W - 1),
        vv = y / (H - 1);
      const detail = nA.fbm(u * aspect * 14, vv * 14, 4) * (4 + 90 * shaped * shaped);
      elev[y * W + x] = outletElev + shaped * (topElev - outletElev) + detail;
    }
  }

  // ---------- 3. glacial U-shaped trunk valley floor ----------
  widenTrunk(w, flip);

  // ---------- 4. alpine tarns in high cirques ----------
  const sorted = Array.from(elev).sort((a, b) => a - b);
  const p82 = sorted[Math.floor(sorted.length * 0.82)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const tarnCount = rng.intRange(2, 4);
  let made = 0;
  const tarnSites: number[] = [];
  for (let tries = 0; tries < 800 && made < tarnCount; tries++) {
    const x = rng.intRange(12, W - 13),
      y = rng.intRange(10, H - 11);
    const c = y * W + x;
    const e = elev[c];
    if (e < p82 || e > p95) continue;
    if (tarnSites.some((t) => Math.hypot((t % W) - x, ((t / W) | 0) - y) < 25)) continue;
    const r = rng.range(2.2, 3.4);
    const depth = rng.range(8, 16);
    const lip = r + 1.6;
    for (let dy = -6; dy <= 6; dy++)
      for (let dx = -6; dx <= 6; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > lip) continue;
        const i = (y + dy) * W + (x + dx);
        const d = dist / r;
        if (d <= 1) elev[i] = Math.min(elev[i], e - depth * (1 - d * d * 0.6));
        else elev[i] = Math.max(elev[i], e + 2.5 + (lip - dist)); // terminal moraine
      }
    tarnSites.push(c);
    made++;
  }

  // Carve the outlet so the trunk river leaves the map cleanly.
  const outletX = flip ? 0 : W - 1;
  let oy = Math.round(centerline[outletX]);
  let lowest = Infinity;
  for (let y = Math.max(2, oy - 8); y < Math.min(H - 2, oy + 8); y++) {
    const e = elev[y * W + (flip ? 2 : W - 3)];
    if (e < lowest) {
      lowest = e;
      oy = y;
    }
  }
  for (let k = 0; k < 4; k++) {
    const x = flip ? k : W - 1 - k;
    for (let dy = -2; dy <= 2; dy++) {
      const y = Math.min(H - 1, Math.max(0, oy + dy));
      const i = y * W + x;
      elev[i] = Math.min(elev[i], lowest - 3 - (3 - k) + Math.abs(dy) * 2);
    }
  }

  let headElev = 0;
  const hx = flip ? W - 12 : 11;
  headElev = elev[Math.round(centerline[hx]) * W + hx];
  return { flip, outletElev, headElev, centerline };
}

/**
 * Stream-power landscape evolution: dh/dt = U - K A^m S, solved implicitly in
 * receiver order each iteration, with linear hillslope diffusion. Boundary
 * cells that are not outlets are closed (no flow leaves the map there).
 */
function evolve(h: Float32Array, U: Float32Array, isOutlet: Uint8Array, W: number, H: number, iters: number): void {
  const N = W * H;
  const K = 0.06,
    m = 0.5,
    dt = 1,
    D = 0.04;
  const fill = new Float32Array(N);
  const closed = new Uint8Array(N);
  const order = new Int32Array(N);
  const rec = new Int32Array(N);
  const recD = new Float32Array(N);
  const A = new Float32Array(N);
  const lap = new Float32Array(N);
  const heap = new MinHeap(N);
  for (let it = 0; it < iters; it++) {
    // priority flood from outlets → depressionless surface + topological order
    fill.set(h);
    closed.fill(0);
    heap.clear();
    let n = 0;
    for (let i = 0; i < N; i++)
      if (isOutlet[i]) {
        closed[i] = 1;
        h[i] = 0;
        fill[i] = 0;
        heap.push(0, i);
      }
    while (heap.size > 0) {
      const c = heap.pop();
      order[n++] = c;
      const cx = c % W,
        cy = (c / W) | 0;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX8[d],
          ny = cy + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (closed[ni]) continue;
        closed[ni] = 1;
        if (fill[ni] <= fill[c]) fill[ni] = fill[c] + 1e-6;
        heap.push(fill[ni], ni);
      }
    }
    // steepest-descent receivers on the filled surface
    for (let k = 0; k < n; k++) {
      const i = order[k];
      if (isOutlet[i]) {
        rec[i] = -1;
        continue;
      }
      const cx = i % W,
        cy = (i / W) | 0;
      let best = -1,
        bestS = -Infinity,
        bestD = 1;
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX8[d],
          ny = cy + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        const s = (fill[i] - fill[ni]) / DIST8[d];
        if (s > bestS) {
          bestS = s;
          best = ni;
          bestD = DIST8[d];
        }
      }
      rec[i] = best;
      recD[i] = bestD;
    }
    // drainage area
    A.fill(1);
    for (let k = n - 1; k >= 0; k--) {
      const i = order[k];
      const r = rec[i];
      if (r >= 0) A[r] += A[i];
    }
    // implicit stream-power incision with uplift
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const r = rec[i];
      if (r < 0) continue;
      const f = (K * dt * Math.pow(A[i], m)) / recD[i];
      const hr = h[r];
      let hi = h[i] + U[i] * dt;
      hi = (hi + f * hr) / (1 + f);
      h[i] = Math.max(hi, hr + 1e-6);
    }
    // hillslope diffusion
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const l = x > 0 ? h[i - 1] : h[i],
          r = x < W - 1 ? h[i + 1] : h[i];
        const u = y > 0 ? h[i - W] : h[i],
          dd = y < H - 1 ? h[i + W] : h[i];
        lap[i] = l + r + u + dd - 4 * h[i];
      }
    for (let i = 0; i < N; i++) if (!isOutlet[i]) h[i] += D * lap[i];
  }
}

/** Flatten the floor around the trunk river into a U-shaped valley. */
function widenTrunk(w: World, flip: boolean): void {
  const { W, H, N } = w;
  const elev = w.L.elev;
  // quick D8 accumulation on the raw surface (pits ignored; only for locating the trunk)
  const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => elev[b] - elev[a]);
  const acc = new Float32Array(N).fill(1);
  for (const i of order) {
    const cx = i % W,
      cy = (i / W) | 0;
    let best = -1,
      bs = 0;
    for (let d = 0; d < 8; d++) {
      const nx = cx + DX8[d],
        ny = cy + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      const s = (elev[i] - elev[ni]) / DIST8[d];
      if (s > bs) {
        bs = s;
        best = ni;
      }
    }
    if (best >= 0) acc[best] += acc[i];
  }
  const trunkT = N * 0.012;
  // BFS from trunk cells carrying the trunk elevation
  const dist = new Float32Array(N).fill(1e9);
  const base = new Float32Array(N);
  const q: number[] = [];
  for (let i = 0; i < N; i++)
    if (acc[i] >= trunkT) {
      dist[i] = 0;
      base[i] = elev[i];
      q.push(i);
    }
  let qh = 0;
  while (qh < q.length) {
    const c = q[qh++];
    const cx = c % W,
      cy = (c / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = cx + DX8[d],
        ny = cy + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      const nd = dist[c] + DIST8[d];
      if (nd < dist[ni] && nd < 26) {
        dist[ni] = nd;
        base[ni] = base[c];
        q.push(ni);
      }
    }
  }
  for (let i = 0; i < N; i++) {
    if (dist[i] > 25) continue;
    const u = (i % W) / (W - 1);
    const along = flip ? 1 - u : u;
    const floorHalf = lerp(3, 9, along) * (0.6 + 0.4 * Math.min(1, acc[i] / trunkT));
    const t = smoothstep(floorHalf * 0.5, floorHalf * 2.6, dist[i]);
    const floorE = base[i] + dist[i] * 0.8;
    elev[i] = lerp(Math.min(elev[i], floorE), elev[i], t);
  }
}
