import { describe, expect, it } from 'vitest';
import { flatWorld } from '../helpers.ts';
import { applyFireEffects, fireSubstep, grassHeadRateKmh, lengthToBreadth, moistureDamping, projectContains, startFire, surfaceHeadRate } from '../../src/sim/systems/fire.ts';
import { cellFuel } from '../../src/sim/systems/fuels.ts';
import { createProject, igniteProjectBurn } from '../../src/sim/systems/projects.ts';
import { FIRE } from '../../src/sim/types.ts';
import type { Town } from '../../src/sim/types.ts';
import type { World } from '../../src/sim/world.ts';
import { Rng } from '../../src/sim/rng.ts';
import { townsYearly } from '../../src/sim/systems/towns.ts';
import { decodeWorld, encodeWorld } from '../../src/sim/save.ts';

function burn(w: World, steps: number): void {
  for (let s = 0; s < steps && w.burning.length > 0; s++) {
    w.sub = 4; // keep afternoon conditions for controlled experiments
    fireSubstep(w);
  }
}

function extent(w: World, fid: number) {
  let minX = Infinity,
    maxX = -Infinity;
  for (let i = 0; i < w.N; i++) {
    const burned = w.L.fid[i] === fid || w.L.lastBurn[i] > 0;
    if (!burned) continue;
    const x = i % w.W;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  }
  return { minX, maxX };
}

