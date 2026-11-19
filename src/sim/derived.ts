/**
 * Derived per-cell quantities shared by the simulation, overlays and renderer.
 */
import { clamp01, smoothstep } from './grid.ts';
import type { World } from './world.ts';

/**
 * Seasonal phenology 0..1 (0 dormant/cured, 1 lush). doy 0 = first day of spring.
 * Elevation delays green-up and hastens curing.
 */
export function phenology(doy: number, elev: number): number {
  const d = doy / 360;
  const lag = (elev - 1500) / 1500 * 0.06; // high country greens later
  const up = smoothstep(0.02 + lag, 0.16 + lag, d);
  const cure = 1 - smoothstep(0.36 - lag * 0.5, 0.6, d);
  return clamp01(up * (0.25 + 0.75 * cure));
}

/** Live vegetation greenness: phenology limited by soil moisture. */
export function greenness(w: World, i: number): number {
  const L = w.L;
  const ph = phenology(w.doy, L.elev[i]);
  const moist = smoothstep(0.08, 0.5, L.sm[i]);
  return clamp01(ph * (0.25 + 0.75 * moist) + (L.pond[i] > 0.1 ? 0.3 : 0));
}

/** Blackened ground after fire, fading as vegetation recovers. */
export function charFactor(w: World, i: number): number {
  const L = w.L;
  if (L.fire[i] === 2) return 0.95;
  const yrs = w.yearF - L.lastBurn[i];
  if (yrs < 0 || yrs > 4) return 0;
  const sev = L.burnSev[i] / 3;
  return clamp01(sev * (1 - smoothstep(0, 3, yrs)) * (1 - 0.6 * L.grass[i]));
}

/** Fireweed bloom intensity on recent burns in midsummer. */
export function bloomFactor(w: World, i: number): number {
  const L = w.L;
  const yrs = w.yearF - L.lastBurn[i];
  if (yrs < 0.6 || yrs > 8 || L.burnSev[i] < 2) return 0;
  const d = w.doy / 360;
  const season = smoothstep(0.27, 0.33, d) * (1 - smoothstep(0.46, 0.53, d));
  const curve = smoothstep(0.6, 1.6, yrs) * (1 - smoothstep(3.5, 8, yrs));
  return clamp01(season * curve * (0.4 + 0.6 * L.grass[i]) * (1 - 0.8 * (L.aspen[i] + L.pine[i] + L.fir[i])));
}

export function snowCover(swe: number): number {
  return smoothstep(4, 70, swe);
}

/** Canopy cover of living trees. */
export function canopy(w: World, i: number): number {
  return w.L.aspen[i] + w.L.pine[i] + w.L.fir[i];
}
