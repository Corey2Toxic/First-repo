/**
 * Test helpers: synthetic flat worlds with uniform fuels for controlled
 * fire-behaviour experiments, and small generated worlds for integration.
 */
import { World } from '../src/sim/world.ts';
import type { GameConfig } from '../src/sim/world.ts';
import { makeConfig } from '../src/sim/scenarios.ts';
import { generateWorld } from '../src/sim/gen/index.ts';

export function flatWorld(w = 60, h = 40, opts: { grass?: number; pine?: number; fir?: number; litter?: number; fm?: number; ladder?: boolean } = {}): World {
  const cfg: GameConfig = { ...makeConfig('custom', 'flat-test'), width: w, height: h };
  const world = new World(cfg);
  const L = world.L;
  for (let i = 0; i < world.N; i++) {
    L.elev[i] = 1500;
    L.slope[i] = 0;
    L.flowAcc[i] = 1;
    L.flowTo[i] = -1;
    L.soil[i] = 0.6;
    L.sm[i] = 0.3;
    L.grass[i] = opts.grass ?? 0.8;
    L.pine[i] = opts.pine ?? 0;
    L.fir[i] = opts.fir ?? 0;
    L.ageP[i] = 120;
    L.ageF[i] = opts.ladder ? 20 : 120;
    L.shrub[i] = opts.ladder ? 0.4 : 0.05;
    L.litter[i] = opts.litter ?? 3;
    L.dead[i] = 5;
    L.fm[i] = opts.fm ?? 0.06;
  }
  world.day = 150; // midsummer: grass cured
  world.sub = 4;
  world.weather.windSpeed = 6;
  world.weather.windDir = 0; // toward +x
  world.weather.rh = 0.2;
  world.weather.temp = 26;
  world.climate.droughtIndex = 0.6;
  return world;
}

export function smallWorld(scenario: Parameters<typeof makeConfig>[0] = 'firstseason', seed = 'test-seed-1'): World {
  return generateWorld(makeConfig(scenario, seed, 'small'));
}
