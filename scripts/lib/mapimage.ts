/**
 * CPU map colouring for headless dumps (a simplified version of the shader).
 */
import type { World } from '../../src/sim/world.ts';
import { INFRA } from '../../src/sim/types.ts';

export function mapImage(w: World, mode: 'natural' | 'zones' | 'fuel' | 'age' = 'natural'): Uint8Array {
  const L = w.L;
  const out = new Uint8Array(w.N * 4);
  for (let i = 0; i < w.N; i++) {
    let r = 0, g = 0, b = 0;
    const shade = 0.45 + 0.75 * L.shade[i];
    if (mode === 'natural') {
      // soil / rock base
      const e = L.elev[i];
      r = 150; g = 135; b = 105;
      if (e > 2900) { r = 160; g = 158; b = 152; }
      const gr = L.grass[i], sh = L.shrub[i], a = L.aspen[i], p = L.pine[i], f = L.fir[i];
      const mix = (cr: number, cg: number, cb: number, k: number) => { r += (cr - r) * k; g += (cg - g) * k; b += (cb - b) * k; };
      mix(170, 165, 90, Math.min(1, gr));
      mix(110, 120, 70, Math.min(1, sh));
      mix(120, 170, 70, Math.min(1, a));
      mix(55, 95, 60, Math.min(1, p * 1.1));
      mix(30, 70, 60, Math.min(1, f * 1.1));
      if (L.snow[i] > 20 && (globalThis as any).SHOW_SNOW) mix(240, 244, 250, Math.min(1, L.snow[i] / 150));
      const yrs = w.yearF - L.lastBurn[i];
      if (yrs < 3 && L.burnSev[i] >= 2) mix(40, 35, 32, 0.7 * (1 - yrs / 3));
      r *= shade; g *= shade; b *= shade;
      if (L.flowAcc[i] > 120) { const k = Math.min(1, Math.log(L.flowAcc[i] / 120) / 4); r = r * (1 - k) + 60 * k; g = g * (1 - k) + 120 * k; b = b * (1 - k) + 170 * k; }
      if (L.water[i]) { r = 50; g = 100; b = 150; }
      if (L.fire[i] === 1) { r = 255; g = 120; b = 20; }
      if (L.town[i]) { r = 200; g = 80; b = 70; }
      if (L.infra[i] & INFRA.ROAD) { r = 225; g = 205; b = 160; }
      if (L.infra[i] & (INFRA.TOWER | INFRA.CAMP | INFRA.STATION | INFRA.DAM)) { r = 255; g = 255; b = 0; }
    } else if (mode === 'zones') {
      const cols = [[120,120,120],[60,140,80],[80,160,220],[200,150,60],[210,200,90],[220,90,90]];
      const c = cols[L.zone[i]];
      r = c[0] * shade; g = c[1] * shade; b = c[2] * shade;
      if (L.water[i]) { r = 40; g = 70; b = 120; }
    } else if (mode === 'fuel') {
      const fuel = Math.min(1, (L.litter[i] + L.dead[i] * 0.3 + L.snag[i] * 0.2) / 30);
      r = 255 * fuel; g = 200 * (1 - fuel); b = 40;
      if (L.water[i]) { r = 40; g = 70; b = 120; }
    } else {
      const age = Math.max(L.ageP[i] * (L.pine[i] > 0.05 ? 1 : 0), L.ageF[i] * (L.fir[i] > 0.05 ? 1 : 0), L.ageA[i] * (L.aspen[i] > 0.05 ? 1 : 0));
      const k = Math.min(1, age / 250);
      r = 255 * (1 - k); g = 230 * k + 30; b = 80;
      if (L.water[i]) { r = 40; g = 70; b = 120; }
    }
    out[i * 4] = Math.max(0, Math.min(255, r));
    out[i * 4 + 1] = Math.max(0, Math.min(255, g));
    out[i * 4 + 2] = Math.max(0, Math.min(255, b));
    out[i * 4 + 3] = 255;
  }
  return out;
}
