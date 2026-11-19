import { describe, expect, it } from 'vitest';
import { evaluateLegacy } from '../../src/sim/score.ts';
import { beginReview } from '../../src/sim/systems/council.ts';
import { smallWorld } from '../helpers.ts';

const part = (w: ReturnType<typeof smallWorld>, label: string) => evaluateLegacy(w, 'tenure').breakdown.find((b) => b[0] === label)?.[1] as number;

describe('legacy score agency', () => {
  it('wolves released at the last moment earn little wildlife credit', () => {
    const w = smallWorld('firstseason', 'score-wolves');
    const months = 25 * 12;
    w.stats.wolves = Array.from({ length: months }, (_, k) => (k > months - 3 ? 5 : 0));
    w.stats.beavers = Array.from({ length: months }, () => 0);
    w.colonies = [];
    w.herds = [];
    w.stats.deer = Array.from({ length: months }, () => 0);
    const late = part(w, 'Wild things');
    w.stats.wolves = Array.from({ length: months }, () => 5);
    const always = part(w, 'Wild things');
    expect(late).toBeLessThan(0.2);
    expect(always).toBeCloseTo(4, 5); // v1.0: 4 points for wolves present on the last day, either way
  });

  it('a valley with no fire at all earns nothing for fire doing its work', () => {
    const w = smallWorld('firstseason', 'score-nofire');
    w.day = 25 * 360;
    w.counters.totalBurned = 0;
    w.counters.totalHighSeverity = 0;
    expect(part(w, 'Fire doing its work')).toBe(0); // v1.0 gave 4 of 8 points for fire exclusion
  });

  it('dredging at the end of a tenure does not erase a silted record', () => {
    const w = smallWorld('firstseason', 'score-silt');
    w.reservoirSilt = 0.05; // just dredged
    w.memory.siltYears = 25;
    w.memory.siltSum = 0.05 * 25;
    const keptClean = part(w, 'Clean water');
    w.memory.siltSum = 0.35 * 25;
    const dredgedAtTheEnd = part(w, 'Clean water');
    // the silt half of 'Clean water' follows the tenure average, not the last day (v1.0: equal)
    expect(keptClean - dredgedAtTheEnd).toBeGreaterThan(5 * 0.3 * 2.5 - 0.15); // breakdown is rounded to 0.1
  });

  it('the council puts no petitions to an outgoing warden', () => {
    const w = smallWorld('firstseason', 'score-final');
    w.config.tenureYears = 1;
    w.day = 360; // year 2 has begun: the first year is under review
    beginReview(w);
    expect(w.review.verdict).toBe('tenure');
    expect(w.review.petitions.length).toBe(0);
  });

  it('spending the allocation for its own sake is not rewarded', () => {
    const w = smallWorld('firstseason', 'score-spend');
    w.memory.allocTotal = 1_000_000;
    w.memory.returnedTotal = 1_000_000;
    const thrifty = part(w, 'Sound finances');
    w.memory.returnedTotal = 0;
    expect(part(w, 'Sound finances')).toBe(thrifty);
  });
});
