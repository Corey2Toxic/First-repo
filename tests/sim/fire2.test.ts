/**
 * The v2 fire core. Each test states a behaviour the game depends on; where 1.1.1 behaved
 * differently the comment gives what it did (measured with scripts/v2 on the 1.1.1 tree).
 */
import { describe, expect, it } from 'vitest';
import { established, flatWorld } from '../helpers.ts';
import type { FlatOpts } from '../helpers.ts';
import {
  FLAME_LIMIT,
  KNOCKED_DOWN,
  applyFireEffects,
  byramIntensity,
  CBH_MIN,
  canopyBaseHeight,
  crownInitiationIntensity,
  currentSpreadEnv,
  fireSubstep,
  frontBehaviour,
  frontLoad,
  moistureResponse,
  startFire,
  surfaceFlameLength,
  surfaceHeadRate,
  MX_GRASS,
  MX_LITTER,
} from '../../src/sim/systems/fire.ts';
import { cellFuel } from '../../src/sim/systems/fuels.ts';
import { applyThinning } from '../../src/sim/systems/projects.ts';
import { FIRE } from '../../src/sim/types.ts';
import type { World } from '../../src/sim/world.ts';
import { Rng } from '../../src/sim/rng.ts';

const PINE: FlatOpts = { grass: 0, pine: 0.7, litter: 6, dead: 40 };
const FIR: FlatOpts = { grass: 0, fir: 0.8, litter: 8, dead: 40 };
const GRASS: FlatOpts = { grass: 0.85, litter: 0.4 };

/** Head rate (m/h) the model specifies for a cell in the current sub-step. */
function specified(w: World, cell: number): number {
  const env = currentSpreadEnv(w);
  return surfaceHeadRate(w, cell, cellFuel(w, cell), env.windEff, w.L.fm[cell] + env.fmAdd) * env.spread;
}

/** Realised head rate (m/h) with every burning cell held alight and flaming, the same sub-step repeated. */
function realised(opts: FlatOpts, wind: number, fm: number, sub: number, hours: number, tag: string): { realised: number; specified: number } {
  const reps = 5;
  let sum = 0,
    spec = 0;
  for (let rep = 0; rep < reps; rep++) {
    const w = flatWorld(140, 41, { ...opts, fm });
    w.rng.fire = new Rng(`${tag}-${rep}`);
    w.weather.windSpeed = wind;
    w.sub = sub;
    const c = 20 * w.W + 20;
    established(startFire(w, c, 'lightning'));
    for (let s = 0; s < hours / 3; s++) {
      w.sub = sub;
      for (const b of w.burning) {
        w.L.ftime[b] = 48;
        w.L.fphase[b] = 0;
      }
      fireSubstep(w);
    }
    let maxX = 20;
    for (let i = 0; i < w.N; i++) if (w.L.fire[i] !== FIRE.NONE && Math.floor(i / w.W) === 20) maxX = Math.max(maxX, i % w.W);
    sum += ((maxX - 20) * 100) / hours;
    spec = specified(w, c + 5);
  }
  return { realised: sum / reps, specified: spec };
}

describe('fire core v2: spread that keeps its place', () => {
  it('a slow surface fire advances at the rate the model specifies (1.1.1: 0.27x at 3 m/s, 0.05x at 1 m/s)', () => {
    for (const wind of [3, 1]) {
      const r = realised(PINE, wind, 0.06, 4, 24, 'slow-pine-' + wind);
      expect(r.specified).toBeGreaterThan(8);
      expect(r.specified).toBeLessThan(40);
      expect(r.realised / r.specified).toBeGreaterThan(0.6);
      expect(r.realised / r.specified).toBeLessThan(1.7);
    }
  });

  it('fire creeps through short-needle litter and through the night (1.1.1: not at all)', () => {
    const fir = realised(FIR, 6, 0.06, 4, 48, 'slow-fir');
    expect(fir.specified).toBeLessThan(40);
    expect(fir.realised / fir.specified).toBeGreaterThan(0.5);
    // midnight sub-step: the wind has dropped and the fuel has re-wetted, but a litter fire still creeps
    const night = realised(PINE, 6, 0.06, 0, 48, 'slow-night');
    expect(night.specified).toBeGreaterThan(2);
    expect(night.realised).toBeGreaterThan(0.5 * night.specified);
  });

  it('progress toward a cell is kept between steps, not added up across sources', () => {
    // one source: after a step too short to cross, the target holds a fraction of the crossing
    const w = flatWorld(30, 11, { ...FIR, fm: 0.06 });
    w.rng.fire = new Rng('prog');
    w.weather.windSpeed = 6;
    const c = 5 * w.W + 10;
    established(startFire(w, c, 'lightning'));
    w.sub = 4;
    fireSubstep(w);
    const ahead = w.L.fprog[c + 1];
    expect(ahead).toBeGreaterThan(0.02);
    expect(ahead).toBeLessThan(1);
    // when nothing is left burning, unfinished crossings are forgotten
    for (const b of w.burning) w.L.ftime[b] = 0;
    fireSubstep(w);
    expect(w.burning.length).toBe(0);
    expect(w.L.fprog.every((v) => v === 0)).toBe(true);
  });
});

