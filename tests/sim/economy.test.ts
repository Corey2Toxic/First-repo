import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/sim/sim.ts';
import { applyCommand } from '../../src/sim/commands.ts';
import { generatePetitions } from '../../src/sim/systems/council.ts';
import { bestCampSite, buildCampground, campSiteValid, timberHarvest } from '../../src/sim/systems/economy.ts';
import { MILL_MIN_DEMAND, millCeiling } from '../../src/sim/gen/settle.ts';
import { COST } from '../../src/sim/economyParams.ts';
import { FIRE, INFRA, ZONE } from '../../src/sim/types.ts';
import type { Petition } from '../../src/sim/types.ts';
import type { World } from '../../src/sim/world.ts';
import { smallWorld } from '../helpers.ts';

const PETITION_KEYS = [
  'raise-harvest',
  'salvage',
  'cull-wolves',
  'more-grazing',
  'wilderness',
  'wolves-back',
  'end-clearcuts',
  'protect-homes',
  'smoke-rules',
  'water',
  'lift-ban',
  'campground',
];

/** The petition with this key, if the valley's state calls for it (all other petitions held back). */
function petitionFor(w: World, key: string): Petition | undefined {
  w.memory.lastPetitionYear = Object.fromEntries(PETITION_KEYS.filter((k) => k !== key).map((k) => [k, w.year]));
  return generatePetitions(w).find((p) => p.key === key);
}

function openCouncil(w: World, p: Petition): void {
  w.review.pending = true;
  w.review.petitions = [p];
}

/** One summer of visitors (no wildfires) with `k` campgrounds on the best distinct sites. */
function summerWith(k: number) {
  const w = smallWorld('firstseason', 'econ-camps');
  while (w.camps.length < k) {
    const s = bestCampSite(w);
    expect(s).toBeGreaterThanOrEqual(0);
    buildCampground(w, s);
  }
  new Simulation(w, {}, { ignitions: false, autoReview: true }).runDays(360);
  const ledger = w.economy.history.at(-1)!;
  return { fees: ledger.income['Recreation fees'] ?? 0, visitors: w.economy.visitorsLastYear, turnedAway: w.memory.turnedAwayShare ?? 0 };
}

