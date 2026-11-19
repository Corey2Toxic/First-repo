import { describe, expect, it } from 'vitest';
import { flatWorld } from '../helpers.ts';
import { applyFireEffects, fireSubstep, moistureDamping, projectContains, startFire } from '../../src/sim/systems/fire.ts';
import { createProject, igniteProjectBurn } from '../../src/sim/systems/projects.ts';
import { FIRE } from '../../src/sim/types.ts';
import type { World } from '../../src/sim/world.ts';
import { Rng } from '../../src/sim/rng.ts';

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
});
