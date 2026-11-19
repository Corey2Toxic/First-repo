/**
 * Initial vegetation and fuels. Rather than painting biomes, we reconstruct a
 * plausible *history*: each cell gets a time-since-fire drawn from its site's
 * natural fire regime (dry pine sites burn often and gently; moist fir sites
 * rarely and severely), optionally overwritten by a century of suppression or a
 * recent megafire. Composition, ages and fuel loads then follow from that
 * history, so the starting landscape already carries the consequences of its past.
 */
import { Simplex2 } from '../noise.ts';
import type { Rng } from '../rng.ts';
import { clamp01, lerp, smoothstep } from '../grid.ts';
import { annualMeanTemp, canopyCapacity, siteWetness, suitability } from '../env.ts';
import { SP } from '../types.ts';
import type { World } from '../world.ts';

export interface BurnScar {
  x: number;
  y: number;
  rx: number;
  ry: number;
  angle: number;
}

export function initSoil(w: World, rng: Rng): void {
  const n = new Simplex2(rng);
  const L = w.L;
  for (let i = 0; i < w.N; i++) {
    const x = i % w.W,
      y = (i / w.W) | 0;
    L.soil[i] = clamp01(0.32 + 0.5 * L.twi[i] - 0.9 * L.slope[i] + 0.14 * n.fbm(x / 14, y / 14, 3));
  }
}

