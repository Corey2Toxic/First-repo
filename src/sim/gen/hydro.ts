/**
 * Hydrological conditioning: priority-flood depression filling (Barnes 2014,
 * with epsilon so flats drain), lake detection, D8 flow directions,
 * flow accumulation, slope/aspect, wetness index and hillshade.
 */
import { DX8, DY8, DIST8, MinHeap, clamp01 } from '../grid.ts';
import type { World } from '../world.ts';

export const CELL_M = 100; // metres per cell

export interface HydroInfo {
  /** Cells sorted from highest to lowest (upstream → downstream) */
  order: Int32Array;
}

export function conditionHydrology(w: World): HydroInfo {
  const { W, H, N } = w;
  const elev = w.L.elev;
  const fill = new Float32Array(elev);
  const closed = new Uint8Array(N);
  const heap = new MinHeap(N);
  const EPS = 0.002;
  // seed with all edge cells
  for (let x = 0; x < W; x++) {
    for (const y of [0, H - 1]) {
      const i = y * W + x;
      if (!closed[i]) {
        closed[i] = 1;
        heap.push(fill[i], i);
      }
    }
  }
  for (let y = 1; y < H - 1; y++) {
    for (const x of [0, W - 1]) {
      const i = y * W + x;
      if (!closed[i]) {
        closed[i] = 1;
        heap.push(fill[i], i);
      }
    }
  }
  while (heap.size > 0) {
    const c = heap.pop();
    const cx = c % W,
      cy = (c / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = cx + DX8[d],
        ny = cy + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (closed[ni]) continue;
      closed[ni] = 1;
      if (fill[ni] <= fill[c]) fill[ni] = fill[c] + EPS;
      heap.push(fill[ni], ni);
    }
  }

  // D8 flow directions on the conditioned (filled) surface.
  const flowTo = w.L.flowTo;
  for (let i = 0; i < N; i++) {
    const cx = i % W,
      cy = (i / W) | 0;
    if (cx === 0 || cy === 0 || cx === W - 1 || cy === H - 1) {
      flowTo[i] = -1;
      continue;
    }
    let best = -1,
      bestS = 0;
    for (let d = 0; d < 8; d++) {
      const ni = (cy + DY8[d]) * W + (cx + DX8[d]);
      const s = (fill[i] - fill[ni]) / DIST8[d];
      if (s > bestS) {
        bestS = s;
        best = ni;
      }
    }
    flowTo[i] = best;
  }

  // Order cells from high to low for accumulation and routing.
  const idx = new Int32Array(N);
  for (let i = 0; i < N; i++) idx[i] = i;
  const sortedIdx = Array.from(idx).sort((a, b) => fill[b] - fill[a]);
  const order = Int32Array.from(sortedIdx);
  const acc = w.L.flowAcc;
  acc.fill(1);
  for (let k = 0; k < N; k++) {
    const i = order[k];
    const t = flowTo[i];
    if (t >= 0) acc[t] += acc[i];
  }

  // Lakes: connected filled basins deeper than 3 m with area >= 5 cells,
  // away from the map edge, and not merely pools on a large river.
  const water = w.L.water;
  const seen = new Uint8Array(N);
  const stack: number[] = [];
  for (let i = 0; i < N; i++) {
    if (seen[i] || fill[i] - elev[i] < 3) continue;
    const comp: number[] = [];
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      const cx = c % W,
        cy = (c / W) | 0;
      for (let d = 0; d < 8; d += 2) {
        const nx = cx + DX8[d],
          ny = cy + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (seen[ni] || fill[ni] - elev[ni] < 0.5) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
    let reject = false;
    for (const c of comp) {
      const cx = c % W,
        cy = (c / W) | 0;
      if (cx < 5 || cy < 5 || cx >= W - 5 || cy >= H - 5) reject = true;
      if (acc[c] >= 700) reject = true;
    }
    if (comp.length >= 5 && !reject) for (const c of comp) water[c] = 2;
  }
  // Flatten all filled areas to their spill level (lake surfaces are flat).
  for (let i = 0; i < N; i++) if (fill[i] > elev[i]) elev[i] = fill[i];

  computeSlopeAspectShade(w);

  // Topographic wetness index, normalised by percentiles.
  const twi = w.L.twi;
  const tmp = new Float32Array(N);
  for (let i = 0; i < N; i++) tmp[i] = Math.log((acc[i] * CELL_M) / (Math.max(0.005, w.L.slope[i]) * CELL_M));
  const s = Array.from(tmp).sort((a, b) => a - b);
  const lo = s[Math.floor(N * 0.02)],
    hi = s[Math.floor(N * 0.98)];
  for (let i = 0; i < N; i++) twi[i] = clamp01((tmp[i] - lo) / (hi - lo));

  return { order };
}

export function computeSlopeAspectShade(w: World): void {
  const { W, H } = w;
  const elev = w.L.elev;
  const slope = w.L.slope,
    aspectS = w.L.aspectS,
    shade = w.L.shade;
  // Light from the north-west (map -x, -y), 40° above the horizon.
  const alt = (40 * Math.PI) / 180;
  const lx = -Math.SQRT1_2 * Math.cos(alt),
    ly = -Math.SQRT1_2 * Math.cos(alt),
    lz = Math.sin(alt);
  const exaggeration = 2.2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const xl = Math.max(0, x - 1),
        xr = Math.min(W - 1, x + 1);
      const yu = Math.max(0, y - 1),
        yd = Math.min(H - 1, y + 1);
      const dzdx = (elev[y * W + xr] - elev[y * W + xl]) / ((xr - xl) * CELL_M);
      const dzdy = (elev[yd * W + x] - elev[yu * W + x]) / ((yd - yu) * CELL_M);
      const s = Math.sqrt(dzdx * dzdx + dzdy * dzdy);
      slope[i] = s;
      // downhill direction (-grad); "south" is +y on the map
      aspectS[i] = s > 1e-6 ? (-dzdy / s) * Math.min(1, s * 6) : 0;
      // surface normal with vertical exaggeration
      let nx = -dzdx * exaggeration,
        ny = -dzdy * exaggeration,
        nz = 1;
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const d = nx * lx + ny * ly + nz * lz;
      shade[i] = clamp01(d);
    }
  }
}

/** Cells that are part of the channel network (for rendering/beavers/roads). */
export function isStreamCell(w: World, i: number, threshold = 60): boolean {
  return w.L.flowAcc[i] >= threshold;
}
