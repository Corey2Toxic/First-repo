/**
 * Fuel model: translates the vegetation and dead-biomass state of a cell into
 * the quantities fire behaviour depends on.
 */
import { clamp01, smoothstep } from '../grid.ts';
import { greenness } from '../derived.ts';
import type { World } from '../world.ts';

export interface CellFuel {
  fine: number; // t/ha of fine dead/cured fuel that carries surface fire
  grassShare: number; // fraction of fine fuel that is cured grass
  ladder: number; // 0..1 vertical continuity from surface to crowns
  canopy: number; // 0..1 crown fuel
  heavy: number; // t/ha coarse fuel (residence time, smoke)
  green: number; // live greenness 0..1
}

export function cellFuel(w: World, i: number, out?: CellFuel): CellFuel {
  const L = w.L;
  const g = greenness(w, i);
  // a burn leaves no cured grass to carry fire until the next season's crop has grown and cured
  // (v1.0 hid this behind a rate that collapsed at low fuel load)
  const since = w.yearF - L.lastBurn[i];
  const regrown = since >= 0 && since < 1 ? smoothstep(0.35, 0.95, since) : 1;
  const grassFuel = L.grass[i] * 2.6 * (1 - 0.8 * g) * (1 - 0.6 * L.graze[i]) * regrown;
  const shrubFine = L.shrub[i] * 2.4 * (1 - 0.45 * g);
  const fine = L.litter[i] + grassFuel + shrubFine + L.red[i] * 10 + L.slash[i] * 0.45;
  const youngFir = 1 - smoothstep(25, 90, L.ageF[i]);
  const youngPine = 1 - smoothstep(12, 50, L.ageP[i]);
  const ladder = clamp01(
    L.shrub[i] * 0.55 + L.fir[i] * (0.3 + 0.7 * youngFir) * 0.9 + L.pine[i] * youngPine * 0.55 + L.slash[i] / 40 + L.snag[i] / 220,
  );
  const canopy = clamp01(L.pine[i] * 0.72 + L.fir[i] * 1.0 + L.aspen[i] * 0.1 + L.red[i] * 1.3);
  const heavy = L.dead[i] + L.snag[i] * 0.3 + L.slash[i];
  const o = out ?? { fine: 0, grassShare: 0, ladder: 0, canopy: 0, heavy: 0, green: 0 };
  o.fine = fine;
  o.grassShare = fine > 0 ? grassFuel / fine : 0;
  o.ladder = ladder;
  o.canopy = canopy;
  o.heavy = heavy;
  o.green = g;
  return o;
}

/** A compact 0..1 hazard index for overlays and scoring (potential fire severity). */
export function hazardIndex(w: World, i: number): number {
  if (w.L.water[i]) return 0;
  const f = cellFuel(w, i);
  const surface = smoothstep(2, 22, f.fine);
  const crown = f.canopy * smoothstep(0.1, 0.7, f.ladder);
  // wet hollows and stream banks rarely carry fire, whatever grows there
  const wet = 1 - 0.6 * smoothstep(0.55, 0.9, w.L.twi[i]) - (w.L.pond[i] > 0.05 ? 0.4 : 0);
  return clamp01((0.55 * surface + 0.45 * crown * (0.4 + 0.6 * surface)) * wet);
}
