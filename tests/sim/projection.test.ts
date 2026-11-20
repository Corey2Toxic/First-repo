/**
 * Seeing fire coming: the spread projection and the fireshed must agree with the simulation they
 * describe, respond to the things a warden can change, and never disturb a game.
 * (FIREWEED 1.1.1 had neither: the only forward-looking figure was a danger class for today.)
 */
import { describe, expect, it } from 'vitest';
import { flatWorld, smallWorld } from '../helpers.ts';
import type { FlatOpts } from '../helpers.ts';
import { applyFireEffects, fireSubstep, startFire } from '../../src/sim/systems/fire.ts';
import { applyThinning } from '../../src/sim/systems/projects.ts';
import { BURN_PERIOD, computeFireshed, designCases, periodsAhead, projectSpread } from '../../src/sim/projection.ts';
import { stateHash } from '../../src/sim/save.ts';
import { FIRE, INFRA } from '../../src/sim/types.ts';
import type { Town } from '../../src/sim/types.ts';
import type { World } from '../../src/sim/world.ts';
import { Rng } from '../../src/sim/rng.ts';
import { Simulation } from '../../src/sim/sim.ts';

const GRASS: FlatOpts = { grass: 0.85, litter: 0.4 };
const PINE: FlatOpts = { grass: 0.05, pine: 0.55, litter: 6, dead: 8 };
const THICKET: FlatOpts = { grass: 0.05, pine: 0.4, fir: 0.45, shrub: 0.3, litter: 16, dead: 30, under: 0.85 };
const WESTERLY = { name: 'westerly', windSpeed: 7, windDir: 0, windEvent: false, fm: 0.06 };

function town(w: World, x: number, y: number, homes: Array<[number, number]>, firewise = 0): Town {
  const t: Town = { id: w.towns.length, name: 'Testville', x, y, population: 400, structures: homes.length, lostStructures: 0, mill: false, station: y * w.W + x, firewise, smokeToday: 0, smokeDays: 0, threat: 0, evacuated: false, growthPressure: 0, happiness: 0.5 };
  w.towns.push(t);
  for (const [hx, hy] of homes) w.L.town[hy * w.W + hx] = t.id + 1;
  return t;
}

/** How far downwind (cells) fire got along the ignition row in an afternoon and evening, mean of several runs. */
function simulatedHead(opts: FlatOpts, wind: number, tag: string): { head: number; area: number } {
  const reps = 6;
  let head = 0,
    area = 0;
  for (let k = 0; k < reps; k++) {
    const w = flatWorld(200, 81, opts);
    w.weather.windSpeed = wind;
    w.rng.fire = new Rng(`${tag}-${k}`);
    startFire(w, 40 * w.W + 30, 'lightning');
    for (let s = 0; s < 4; s++) {
      w.sub = 4 + s;
      if (w.burning.length) fireSubstep(w);
    }
    let maxX = 30;
    for (let i = 0; i < w.N; i++)
      if (w.L.fire[i] !== FIRE.NONE || w.L.lastBurn[i] > 0) {
        area++;
        if (((i / w.W) | 0) === 40) maxX = Math.max(maxX, i % w.W);
      }
    head += maxX - 30;
  }
  return { head: head / reps, area: area / reps };
}

function projectedHead(opts: FlatOpts, wind: number): { head: number; area: number } {
  const w = flatWorld(200, 81, opts);
  w.weather.windSpeed = wind;
  const pr = projectSpread(w, { ignite: [40 * w.W + 30], hours: 12 });
  let maxX = 30,
    area = 0;
  for (let i = 0; i < w.N; i++)
    if (pr.arrival[i] <= 12) {
      area++;
      if (((i / w.W) | 0) === 40) maxX = Math.max(maxX, i % w.W);
    }
  return { head: maxX - 30, area };
}

