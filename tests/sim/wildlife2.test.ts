/**
 * Wildlife rules changed in 2.0, each a defect measured on 1.1.1 (see docs/V2_REPORT.md):
 * forage that was eaten but stayed on the range, small packs that killed twice what they ate,
 * a pack deleted the day it fell to one wolf, and hunting revenue that grew with an irruption.
 */
import { describe, expect, it } from 'vitest';
import { smallWorld } from '../helpers.ts';
import { DEER_INTAKE, wildlifeDaily } from '../../src/sim/systems/wildlife.ts';
import { applyCommand } from '../../src/sim/commands.ts';
import { objectives } from '../../src/sim/objectives.ts';
import type { Herd, Pack } from '../../src/sim/types.ts';
import type { World } from '../../src/sim/world.ts';

/** Forage units on the ground a herd at (x, y) can reach, as the herd's own feeding counts them (snow-free). */
function stock(w: World, x: number, y: number, r: number): number {
  let s = 0;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      if (!w.inside(x + dx, y + dy)) continue;
      const i = (y + dy) * w.W + x + dx;
      if (w.L.water[i] >= 2) continue;
      s += w.L.grass[i] + w.L.shrub[i];
    }
  return s;
}

describe('wildlife (v2)', () => {
  it('what deer eat leaves the range (1.1.1: 6-19 % of a winter\'s intake did)', () => {
    const w = smallWorld('firstseason', 'eat-1');
    w.packs = [];
    const h0 = w.herds[0];
    const hx = Math.floor(h0.x),
      hy = Math.floor(h0.y);
    // one large herd held on a snow-free patch through 60 autumn days, nothing regrowing
    w.herds = [{ ...h0, id: 9001, n: 60, cond: 0.8, fed: 1 } as Herd];
    w.day = 250;
    for (let i = 0; i < w.N; i++) w.L.snow[i] = 0;
    const before = stock(w, hx, hy, 5);
    let eaten = 0;
    for (let d = 0; d < 60; d++) {
      const h = w.herds[0];
      h.x = h0.x;
      h.y = h0.y;
      wildlifeDaily(w);
      eaten += h.n * DEER_INTAKE * h.fed;
      w.day++;
      if (w.doy % 30 === 0) w.day++; // skip the monthly demography: the test is about the range
    }
    const after = stock(w, hx, hy, 5);
    const removed = before - after;
    expect(eaten).toBeGreaterThan(5);
    // the cover that went is of the order of what was eaten (cover and forage units are not the
    // same thing, and cured grass counts for less than its cover: within a factor of three)
    expect(removed).toBeGreaterThan(eaten * 0.6);
    expect(removed).toBeLessThan(eaten * 3.5);
  });

  it('a small pack kills what it eats: about twenty deer a wolf a year (1.1.1: 25-45)', () => {
    let perWolf = 0;
    const seeds = ['kill-1', 'kill-2', 'kill-3'];
    for (const seed of seeds) {
      const w = smallWorld('tinderbox', seed);
      // plenty of deer everywhere, one pack of three, a year of hunting with the pack held at three
      const base = w.herds.slice();
      w.herds = [];
      for (let k = 0; k < 4; k++) for (const h of base) w.herds.push({ ...h, id: 20000 + w.herds.length, x: h.x + k, y: h.y + k * 0.5, n: 40, cond: 0.75 } as Herd);
      const p0 = w.packs[0] ?? ({ id: 1, name: 'Test Pack', x: w.W / 2, y: w.H / 2, px: 0, py: 0, n: 3, tx: w.W / 2, ty: w.H / 2, hunger: 0.2, targetHerd: -1, kills: 0, founded: 0 } as Pack);
      p0.n = 3;
      p0.kills = 0;
      p0.hunger = 0.2;
      w.packs = [p0];
      for (let d = 0; d < 360; d++) {
        wildlifeDaily(w);
        p0.n = 3;
        for (const h of w.herds) if (h.n < 30) h.n = 40;
        w.day++;
      }
      perWolf += p0.kills / 3;
    }
    perWolf /= seeds.length;
    expect(perWolf).toBeGreaterThan(13);
    expect(perWolf).toBeLessThan(26);
  });

  it('a pack reduced to one wolf holds its territory, and in time pairs or is gone (1.1.1: deleted at once)', () => {
    let held = 0,
      paired = 0,
      gone = 0;
    for (const seed of ['lone-1', 'lone-2', 'lone-3', 'lone-4', 'lone-5', 'lone-6']) {
      const w = smallWorld('tinderbox', seed);
      const p0 = w.packs[0] ?? ({ id: 1, name: 'Test Pack', x: w.W / 2, y: w.H / 2, px: 0, py: 0, n: 1, tx: w.W / 2, ty: w.H / 2, hunger: 0, targetHerd: -1, kills: 0, founded: 0 } as Pack);
      p0.n = 1;
      p0.hunger = 0;
      w.packs = [p0];
      // to midsummer: no disperser has had the chance to pair with it yet
      for (let d = 0; d < 200; d++) {
        wildlifeDaily(w);
        w.day++;
      }
      const mine = w.packs.find((p) => p.id === p0.id);
      if (mine && mine.n === 1) {
        held++;
        expect(mine.lone).toBeDefined();
      }
      // two more years: it has found a mate, or the territory is vacant again
      for (let d = 0; d < 720; d++) {
        wildlifeDaily(w);
        w.day++;
      }
      const later = w.packs.find((p) => p.id === p0.id);
      if (!later) gone++;
      else if (later.n >= 2) paired++;
      else expect(w.day - (later.lone ?? w.day)).toBeLessThanOrEqual(540);
    }
    // most lone wolves are still there after 200 days (some die: 12 % a year)
    expect(held).toBeGreaterThanOrEqual(4);
    // and both endings happen
    expect(paired + gone).toBeGreaterThanOrEqual(5);
    expect(paired).toBeGreaterThan(0);
  });

  it('hunting tags sell at full price only up to what the valley can host', () => {
    const revenue = (deerPerHerd: number) => {
      const w = smallWorld('tinderbox', 'tags-1');
      w.packs = [];
      w.policies.hunting = 'heavy';
      for (const h of w.herds) h.n = deerPerHerd;
      w.day = 8 * 30; // the hunting month
      const before = w.economy.ledger.income['Hunting licenses'] ?? 0;
      wildlifeDaily(w);
      return { money: (w.economy.ledger.income['Hunting licenses'] ?? 0) - before, taken: w.counters.yearHunted, cap: Math.round((w.N / 100) * 0.6) };
    };
    const few = revenue(20),
      many = revenue(2000);
    expect(few.taken).toBeLessThanOrEqual(few.cap);
    expect(few.money).toBeCloseTo(few.taken * 320, -2);
    // an irruption is not a windfall: a hundred times the deer, a few times the money
    expect(many.taken).toBeGreaterThan(many.cap * 10);
    expect(many.money).toBeLessThan(many.taken * 320 * 0.35);
    expect(many.money).toBeGreaterThan(few.money);
  });
  it('no wolves walk into a valley set up without them until the warden brings some back', () => {
    // 1.1.1 and 2.0 until its last week: a pair settled in Silent Woods ("no wolves for eighty
    // years") within about four years, and a passive warden had wolves for 61-97 % of a tenure
    const w = smallWorld('silentwoods', 'silent-1');
    expect(w.config.wolves).toBe(0);
    expect(w.packs.length).toBe(0);
    for (let d = 0; d < 360 * 12; d++) {
      w.day++;
      wildlifeDaily(w);
    }
    expect(w.packs.length).toBe(0);
    // the same twelve autumns in a valley that has wolves in its country bring a pair
    const w2 = smallWorld('silentwoods', 'silent-1');
    w2.config.wolves = 1;
    let arrived = false;
    for (let d = 0; d < 360 * 12 && !arrived; d++) {
      w2.day++;
      wildlifeDaily(w2);
      arrived = w2.packs.length > 0;
    }
    expect(arrived).toBe(true);
    // a release puts the valley back on the wolves' map
    let cell = -1;
    for (let i = 0; i < w.N && cell < 0; i++) {
      const x = i % w.W,
        y = (i / w.W) | 0;
      if (w.L.water[i] < 2 && w.towns.every((t) => Math.hypot(t.x - x, t.y - y) > 18)) cell = i;
    }
    expect(applyCommand(w, { t: 'reintroduceWolves', cell }).ok).toBe(true);
    expect(w.packs.length).toBe(1);
    expect(w.memory.wolfReleases).toBe(1);
  });

  it("Silent Woods' third charge follows the herd: five deer per km² or fewer over five years", () => {
    const w = smallWorld('silentwoods', 'silent-2');
    const deer = () => objectives(w).find((o) => o.id === 'deer')!;
    let land = 0;
    for (let i = 0; i < w.N; i += 5) if (w.L.water[i] < 2) land += 5;
    const km2 = land / 100;
    w.stats.deer = Array.from({ length: 80 }, () => Math.round(12 * km2));
    expect(deer().progress).toBeCloseTo(5 / 12, 1);
    expect(deer().progress).toBeLessThan(1);
    expect(deer().reading).toContain('12.0 deer per km²');
    // the last five years count, not the years before
    w.stats.deer = [...Array.from({ length: 40 }, () => Math.round(12 * km2)), ...Array.from({ length: 60 }, () => Math.round(3 * km2))];
    expect(deer().progress).toBe(1);
    expect(deer().state).toBe('met');
  });
});