describe('fire core v2: physical intensity', () => {
  it('flame lengths of the reference fuel beds match the published fuel models', () => {
    // Byram: I = H w R; L = 0.0775 I^0.46
    expect(surfaceFlameLength(byramIntensity(frontLoad(6.5), 1.0))).toBeGreaterThan(0.7); // FM9 at ~100 m/h: 0.8-1 m
    expect(surfaceFlameLength(byramIntensity(frontLoad(6.5), 1.0))).toBeLessThan(1.3);
    expect(surfaceFlameLength(byramIntensity(frontLoad(2.6), 13.6))).toBeGreaterThan(1.8); // cured grass at 1.36 km/h: ~2-2.5 m
    expect(surfaceFlameLength(byramIntensity(frontLoad(2.6), 13.6))).toBeLessThan(3);
    expect(surfaceFlameLength(byramIntensity(frontLoad(8), 0.3))).toBeLessThan(0.7); // FM8 at 30 m/h: ~0.3-0.5 m
    // Van Wagner: a 2 m crown base at 100 % foliar moisture needs ~480 kW/m; 6 m needs ~2,500
    expect(crownInitiationIntensity(2, 100)).toBeGreaterThan(400);
    expect(crownInitiationIntensity(2, 100)).toBeLessThan(560);
    expect(crownInitiationIntensity(6, 100)).toBeGreaterThan(2200);
    // ladder fuels lower the crown base from ~9 m to about half a metre
    expect(canopyBaseHeight(0)).toBeGreaterThan(8);
    // a thicket: about a metre and a half (the first 2.0 builds: 0.5 m, a threshold any flame met)
    expect(canopyBaseHeight(0.9)).toBeLessThan(1.6);
    expect(canopyBaseHeight(1)).toBe(CBH_MIN);
    expect(FLAME_LIMIT.hand).toBeLessThan(FLAME_LIMIT.engine);
  });

  it('behind the head, the flanks and the rear burn cool enough to work (1.1.1: the same number all round)', () => {
    // What a crew faces is the flame on the edge now. (Peak flame is another matter: most cells of
    // a wind-driven fire are entered from upwind at the head rate, and scorch accordingly.)
    let head = 0,
      flank = 0,
      nh = 0,
      nf = 0;
    for (let k = 0; k < 6; k++) {
      const w = flatWorld(160, 61, { grass: 0, pine: 0.6, litter: 6, dead: 10 });
      w.rng.fire = new Rng('flank-' + k);
      w.weather.windSpeed = 8;
      const cx = 25,
        cy = 30;
      const fe = startFire(w, cy * w.W + cx, 'lightning')!;
      for (let s = 0; s < 8; s++) {
        w.sub = 4;
        fireSubstep(w);
      }
      expect(fe.area).toBeGreaterThan(20);
      let maxX = cx;
      for (const b of w.burning) maxX = Math.max(maxX, b % w.W);
      for (const b of w.burning) {
        if (w.L.fphase[b] !== 0) continue; // advancing edge only
        const x = b % w.W;
        if (x >= maxX - 2) {
          head += w.L.fint[b];
          nh++;
        } else if (x <= cx + (maxX - cx) * 0.6) {
          flank += w.L.fint[b];
          nf++;
        }
      }
    }
    expect(nh).toBeGreaterThan(6);
    expect(nf).toBeGreaterThan(20);
    expect(flank / nf).toBeLessThan(0.7 * (head / nh));
    // the head of a needle-litter fire in an 8 m/s wind: about a metre of flame; its flanks well
    // inside what a hand crew can work
    expect(head / nh).toBeGreaterThan(0.6);
    expect(head / nh).toBeLessThan(2.5);
    expect(flank / nf).toBeLessThan(FLAME_LIMIT.hand);
  });

  it('a grass head fire reads as the fast, long-flamed fire it is (1.1.1: the mildest fire on the map)', () => {
    const w = flatWorld(120, 21, GRASS);
    w.rng.fire = new Rng('grasshead');
    w.weather.windSpeed = 6;
    const fe = startFire(w, 10 * w.W + 10, 'human')!;
    w.sub = 4;
    fireSubstep(w);
    fireSubstep(w);
    // flames beyond what a hand crew can face at the head
    expect(fe.maxIntensity).toBeGreaterThan(FLAME_LIMIT.hand);
    expect(fe.maxIntensity).toBeLessThan(5);
  });
});