describe('spread projection', () => {
  it('puts the head of a fire where the simulation puts it, in fast fuel and slow', () => {
    for (const [name, bed, wind] of [
      ['grass', GRASS, 6],
      ['pine litter', PINE, 8],
      ['thicket', THICKET, 8],
    ] as Array<[string, FlatOpts, number]>) {
      const sim = simulatedHead(bed, wind, 'proj-' + name);
      const proj = projectedHead(bed, wind);
      // within a cell or a fifth of the run, whichever is larger
      expect(Math.abs(proj.head - sim.head), `${name}: projected ${proj.head}, simulated ${sim.head.toFixed(1)}`).toBeLessThanOrEqual(Math.max(1.2, 0.2 * sim.head));
      // and the area is the right size: never more than the simulation's by a quarter, never under half
      expect(proj.area, `${name} area: projected ${proj.area}, simulated ${sim.area.toFixed(0)}`).toBeLessThanOrEqual(1.25 * sim.area + 2);
      expect(proj.area, `${name} area: projected ${proj.area}, simulated ${sim.area.toFixed(0)}`).toBeGreaterThanOrEqual(0.5 * sim.area - 2);
    }
  });

  it('runs downwind: far ahead of the fire, hardly at all behind it', () => {
    const w = flatWorld(160, 61, GRASS);
    w.weather.windSpeed = 8;
    const c = 30 * w.W + 60;
    const pr = projectSpread(w, { ignite: [c], hours: 6 });
    expect(pr.arrival[c + 15]).toBeLessThan(6);
    expect(pr.arrival[c - 15]).toBe(Infinity);
    // arrival times rise with distance from the fire
    expect(pr.arrival[c + 4]).toBeLessThan(pr.arrival[c + 8]);
    expect(pr.arrival[c + 8]).toBeLessThan(pr.arrival[c + 15]);
    // and the totals are consistent
    expect(pr.area[0]).toBeGreaterThan(20);
    expect(pr.area[1]).toBeGreaterThanOrEqual(pr.area[0]);
    expect(pr.area[2]).toBeGreaterThanOrEqual(pr.area[1]);
  });

  it('projects a burning fire from where it is now, and only fires the warden knows of', () => {
    const w = flatWorld(160, 61, GRASS);
    w.weather.windSpeed = 6;
    w.rng.fire = new Rng('proj-known');
    const fe = startFire(w, 30 * w.W + 40, 'lightning')!;
    w.sub = 4;
    fireSubstep(w);
    expect(fe.detected).toBe(false);
    const hidden = projectSpread(w, { hours: 6 });
    expect(hidden.area[0]).toBe(0);
    fe.detected = true;
    const pr = projectSpread(w, { hours: 6 });
    expect(pr.area[0]).toBeGreaterThan(10);
    // cells burning now are the starting line
    for (const b of w.burning) expect(pr.arrival[b]).toBe(0);
    // what burned out behind the front is not projected to burn again
    let reburn = 0;
    for (let i = 0; i < w.N; i++) if (w.L.fire[i] === FIRE.BURNT && pr.arrival[i] > 0 && pr.arrival[i] < Infinity) reburn++;
    expect(reburn).toBe(0);
    // the same projection through the fire's id; another id projects nothing
    expect(projectSpread(w, { fireId: fe.id, hours: 6 }).area[0]).toBe(pr.area[0]);
    expect(projectSpread(w, { fireId: fe.id + 99, hours: 6 }).area[0]).toBe(0);
  });

  it('does not cross a lake, and a road holds a surface fire for a while', () => {
    // (a fixed afternoon, so the answer does not depend on tomorrow's forecast)
    const open = flatWorld(140, 41, PINE);
    const c = 20 * open.W + 30;
    const free = projectSpread(open, { ignite: [c], hours: 36, design: WESTERLY });
    const beyond = c + 12;
    expect(free.arrival[beyond]).toBeLessThan(36);

    const lake = flatWorld(140, 41, PINE);
    for (let y = 0; y < lake.H; y++) for (let x = 36; x <= 38; x++) lake.L.water[y * lake.W + x] = 2;
    expect(projectSpread(lake, { ignite: [c], hours: 36, design: WESTERLY }).arrival[beyond]).toBe(Infinity);

    // a road stops a surface fire in a light wind (in a strong one it is only a place to make a stand)
    const light = { name: 'light', windSpeed: 2.5, windDir: 0, windEvent: false, fm: 0.06 };
    const noRoad = projectSpread(open, { ignite: [c], hours: 96, design: light }).arrival[beyond];
    expect(noRoad).toBeLessThan(96);
    const road = flatWorld(140, 41, PINE);
    for (let y = 0; y < road.H; y++) road.L.infra[y * road.W + 37] |= INFRA.ROAD;
    expect(projectSpread(road, { ignite: [c], hours: 96, design: light }).arrival[beyond]).toBeGreaterThan(noRoad + 6);
    expect(projectSpread(road, { ignite: [c], hours: 36, design: WESTERLY }).arrival[beyond]).toBeGreaterThan(free.arrival[beyond]);
  });

  it('shows treated ground for what it is: a thinned and underburned block drops the fire to the ground', () => {
    const make = (treated: boolean): World => {
      const w = flatWorld(140, 41, THICKET);
      if (treated)
        for (let y = 0; y < w.H; y++)
          for (let x = 40; x < 60; x++) {
            const i = y * w.W + x;
            applyThinning(w, i);
            applyFireEffects(w, i, 1);
            w.L.fire[i] = FIRE.NONE;
            w.L.lastBurn[i] = w.yearF - 3; // three years on: litter is back, the thicket is not
            w.L.litter[i] = 5;
          }
      return w;
    };
    const c = 20 * 140 + 30;
    const wild = projectSpread(make(false), { ignite: [c], hours: 60, design: WESTERLY });
    const treated = projectSpread(make(true), { ignite: [c], hours: 60, design: WESTERLY });
    const inBlock = 20 * 140 + 50,
      past = 20 * 140 + 66;
    // the thicket torches; the treated block burns on the ground with flames crews can work beside
    expect(wild.crown[inBlock]).toBe(1);
    expect(treated.crown[inBlock]).toBe(0);
    expect(treated.flame[inBlock]).toBeLessThan(wild.flame[inBlock] * 0.6);
    expect(treated.flame[inBlock]).toBeLessThan(1.6);
    // It does not stop the fire, or even slow it: an opened stand lets the wind in. What it buys is
    // a fire that stays on the ground where a crew can stand in front of it.
    expect(wild.arrival[past]).toBeLessThan(60);
    expect(treated.arrival[past]).toBeLessThan(60);
    expect(wild.flame[inBlock]).toBeGreaterThan(2.4);
  });

  it('says when a town is in the way, how soon, and how many homes', () => {
    const w = flatWorld(140, 41, GRASS);
    w.weather.windSpeed = 7;
    const homes: Array<[number, number]> = [];
    for (let y = 18; y <= 22; y += 2) for (let x = 70; x <= 74; x += 2) homes.push([x, y]);
    town(w, 72, 20, homes);
    const upwind = projectSpread(w, { ignite: [20 * w.W + 40], hours: 24 });
    expect(upwind.towns[0].hours).toBeGreaterThan(0.5);
    expect(upwind.towns[0].hours).toBeLessThan(12);
    expect(upwind.towns[0].homes).toBeGreaterThanOrEqual(6);
    // houses are not fuel for the front: it never "arrives" on a house cell itself
    for (const [hx, hy] of homes) expect(upwind.arrival[hy * w.W + hx]).toBe(Infinity);
    // the same fire lit downwind of the town backs toward it far more slowly, if at all
    const downwind = projectSpread(w, { ignite: [20 * w.W + 110], hours: 24 });
    expect(downwind.towns[0].hours).toBeGreaterThan(upwind.towns[0].hours * 3);
  });

  it('follows the forecast: the hours ahead are today as it is, then the days as forecast', () => {
    const w = smallWorld('tinderbox', 'proj-fc');
    const sim = new Simulation(w, {}, { autoReview: true, ignitions: false });
    sim.runDays(150);
    while (w.sub !== 3) sim.tick();
    const env = periodsAhead(w, 48);
    expect(env.length).toBe(16);
    // afternoon winds are stronger than the night's, today and tomorrow
    expect(env[1].windEff).toBeGreaterThan(env[5].windEff);
    for (const e of env) {
      expect(Number.isFinite(e.windEff)).toBe(true);
      expect(Number.isFinite(e.fmAdd)).toBe(true);
      expect(Math.abs(Math.hypot(e.wdx, e.wdy) - 1)).toBeLessThan(1e-6);
    }
  });

  it('never changes the world or draws a random number', () => {
    const w = smallWorld('tinderbox', 'proj-pure');
    const sim = new Simulation(w, {}, { autoReview: true });
    sim.runDays(170);
    // light something so there is a real fire to project
    let c = -1;
    for (let i = 0; i < w.N && c < 0; i += 7) if (!w.L.water[i] && w.L.town[i] === 0 && w.L.pine[i] > 0.3) c = i;
    const fe = startFire(w, c, 'lightning');
    if (fe) fe.detected = true;
    sim.tick();
    const before = stateHash(w);
    const a = projectSpread(w, { hours: 48 });
    const b = projectSpread(w, { ignite: [c + 3], hours: 24 });
    const fs = computeFireshed(w);
    expect(stateHash(w)).toBe(before);
    // and asking twice gives the same answer
    const a2 = projectSpread(w, { hours: 48 });
    expect(Array.from(a2.area)).toEqual(Array.from(a.area));
    expect(b.horizon).toBe(24);
    expect(fs.towns.length).toBe(w.towns.length);
    const fs2 = computeFireshed(w);
    expect(fs2.towns.map((t) => t.risk)).toEqual(fs.towns.map((t) => t.risk));
  });
});

