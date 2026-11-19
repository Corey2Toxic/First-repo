/**
 * Smoke: a scalar field advected downwind (semi-Lagrangian), diffused and
 * dispersed. Calm, cold days trap smoke in the valley bottom (inversions).
 */
import type { World } from '../world.ts';

let scratch: Float32Array | null = null;

export function smokeSubstep(w: World): void {
  const L = w.L;
  const { W, H, N } = w;
  if (!scratch || scratch.length !== N) scratch = new Float32Array(N);
  const out = scratch;
  const wx = w.weather;
  const disp = 0.55 * wx.windSpeed;
  const ux = Math.cos(wx.windDir) * disp,
    uy = Math.sin(wx.windDir) * disp;
  const sm = L.smoke;
  let any = false;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = x - ux,
        sy = y - uy;
      let v = 0;
      if (sx >= 0 && sy >= 0 && sx < W - 1 && sy < H - 1) {
        const ix = sx | 0,
          iy = sy | 0;
        const fx = sx - ix,
          fy = sy - iy;
        const k = iy * W + ix;
        v = sm[k] * (1 - fx) * (1 - fy) + sm[k + 1] * fx * (1 - fy) + sm[k + W] * (1 - fx) * fy + sm[k + W + 1] * fx * fy;
      }
      out[y * W + x] = v;
    }
  }
  // diffusion + dispersion; low dispersion holds smoke in low ground
  const base = 0.05 + 0.22 * wx.dispersion;
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const blur = (out[i - 1] + out[i + 1] + out[i - W] + out[i + W]) * 0.25;
      let v = out[i] * 0.8 + blur * 0.2;
      const trap = wx.dispersion < 0.4 ? Math.max(0, 1 - (L.elev[i] - 1200) / 900) * (0.4 - wx.dispersion) : 0;
      v *= 1 - Math.max(0.02, base - trap * 0.5);
      if (v < 0.002) v = 0;
      else any = true;
      sm[i] = v;
    }
  }
  for (let x = 0; x < W; x++) {
    sm[x] = 0;
    sm[(H - 1) * W + x] = 0;
  }
  for (let y = 0; y < H; y++) {
    sm[y * W] = 0;
    sm[y * W + W - 1] = 0;
  }
  w.smokePresent = any;
  w.dirty.smoke++;
}
