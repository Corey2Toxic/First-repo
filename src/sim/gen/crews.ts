/**
 * Starting crews: hand crews at the two largest towns and an engine at the
 * main station.
 */
import type { Crew, CrewKind } from '../types.ts';
import type { World } from '../world.ts';
import type { NameBank } from './names.ts';

export function makeCrew(w: World, kind: CrewKind, station: number, name: string): Crew {
  const x = (station % w.W) + 0.5,
    y = ((station / w.W) | 0) + 0.5;
  return {
    id: w.nextId(),
    name,
    kind,
    home: station,
    x,
    y,
    px: x,
    py: y,
    state: 'idle',
    task: null,
    path: [],
    workCell: -1,
    fatigue: 0,
    water: 1,
    hoursWorked: 0,
    manual: false,
  };
}

export function initCrews(w: World, names: NameBank): void {
  if (w.towns.length === 0) return;
  const main = w.towns[0];
  const second = w.towns[1] ?? main;
  w.crews.push(makeCrew(w, 'hand', main.station, names.crewName('hand', 1)));
  w.crews.push(makeCrew(w, 'hand', second.station, names.crewName('hand', 2)));
  w.crews.push(makeCrew(w, 'engine', main.station, names.crewName('engine', 1)));
}
