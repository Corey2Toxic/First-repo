import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/sim/sim.ts';
import { decodeWorld, encodeWorld, stateHash } from '../../src/sim/save.ts';
import { humanActivity } from '../../src/sim/systems/fire.ts';
import { loseStructure, townsYearly } from '../../src/sim/systems/towns.ts';
import type { World } from '../../src/sim/world.ts';
import { smallWorld } from '../helpers.ts';

/**
 * Audit R1 (verification of 1.1): the human-ignition cache was rebuilt only when the road, camp or
 * zoning counters changed, but its weights also depend on where houses stand. Losing a house bumped
 * the counter; rebuilding one did not. A long-running game kept stale weights while a reloaded game
 * rebuilt them fresh, so after a year with rebuilt houses a reload could change which fires start.
 */

/** A fire year: half of the first town's houses lost, then the year-end rebuild with no growth anywhere. */
function afterRebuild(seed: string): { w: World; rebuilt: number } {
  const w = smallWorld('boomtown', seed);
  humanActivity(w); // the running game has built its cache
  const housed = new Set<number>();
  for (let i = 0; i < w.N; i++) if (w.L.town[i] > 0) housed.add(i);
  const tid = w.towns[0].id + 1;
  const homes = [...housed].filter((i) => w.L.town[i] === tid);
  for (let k = 0; k < homes.length; k += 2) loseStructure(w, homes[k]);
  humanActivity(w); // losses invalidate the cache, which is rebuilt without those houses
  // after a bad fire year nobody needs new homes: no town expands (expansion would bump the counter)
  for (const t of w.towns) t.population = 80;
  const ruins = Math.ceil(homes.length / 2);
  townsYearly(w);
  let rebuilt = 0;
  for (let i = 0; i < w.N; i++) {
    if (w.L.town[i] <= 0) continue;
    expect(housed.has(i)).toBe(true); // premise: houses only went back where they had stood
    if (w.L.town[i] === tid && homes.indexOf(i) % 2 === 0) rebuilt++;
  }
  expect(rebuilt).toBeLessThanOrEqual(ruins);
  return { w, rebuilt };
}

describe('save and reload after houses are rebuilt (audit R1)', () => {
  it('a running game uses the same human-ignition weights a reloaded game computes', () => {
    const { w, rebuilt } = afterRebuild('r1-cache');
    expect(rebuilt).toBeGreaterThan(0);
    const live = humanActivity(w);
    const fresh = humanActivity(decodeWorld(encodeWorld(w)));
    expect(live.total).toBe(fresh.total); // v1.1: the live cache still counted the ruins' fringe
    expect(Array.from(live.cells)).toEqual(Array.from(fresh.cells));
  });

  it('a game reloaded after a rebuild year continues exactly like the original', () => {
    // human ignition attempts are rare (a few a season), so the stale weights show up only when one
    // lands differently: on this seed the unfixed game diverged 314 days after the reload (3 of 6
    // seeds diverged within a year). The cache test above is the deterministic guard.
    const { w: a } = afterRebuild('r1-fork-3');
    a.day = 150; // into the fire season, when people start fires
    const b = decodeWorld(encodeWorld(a));
    expect(stateHash(b)).toBe(stateHash(a));
    const simA = new Simulation(a, {}, { autoReview: true });
    const simB = new Simulation(b, {}, { autoReview: true });
    simA.runDays(330);
    simB.runDays(330);
    expect(stateHash(b)).toBe(stateHash(a));
  }, 120000);
  it('through years of fires, losses, rebuilding and growth the running cache matches a reload', () => {
    // a general guard: any future change to houses, roads, campgrounds or zoning that forgets to bump
    // the cache counters shows up here as a mismatch at some year end
    const w = smallWorld('boomtown', 'r1-years');
    const sim = new Simulation(w, {}, { autoReview: true });
    const mismatches: string[] = [];
    for (let y = 0; y < 8; y++) {
      sim.runDays(180);
      // a few homes lost every summer (small maps rarely lose any), so each year end rebuilds some
      const t = w.towns[y % w.towns.length];
      const homes: number[] = [];
      for (let i = 0; i < w.N; i++) if (w.L.town[i] === t.id + 1) homes.push(i);
      for (let k = 0; k < Math.min(4, homes.length); k++) loseStructure(w, homes[(k * 7 + y) % homes.length]);
      sim.runDays(180);
      const live = humanActivity(w);
      const fresh = humanActivity(decodeWorld(encodeWorld(w)));
      if (live.total !== fresh.total || live.cells.length !== fresh.cells.length) mismatches.push(`year ${y + 1}: ${live.total} vs ${fresh.total}`);
    }
    expect(mismatches).toEqual([]);
  }, 300000);
});
