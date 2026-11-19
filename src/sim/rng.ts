/**
 * Deterministic, serializable pseudo-random number generation.
 *
 * sfc32 (Small Fast Counting) generator — 128-bit state, excellent statistical
 * quality for games, and trivially serializable as four uint32 values.
 * Every simulation subsystem owns its own stream so that adding a random draw
 * in one system never perturbs another (keeps balancing + tests stable).
 */

export type RngState = [number, number, number, number];

/** cyrb128 string hash → four 32-bit seeds. */
export function hashString(str: string): RngState {
  let h1 = 1779033703,
    h2 = 3144134277,
    h3 = 1013904242,
    h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

export class Rng {
  a: number;
  b: number;
  c: number;
  d: number;

  constructor(seed: string | RngState) {
    const s = typeof seed === 'string' ? hashString(seed) : seed;
    this.a = s[0] >>> 0;
    this.b = s[1] >>> 0;
    this.c = s[2] >>> 0;
    this.d = s[3] >>> 0;
    // Warm up so that similar seeds diverge quickly.
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  static fromState(state: RngState): Rng {
    const r = Object.create(Rng.prototype) as Rng;
    r.a = state[0] >>> 0;
    r.b = state[1] >>> 0;
    r.c = state[2] >>> 0;
    r.d = state[3] >>> 0;
    return r;
  }

  getState(): RngState {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }

  nextU32(): number {
    const a = this.a,
      b = this.b,
      c = this.c,
      d = this.d;
    const t = (((a + b) | 0) + d) | 0;
    this.d = (d + 1) | 0;
    this.a = b ^ (b >>> 9);
    this.b = (c + (c << 3)) | 0;
    let cc = (c << 21) | (c >>> 11);
    cc = (cc + t) | 0;
    this.c = cc;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform float in [a, b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Uniform integer in [a, b] inclusive. */
  intRange(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Standard normal via Box–Muller. */
  normal(mean = 0, sd = 1): number {
    let u = this.next();
    if (u < 1e-12) u = 1e-12;
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Exponential with given mean. */
  exponential(mean: number): number {
    let u = this.next();
    if (u < 1e-12) u = 1e-12;
    return -Math.log(u) * mean;
  }

  /** Poisson-distributed integer (Knuth for small λ, normal approx for large). */
  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 40) return Math.max(0, Math.round(this.normal(lambda, Math.sqrt(lambda))));
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > L);
    return k - 1;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Weighted index pick; returns -1 if all weights are zero. */
  weighted(weights: ArrayLike<number>): number {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += Math.max(0, weights[i]);
    if (total <= 0) return -1;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Derive an independent child stream deterministically from this one. */
  fork(label: string): Rng {
    const h = hashString(label);
    return new Rng([
      (this.nextU32() ^ h[0]) >>> 0,
      (this.nextU32() ^ h[1]) >>> 0,
      (this.nextU32() ^ h[2]) >>> 0,
      (this.nextU32() ^ h[3]) >>> 0,
    ]);
  }
}

/** Stateless integer hash → [0,1). Used for render-stable per-cell variation. */
export function hash2(x: number, y: number, salt = 0): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(salt | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