describe('the valley economy (D6, D7, D8)', () => {
  it('the campground petition builds and charges a real campground (D6)', () => {
    const w = smallWorld('firstseason', 'econ-pet');
    // nobody is turned away: no petition
    w.memory.turnedAwayShare = 0.05;
    expect(petitionFor(w, 'campground')).toBeUndefined();
    // a crowded summer: tourism asks, naming the place
    w.memory.turnedAwayShare = 0.3;
    const p = petitionFor(w, 'campground')!;
    expect(p).toBeDefined();
    expect(p.action.type).toBe('fund');
    const site = (p.action as { cells: number[] }).cells[0];
    expect(campSiteValid(w, site)).toBe(true);
    expect(p.text).toMatch(/km (north|south|east|west)/);
    expect(p.text).toContain('30%');
    const camps = w.camps.length;
    const f0 = w.economy.funds;
    const infra0 = w.economy.ledger.expense['Infrastructure'] ?? 0;
    const a0 = w.factions.tourism.approval;
    openCouncil(w, p);
    expect(applyCommand(w, { t: 'petition', id: p.id, accept: true }).ok).toBe(true);
    expect(w.camps.length).toBe(camps + 1);
    expect(w.camps).toContain(site);
    expect(w.L.infra[site] & INFRA.CAMP).toBeTruthy();
    expect(f0 - w.economy.funds).toBeCloseTo(COST.camp, 3);
    expect((w.economy.ledger.expense['Infrastructure'] ?? 0) - infra0).toBeCloseTo(COST.camp, 3);
    expect(w.factions.tourism.approval).toBeGreaterThan(a0);
    expect(w.memory.pendingCampground).toBeUndefined();
  });

  it('with nowhere left to camp the petition is not offered, and granting a stale one changes nothing (D6)', () => {
    const w = smallWorld('firstseason', 'econ-pet-2');
    w.memory.turnedAwayShare = 0.3;
    const p = petitionFor(w, 'campground')!;
    expect(p).toBeDefined();
    // the whole valley becomes too steep to build on
    w.L.slope.fill(0.5);
    expect(bestCampSite(w)).toBe(-1);
    expect(petitionFor(w, 'campground')).toBeUndefined();
    const camps = w.camps.length;
    const f0 = w.economy.funds;
    const a0 = w.factions.tourism.approval;
    const c0 = w.factions.conservation.approval;
    openCouncil(w, p);
    expect(applyCommand(w, { t: 'petition', id: p.id, accept: true }).ok).toBe(true);
    expect(w.camps.length).toBe(camps);
    expect(w.economy.funds).toBe(f0);
    expect(w.factions.tourism.approval).toBe(a0);
    expect(w.factions.conservation.approval).toBe(c0);
  });

  it('campgrounds need gentle, dry ground that is not on fire (D7)', () => {
    const w = smallWorld('firstseason', 'econ-site');
    const site = bestCampSite(w);
    expect(site).toBeGreaterThanOrEqual(0);
    const slope = w.L.slope[site];
    w.L.slope[site] = 0.3;
    expect(applyCommand(w, { t: 'build', what: 'camp', cell: site }).ok).toBe(false);
    w.L.slope[site] = slope;
    w.L.fire[site] = FIRE.BURNING;
    expect(applyCommand(w, { t: 'build', what: 'camp', cell: site }).ok).toBe(false);
    w.L.fire[site] = FIRE.NONE;
    const f0 = w.economy.funds;
    expect(applyCommand(w, { t: 'build', what: 'camp', cell: site }).ok).toBe(true);
    expect(f0 - w.economy.funds).toBeCloseTo(COST.camp, 3);
    // the next one has to go somewhere else
    const x = site % w.W,
      y = (site / w.W) | 0;
    expect(applyCommand(w, { t: 'build', what: 'camp', cell: y * w.W + Math.min(w.W - 1, x + 3) }).ok).toBe(false);
    expect(bestCampSite(w)).not.toBe(site);
  });

  it('visitors are limited by demand: extra campgrounds have diminishing returns (D7)', () => {
    const r = [1, 2, 5, 6].map(summerWith);
    const [one, two, five, six] = r;
    // the starting valley is crowded: a real share of would-be visitors find no room
    expect(one.turnedAway).toBeGreaterThan(0.15);
    expect(two.turnedAway).toBeLessThan(one.turnedAway);
    const second = two.fees - one.fees;
    const sixth = six.fees - five.fees;
    expect(second).toBeGreaterThan(30_000); // a second campground pays for itself
    expect(sixth).toBeLessThan(0.1 * second); // the sixth hardly fills
    expect(sixth).toBeLessThan(COST.campUpkeep); // and does not cover its upkeep
    expect(six.fees / one.fees).toBeLessThan(1.6); // v1.0: ×3.9 with six campgrounds
    expect(six.turnedAway).toBeLessThan(0.02);
  }, 120000);

  it("the 'low' harvest quota does not close the mill by construction (D8)", () => {
    const w = smallWorld('firstseason', 'econ-low');
    const e = w.economy;
    w.policies.harvest = 'low';
    for (let y = 0; y < 5; y++) {
      w.day += 360;
      e.harvestThisYear = 0;
      timberHarvest(w);
      expect(e.harvestThisYear).toBeGreaterThan(0.45 * e.millDemand);
      expect(e.millStrain).toBe(0); // v1.0: 1, 2, 3 — closed
    }
    expect(e.millOpen).toBe(true);
  });

  it('mill strain counts consecutive short years, and a closed mill reopens once the stands recover (D8)', () => {
    const w = smallWorld('firstseason', 'econ-reopen');
    const e = w.economy;
    // a good year wipes out earlier short ones
    e.millStrain = 2;
    w.day += 360;
    timberHarvest(w);
    expect(e.millStrain).toBe(0);
    // closed two years ago: still waiting
    w.day += 360;
    e.millOpen = false;
    w.memory.millClosedYear = w.year - 2;
    e.harvestThisYear = 0;
    timberHarvest(w);
    expect(e.millOpen).toBe(false);
    expect(e.harvestThisYear).toBe(0);
    // three years on, with plenty of stands ready, a buyer reopens it, sized to the Timber zone
    w.day += 360;
    const chronicle = w.chronicle.length;
    const ceiling = millCeiling(w);
    timberHarvest(w);
    expect(e.millOpen).toBe(true);
    expect(e.millStrain).toBe(0);
    expect(Math.abs(e.millDemand - 0.75 * ceiling)).toBeLessThanOrEqual(50);
    expect(e.harvestThisYear).toBeGreaterThan(0);
    expect(w.chronicle.slice(chronicle).some((c) => /sawmill.*reopened/.test(c.text))).toBe(true);
  });

  it('a stock-limited mill asks for more Timber zone, not a higher quota (D8)', () => {
    const w = smallWorld('firstseason', 'econ-stock');
    const e = w.economy;
    e.harvestLastYear = 0.4 * e.millDemand;
    // the quota was the limit: ask for a higher quota
    w.memory.harvestStockLimited = false;
    const q = petitionFor(w, 'raise-harvest')!;
    expect(q.action).toEqual({ type: 'policy', key: 'harvest', value: 'high' });
    // the stands were the limit: ask for more forest
    w.memory.harvestStockLimited = true;
    const p = petitionFor(w, 'raise-harvest')!;
    expect(p.action.type).toBe('zone');
    const cells = (p.action as { cells: number[] }).cells;
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => w.L.zone[c] === ZONE.NONE && !w.L.water[c] && w.L.town[c] === 0)).toBe(true);
    const ceiling = millCeiling(w);
    openCouncil(w, p);
    expect(applyCommand(w, { t: 'petition', id: p.id, accept: true }).ok).toBe(true);
    expect(cells.every((c) => w.L.zone[c] === ZONE.TIMBER)).toBe(true);
    expect(millCeiling(w) - ceiling).toBeGreaterThan((e.millDemand - e.harvestLastYear) / 0.8);
    expect(w.policies.harvest).toBe('medium');
  });

  it('the mill is sized to what its Timber zone can sustain (D8)', () => {
    for (const sc of ['firstseason', 'tinderbox'] as const) {
      const w = smallWorld(sc, 'econ-size');
      const ceiling = millCeiling(w);
      expect(w.economy.millDemand).toBeLessThanOrEqual(0.75 * ceiling + 50);
      expect(w.economy.millDemand).toBeGreaterThanOrEqual(Math.min(MILL_MIN_DEMAND, 0.75 * ceiling - 50));
    }
  });

  for (const seed of ['mill-a', 'mill-b']) {
    it(`First Season's mill stays open 25 years under default play (D8, seed ${seed})`, () => {
      const w = smallWorld('firstseason', seed);
      const sim = new Simulation(w, {}, { autoReview: true });
      const harvest: number[] = [];
      for (let y = 0; y < 25; y++) {
        sim.runDays(360);
        expect(w.economy.millOpen).toBe(true); // v1.0: closed by year 8-15 whatever the player did
        harvest.push(w.economy.harvestLastYear);
      }
      const mean = harvest.reduce((a, b) => a + b, 0) / harvest.length;
      expect(mean).toBeGreaterThan(0.8 * w.economy.millDemand);
    }, 300000);
  }
});