describe('fire core v2: suppression acts on the front', () => {
  it('a cell that crews have knocked down spreads no further (1.1.1: it spread at full vigour)', () => {
    const w = flatWorld(80, 41, GRASS);
    w.rng.fire = new Rng('knock');
    const fe = startFire(w, 20 * w.W + 20, 'human')!;
    w.sub = 4;
    fireSubstep(w);
    fireSubstep(w);
    expect(fe.area).toBeGreaterThan(10);
    const before = fe.area;
    for (const b of w.burning) w.L.ftime[b] = KNOCKED_DOWN;
    fireSubstep(w);
    expect(fe.area).toBe(before);
    expect(w.burning.length).toBe(0);
  });

  it('long flames reach across a scraped line that stops a cool edge', () => {
    const crossed = (flame: number) => {
      let n = 0;
      for (let k = 0; k < 10; k++) {
        const w = flatWorld(40, 21, { grass: 0, pine: 0.6, litter: 6, dead: 10 });
        w.rng.fire = new Rng(`line-${flame}-${k}`);
        w.weather.windSpeed = 6;
        for (let y = 0; y < w.H; y++) w.L.fline[y * w.W + 22] = 1;
        startFire(w, 10 * w.W + 21, 'human');
        for (let s = 0; s < 8; s++) {
          w.sub = 4;
          // hold the edge next to the line at the given flame length
          for (const b of w.burning) {
            w.L.ftime[b] = 48;
            w.L.fphase[b] = 0;
            w.L.fint[b] = flame;
          }
          fireSubstep(w);
        }
        let past = false;
        for (let i = 0; i < w.N; i++) if (w.L.fire[i] !== FIRE.NONE && i % w.W >= 22) past = true;
        if (past) n++;
      }
      return n;
    };
    expect(crossed(0.8)).toBe(0);
    expect(crossed(5)).toBeGreaterThan(5);
  });
});

