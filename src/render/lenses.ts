/**
 * Map lenses: thematic overlays computed on the CPU into an RGBA texture,
 * each with a legend the UI can display.
 */
import { clamp01, smoothstep } from '../sim/grid.ts';
import { hazardIndex } from '../sim/systems/fuels.ts';
import type { World } from '../sim/world.ts';
import type { Fireshed } from '../sim/projection.ts';

export type LensId = 'none' | 'hazard' | 'behaviour' | 'fireshed' | 'veg' | 'age' | 'moisture' | 'wildlife' | 'zones' | 'history' | 'beetles' | 'water';

export interface LensInfo {
  id: LensId;
  name: string;
  key: string;
  description: string;
  legend: Array<[string, string]>; // [css colour, label]
  dynamic: boolean; // changes day to day
  /** needs the towns' firesheds (projection.ts computeFireshed) */
  fireshed?: boolean;
}

export const LENSES: LensInfo[] = [
  { id: 'none', name: 'Landscape', key: '`', description: 'The valley as it looks.', legend: [], dynamic: false },
  {
    id: 'hazard',
    name: 'Fuel hazard',
    key: '1',
    description: 'How severely each stand would burn: surface fuel load, ladder fuels and crown fuel. Where crown fires will start.',
    legend: [
      ['#3f8f56', 'Low'],
      ['#d8c24a', 'Moderate'],
      ['#e0782f', 'High'],
      ['#a01d2a', 'Extreme'],
    ],
    dynamic: true,
  },
  {
    id: 'behaviour',
    name: 'Bad-day fire',
    key: '0',
    description: 'What fire would do in each stand on a bad day (late summer, drought, a strong dry wind), by what could be done about it. Thinning and burning move ground down this scale.',
    legend: [
      ['#4f9a5d', 'Hand crews can work it (flames under 1.2 m)'],
      ['#d9c64c', 'Engines only (under 2.4 m)'],
      ['#e58a2e', 'Aircraft only (longer flames)'],
      ['#a01d2a', 'Torching and crown fire'],
    ],
    dynamic: false,
    fireshed: true,
  },
  {
    id: 'fireshed',
    name: 'Fireshed',
    key: '-',
    description: 'How long a fire starting here on a bad day would need to reach homes. The ground that threatens the towns, and where work protects them.',
    legend: [
      ['#8e1b2c', 'Under 3 hours'],
      ['#d1492e', '3–6 hours'],
      ['#e8922e', '6–12 hours (one burning period)'],
      ['#e8cf5a', '12–24 hours'],
      ['#b9c7a0', '1–1.5 days'],
    ],
    dynamic: false,
    fireshed: true,
  },
  {
    id: 'moisture',
    name: 'Fuel moisture',
    key: '4',
    description: 'Dead fine-fuel moisture today. Below ~8% fires run; above ~20% they barely creep.',
    legend: [
      ['#b3261e', '< 6%'],
      ['#e58f3c', '8%'],
      ['#e8d679', '12%'],
      ['#7ab4c9', '18%'],
      ['#2f5f9a', '> 25%'],
    ],
    dynamic: true,
  },
  {
    id: 'history',
    name: 'Fire history',
    key: '7',
    description: 'Years since each hectare last burned, and how severely. Long-unburned dry forest is a warning.',
    legend: [
      ['#ff4fa3', '< 3 years'],
      ['#e9a0d8', '3–15 years'],
      ['#b4a8d8', '15–50 years'],
      ['#6f6a8a', '50–100 years'],
      ['#3b2b2b', '100+ / never'],
    ],
    dynamic: false,
  },
  {
    id: 'veg',
    name: 'Vegetation',
    key: '2',
    description: 'The dominant plant community in each hectare.',
    legend: [
      ['#c8b46a', 'Grass & forbs'],
      ['#8a8d45', 'Shrubs / willow'],
      ['#a6d65c', 'Aspen'],
      ['#3f7a44', 'Pine'],
      ['#1f4f47', 'Fir & spruce'],
      ['#9a9a9a', 'Rock / barren'],
    ],
    dynamic: true,
  },
  {
    id: 'age',
    name: 'Forest age',
    key: '3',
    description: 'Age of the oldest trees. Old growth (150+ years) is rare, slow to replace, and loved by conservationists.',
    legend: [
      ['#e8e3a0', 'Young (<40)'],
      ['#7fbf7b', 'Mature (40–150)'],
      ['#5b3f8c', 'Old growth (150+)'],
    ],
    dynamic: false,
  },
  {
    id: 'wildlife',
    name: 'Wildlife',
    key: '5',
    description: 'Where deer browse (orange) and where wolves make them wary (violet). Herds, packs and beaver colonies are marked.',
    legend: [
      ['#e98a2f', 'Browse pressure'],
      ['#7b5cd6', 'Wolf presence (fear)'],
      ['#4fb0c6', 'Beaver ponds'],
    ],
    dynamic: true,
  },
  {
    id: 'zones',
    name: 'Land use',
    key: '6',
    description: 'Management zones you have designated.',
    legend: [
      ['#5abf73', 'Wilderness'],
      ['#59b3f2', 'Recreation'],
      ['#f2a640', 'Timber'],
      ['#ebe066', 'Rangeland'],
      ['#f26666', 'Community buffer'],
    ],
    dynamic: false,
  },
  {
    id: 'beetles',
    name: 'Bark beetles',
    key: '8',
    description: 'Beetle pressure in pine stands, and the red-needle trees they have killed.',
    legend: [
      ['#f0d070', 'Endemic'],
      ['#e07030', 'Outbreak'],
      ['#9c3a1e', 'Red-phase kill'],
    ],
    dynamic: true,
  },
  {
    id: 'water',
    name: 'Watershed',
    key: '9',
    description: 'Soil moisture, and where hillsides are shedding sediment toward the reservoir.',
    legend: [
      ['#d8b878', 'Dry soil'],
      ['#5aa0c8', 'Moist soil'],
      ['#7b4a22', 'Eroding'],
    ],
    dynamic: true,
  },
];

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function ramp(stops: Array<[number, string]>, t: number): [number, number, number] {
  if (t <= stops[0][0]) return hex(stops[0][1]);
  for (let k = 1; k < stops.length; k++) {
    if (t <= stops[k][0]) {
      const [t0, c0] = stops[k - 1];
      const [t1, c1] = stops[k];
      const u = (t - t0) / (t1 - t0);
      const a = hex(c0),
        b = hex(c1);
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
    }
  }
  return hex(stops[stops.length - 1][1]);
}