describe('fireshed and town exposure', () => {
  /** A town of 12 homes in a sea of one fuel bed, wind from the west on the design day. */
  function valley(bed: FlatOpts, firewise = 0): World {
    const w = flatWorld(160, 81, bed);
    const homes: Array<[number, number]> = [];
    for (let y = 37; y <= 43; y += 2) for (let x = 100; x <= 104; x += 2) homes.push([x, y]);
    town(w, 102, 40, homes, firewise);
    return w;
  }

  it('reaches upwind: ground west of a town is hours from its homes, ground east of it is not in the fireshed', () => {
    const w = valley(GRASS);
    const fs = computeFireshed(w, [{ name: 'westerly', windSpeed: 7, windDir: 0, windEvent: false, fm: 0.06 }]);
    const row = 40 * w.W;
    expect(fs.hours[row + 95]).toBeLessThan(fs.hours[row + 80]);
    expect(fs.hours[row + 80]).toBeLessThan(fs.hours[row + 60]);
    expect(fs.hours[row + 60]).toBeLessThan(BURN_PERIOD);
    // downwind of town a fire has to back into the wind
    expect(fs.hours[row + 130]).toBeGreaterThan(fs.hours[row + 74] * 4);
    expect(fs.towns[0].homes).toBe(12);
    expect(fs.towns[0].area12).toBeGreaterThan(fs.towns[0].area6);
    expect(fs.towns[0].area6).toBeGreaterThan(50);
  });

  it('agrees with the forward projection about how long a fire takes to arrive', () => {
    const w = valley(GRASS);
    const design = { name: 'westerly', windSpeed: 7, windDir: 0, windEvent: false, fm: 0.06 };
    const fs = computeFireshed(w, [design]);
    const origin = 40 * w.W + 70;
    const fwd = projectSpread(w, { ignite: [origin], hours: 36, design });
    expect(fwd.towns[0].hours).toBeGreaterThan(0);
    // the reverse search and the forward search are the same model run in opposite directions
    expect(Math.abs(fwd.towns[0].hours - fs.hours[origin])).toBeLessThan(Math.max(0.5, 0.25 * fs.hours[origin]));
  });

  it('measures what a town faces: a thicket at the fence is worse than grass, and both are worse than a treated edge', () => {
    const grass = computeFireshed(valley(GRASS)).towns[0];
    const thicket = computeFireshed(valley(THICKET)).towns[0];
    expect(thicket.crownEdge).toBeGreaterThan(0.8);
    expect(grass.crownEdge).toBe(0);
    expect(thicket.exposed).toBeGreaterThan(grass.exposed);
    expect(thicket.exposed).toBeGreaterThan(3);

    // thin and underburn everything within 400 m of the homes
    const w = valley(THICKET);
    for (let y = 30; y <= 50; y++)
      for (let x = 93; x <= 111; x++) {
        const i = y * w.W + x;
        if (w.L.town[i] !== 0) continue;
        applyThinning(w, i);
        applyFireEffects(w, i, 1);
        w.L.fire[i] = FIRE.NONE;
        w.L.lastBurn[i] = w.yearF - 3;
        w.L.litter[i] = 5;
      }
    const treated = computeFireshed(w).towns[0];
    expect(treated.crownEdge).toBeLessThan(0.1);
    expect(treated.exposed).toBeLessThan(thicket.exposed * 0.6);
    expect(treated.risk).toBeLessThan(thicket.risk * 0.6);
  });

  it('counts home hardening: the same fire takes fewer firewise homes', () => {
    const soft = computeFireshed(valley(THICKET, 0), [WESTERLY]).towns[0];
    const hard = computeFireshed(valley(THICKET, 0.9), [WESTERLY]).towns[0];
    expect(hard.exposed).toBeLessThan(soft.exposed * 0.75);
    expect(hard.risk).toBeLessThan(soft.risk * 0.75);
    expect(hard.area12).toBe(soft.area12); // hardening does not change the fire, only what it finds
  });

  it('classifies design-day behaviour by what crews could do about it', () => {
    const g = computeFireshed(valley(PINE));
    const t = computeFireshed(valley(THICKET));
    const cell = 20 * 160 + 30;
    expect(g.behaviour[cell]).toBeGreaterThanOrEqual(1);
    expect(g.behaviour[cell]).toBeLessThan(4);
    expect(t.behaviour[cell]).toBe(4);
    expect(t.flame[cell]).toBeGreaterThan(g.flame[cell]);
    // a house cell is not fuel
    expect(g.behaviour[37 * 160 + 100]).toBe(0);
  });

  it('works on a generated valley: every town has a fireshed and a risk between 0 and 100', () => {
    const w = smallWorld('tinderbox', 'shed-1');
    const fs = computeFireshed(w);
    expect(designCases(w).length).toBeGreaterThanOrEqual(3);
    expect(fs.towns.length).toBe(w.towns.length);
    for (const te of fs.towns) {
      expect(te.homes).toBeGreaterThan(0);
      expect(te.area12).toBeGreaterThanOrEqual(te.area6);
      expect(te.risk).toBeGreaterThanOrEqual(0);
      expect(te.risk).toBeLessThanOrEqual(100);
      expect(te.exposed).toBeLessThanOrEqual(te.homes);
    }
    // water is never in a fireshed
    for (let i = 0; i < w.N; i++) if (w.L.water[i] >= 2) expect(fs.hours[i]).toBe(Infinity);
  });
});