describe('fire core v2: fires that last', () => {
  /** Run whole days with the clock moving (night included); returns area at the end of each day. */
  function days(w: World, n: number): number[] {
    const out: number[] = [];
    for (let d = 0; d < n; d++) {
      for (let s = 0; s < 8; s++) {
        w.sub = (4 + s) % 8;
        if (w.burning.length) fireSubstep(w);
      }
      let a = 0;
      for (let i = 0; i < w.N; i++) if (w.L.fire[i] !== FIRE.NONE || w.L.lastBurn[i] > 0) a++;
      out.push(a);
    }
    return out;
  }

  it('heavy fuel in a drought holds fire through the night and it runs again the next afternoon', () => {
    let alive = 0,
      grew = 0;
    for (let k = 0; k < 6; k++) {
      const w = flatWorld(120, 61, { grass: 0, pine: 0.6, litter: 12, dead: 30, fm: 0.06 });
      w.rng.fire = new Rng('hold-' + k);
      w.climate.droughtIndex = 0.6;
      w.weather.windSpeed = 5;
      startFire(w, 30 * w.W + 30, 'lightning');
      const a = days(w, 3);
      if (w.burning.length > 0) alive++;
      if (a[2] > a[0] * 1.3) grew++;
    }
    // 1.1.1: 45 of 49 Tinderbox wildfires were out within a day
    expect(alive).toBeGreaterThanOrEqual(5);
    expect(grew).toBeGreaterThanOrEqual(5);
  });

  it('a grass fire with nothing heavy to hold it is out by morning once the night air is damp', () => {
    let out = 0;
    for (let k = 0; k < 6; k++) {
      const w = flatWorld(160, 61, { ...GRASS, dead: 0.5, fm: 0.1 });
      w.rng.fire = new Rng('grassnight-' + k);
      w.climate.droughtIndex = 0.05;
      w.weather.windSpeed = 3;
      w.weather.rh = 0.5;
      startFire(w, 30 * w.W + 30, 'human');
      days(w, 2);
      if (w.burning.length === 0) out++;
    }
    expect(out).toBeGreaterThanOrEqual(5);
  });

  it('rain ends a fire', async () => {
    const { weatherOnFires } = await import('../../src/sim/systems/fire.ts');
    const w = flatWorld(60, 41, { grass: 0, pine: 0.6, litter: 12, dead: 30 });
    w.rng.fire = new Rng('rain');
    startFire(w, 20 * w.W + 20, 'lightning');
    w.sub = 4;
    fireSubstep(w);
    fireSubstep(w);
    expect(w.burning.length).toBeGreaterThan(0);
    w.weather.precip = 12;
    weatherOnFires(w);
    fireSubstep(w);
    expect(w.burning.length).toBe(0);
  });
});

describe('fire core v2: fuel moisture and mixed fuel beds', () => {
  it('each fuel answers to its own moisture of extinction', () => {
    // at 16 % cured grass is out and needle litter still carries at more than a third of its dry rate
    expect(moistureResponse(0.16, MX_GRASS)).toBe(0);
    expect(moistureResponse(0.16, MX_LITTER)).toBeGreaterThan(0.35);
    expect(moistureResponse(0.06, MX_LITTER)).toBeCloseTo(1, 6);
    expect(moistureResponse(0.03, MX_LITTER)).toBeGreaterThan(1);
    let prev = Infinity;
    for (let m = 0.02; m < 0.3; m += 0.02) {
      const r = moistureResponse(m, MX_LITTER);
      expect(r).toBeLessThanOrEqual(prev + 1e-9);
      prev = r;
    }
  });

  it('a grassy pine stand in damp air burns like its litter, not like grass (1.1.1: one blended damping)', () => {
    const w = flatWorld(10, 10, { grass: 0.5, pine: 0.4, litter: 4 });
    const f = cellFuel(w, 55);
    expect(f.grassShare).toBeGreaterThan(0.1);
    const dry = surfaceHeadRate(w, 55, f, 6, 0.06);
    const damp = surfaceHeadRate(w, 55, f, 6, 0.16);
    const litterOnly = flatWorld(10, 10, { grass: 0, pine: 0.4, litter: 4 });
    const lf = cellFuel(litterOnly, 55);
    const litterDamp = surfaceHeadRate(litterOnly, 55, lf, 6, 0.16);
    expect(damp).toBeLessThan(0.5 * dry);
    expect(damp).toBeLessThan(1.6 * litterDamp);
  });

  it('a mixed bed spreads between its components: faster than the litter, far slower than the grass', () => {
    const mixed = flatWorld(10, 10, { grass: 0.5, pine: 0.4, litter: 4 });
    const grass = flatWorld(10, 10, { grass: 0.85, litter: 0.3 });
    const litter = flatWorld(10, 10, { grass: 0, pine: 0.4, litter: 4 });
    const r = (w: World) => surfaceHeadRate(w, 55, cellFuel(w, 55), 6, 0.06);
    expect(r(mixed)).toBeGreaterThan(r(litter));
    // 1.1.1 took the share-weighted mean of the rates, so a fifth of grass tripled the rate
    expect(r(mixed)).toBeLessThan(0.35 * r(grass));
    expect(r(mixed)).toBeLessThan(3 * r(litter));
  });

  it('aspen with its green understory is a fuel break', () => {
    const aspen = flatWorld(10, 10, { grass: 0.3, aspen: 0.8, litter: 3 });
    const pine = flatWorld(10, 10, { grass: 0.3, pine: 0.5, litter: 3 });
    const r = (w: World) => surfaceHeadRate(w, 55, cellFuel(w, 55), 6, 0.06);
    expect(r(aspen)).toBeLessThan(0.75 * r(pine));
  });
});

