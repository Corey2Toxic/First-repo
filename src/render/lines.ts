/**
 * High-resolution distance fields for linear features (streams and roads).
 * D8 flow paths and A* road paths are smoothed, then rasterised as capsule
 * distances into a 4x texture so the shader can draw crisp anti-aliased lines
 * of physically sensible width at any zoom.
 */
import type { World } from '../sim/world.ts';
import { hash2 } from '../sim/rng.ts';
import { DX8, DY8 } from '../sim/grid.ts';

export const LINE_SCALE = 4;
export const MAX_DIST = 1.5; // cells encoded in the distance channel
export const MAX_HW = 0.4; // max half-width encoded

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  hw: number;
}

/**
 * Rasterise segments into an "offset to closest point" field: each texel
 * stores the vector from its centre to the nearest point on any segment
 * (RG, signed) and that segment's half-width (B). Unlike a distance field this
 * is affine near a straight line, so bilinear filtering reconstructs it exactly
 * and lines thinner than a texel still render continuously.
 */
function rasterise(segs: Seg[], W: number, H: number, out: Uint8Array): void {
  const S = LINE_SCALE;
  const TW = W * S,
    TH = H * S;
  const best = new Float32Array(TW * TH).fill(Infinity);
  const vx = new Float32Array(TW * TH).fill(MAX_DIST);
  const vy = new Float32Array(TW * TH).fill(MAX_DIST);
  const width = new Float32Array(TW * TH);
  for (const s of segs) {
    const x0 = Math.max(0, Math.floor((Math.min(s.ax, s.bx) - MAX_DIST) * S));
    const x1 = Math.min(TW - 1, Math.ceil((Math.max(s.ax, s.bx) + MAX_DIST) * S));
    const y0 = Math.max(0, Math.floor((Math.min(s.ay, s.by) - MAX_DIST) * S));
    const y1 = Math.min(TH - 1, Math.ceil((Math.max(s.ay, s.by) + MAX_DIST) * S));
    const dx = s.bx - s.ax,
      dy = s.by - s.ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    for (let ty = y0; ty <= y1; ty++) {
      const py = (ty + 0.5) / S;
      for (let tx = x0; tx <= x1; tx++) {
        const px = (tx + 0.5) / S;
        let t = ((px - s.ax) * dx + (py - s.ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = s.ax + t * dx - px,
          qy = s.ay + t * dy - py;
        const d = Math.sqrt(qx * qx + qy * qy);
        if (d > MAX_DIST) continue;
        const k = ty * TW + tx;
        const score = d - s.hw;
        if (score < best[k]) {
          best[k] = score;
          vx[k] = qx;
          vy[k] = qy;
          width[k] = s.hw;
        }
      }
    }
  }
  for (let k = 0; k < TW * TH; k++) {
    out[k * 4] = Math.round((vx[k] / MAX_DIST) * 127.5 + 127.5);
    out[k * 4 + 1] = Math.round((vy[k] / MAX_DIST) * 127.5 + 127.5);
    out[k * 4 + 2] = Math.round(Math.min(1, width[k] / MAX_HW) * 255);
    out[k * 4 + 3] = 255;
  }
}

/** Smoothed node position for a cell along a linear network. */
function node(i: number, W: number, up: number, down: number, salt: number): [number, number] {
  const cx = (i % W) + 0.5 + (hash2(i % W, (i / W) | 0, salt) - 0.5) * 0.36;
  const cy = ((i / W) | 0) + 0.5 + (hash2((i / W) | 0, i % W, salt + 7) - 0.5) * 0.36;
  let sx = cx * 2,
    sy = cy * 2,
    n = 2;
  if (up >= 0) {
    sx += (up % W) + 0.5;
    sy += ((up / W) | 0) + 0.5;
    n++;
  }
  if (down >= 0) {
    sx += (down % W) + 0.5;
    sy += ((down / W) | 0) + 0.5;
    n++;
  }
  return [sx / n, sy / n];
}

export const STREAM_T = 110;

export function buildStreamSegments(w: World): Seg[] {
  const L = w.L;
  const { W, H, N } = w;
  let maxAcc = 1;
  for (let i = 0; i < N; i++) maxAcc = Math.max(maxAcc, L.flowAcc[i]);
  const logMax = Math.log(maxAcc / STREAM_T);
  // main upstream contributor for each stream cell
  const mainUp = new Int32Array(N).fill(-1);
  const upAcc = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = L.flowTo[i];
    if (t < 0 || L.flowAcc[i] < STREAM_T) continue;
    if (L.flowAcc[i] > upAcc[t]) {
      upAcc[t] = L.flowAcc[i];
      mainUp[t] = i;
    }
  }
  const pos = new Map<number, [number, number]>();
  const P = (i: number) => {
    let p = pos.get(i);
    if (!p) {
      p = node(i, W, mainUp[i], L.flowTo[i], 11);
      pos.set(i, p);
    }
    return p;
  };
  const segs: Seg[] = [];
  for (let i = 0; i < N; i++) {
    const a = L.flowAcc[i];
    if (a < STREAM_T) continue;
    const t = L.flowTo[i];
    const [ax, ay] = P(i);
    let bx: number, by: number;
    if (t >= 0) [bx, by] = P(t);
    else {
      // run off the map edge
      const x = i % W,
        y = (i / W) | 0;
      bx = x === 0 ? -0.5 : x === W - 1 ? W + 0.5 : x + 0.5;
      by = y === 0 ? -0.5 : y === H - 1 ? H + 0.5 : y + 0.5;
    }
    const k = Math.min(1, Math.log(a / STREAM_T) / logMax);
    segs.push({ ax, ay, bx, by, hw: 0.035 + 0.25 * Math.pow(k, 1.3) });
  }
  return segs;
}

export function buildRoadSegments(w: World): Seg[] {
  const segs: Seg[] = [];
  const W = w.W;
  for (const path of w.roads) {
    if (path.length < 2) continue;
    // Chaikin-smoothed polyline through cell centres (with tiny jitter)
    let pts: Array<[number, number]> = path.map((c) => [(c % W) + 0.5, ((c / W) | 0) + 0.5]);
    for (let it = 0; it < 2; it++) {
      const np: Array<[number, number]> = [pts[0]];
      for (let k = 0; k < pts.length - 1; k++) {
        const [x0, y0] = pts[k],
          [x1, y1] = pts[k + 1];
        np.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25]);
        np.push([x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
      }
      np.push(pts[pts.length - 1]);
      pts = np;
    }
    for (let k = 0; k < pts.length - 1; k++)
      segs.push({ ax: pts[k][0], ay: pts[k][1], bx: pts[k + 1][0], by: pts[k + 1][1], hw: 0.075 });
  }
  return segs;
}

/** Road cells not covered by any recorded path (e.g. legacy saves) get short links. */
export function orphanRoadSegments(w: World, isRoad: (i: number) => boolean): Seg[] {
  const covered = new Uint8Array(w.N);
  for (const p of w.roads) for (const c of p) covered[c] = 1;
  const segs: Seg[] = [];
  for (let i = 0; i < w.N; i++) {
    if (!isRoad(i) || covered[i]) continue;
    const x = i % w.W,
      y = (i / w.W) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = x + DX8[d],
        ny = y + DY8[d];
      if (!w.inside(nx, ny)) continue;
      if (isRoad(ny * w.W + nx)) segs.push({ ax: x + 0.5, ay: y + 0.5, bx: nx + 0.5, by: ny + 0.5, hw: 0.075 });
    }
  }
  return segs;
}

export function buildRiverTexture(w: World): Uint8Array {
  const out = new Uint8Array(w.W * LINE_SCALE * w.H * LINE_SCALE * 4);
  rasterise(buildStreamSegments(w), w.W, w.H, out);
  return out;
}

export function buildRoadTexture(w: World, isRoad: (i: number) => boolean, out?: Uint8Array): Uint8Array {
  const o = out ?? new Uint8Array(w.W * LINE_SCALE * w.H * LINE_SCALE * 4);
  rasterise([...buildRoadSegments(w), ...orphanRoadSegments(w, isRoad)], w.W, w.H, o);
  return o;
}
