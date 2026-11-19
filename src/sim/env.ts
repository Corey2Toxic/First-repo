/**
 * Climate normals and species/site ecology shared by generation and dynamics.
 */
import { bump, clamp01, smoothstep } from './grid.ts';
import { SP } from './types.ts';
import type { World } from './world.ts';

export const REF_ELEV = 1500; // m, reference for weather
export const LAPSE = 0.006; // °C per m
export const MEAN_T_REF = 6.0; // annual mean temperature at REF_ELEV
export const SEASON_AMP = 11; // seasonal half-amplitude °C
export const ANNUAL_PRECIP_REF = 520; // mm/year at REF_ELEV

export function annualMeanTemp(elev: number): number {
  return MEAN_T_REF - LAPSE * (elev - REF_ELEV);
}

export function precipFactor(elev: number): number {
  return Math.max(0.6, 1 + (0.45 * (elev - REF_ELEV)) / 1000);
}

/** Static site wetness potential 0..1 (topography, elevation, aspect, soil). */
export function siteWetness(w: World, i: number): number {
  const L = w.L;
  return clamp01(
    0.3 + (0.42 * (L.elev[i] - 1400)) / 1500 + 0.45 * (L.twi[i] - 0.4) - 0.18 * L.aspectS[i] + 0.08 * (L.soil[i] - 0.5),
  );
}

/** Tree line factor: 1 below the line, 0 well above (alpine). */
export function treelineFactor(meanT: number): number {
  return smoothstep(-3.2, -1.6, meanT);
}

/** Site suitability 0..1 for each functional type given mean temp and wetness. */
export function suitability(sp: number, meanT: number, wet: number): number {
  const tl = treelineFactor(meanT);
  switch (sp) {
    case SP.GRASS:
      return clamp01(0.55 + 0.45 * bump(meanT, 6, 6) - 0.25 * smoothstep(0.75, 1, wet));
    case SP.SHRUB:
      return clamp01(0.85 * bump(wet, 0.55, 0.4) * bump(meanT, 4, 5.5) + 0.25 * smoothstep(0.75, 0.95, wet));
    case SP.ASPEN:
      return bump(wet, 0.72, 0.24) * bump(meanT, 2.6, 3.2) * tl;
    case SP.PINE:
      return bump(wet, 0.32, 0.26) * bump(meanT, 5.4, 3.1) * tl;
    case SP.FIR:
      return smoothstep(0.32, 0.66, wet) * bump(meanT, 0.6, 2.8) * tl;
  }
  return 0;
}

/** Total canopy the site can carry (dry sites only support open woodland). */
export function canopyCapacity(meanT: number, wet: number): number {
  return clamp01((0.3 + 0.75 * smoothstep(0.1, 0.65, wet)) * treelineFactor(meanT));
}