describe('fire core v2: the understory', () => {
  const STAND: FlatOpts = { grass: 0.1, pine: 0.55, litter: 9, dead: 15 };

  it('a stand with a century of regeneration under it torches; the same stand kept open does not', () => {
    const torch = (under: number) => {
      const w = flatWorld(10, 10, { ...STAND, under });
      const f = cellFuel(w, 55);
      const env = currentSpreadEnv(w);
      const rate = (surfaceHeadRate(w, 55, f, env.windEff, 0.06) / 100) * env.spread;
      return frontBehaviour(w, 55, f, rate, 0).crown;
    };
    // 1.1.1 had no understory: nothing in a generated "Tinderbox" valley could torch
    expect(torch(0.9)).toBe(true);
    expect(torch(0)).toBe(false);
  });

  it('a fire in thickets is a severe fire; in open forest it is a gentle one', () => {
    const run = (under: number) => {
      let high = 0,
        area = 0;
      for (let k = 0; k < 4; k++) {
        const w = flatWorld(100, 41, { ...STAND, under });
        w.rng.fire = new Rng(`thicket-${under}-${k}`);
        w.weather.windSpeed = 6;
        const fe = startFire(w, 20 * w.W + 20, 'lightning')!;
        for (let s = 0; s < 6; s++) {
          w.sub = 4;
          fireSubstep(w);
        }
        high += fe.crownArea;
        area += fe.area;
      }
      return high / Math.max(1, area);
    };
    expect(run(0.9)).toBeGreaterThan(0.5);
    expect(run(0)).toBeLessThan(0.05);
  });

  it('a low-severity fire clears the understory and spares the big pines', () => {
    const w = flatWorld(10, 10, { ...STAND, under: 0.9 });
    const pine = w.L.pine[55];
    applyFireEffects(w, 55, 1);
    expect(w.L.under[55]).toBeLessThan(0.3);
    expect(w.L.pine[55]).toBeGreaterThan(0.85 * pine);
    applyFireEffects(w, 56, 3);
    expect(w.L.under[56]).toBe(0);
  });

  it('thinning takes the ladder out, and a thinned stand lets a crown run drop to the ground', () => {
    const w0 = flatWorld(10, 10, { ...STAND, under: 0.9 });
    const before = cellFuel(w0, 55).ladder;
    applyThinning(w0, 55);
    const after = cellFuel(w0, 55);
    expect(after.ladder).toBeLessThan(0.5 * before);
    // (1.1.1 left 10-18 t/ha of slash: fine fuel and hazard went UP after thinning)
    expect(after.fine).toBeLessThan(cellFuel(flatWorld(10, 10, { ...STAND, under: 0.9 }), 55).fine + 1.5);

    // a wind-driven crown fire meets a thinned block 2 km deep
    let inBlock = 0,
      nBlock = 0,
      outside = 0,
      nOut = 0;
    for (let k = 0; k < 4; k++) {
      const w = flatWorld(140, 41, { grass: 0.05, pine: 0.5, fir: 0.25, litter: 12, dead: 25, under: 0.9 });
      w.rng.fire = new Rng('thinblock-' + k);
      w.weather.windSpeed = 12;
      for (let y = 0; y < w.H; y++) for (let x = 60; x < 80; x++) applyThinning(w, y * w.W + x);
      startFire(w, 20 * w.W + 15, 'lightning');
      const crowned = new Uint8Array(w.N);
      for (let s = 0; s < 14; s++) {
        w.sub = 4;
        fireSubstep(w);
        for (const b of w.burning) if (w.L.crown[b]) crowned[b] = 1;
      }
      for (let i = 0; i < w.N; i++) {
        if (w.L.fire[i] === FIRE.NONE && !(w.L.lastBurn[i] > 0)) continue;
        const x = i % w.W;
        if (x >= 60 && x < 80) {
          nBlock++;
          inBlock += crowned[i];
        } else if (x >= 30 && x < 58) {
          nOut++;
          outside += crowned[i];
        }
      }
    }
    expect(nOut).toBeGreaterThan(100);
    expect(outside / nOut).toBeGreaterThan(0.6);
    // the fire may or may not have reached the block; where it burned there, it stayed on the ground
    if (nBlock > 20) expect(inBlock / nBlock).toBeLessThan(0.25 * (outside / nOut));
  });
});

