/**
 * The annual council review and the year boundary: the review reports the closed year's
 * books (D22), and year-end chronicle entries belong to the year being closed.
 */
import { describe, expect, it } from 'vitest';
import { Simulation } from '../../src/sim/sim.ts';
import { applyCommand } from '../../src/sim/commands.ts';
import { ledgerTotals } from '../../src/sim/systems/economy.ts';
import type { World } from '../../src/sim/world.ts';
import { yearOfDay } from '../../src/ui/format.ts';
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

  it('files year-end chronicle entries (drought, mill closure, petitions) under the closing year', () => {
    const w = smallWorld('firstseason', 'review-chronicle-1');
    const sim = new Simulation(w, {}, { ignitions: false });
    w.day = 359; // the last day of year 1
    sim.tick(); // start-of-year processing runs on the first tick
    w.climate.yearWet = 0.5; // a drought year
    w.economy.millStrain = 5; // the mill gives up at the year's end
    while (!w.review.pending) sim.tick();
    expect(w.year).toBe(2);
    expect(w.review.year).toBe(1);
    const drought = w.chronicle.find((c) => c.text.startsWith('A drought year'));
    const mill = w.chronicle.find((c) => c.text.includes('sawmill shut'));
    expect(drought && yearOfDay(w, drought.day)).toBe(1);
    expect(mill && yearOfDay(w, mill.day)).toBe(1);
    // what the review modal shows as "Remembered" for year 1
    const highlights = w.chronicle.filter((c) => yearOfDay(w, c.day) === w.review.year && c.importance >= 2);
    expect(highlights).toContain(drought);
    expect(highlights).toContain(mill);
    // petitions answered at the review belong to the year under review
    const p = w.review.petitions[0];
    if (p) {
      expect(applyCommand(w, { t: 'petition', id: p.id, accept: false }).ok).toBe(true);
      expect(yearOfDay(w, w.chronicle.at(-1)!.day)).toBe(1);
    }
    expect(applyCommand(w, { t: 'closeReview' }).ok).toBe(true);
    // once the council has risen, the new year's events are the new year's
    w.record('test', 'A new-year event.', 1);
    expect(yearOfDay(w, w.chronicle.at(-1)!.day)).toBe(2);
  });
});
