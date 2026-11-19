/**
 * The annual council review reports the closed year's books (D22).
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/sim/sim.ts';
import { applyCommand } from '../../src/sim/commands.ts';
import { ledgerTotals } from '../../src/sim/systems/economy.ts';
import type { World } from '../../src/sim/world.ts';
import { smallWorld } from '../helpers.ts';

const reported = (w: World, key: string): [number, number] => {
  const row = w.review.report.find(([k]) => k === key);
  const m = row?.[1].match(/^\$(-?\d+)k \/ \$(-?\d+)k$/);
  if (!m) throw new Error(`no "${key}" line in the review: ${JSON.stringify(w.review.report)}`);
  return [Number(m[1]), Number(m[2])];
};

describe('the annual council review', () => {
  it('reports the income and spending of the year it reviews (D22)', () => {
    const w = smallWorld('tinderbox', 'review-ledger-1');
    const sim = new Simulation(w);
    const seen: number[] = [];
    sim.runDays(360 * 3 + 2, (ww) => {
      const closed = ww.economy.history.at(-1)!;
      expect(closed.year).toBe(ww.review.year);
      const tot = ledgerTotals(closed);
      const [income, spending] = reported(ww, 'Income / spending');
      expect(income).toBe(Math.round(tot.income / 1000));
      expect(spending).toBe(Math.round(tot.expense / 1000));
      // v1.0 totalled the freshly reset ledger: $0k / $0k every year
      expect(income).toBeGreaterThan(0);
      expect(spending).toBeGreaterThan(0);
      seen.push(ww.review.year);
      expect(applyCommand(ww, { t: 'closeReview' }).ok).toBe(true);
    });
    expect(seen).toEqual([1, 2, 3]);
  });
});