describe('fire core v2: houses', () => {
  /** One house of a 6 x 6 block set alight; how many are lost a day later? */
  function blockLoss(wind: number, firewise: number, tag: string): number {
    let lost = 0;
    const trials = 10;
    for (let k = 0; k < trials; k++) {
      const w = flatWorld(40, 30, { grass: 0, litter: 0, dead: 0 });
      w.rng.fire = new Rng(`${tag}-${k}`);
      w.weather.windSpeed = wind;
      w.towns.push({ id: 0, name: 'Testville', x: 20, y: 15, population: 1000, structures: 36, lostStructures: 0, mill: false, station: 0, firewise, smokeToday: 0, smokeDays: 0, threat: 0, evacuated: false, growthPressure: 0, happiness: 0.5 });
      for (let y = 12; y < 18; y++) for (let x = 17; x < 23; x++) w.L.town[y * w.W + x] = 1;
      // a patch of grass to start a fire record on, then hand the fire to one house
      const g = 5 * w.W + 5;
      w.L.grass[g] = 0.8;
      w.L.litter[g] = 2;
      const fe = startFire(w, g, 'human')!;
      w.L.ftime[g] = KNOCKED_DOWN;
      const h = 14 * w.W + 19;
      w.L.fire[h] = FIRE.BURNING;
      w.L.fid[h] = fe.id;
      w.L.fint[h] = 4;
      w.L.ftime[h] = 6;
      w.burning.push(h);
      for (let s = 0; s < 8 && w.burning.length; s++) {
        w.sub = 4;
        fireSubstep(w);
      }
      lost += w.towns[0].lostStructures;
    }
    return lost / trials;
  }

  it('fire runs from house to house in wind, not in still air (1.1.1: a flat 0.16 a neighbour whatever the weather)', () => {
    const calm = blockLoss(0.5, 0.2, 'h2h-calm');
    const gale = blockLoss(12, 0.2, 'h2h-gale');
    expect(calm).toBeLessThan(4);
    expect(gale).toBeGreaterThan(2 * calm + 2);
    // firewise homes resist it even in wind
    expect(blockLoss(12, 1, 'h2h-fw')).toBeLessThan(0.5 * gale);
  });
});

describe('fire core v2: burn scars', () => {
  it('a fresh burn does not carry fire; a year later it does (before: the litter a light fire left carried the next one within days)', () => {
    /** Does fire lit west of a strip burned `yearsAgo` reach the far side of it in a long windy afternoon? */
    const crosses = (yearsAgo: number): number => {
      let n = 0;
      for (let k = 0; k < 4; k++) {
        const w = flatWorld(90, 31, { ...PINE, fm: 0.06 });
        w.rng.fire = new Rng(`scar-${yearsAgo}-${k}`);
        w.weather.windSpeed = 8;
        // the strip burned lightly: its litter is what such a fire leaves, enough by itself to carry
        for (let y = 0; y < w.H; y++)
          for (let x = 30; x < 38; x++) {
            const i = y * w.W + x;
            w.L.lastBurn[i] = w.yearF - yearsAgo;
            w.L.litter[i] = 3.5;
          }
        established(startFire(w, 15 * w.W + 22, 'lightning'));
        for (let s = 0; s < 40 && w.burning.length; s++) {
          w.sub = 4;
          fireSubstep(w);
        }
        let past = false;
        for (let i = 0; i < w.N; i++) if (i % w.W >= 40 && w.L.lastBurn[i] >= w.yearF - 0.01) past = true;
        if (past) n++;
      }
      return n;
    };
    expect(crosses(0.05)).toBe(0);
    expect(crosses(1.5)).toBe(4);
  });
});
