/**
 * Shared loader for the v2 development harnesses. Every harness runs against a source tree chosen
 * with FW_ROOT (default: this repository), so the same measurement can be made on FIREWEED 1.1.1
 * and on the current code:
 *
 *   node scripts/v2/regime.ts tinderbox seed-a 25
 *   FW_ROOT=/path/to/fireweed-1.1.1 node scripts/v2/regime.ts tinderbox seed-a 25
 */
import { fileURLToPath } from 'node:url';

export const ROOT = (process.env.FW_ROOT ?? fileURLToPath(new URL('../..', import.meta.url))).replace(/\/$/, '');

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Sim {
  generateWorld: (cfg: any) => any;
  makeConfig: (scenario: string, seed: string, size?: string, overrides?: any) => any;
  Simulation: new (w: any, hooks?: any, opts?: any) => any;
  autoCloseReview: (w: any, accept?: boolean) => void;
  World: new (cfg: any) => any;
  fire: any;
  fuels: any;
  climate: any;
  moisture: any;
  types: any;
  rng: any;
  /** true when the tree has the v2 fire core (flame lengths, spread progress) */
  v2: boolean;
}

export async function loadSim(root: string = ROOT): Promise<Sim> {
  const m = (p: string) => import(root + '/src/sim/' + p);
  const [gen, scen, sim, world, fire, fuels, climate, moisture, types, rng] = await Promise.all([
    m('gen/index.ts'),
    m('scenarios.ts'),
    m('sim.ts'),
    m('world.ts'),
    m('systems/fire.ts'),
    m('systems/fuels.ts'),
    m('systems/climate.ts'),
    m('systems/moisture.ts'),
    m('types.ts'),
    m('rng.ts'),
  ]);
  return {
    generateWorld: gen.generateWorld,
    makeConfig: scen.makeConfig,
    Simulation: sim.Simulation,
    autoCloseReview: sim.autoCloseReview,
    World: world.World,
    fire,
    fuels,
    climate,
    moisture,
    types,
    rng,
    v2: typeof fire.frontBehaviour === 'function',
  };
}

/** A flat, uniform test valley: one fuel bed everywhere, midsummer afternoon. */
export interface Bed {
  name: string;
  grass?: number;
  shrub?: number;
  pine?: number;
  fir?: number;
  aspen?: number;
  litter?: number;
  dead?: number;
  ageP?: number;
  ageF?: number;
  /** understory of saplings and pole thickets, 0..1 (v2 trees only) */
  under?: number;
  /** published behaviour of the nearest standard fuel model, for the table */
  ref?: string;
}

export function flatValley(S: Sim, bed: Bed, o: { w?: number; h?: number; fm?: number; wind?: number; drought?: number; sub?: number } = {}): any {
  const cfg = { ...S.makeConfig('custom', 'lab'), width: o.w ?? 220, height: o.h ?? 121 };
  const w = new S.World(cfg);
  const L = w.L;
  for (let i = 0; i < w.N; i++) {
    L.elev[i] = 1500;
    L.flowAcc[i] = 1;
    L.flowTo[i] = -1;
    L.soil[i] = 0.6;
    L.sm[i] = 0.2;
    L.grass[i] = bed.grass ?? 0.05;
    L.shrub[i] = bed.shrub ?? 0.03;
    L.pine[i] = bed.pine ?? 0;
    L.fir[i] = bed.fir ?? 0;
    L.aspen[i] = bed.aspen ?? 0;
    L.ageP[i] = bed.ageP ?? 100;
    L.ageF[i] = bed.ageF ?? 100;
    L.ageA[i] = 60;
    L.litter[i] = bed.litter ?? 1;
    L.dead[i] = bed.dead ?? 2;
    L.fm[i] = o.fm ?? 0.06;
    if (L.under) L.under[i] = bed.under ?? 0;
  }
  w.day = 150; // late summer: grass cured
  w.sub = o.sub ?? 4;
  w.weather.windSpeed = o.wind ?? 6;
  w.weather.windDir = 0; // toward +x
  w.weather.rh = 0.2;
  w.weather.temp = 26;
  w.climate.droughtIndex = o.drought ?? 0.3;
  return w;
}

/** Reference fuel beds with the published behaviour of the nearest standard fuel model. */
export const BEDS: Bed[] = [
  { name: 'cured grass (open)', grass: 0.85, litter: 0.3, dead: 0.5, ref: 'GR2/FM1: 1-2 km/h, flames 1.2-2.5 m' },
  { name: 'shrub', grass: 0.15, shrub: 0.75, litter: 2.5, dead: 3, ref: 'FM5: 300-400 m/h, 1.2-1.8 m' },
  { name: 'open pine, needle litter', pine: 0.55, litter: 6, dead: 8, ageP: 130, ref: 'FM9: 100-150 m/h, 0.8-1 m' },
  { name: 'pine + grass understory', pine: 0.4, grass: 0.5, litter: 4, dead: 6, ageP: 130, ref: 'FM2: 400-700 m/h, 1.5-2 m' },
  { name: 'closed fir, short needles', fir: 0.85, litter: 8, dead: 15, ageF: 140, ref: 'FM8: 20-40 m/h, 0.3 m' },
  { name: 'suppressed mixed thicket', pine: 0.4, fir: 0.45, shrub: 0.3, litter: 16, dead: 30, ageP: 110, ageF: 35, under: 0.85, ref: 'FM10: 100-180 m/h, 1.5 m, torching' },
  { name: 'aspen, leaf litter', aspen: 0.8, grass: 0.3, litter: 3, dead: 4, ref: 'slow; a natural fuel break' },
];

export const pct = (x: number) => Math.round(x * 100) + '%';