describe('fire behaviour', () => {
  it('Rothermel damping falls from 1 to 0 as moisture approaches extinction', () => {
    expect(moistureDamping(0)).toBe(1);
    expect(moistureDamping(1)).toBe(0);
    let prev = 1;
    for (let r = 0.05; r < 1; r += 0.05) {
      const d = moistureDamping(r);
      expect(d).toBeLessThanOrEqual(prev + 1e-9);
      prev = d;
    }
  });

  it('spreads farther downwind than upwind (aggregate of stochastic runs)', () => {
    let down = 0,
      up = 0,
      area = 0;
    for (let k = 0; k < 8; k++) {
      const w = flatWorld(80, 40);
      w.rng.fire = new Rng('downwind-' + k);
      const fe = startFire(w, 20 * w.W + 40, 'human')!;
      expect(fe).toBeTruthy();
      burn(w, 8);
      const { minX, maxX } = extent(w, fe.id);
      down += maxX - 40;
      up += 40 - minX;
      area += fe.area;
    }
    expect(down).toBeGreaterThan(up * 1.5);
    expect(area).toBeGreaterThan(40);
  });

  it('does not cross open water by surface spread', () => {
    const w = flatWorld(60, 30);
    w.weather.windSpeed = 2; // calm: no long-range spotting
    for (let y = 0; y < w.H; y++) w.L.water[y * w.W + 30] = 2; // a lake strip
    const fe = startFire(w, 15 * w.W + 25, 'human')!;
    burn(w, 40);
    for (let y = 0; y < w.H; y++) for (let x = 31; x < w.W; x++) expect(w.L.fid[y * w.W + x]).not.toBe(fe.id);
  });

  it('wet fuels do not carry fire', () => {
    const w = flatWorld(40, 30, { fm: 0.32 });
    const fe = startFire(w, 15 * w.W + 20, 'human')!;
    burn(w, 16);
    expect(fe.area).toBeLessThanOrEqual(3);
  });

  it('a crown fire kills fir while a low-severity fire spares mature pine', () => {
    const w = flatWorld(10, 10, { pine: 0.5, fir: 0.3 });
    const a = 5 * w.W + 2,
      b = 5 * w.W + 7;
    w.L.ageP[a] = w.L.ageP[b] = 150;
    applyFireEffects(w, a, 1);
    applyFireEffects(w, b, 3);
    expect(w.L.pine[a]).toBeGreaterThan(0.4); // thick bark survives
    expect(w.L.fir[a]).toBeLessThan(0.2); // thin bark does not
    expect(w.L.pine[b]).toBeLessThan(0.02);
    expect(w.L.fir[b]).toBe(0);
    expect(w.L.snag[b]).toBeGreaterThan(w.L.snag[a]); // dead trees become snags
    expect(w.L.burnSev[b]).toBe(3);
  });

  it('ladder fuels let surface fire climb into the crowns', () => {
    const run = (ladder: boolean) => {
      let crown = 0;
      for (let k = 0; k < 5; k++) {
        const w = flatWorld(60, 40, { grass: 0.2, pine: 0.55, fir: 0.25, litter: 16, ladder });
        w.rng.fire = new Rng('ladder-' + k);
        w.weather.windSpeed = 9;
        const fe = startFire(w, 20 * w.W + 15, 'lightning')!;
        burn(w, 10);
        crown += fe.crownArea;
      }
      return crown;
    };
    const withLadder = run(true);
    expect(withLadder).toBeGreaterThan(0);
    expect(withLadder).toBeGreaterThan(run(false) * 2);
  });

  it('burnt cells are released when a fire goes out', () => {
    const w = flatWorld(30, 20, { fm: 0.12 });
    const fe = startFire(w, 10 * w.W + 10, 'human')!;
    for (let s = 0; s < 200 && fe.active; s++) {
      w.sub = s % 8;
      fireSubstep(w);
    }
    expect(fe.active).toBe(false);
    for (let i = 0; i < w.N; i++) expect(w.L.fire[i]).toBe(FIRE.NONE);
  });

  it('homes built inside a burn unit while it waited are cut out of it before lighting', () => {
    const w = flatWorld(40, 30, { fm: 0.12 });
    const unit: number[] = [];
    for (let y = 10; y < 16; y++) for (let x = 10; x < 18; x++) unit.push(y * w.W + x);
    const pr = createProject(w, 'burn', unit)!;
    expect(pr.unit.length).toBe(unit.length);
    const house = 12 * w.W + 13;
    expect(projectContains(w, pr.id, house)).toBe(true); // membership is cached from here on
    w.L.town[house] = 1; // the town grew into the unit before the weather window came
    expect(igniteProjectBurn(w, pr)).not.toBeNull();
    expect(pr.unit).not.toContain(house);
    expect(projectContains(w, pr.id, house)).toBe(false); // so fire reaching it is an escape
    // a unit that has been built over entirely is called off
    const pr2 = createProject(w, 'burn', [20 * w.W + 30, 20 * w.W + 31])!;
    for (const c of pr2.unit) w.L.town[c] = 1;
    expect(igniteProjectBurn(w, pr2)).toBeNull();
    expect(pr2.status).toBe('cancelled');
  });

  /** A grass strip that ends at one isolated house: the house is outside the fuel the fire spreads through. */
  function stripToHouse(seed: string): { w: World; house: number } {
    const w = flatWorld(40, 20, { grass: 0, litter: 0, fm: 0.05 });
    for (let i = 0; i < w.N; i++) w.L.dead[i] = 0;
    for (let y = 8; y <= 12; y++)
      for (let x = 5; x <= 19; x++) {
        const i = y * w.W + x;
        w.L.grass[i] = 0.9;
        w.L.litter[i] = 6;
        w.L.shrub[i] = 0.3;
      }
    const town: Town = { id: 0, name: 'T', x: 20, y: 10, population: 100, structures: 1, lostStructures: 0, mill: false, station: 10 * w.W + 20, firewise: 0, smokeToday: 0, smokeDays: 0, threat: 0, evacuated: false, growthPressure: 0, happiness: 0.5 };
    w.towns.push(town);
    const house = 10 * w.W + 20;
    w.L.town[house] = 1;
    w.weather.windSpeed = 9;
    w.climate.droughtIndex = 0.7;
    w.rng.fire = new Rng(seed);
    return { w, house };
  }

  it('houses burned outside the spread front are released when the fire ends, and can burn again when rebuilt (D1)', () => {
    let lost = 0,
      reburned = 0;
    for (let k = 0; k < 120 && reburned === 0; k++) {
      const { w, house } = stripToHouse('d1-' + k);
      const fe = startFire(w, 10 * w.W + 18, 'human')!;
      for (let s = 0; s < 300 && w.burning.length; s++) {
        w.sub = 4;
        fireSubstep(w);
      }
      expect(fe.active).toBe(false);
      if (w.L.town[house] >= 0) continue;
      lost++;
      // nothing the fire touched may stay BURNT once it is out — houses included
      for (let i = 0; i < w.N; i++) expect(w.L.fire[i]).toBe(FIRE.NONE);
      expect(fe.maxX).toBeGreaterThanOrEqual(20); // the house is inside the fire's box
      for (let y = 0; y < 30 && w.L.town[house] < 0; y++) townsYearly(w);
      expect(w.L.town[house]).toBe(1);
      // the rebuilt house is as vulnerable as the first one: burn the strip again until it goes
      for (let t = 0; t < 60 && w.L.town[house] > 0; t++) {
        for (let y = 8; y <= 12; y++)
          for (let x = 5; x <= 19; x++) {
            const i = y * w.W + x;
            w.L.grass[i] = 0.9;
            w.L.litter[i] = 6;
          }
        startFire(w, 10 * w.W + 18, 'human');
        for (let s = 0; s < 300 && w.burning.length; s++) {
          w.sub = 4;
          fireSubstep(w);
        }
      }
      if (w.L.town[house] < 0) reburned++;
    }
    expect(lost).toBeGreaterThan(0);
    expect(reburned).toBeGreaterThan(0);
  });

  it('loading a v1.0 save repairs burned houses that were never released', () => {
    const { w, house } = stripToHouse('d1-save');
    w.L.town[house] = 1;
    w.L.fire[house] = FIRE.BURNT; // state left behind by the v1.0 bug
    w.L.fid[house] = 424242; // a fire that no longer exists
    const w2 = decodeWorld(encodeWorld(w));
    expect(w2.L.fire[house]).toBe(FIRE.NONE);
    expect(w2.L.fid[house]).toBe(-1);
  });

  /** Head-fire distance (m/h) after one 3-hour afternoon step, mean of `n` replicate fires. */
  function headRate(opts: Parameters<typeof flatWorld>[2], wind: number, n = 8): number {
    let sum = 0;
    for (let k = 0; k < n; k++) {
      const w = flatWorld(400, 31, opts);
      w.rng.fire = new Rng('head-' + k + JSON.stringify(opts) + wind);
      w.weather.windSpeed = wind;
      const fe = startFire(w, 15 * w.W + 10, 'human')!;
      w.sub = 4;
      fireSubstep(w);
      let hx = 0;
      for (let i = 0; i < w.N; i++) if (w.L.fid[i] === fe.id && Math.abs(((i / w.W) | 0) - 15) <= 1) hx = Math.max(hx, (i % w.W) - 10);
      sum += (hx * 100) / 3;
    }
    return sum / n;
  }

  it('cured grass out-runs timber litter, and crown fire out-runs surface fire in the same timber (audit: inverted ordering)', () => {
    const grass = { grass: 0.85, litter: 0.4, pine: 0, fir: 0 };
    const pine = { grass: 0.25, pine: 0.55, litter: 8, fir: 0 };
    for (const U of [3, 6, 12]) {
      const g = headRate(grass, U),
        p = headRate(pine, U);
      expect(g).toBeGreaterThan(3 * p);
    }
    // published cured-grass head-fire rates at moderate wind are ~1–8 km/h; with the documented
    // heterogeneity factor the game's grass runs ~1–3 km/h in a 6 m/s afternoon wind (v1.0: 40 m/h)
    const g6 = headRate(grass, 6);
    expect(g6).toBeGreaterThan(800);
    expect(g6).toBeLessThan(4000);
    // a long-needle pine litter surface fire runs tens to hundreds of m/h (v1.0: ~5–20 m/h)
    const p6 = headRate(pine, 6);
    expect(p6).toBeGreaterThan(40);
    expect(p6).toBeLessThan(500);
  });

  it('the simulated front advances at the rate the model specifies (no first-passage speed-up)', () => {
    // no wind: isotropic; the front should cover ~R·t, not several times it (v1.0: 3.7x)
    const w0 = flatWorld(10, 10, { grass: 0.85, litter: 0.4 });
    w0.weather.windSpeed = 0.3;
    const f = cellFuel(w0, 55);
    const di = 1.16; // diurnal spread factor at 15:00
    const fm = w0.L.fm[55] - 0.015 + f.green * (0.06 + 0.06 * f.grassShare);
    const spec = surfaceHeadRate(w0, 55, f, 0.3 * 1.26) * moistureDamping(fm / (0.15 + 0.13 * (1 - f.grassShare))) * di;
    let sum = 0;
    const n = 8;
    for (let k = 0; k < n; k++) {
      const w = flatWorld(121, 121, { grass: 0.85, litter: 0.4 });
      w.rng.fire = new Rng('fpp-' + k);
      w.weather.windSpeed = 0.3;
      const fe = startFire(w, 60 * w.W + 60, 'human')!;
      for (let s = 0; s < 4; s++) {
        w.sub = 4;
        fireSubstep(w);
      }
      let ex = 0;
      for (let i = 0; i < w.N; i++) if (w.L.fid[i] === fe.id && ((i / w.W) | 0) === 60) ex = Math.max(ex, (i % w.W) - 60);
      sum += (ex * 100) / 12;
    }
    const measured = sum / n;
    expect(measured / spec).toBeGreaterThan(0.6);
    expect(measured / spec).toBeLessThan(1.6);
  });

  it('rate building blocks follow the published forms', () => {
    // CSIRO grassland model: ~1 km/h at 3.6 km/h wind, ~10 km/h at 20 km/h (before moisture/curing)
    expect(grassHeadRateKmh(3.6)).toBeCloseTo(0.054 + 0.269 * 3.6, 6);
    expect(grassHeadRateKmh(20)).toBeGreaterThan(8);
    expect(grassHeadRateKmh(20)).toBeLessThan(11);
    // fires elongate with wind; grass fires more than forest fires; never beyond 8:1
    expect(lengthToBreadth(0, 0)).toBeCloseTo(1, 6);
    expect(lengthToBreadth(30, 1)).toBeGreaterThan(lengthToBreadth(30, 0));
    expect(lengthToBreadth(30, 0)).toBeGreaterThan(lengthToBreadth(10, 0));
    expect(lengthToBreadth(200, 1)).toBeLessThanOrEqual(8);
  });

  it('ground burned this season has no cured grass to carry a second fire', () => {
    const run = (burnedThisSeason: boolean) => {
      let area = 0;
      for (let k = 0; k < 6; k++) {
        const w = flatWorld(80, 30, { grass: 0.85, litter: 0.4 });
        w.rng.fire = new Rng('reburn-' + k);
        if (burnedThisSeason) for (let i = 0; i < w.N; i++) w.L.lastBurn[i] = w.yearF - 0.1;
        const fe = startFire(w, 15 * w.W + 10, 'human')!;
        burn(w, 4);
        area += fe.area;
      }
      return area;
    };
    expect(run(true)).toBeLessThan(run(false) * 0.2);
  });

  it('a road stops a light-wind grass fire more often than not', () => {
    let crossed = 0,
      reached = 0;
    for (let k = 0; k < 12; k++) {
      const w = flatWorld(60, 30, { grass: 0.85, litter: 0.4 });
      w.rng.fire = new Rng('road-' + k);
      w.weather.windSpeed = 2;
      for (let y = 0; y < w.H; y++) w.L.infra[y * w.W + 30] |= 1; // a road across the strip
      const fe = startFire(w, 15 * w.W + 22, 'human')!;
      burn(w, 6);
      let past = false,
        at = false;
      for (let i = 0; i < w.N; i++) {
        if (w.L.fid[i] !== fe.id && !(w.L.lastBurn[i] > 0)) continue;
        if (i % w.W === 29) at = true;
        if (i % w.W > 31) past = true;
      }
      if (at) reached++;
      if (past) crossed++;
    }
    expect(reached).toBeGreaterThan(6);
    expect(crossed).toBeLessThan(reached / 2); // v1.0/v1.1-early: a road only halved the rate
  });
  it('a head fire runs about as far whatever the wind direction is relative to the grid', () => {
    // v1.1's first elliptical spread on 8 neighbours ran 4x slower with the wind between them
    const head = (ang: number) => {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const w = flatWorld(150, 150, { grass: 0.85, litter: 0.4, fm: 0.05 });
        w.rng.fire = new Rng(`aniso-${ang}-${k}`);
        w.weather.windSpeed = 9;
        w.weather.windDir = ang;
        const fe = startFire(w, 15 * w.W + 15, 'human')!;
        burn(w, 1);
        let best = 0;
        for (let i = 0; i < w.N; i++) {
          if (w.L.fid[i] !== fe.id) continue;
          const x = (i % w.W) - 15,
            y = ((i / w.W) | 0) - 15;
          best = Math.max(best, x * Math.cos(ang) + y * Math.sin(ang));
        }
        sum += best;
      }
      return sum / 4;
    };
    const axis = head(0),
      off = head(Math.PI / 8),
      diag = head(Math.PI / 4);
    expect(axis).toBeGreaterThan(20);
    for (const r of [off / axis, diag / axis]) {
      expect(r).toBeGreaterThan(0.85);
      expect(r).toBeLessThan(1.25);
    }
  });
});