export function initVegetation(w: World, rng: Rng, history: 'natural' | 'suppressed' | 'burned'): BurnScar | null {
  const L = w.L;
  const nPatch = new Simplex2(rng),
    nPatch2 = new Simplex2(rng),
    nJit = new Simplex2(rng);
  const startYear = w.startYear;
  let scar: BurnScar | null = null;
  if (history === 'burned') {
    // A large recent burn in forested mid-slopes, away from the outlet town.
    let best = -1,
      bestScore = -Infinity;
    for (let k = 0; k < 300; k++) {
      const x = rng.intRange(Math.floor(w.W * 0.15), Math.floor(w.W * 0.85));
      const y = rng.intRange(Math.floor(w.H * 0.15), Math.floor(w.H * 0.85));
      const i = y * w.W + x;
      const mt = annualMeanTemp(L.elev[i]);
      const s = canopyCapacity(mt, siteWetness(w, i)) + rng.range(0, 0.3) - (L.water[i] ? 2 : 0);
      if (s > bestScore) {
        bestScore = s;
        best = i;
      }
    }
    scar = {
      x: best % w.W,
      y: (best / w.W) | 0,
      rx: w.W * rng.range(0.16, 0.22),
      ry: w.H * rng.range(0.14, 0.2),
      angle: rng.range(0, Math.PI),
    };
  }

  for (let i = 0; i < w.N; i++) {
    const x = i % w.W,
      y = (i / w.W) | 0;
    if (L.water[i]) {
      L.grass[i] = L.shrub[i] = L.aspen[i] = L.pine[i] = L.fir[i] = 0;
      continue;
    }
    const mt = annualMeanTemp(L.elev[i]);
    const wet = siteWetness(w, i);
    const cap = canopyCapacity(mt, wet) * lerp(0.75, 1, L.soil[i]);
    const sG = suitability(SP.GRASS, mt, wet),
      sS = suitability(SP.SHRUB, mt, wet),
      sA = suitability(SP.ASPEN, mt, wet),
      sP = suitability(SP.PINE, mt, wet),
      sF = suitability(SP.FIR, mt, wet);
    // propensity for frequent, low-severity fire (dry, warm, grassy pine sites)
    const frequent = clamp01(1.4 * sP - 0.9 * sF + 0.25 * (sG - 0.5) + 0.15);
    const fri = lerp(160, 10, frequent); // natural fire-return interval (years)
    const patch = clamp01(nPatch.fbm(x / 16, y / 16, 3) * 0.55 + 0.5);
    let tsf = Math.max(1, fri * lerp(0.04, 1.1, patch)); // years since any fire
    let tsfStand = frequent > 0.55 ? Math.max(tsf, 80 + 140 * patch) : tsf; // since stand-replacing fire
    let sev = frequent > 0.55 ? 1 : 3;
    if (history !== 'natural') {
      const p2 = nPatch2.fbm(x / 22, y / 22, 3) * 0.5 + 0.5;
      if (p2 < 0.12) {
        // a few patches burned within living memory
        tsf = 5 + 25 * (p2 / 0.12);
        tsfStand = frequent > 0.55 ? tsfStand : tsf;
      } else {
        const sup = 92 + 24 * nJit.noise(x / 9, y / 9);
        tsf = Math.max(tsf, sup);
        if (frequent <= 0.55) tsfStand = Math.max(tsfStand, sup * lerp(0.6, 1.4, patch));
        else tsfStand = Math.max(tsfStand, 110);
      }
    }
    let inScar = 0;
    if (scar) {
      const dx = x - scar.x,
        dy = y - scar.y;
      const ca = Math.cos(scar.angle),
        sa = Math.sin(scar.angle);
      const u = (dx * ca + dy * sa) / scar.rx,
        v = (-dx * sa + dy * ca) / scar.ry;
      const r = Math.sqrt(u * u + v * v) + 0.25 * nJit.noise(x / 6, y / 6);
      inScar = r < 1 ? smoothstep(1, 0.7, r) : 0;
    }

    // --- canopy development since stand-replacing fire ---
    let canopy = cap * (1 - Math.exp(-(tsfStand + 3) / 24));
    if (frequent > 0.4) canopy *= lerp(1, lerp(0.5, 1, smoothstep(4, 70, tsf)), smoothstep(0.4, 0.75, frequent));
    const wA = sA * (1.25 - smoothstep(45, 150, tsfStand)) * (0.7 + 0.6 * patch);
    const wP = sP * (0.55 + 0.45 * frequent);
    const wF = sF * smoothstep(12, 110, tsf) * (1 - 0.8 * frequent * (1 - smoothstep(25, 90, tsf)));
    const wsum = wA + wP + wF;
    let a = 0,
      p = 0,
      f = 0;
    if (wsum > 0.02) {
      a = (canopy * wA) / wsum;
      p = (canopy * wP) / wsum;
      f = (canopy * wF) / wsum;
    }
    const can = a + p + f;
    let grass = sG * (1 - 0.85 * can) * (0.75 + 0.25 * (1 - smoothstep(0, 60, tsf)));
    let shrub = sS * (0.25 + 0.5 * smoothstep(8, 70, tsf)) * (1 - 0.55 * can);
    if (grass + shrub > 1) {
      const k = 1 / (grass + shrub);
      grass *= k;
      shrub *= k;
    }

    L.ageA[i] = a > 0 ? Math.min(tsfStand, 85 + 40 * patch) : 0;
    L.ageP[i] = p > 0 ? (frequent > 0.55 ? 70 + 180 * patch : Math.min(tsfStand, 260)) : 0;
    L.ageF[i] = f > 0 ? Math.min(tsf, 240) * lerp(0.55, 1, patch) : 0;
    L.aroot[i] = clamp01(a > 0.03 ? 0.45 + 0.6 * a : sA > 0.55 ? 0.2 * patch : 0);
    L.litter[i] = (2 + 15 * can + 2.5 * grass) * (1 - Math.exp(-tsf / 9));
    L.dead[i] = (4 + 32 * can) * (1 - Math.exp(-tsf / 45));
    L.snag[i] = 2 * can;
    L.lastBurn[i] = tsf < 140 ? startYear - Math.round(tsf) : -999;
    L.burnSev[i] = tsf < 140 ? sev : 0;
    L.burnCount[i] = 0;

    if (inScar > 0) {
      // last summer's megafire: trees killed, snags standing, grass & aspen flush starting
      const k = inScar;
      const killed = (a + p + f) * k;
      L.snag[i] += killed * 110;
      a *= 1 - k;
      p *= 1 - 0.95 * k;
      f *= 1 - k;
      grass = lerp(grass, 0.12 + 0.2 * sG, k);
      shrub *= 1 - 0.8 * k;
      L.litter[i] *= 1 - 0.9 * k;
      L.dead[i] *= 1 - 0.5 * k;
      L.lastBurn[i] = startYear - 1;
      L.burnSev[i] = k > 0.6 ? 3 : 2;
      L.burnCount[i] = 1;
      L.fert[i] = 0.6 * k;
      L.hydro[i] = 0.55 * k;
      L.aroot[i] = clamp01(L.aroot[i] + 0.3 * sA * k);
      if (L.aroot[i] > 0.15) {
        a = Math.max(a, 0.08 * L.aroot[i]);
        L.ageA[i] = 0.5;
      }
      if (p > 0.01) L.ageP[i] = Math.max(L.ageP[i], 120);
      L.ageF[i] = f > 0 ? L.ageF[i] : 0;
    }

    L.aspen[i] = a;
    L.pine[i] = p;
    L.fir[i] = f;
    L.grass[i] = clamp01(grass);
    L.shrub[i] = clamp01(shrub);
  }
  return scar;
}

/** Spring starting conditions for snow and moisture. */
export function initMoisture(w: World): void {
  const L = w.L;
  for (let i = 0; i < w.N; i++) {
    const e = L.elev[i];
    L.snow[i] = Math.max(0, ((e - 1750) / 1000) * 380);
    L.sm[i] = clamp01(0.55 + 0.3 * L.twi[i]);
    L.fm[i] = 0.22;
    L.stress[i] = 0;
  }
}
