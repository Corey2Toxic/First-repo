import { describe, expect, it } from 'vitest';
import { generateWorld } from '../../src/sim/gen/index.ts';
import { makeConfig } from '../../src/sim/scenarios.ts';
import { Simulation } from '../../src/sim/sim.ts';
import { vegetationSummary } from '../../src/sim/systems/vegetation.ts';
import { applyFireEffects } from '../../src/sim/systems/fire.ts';
import { beetlesMonthly, beetleWinterKill } from '../../src/sim/systems/beetles.ts';
import { deerCount } from '../../src/sim/systems/wildlife.ts';
import { smallWorld } from '../helpers.ts';

describe('ecology', () => {
  it('without fire, shade-tolerant fir gains on aspen and fuels accumulate', () => {
    const w = smallWorld('tinderbox', 'succ-1');
    const before = vegetationSummary(w);
    const sim = new Simulation(w, {}, { ignitions: false, autoReview: true });
    sim.runDays(360 * 20);
    const after = vegetationSummary(w);
    expect(after.fir / Math.max(1e-6, after.aspen)).toBeGreaterThan(before.fir / Math.max(1e-6, before.aspen));
    expect(after.aspen).toBeLessThan(before.aspen);
    expect(after.hazard).toBeGreaterThanOrEqual(before.hazard - 0.01);
  }, 180000);

  it('aspen clones resprout after severe fire', () => {
    const w = smallWorld('firstseason', 'aspen-1');
    const cells: number[] = [];
    for (let i = 0; i < w.N && cells.length < 40; i++) if (w.L.aspen[i] > 0.2 && w.L.aroot[i] > 0.3) cells.push(i);
    expect(cells.length).toBeGreaterThan(10);
    for (const c of cells) applyFireEffects(w, c, 3);
    for (const c of cells) expect(w.L.aspen[c]).toBe(0);
    const sim = new Simulation(w, {}, { ignitions: false, autoReview: true });
    sim.runDays(360 * 2);
    const regrown = cells.filter((c) => w.L.aspen[c] > 0.02 && w.L.ageA[c] < 3).length;
    expect(regrown).toBeGreaterThan(cells.length * 0.5);
  }, 120000);

  it('wolves keep deer numbers and browsing down (trophic cascade)', () => {
    const run = (wolves: number) => {
      const w = generateWorld(makeConfig('custom', 'cascade-1', 'small', { wolves, herds: 24, beavers: 2 }));
      const sim = new Simulation(w, {}, { ignitions: false, autoReview: true });
      let browse = 0,
        n = 0;
      for (let y = 0; y < 12; y++) {
        sim.runDays(360);
        if (y >= 6) {
          for (let i = 0; i < w.N; i += 5) browse += w.L.browse[i];
          n++;
        }
      }
      return { deer: deerCount(w), browse: browse / n, packs: w.packs.length };
    };
    const without = run(0);
    const withWolves = run(3);
    expect(withWolves.packs).toBeGreaterThan(0);
    expect(withWolves.deer).toBeLessThan(without.deer);
    expect(withWolves.browse).toBeLessThan(without.browse);
  }, 300000);

  it('bark beetles erupt in drought-stressed pine after mild winters, not after cold ones', () => {
    const outbreak = (winterMin: number) => {
      const w = smallWorld('tinderbox', 'beetle-1');
      for (let i = 0; i < w.N; i++) {
        if (w.L.pine[i] > 0.15) {
          w.L.stress[i] = 0.7;
          w.L.ageP[i] = Math.max(w.L.ageP[i], 90);
          w.L.beetle[i] = 0.05;
        }
      }
      w.climate.winterMin = winterMin;
      beetleWinterKill(w);
      w.climate.yearTemp = 1;
      let pineBefore = 0;
      for (let i = 0; i < w.N; i++) pineBefore += w.L.pine[i];
      for (const m of [3, 4, 5, 6]) {
        w.day = m * 30;
        beetlesMonthly(w);
      }
      let pineAfter = 0,
        red = 0;
      for (let i = 0; i < w.N; i++) {
        pineAfter += w.L.pine[i];
        red += w.L.red[i];
      }
      return { killed: 1 - pineAfter / pineBefore, red };
    };
    const mild = outbreak(-12);
    const cold = outbreak(-34);
    expect(mild.killed).toBeGreaterThan(0.01);
    expect(mild.red).toBeGreaterThan(cold.red);
    expect(mild.killed).toBeGreaterThan(cold.killed * 1.5);
  });
});
