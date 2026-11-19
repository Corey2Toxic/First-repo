/**
 * Bark beetles. An endemic population lives in every pine stand; it erupts
 * when many big pines are drought-stressed and crowded, and when winters are
 * too mild to kill overwintering larvae. Killed pines hold red needles for a
 * couple of years (extremely flammable), then drop them and stand as grey
 * snags that eventually fall into heavy surface fuel. Thinning restores tree
 * vigour; cold winters and fire knock populations back.
 */
import { boxBlur, clamp01, smoothstep } from '../grid.ts';
import type { World } from '../world.ts';

export interface BeetleHooks {
  onOutbreak?: (cells: number, x: number, y: number) => void;
}

let blurA: Float32Array | null = null;
let blurT: Float32Array | null = null;

/** Monthly during the summer flight season. */
export function beetlesMonthly(w: World, hooks: BeetleHooks = {}): void {
  const m = w.month;
  if (m < 3 || m > 6) return;
  const L = w.L;
  const N = w.N;
  const r = w.rng.veg;
  if (!blurA || blurA.length !== N) {
    blurA = new Float32Array(N);
    blurT = new Float32Array(N);
  }
  boxBlur(L.beetle, blurA, blurT!, w.W, w.H, 2);
  let infested = 0,
    sx = 0,
    sy = 0;
  const warm = smoothstep(-0.5, 2.5, w.climate.yearTemp);
  for (let i = 0; i < N; i++) {
    const p = L.pine[i];
    if (p < 0.02) {
      L.beetle[i] *= 0.5;
      continue;
    }
    const crowd = smoothstep(0.35, 0.75, L.pine[i] + L.fir[i]);
    const susc = p * smoothstep(35, 90, L.ageP[i]) * (0.25 + 0.75 * L.stress[i]) * (0.6 + 0.4 * crowd) * (0.8 + 0.4 * warm);
    let b = L.beetle[i];
    // growth toward what the stand can support, plus immigration from neighbours
    b += 1.6 * b * (susc - b) + 0.35 * Math.max(0, blurA[i] - b) * susc * 2;
    if (r.next() < 0.002) b += 0.02 * susc; // endemic background
    b = clamp01(b);
    L.beetle[i] = b;
    // mass attack overwhelms tree defences when stressed
    const resistance = 0.3 * (1 - 0.7 * L.stress[i]);
    const kill = p * Math.max(0, b - resistance) * 0.35;
    if (kill > 0.0005) {
      L.pine[i] -= kill;
      L.red[i] = Math.min(1, L.red[i] + kill * 1.1);
      L.snag[i] += kill * 240 * Math.min(1, 0.15 + L.ageP[i] / 90);
    }
    if (b > 0.3) {
      infested++;
      sx += i % w.W;
      sy += (i / w.W) | 0;
    }
  }
  w.dirty.veg++;
  if (infested > 150 && hooks.onOutbreak) hooks.onOutbreak(infested, sx / infested, sy / infested);
}

/** Start of year: the coldest nights of winter decide how many larvae survive. */
export function beetleWinterKill(w: World): void {
  const t = w.climate.winterMin;
  const surv = t < -30 ? 0.12 : t < -24 ? 0.35 : t < -18 ? 0.6 : 0.85;
  const L = w.L;
  for (let i = 0; i < w.N; i++) L.beetle[i] *= surv;
  w.climate.winterMin = 0;
}

export function beetleSummary(w: World): number {
  let n = 0;
  for (let i = 0; i < w.N; i++) if (w.L.beetle[i] > 0.3) n++;
  return n;
}
