/**
 * World generation orchestrator.
 */
import { World } from '../world.ts';
import type { GameConfig } from '../world.ts';
import type { Town } from '../types.ts';
import { generateTerrain } from './terrain.ts';
import { conditionHydrology, computeSlopeAspectShade } from './hydro.ts';
import { NameBank } from './names.ts';
import { initMoisture, initSoil, initVegetation } from './vegetation.ts';
import { initStandAge, initUnderstory } from '../systems/vegetation.ts';
import { seedBeetles } from '../systems/beetles.ts';
import {
  buildInitialRoads,
  chooseTownSites,
  initialZones,
  makeReservoir,
  nameLandmarks,
  placeInfrastructure,
  placeStructures,
} from './settle.ts';
import { initWildlife } from './wildlife.ts';
import { initCrews } from './crews.ts';
import { updateFirewise } from '../systems/towns.ts';

export function generateWorld(config: GameConfig): World {
  const w = new World(config);
  const rng = w.rng.misc.fork('worldgen');
  const names = new NameBank(rng.fork('names'));

  const info = generateTerrain(w, rng.fork('terrain'));
  conditionHydrology(w);
  initSoil(w, rng.fork('soil'));

  const sites = chooseTownSites(w, info, rng.fork('towns'), config.townCount);
  if (sites.length > 0) makeReservoir(w, info, sites[0], sites);
  computeSlopeAspectShade(w); // reservoir surface is now flat

  initVegetation(w, rng.fork('veg'), config.history);
  initMoisture(w);

  w.valleyName = config.valleyName ?? names.valley();
  w.climate.localWindName = names.wind();
  const basePops = [2100, 900, 380, 220];
  const trng = rng.fork('townpop');
  sites.forEach((c, k) => {
    const pop = Math.round(basePops[k] * trng.range(0.85, 1.15) * (config.scenario === 'boomtown' && k === 0 ? 1.25 : 1));
    const t: Town = {
      id: k,
      name: names.town(),
      x: c % w.W,
      y: (c / w.W) | 0,
      population: pop,
      structures: 0,
      lostStructures: 0,
      mill: false,
      station: c,
      firewise: 0.15,
      smokeToday: 0,
      smokeDays: 0,
      threat: 0,
      evacuated: false,
      growthPressure: config.scenario === 'boomtown' ? 0.9 : 0.4,
      happiness: 0.6,
    };
    w.towns.push(t);
  });
  buildInitialRoads(w, info, rng.fork('roads'));
  for (const t of w.towns) placeStructures(w, t, rng.fork('struct' + t.id), Math.ceil(t.population / 38));
  placeInfrastructure(w, rng.fork('infra'), names);
  initialZones(w);
  nameLandmarks(w, names, info);
  initWildlife(w, rng.fork('wildlife'), names);
  initStandAge(w);
  initUnderstory(w);
  seedBeetles(w);
  initCrews(w, names);
  updateFirewise(w);
  return w;
}
