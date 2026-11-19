import { describe, expect, it } from 'vitest';
import { generateWorld } from '../../src/sim/gen/index.ts';
import { makeConfig } from '../../src/sim/scenarios.ts';
import { Simulation } from '../../src/sim/sim.ts';
import { vegetationSummary } from '../../src/sim/systems/vegetation.ts';
import { applyFireEffects } from '../../src/sim/systems/fire.ts';
import { beetlesMonthly, beetleWinterKill, seedBeetles } from '../../src/sim/systems/beetles.ts';
import { deerCount, wildlifeDaily, TERRITORY_RADIUS } from '../../src/sim/systems/wildlife.ts';
import type { Herd } from '../../src/sim/types.ts';
import { applyPlanting } from '../../src/sim/systems/projects.ts';
import { SP } from '../../src/sim/types.ts';
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
          w.L.dstress[i] = 0.4; // years of drought, not one dry summer
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

  it('deer that crowd the same winter range end thinner (audit: condition was independent of numbers)', () => {
    /** `k` herds of 30 held on one patch of snowy winter range for 45 days; mean condition after. */
    const cond = (k: number) => {
      const w = smallWorld('firstseason', 'herd-size');
      w.packs = [];
      const h0 = w.herds[0];
      w.herds = Array.from({ length: k }, (_, j): Herd => ({ ...h0, id: 9000 + j, n: 30, cond: 0.8, fed: 1 }));
      w.day = 300; // Still (winter): snow buries most of the grass
      const hx = Math.floor(h0.x),
        hy = Math.floor(h0.y);
      for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) if (w.inside(hx + dx, hy + dy)) w.L.snow[(hy + dy) * w.W + hx + dx] = 80;
      for (let d = 0; d < 45; d++) {
        for (const h of w.herds) {
          h.x = h0.x; // hold the herds in place: the test is about sharing a range
          h.y = h0.y;
        }
        wildlifeDaily(w);
        w.day++;
      }
      return w.herds.reduce((a, h) => a + h.cond, 0) / w.herds.length;
    };
    const one = cond(1),
      ten = cond(10),
      thirty = cond(30);
    expect(one).toBeGreaterThanOrEqual(ten);
    expect(ten).toBeGreaterThan(thirty);
    expect(one - thirty).toBeGreaterThan(0.05); // v1.0: identical whatever the crowding
  });

  it('beaver pairs that found a colony breed and grow it (audit D5)', () => {
    const w = smallWorld('firstseason', 'beaver-pair');
    const c0 = w.colonies[0];
    // a dispersing pair founds a new colony beside good food
    w.colonies = [{ ...c0, id: 999, n: 2, years: 0, dam: 0.05 }];
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const i = c0.cell + dy * w.W + dx;
        w.L.aspen[i] = Math.max(w.L.aspen[i], 0.3);
        w.L.shrub[i] = Math.max(w.L.shrub[i], 0.4);
      }
    w.packs = [];
    const sim = new Simulation(w, {}, { ignitions: false, autoReview: true });
    sim.runDays(360 * 3);
    const c = w.colonies.find((x) => x.id === 999)!;
    expect(c.active).toBe(true);
    expect(c.n).toBeGreaterThan(2); // v1.0: stuck at 2 for the rest of the run
  }, 120000);

  it('wolf numbers are bounded by territory and prey, not boom-and-bust', () => {
    const w = generateWorld(makeConfig('custom', 'wolf-bound', 'medium', { wolves: 2, herds: 30 }));
    const sim = new Simulation(w, {}, { ignitions: false, autoReview: true });
    const areaKm2 = (w.W * w.H) / 100;
    let maxDensity = 0,
      wolfYears = 0;
    for (let y = 0; y < 20; y++) {
      sim.runDays(360);
      const wolves = w.packs.reduce((a, p) => a + p.n, 0);
      maxDensity = Math.max(maxDensity, (wolves / areaKm2) * 100);
      if (wolves > 0) wolfYears++;
      // no two territories closer than the spacing that bounds pack density
      for (const a of w.packs) for (const b of w.packs) if (a !== b) expect(Math.hypot(a.tx - b.tx, a.ty - b.ty)).toBeGreaterThan(TERRITORY_RADIUS * 0.5);
    }
    // field densities: typically 1–5 wolves per 100 km², rarely above ~10 (v1.0 reached 15)
    expect(maxDensity).toBeLessThan(10);
    expect(wolfYears).toBeGreaterThanOrEqual(15);
  }, 300000);

  it('planting adds a young cohort instead of resetting old trees to age 1 (D4)', () => {
    const w = smallWorld('firstseason', 'plant-age');
    const i = 10 * w.W + 10;
    w.L.pine[i] = 0.35;
    w.L.ageP[i] = 170;
    applyPlanting(w, i, SP.PINE);
    expect(w.L.pine[i]).toBeCloseTo(0.44, 5);
    expect(w.L.ageP[i]).toBeGreaterThan(130); // v1.0: 1
    expect(w.L.ageP[i]).toBeLessThan(170);
    // open ground: the cohort is the seedlings
    const j = 12 * w.W + 12;
    w.L.fir[j] = 0;
    w.L.ageF[j] = 0;
    applyPlanting(w, j, SP.FIR);
    expect(w.L.ageF[j]).toBeCloseTo(1, 5);
  });

  it('a colony reduced below a breeding pair does not carry on as a ghost (count 0 or negative, still active)', () => {
    for (const n of [1, 0, -2]) {
      const w = smallWorld('firstseason', 'ghost-1');
      w.packs = [];
      const c = w.colonies[0];
      c.n = n; // what wolf predation left (v1.0 could drive it below zero)
      w.day = 150; // a monthly update outside the breeding month
      wildlifeDaily(w);
      expect(c.active === false || c.n >= 2).toBe(true);
    }
  });

  it('bark beetles erupt in old, crowded pine only after years of drought', () => {
    const run = (dstress: number) => {
      const w = smallWorld('tinderbox', 'beetle-2');
      for (let i = 0; i < w.N; i++)
        if (w.L.pine[i] > 0.15) {
          w.L.pine[i] = Math.max(w.L.pine[i], 0.55);
          w.L.ageP[i] = 120;
          w.L.dstress[i] = dstress;
        }
      seedBeetles(w);
      let killed = 0;
      for (let y = 0; y < 3; y++)
        for (const m of [3, 4, 5, 6]) {
          w.day = y * 360 + m * 30;
          const before = w.L.pine.reduce((a, b) => a + b, 0);
          beetlesMonthly(w);
          killed += before - w.L.pine.reduce((a, b) => a + b, 0);
        }
      return killed;
    };
    const normal = run(0.03),
      drought = run(0.15);
    expect(drought).toBeGreaterThan(10);
    expect(drought).toBeGreaterThan(normal * 3);
  });

  it('old growth is lost to stand-replacing disturbance, not to seedlings (stand age)', () => {
    const w = smallWorld('firstseason', 'og-1');
    const i = 10 * w.W + 10;
    w.L.pine[i] = 0.5;
    w.L.fir[i] = 0;
    w.L.aspen[i] = 0;
    w.L.ageP[i] = 180;
    w.L.standAge[i] = 180;
    applyPlanting(w, i, SP.PINE);
    expect(w.L.standAge[i]).toBe(180); // recruits do not make the stand young
    applyFireEffects(w, i, 3); // a crown fire kills the stand
    const sim = new Simulation(w, {}, { ignitions: false, autoReview: true });
    sim.runDays(31);
    expect(w.L.standAge[i]).toBeLessThan(1);
  });
});
