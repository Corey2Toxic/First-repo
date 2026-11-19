import { describe, expect, it } from 'vitest';
import { generateWorld } from '../../src/sim/gen/index.ts';
import { makeConfig } from '../../src/sim/scenarios.ts';
import { Simulation } from '../../src/sim/sim.ts';
import { decodeWorld, encodeWorld, stateHash } from '../../src/sim/save.ts';
import { applyCommand } from '../../src/sim/commands.ts';
import { ZONE } from '../../src/sim/types.ts';

function newGame(seed: string) {
  const w = generateWorld(makeConfig('tinderbox', seed, 'small'));
  return { w, sim: new Simulation(w, {}, { autoReview: true }) };
}

describe('determinism and persistence', () => {
  it('two runs from the same seed stay identical', () => {
    const a = newGame('det-1');
    const b = newGame('det-1');
    a.sim.runDays(200);
    b.sim.runDays(200);
    expect(stateHash(a.w)).toBe(stateHash(b.w));
  });

  it('player commands replay identically', () => {
    const a = newGame('det-2');
    const b = newGame('det-2');
    for (const g of [a, b]) {
      g.sim.runDays(20);
      const cells = Array.from({ length: 40 }, (_, k) => 30 * g.w.W + 30 + k);
      applyCommand(g.w, { t: 'zone', cells, zone: ZONE.WILDERNESS });
      applyCommand(g.w, { t: 'project', kind: 'thin', cells: cells.map((c) => c + g.w.W * 3) });
      applyCommand(g.w, { t: 'hire', kind: 'hand' });
      g.sim.runDays(60);
    }
    expect(stateHash(a.w)).toBe(stateHash(b.w));
  });

  it('a saved and reloaded game continues exactly like the original', () => {
    const a = newGame('det-3');
    a.sim.runDays(150);
    const bytes = encodeWorld(a.w);
    const restored = decodeWorld(bytes);
    expect(stateHash(restored)).toBe(stateHash(a.w));
    const simB = new Simulation(restored, {}, { autoReview: true });
    a.sim.runDays(120);
    simB.runDays(120);
    expect(stateHash(restored)).toBe(stateHash(a.w));
  });
});
