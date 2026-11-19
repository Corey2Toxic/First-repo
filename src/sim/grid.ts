/**
 * Grid utilities: neighbourhoods, blurs, a binary heap, and small math helpers.
 */

export const DX8 = [1, 1, 0, -1, -1, -1, 0, 1] as const;
export const DY8 = [0, 1, 1, 1, 0, -1, -1, -1] as const;
export const DIST8 = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2] as const;
export const DX4 = [1, 0, -1, 0] as const;
export const DY4 = [0, 1, 0, -1] as const;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
/** Gaussian-ish bump: 1 at x=mu falling to ~0.37 at mu±sigma */
export function bump(x: number, mu: number, sigma: number): number {
  const d = (x - mu) / sigma;
  return Math.exp(-d * d);
}

/**
 * Separable box blur with clamped edges. Writes into `out` (may not alias src).
 * `tmp` is scratch of the same length.
 */
export function boxBlur(
  src: Float32Array,
  out: Float32Array,
  tmp: Float32Array,
  W: number,
  H: number,
  r: number,
): void {
  if (r <= 0) {
    out.set(src);
    return;
  }
  const inv = 1 / (2 * r + 1);
  // horizontal
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(W - 1, Math.max(0, k))];
    for (let x = 0; x < W; x++) {
      tmp[row + x] = acc * inv;
      const xa = Math.min(W - 1, x + r + 1);
      const xr = Math.max(0, x - r);
      acc += src[row + xa] - src[row + xr];
    }
  }
  // vertical
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(H - 1, Math.max(0, k)) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = acc * inv;
      const ya = Math.min(H - 1, y + r + 1);
      const yr = Math.max(0, y - r);
      acc += tmp[ya * W + x] - tmp[yr * W + x];
    }
  }
}

/** Min-heap keyed by float priority storing int payloads. */
export class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;

  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }

  private grow(): void {
    const k = new Float64Array(this.keys.length * 2);
    k.set(this.keys);
    const v = new Int32Array(this.vals.length * 2);
    v.set(this.vals);
    this.keys = k;
    this.vals = v;
  }

  push(key: number, val: number): void {
    if (this.size >= this.keys.length) this.grow();
    let i = this.size++;
    const keys = this.keys,
      vals = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      keys[i] = keys[p];
      vals[i] = vals[p];
      i = p;
    }
    keys[i] = key;
    vals[i] = val;
  }

  peekKey(): number {
    return this.keys[0];
  }

  pop(): number {
    const keys = this.keys,
      vals = this.vals;
    const top = vals[0];
    const n = --this.size;
    if (n > 0) {
      const k = keys[n],
        v = vals[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= k) break;
        keys[i] = keys[c];
        vals[i] = vals[c];
        i = c;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return top;
  }

  clear(): void {
    this.size = 0;
  }
}

/**
 * Generic grid A* over 8-neighbourhood. `cost(i, j)` returns the cost of
 * stepping from i to adjacent j (Infinity = impassable). Returns the path as
 * cell indices from start (exclusive) to goal (inclusive), or null.
 */
export function astar(
  W: number,
  H: number,
  start: number,
  goal: number,
  cost: (from: number, to: number, diag: boolean) => number,
  heuristicScale = 1,
  maxExpand = 200000,
): number[] | null {
  const N = W * H;
  // off-grid or fractional endpoints have no cell: refuse them (v1.0 looped forever rebuilding
  // the path from an index outside the arrays, growing it until the process ran out of memory)
  if (!Number.isInteger(start) || !Number.isInteger(goal) || start < 0 || goal < 0 || start >= N || goal >= N) return null;
  if (start === goal) return [];
  const g = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const heap = new MinHeap(4096);
  const gx = goal % W,
    gy = (goal / W) | 0;
  const h = (i: number) => {
    const dx = Math.abs((i % W) - gx),
      dy = Math.abs(((i / W) | 0) - gy);
    return heuristicScale * (Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy));
  };
  g[start] = 0;
  heap.push(h(start), start);
  let expanded = 0;
  while (heap.size > 0) {
    const cur = heap.pop();
    if (cur === goal) break;
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (++expanded > maxExpand) return null;
    const x = cur % W,
      y = (cur / W) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d],
        ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (closed[ni]) continue;
      const c = cost(cur, ni, (d & 1) === 1);
      if (!isFinite(c)) continue;
      const ng = g[cur] + c;
      if (ng < g[ni]) {
        g[ni] = ng;
        came[ni] = cur;
        heap.push(ng + h(ni), ni);
      }
    }
  }
  if (came[goal] === -1) return null;
  const path: number[] = [];
  let c = goal;
  for (let guard = 0; c !== start && c !== -1 && guard <= N; guard++) {
    path.push(c);
    c = came[c];
  }
  path.reverse();
  return path;
}

/** Bresenham line between two cells (inclusive). */
export function lineCells(W: number, x0: number, y0: number, x1: number, y1: number): number[] {
  const out: number[] = [];
  let dx = Math.abs(x1 - x0),
    dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1,
    sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0,
    y = y0;
  for (;;) {
    out.push(y * W + x);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/** Cells within radius r of (cx, cy). */
export function diskCells(W: number, H: number, cx: number, cy: number, r: number): number[] {
  const out: number[] = [];
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r)),
    x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)),
    y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx,
        dy = y - cy;
      if (dx * dx + dy * dy <= r2) out.push(y * W + x);
    }
  return out;
}
