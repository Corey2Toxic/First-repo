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
import { LAPSE, REF_ELEV } from '../env.ts';

export interface BeetleHooks {
  onOutbreak?: (cells: number, x: number, y: number) => void;
}

let blurA: Float32Array | null = null;
let blurT: Float32Array | null = null;

/*
 * v1.1: an eruptive model. v1.0 let beetle pressure rise only toward a "susceptibility" that was a
 * product of five factors below one, fed by within-season drought stress that reset every winter and
 * with no endemic population at the start, so outbreak-scale infestation (>= 150 ha) happened in 5
 * of ~2,550 audited run-years, never in warming, crowded Tinderbox pine. Now (after Raffa et al. 2008):
 *  - an endemic population lives in every stand of big pine (seeded at generation and on load);
 *  - tree resistance falls with multi-year drought (L.dstress, a ~2-year memory) and crowding;
 *  - when local beetle pressure (the cell plus its neighbourhood) overwhelms resistance, the
 *    population erupts toward the stand's capacity and mass attacks kill pine, which ends the
 *    outbreak by using up its host;
 *  - winter kill depends on each cell's own coldest night (valley minimum lapsed by elevation).
 */
function host(w: World, i: number): number {
  const L = w.L;
  const crowd = smoothstep(0.35, 0.75, L.pine[i] + L.fir[i]);
  return L.pine[i] * smoothstep(60, 110, L.ageP[i]) * (0.5 + 0.5 * crowd);
}

/** Seed the endemic population (generation, and v1.0 saves, which have none). */
export function seedBeetles(w: World): void {
  for (let i = 0; i < w.N; i++) w.L.beetle[i] = Math.max(w.L.beetle[i], 0.01 * host(w, i));
}

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
  boxBlur(L.beetle, blurA, blurT!, w.W, w.H, 3);
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
    const H = host(w, i);
    const crowd = smoothstep(0.35, 0.75, p + L.fir[i]);
    // tree defences: vigorous, uncrowded pine resists; years of drought and crowding wear it down
    // (drought memory runs ~0.02–0.05 in ordinary years and 0.08–0.16 through multi-year droughts)
    const resist = 0.03 + 0.1 * (1 - smoothstep(0.02, 0.12, L.dstress[i])) * (1 - 0.35 * crowd) * (1.15 - 0.3 * warm);
    let b = L.beetle[i];
    const pressure = b + 0.6 * blurA[i];
    const erupt = H > 0.02 ? smoothstep(0.7, 1.3, pressure / resist) : 0;
    const K = H * (0.06 + 0.94 * erupt);
    // growth toward the stand's capacity (endemic below the threshold, epidemic above it), plus
    // beetles arriving from erupting neighbours
    b += 1.2 * b * (K - b) / Math.max(0.05, K) * 0.5 + 0.25 * Math.max(0, blurA[i] - b) * erupt;
    if (r.next() < 0.002) b += 0.01 * H; // background arrivals
    b = clamp01(Math.min(b, Math.max(K, 0.01 * H)));
    L.beetle[i] = b;
    // mass attack: an erupting population kills pine, turning crowns red and then into snags
    const kill = p * Math.min(0.3, 0.45 * erupt * (b / Math.max(0.02, H)) * smoothstep(0.02, 0.1, b));
    if (kill > 0.0005) {
      L.pine[i] -= kill;
      L.red[i] = Math.min(1, L.red[i] + kill * 1.1);
      L.snag[i] += kill * 240 * Math.min(1, 0.15 + L.ageP[i] / 90);
    }
    if (kill > 0.002) {
      infested++;
      sx += i % w.W;
      sy += (i / w.W) | 0;
    }
  }
  w.dirty.veg++;
  w.memory.beetleInfested = Math.max(w.memory.beetleInfested ?? 0, infested);
  if (infested > 150 && hooks.onOutbreak) hooks.onOutbreak(infested, sx / infested, sy / infested);
}

/** Start of year: each cell's coldest night decides how many larvae survive. */
export function beetleWinterKill(w: World): void {
  const valleyMin = w.climate.winterMin;
  const L = w.L;
  for (let i = 0; i < w.N; i++) {
    if (L.beetle[i] <= 0) continue;
    const t = valleyMin - LAPSE * (L.elev[i] - REF_ELEV);
    // larvae survive mild winters; nights near -30 C kill half, -40 C nearly all
    const surv = 0.05 + 0.9 * smoothstep(-40, -24, t);
    L.beetle[i] *= surv;
  }
  w.climate.winterMin = 0;
}

export function beetleSummary(w: World): number {
  let n = 0;
  // epidemic cells (the endemic population sits near 1 % of the host)
  for (let i = 0; i < w.N; i++) if (w.L.beetle[i] > 0.05) n++;
  return n;
}