const HAZ: Array<[number, string]> = [
  [0, '#3f8f56'],
  [0.35, '#d8c24a'],
  [0.6, '#e0782f'],
  [0.85, '#a01d2a'],
];
const FM: Array<[number, string]> = [
  [0.04, '#b3261e'],
  [0.08, '#e58f3c'],
  [0.12, '#e8d679'],
  [0.18, '#7ab4c9'],
  [0.26, '#2f5f9a'],
];

const BEHAVIOUR = ['#000000', '#4f9a5d', '#d9c64c', '#e58a2e', '#a01d2a'].map(hex);
const SHED: Array<[number, [number, number, number]]> = [
  [3, hex('#8e1b2c')],
  [6, hex('#d1492e')],
  [12, hex('#e8922e')],
  [24, hex('#e8cf5a')],
  [36, hex('#b9c7a0')],
];

/** Fill `out` (RGBA, w.N*4) for the lens. `shed`: the towns' firesheds, for the lenses that show them. */
export function computeLens(w: World, lens: LensId, out: Uint8Array, shed?: Fireshed): void {
  const L = w.L;
  out.fill(0);
  if (lens === 'none' || lens === 'zones') return;
  if (lens === 'behaviour' || lens === 'fireshed') {
    if (!shed) return;
    for (let i = 0; i < w.N; i++) {
      if (L.water[i] >= 2 || L.town[i] !== 0) continue;
      const o = i * 4;
      if (lens === 'behaviour') {
        const b = shed.behaviour[i];
        if (!b) continue;
        const c = BEHAVIOUR[b];
        out[o] = c[0];
        out[o + 1] = c[1];
        out[o + 2] = c[2];
        out[o + 3] = 190;
      } else {
        const h = shed.hours[i];
        if (!(h <= 36)) continue;
        let c = SHED[SHED.length - 1][1];
        for (const [lim, col] of SHED)
          if (h <= lim) {
            c = col;
            break;
          }
        out[o] = c[0];
        out[o + 1] = c[1];
        out[o + 2] = c[2];
        out[o + 3] = h <= 12 ? 205 : 170;
      }
    }
    return;
  }
  const vegCols = ['#c8b46a', '#8a8d45', '#a6d65c', '#3f7a44', '#1f4f47'].map(hex);
  for (let i = 0; i < w.N; i++) {
    const o = i * 4;
    if (L.water[i] >= 2) continue;
    let r = 0,
      g = 0,
      b = 0,
      a = 0;
    switch (lens) {
      case 'hazard': {
        const h = hazardIndex(w, i);
        [r, g, b] = ramp(HAZ, h);
        a = 0.78;
        break;
      }
      case 'veg': {
        const v = [L.grass[i] * 0.7, L.shrub[i] * 0.9, L.aspen[i] * 1.3, L.pine[i], L.fir[i]];
        let k = 0;
        for (let s = 1; s < 5; s++) if (v[s] > v[k]) k = s;
        const tot = v[0] + v[1] + v[2] + v[3] + v[4];
        if (tot < 0.15) {
          [r, g, b] = [154, 154, 154];
          a = 0.7;
        } else {
          [r, g, b] = vegCols[k];
          a = 0.82;
        }
        break;
      }
      case 'age': {
        const can = L.aspen[i] + L.pine[i] + L.fir[i];
        if (can < 0.12) break;
        const age = Math.max(L.pine[i] > 0.05 ? L.ageP[i] : 0, L.fir[i] > 0.05 ? L.ageF[i] : 0, L.aspen[i] > 0.05 ? L.ageA[i] : 0);
        [r, g, b] = ramp(
          [
            [0, '#f2eeb4'],
            [40, '#9fd08a'],
            [110, '#4f9a6a'],
            [150, '#6a4ea0'],
            [300, '#3d2470'],
          ],
          age,
        );
        a = 0.5 + 0.35 * clamp01(can * 1.5);
        break;
      }
      case 'moisture': {
        [r, g, b] = ramp(FM, L.fm[i]);
        a = 0.72;
        break;
      }
      case 'wildlife': {
        const br = L.browse[i],
          fe = L.fear[i];
        const pond = L.pond[i];
        r = 233 * br + 123 * fe;
        g = 138 * br + 92 * fe;
        b = 47 * br + 214 * fe;
        a = clamp01(br * 1.4 + fe * 1.2) * 0.8;
        if (pond > 0.1) {
          [r, g, b] = [79, 176, 198];
          a = 0.9;
        }
        if (a > 0) {
          const s = br + fe + 1e-6;
          r /= Math.max(1, s);
          g /= Math.max(1, s);
          b /= Math.max(1, s);
        }
        break;
      }
      case 'history': {
        const yrs = w.yearF - L.lastBurn[i];
        if (L.lastBurn[i] < -900) {
          [r, g, b] = [59, 43, 43];
          a = 0.55;
          break;
        }
        [r, g, b] = ramp(
          [
            [0, '#ff4fa3'],
            [3, '#ff4fa3'],
            [15, '#e9a0d8'],
            [50, '#b4a8d8'],
            [100, '#6f6a8a'],
            [140, '#3b2b2b'],
          ],
          yrs,
        );
        a = 0.62 + (L.burnSev[i] === 3 && yrs < 15 ? 0.25 : 0);
        break;
      }
      case 'beetles': {
        const bt = L.beetle[i];
        if (L.red[i] > 0.05) {
          [r, g, b] = [156, 58, 30];
          a = clamp01(0.4 + L.red[i]);
        } else if (bt > 0.02 && L.pine[i] > 0.05) {
          [r, g, b] = ramp(
            [
              [0, '#f0d070'],
              [0.3, '#e07030'],
              [0.7, '#b03018'],
            ],
            bt,
          );
          a = 0.35 + 0.5 * clamp01(bt * 2);
        }
        break;
      }
      case 'water': {
        const sm = L.sm[i];
        [r, g, b] = ramp(
          [
            [0.05, '#d8b878'],
            [0.35, '#b9c49a'],
            [0.7, '#5aa0c8'],
          ],
          sm,
        );
        a = 0.6;
        const sed = L.sediment[i];
        if (sed > 0.002) {
          const k = smoothstep(0.002, 0.08, sed);
          r = r * (1 - k) + 123 * k;
          g = g * (1 - k) + 74 * k;
          b = b * (1 - k) + 34 * k;
          a = Math.max(a, 0.6 + 0.3 * k);
        }
        break;
      }
    }
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a * 255;
  }
}
