import { describe, expect, it } from 'vitest';
import { generateWorld } from '../../src/sim/gen/index.ts';
import { makeConfig } from '../../src/sim/scenarios.ts';
import { Simulation } from '../../src/sim/sim.ts';
import { decodeWorld, encodeWorld, stateHash } from '../../src/sim/save.ts';
import { applyCommand } from '../../src/sim/commands.ts';
import { ZONE } from '../../src/sim/types.ts';
import { fireSubstep, startFire } from '../../src/sim/systems/fire.ts';
import { wildfireFacts } from '../../src/sim/score.ts';
import { flatWorld, smallWorld } from '../helpers.ts';

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

  it('once-only notices are remembered across a reload (D11)', () => {
    const w = smallWorld('tinderbox', 'once-1');
    const sim = new Simulation(w, {}, { ignitions: false });
    const cell = (w.H >> 1) * w.W + (w.W >> 1);
    const fe = startFire(w, cell, 'lightning')!;
    fe.detected = true;
    sim.hooks.onCrown!(fe, cell);
    const n1 = w.notifications.length;
    sim.hooks.onCrown!(fe, cell);
    expect(w.notifications.length).toBe(n1); // told once
    const w2 = decodeWorld(encodeWorld(w));
    const sim2 = new Simulation(w2, {}, { ignitions: false });
    const fe2 = w2.fires.find((f) => f.id === fe.id)!;
    const next = w2.counters.nextId;
    sim2.hooks.onCrown!(fe2, cell);
    expect(w2.notifications.length).toBe(n1); // v1.0: repeated after the reload
    expect(w2.counters.nextId).toBe(next); // and consumed an entity id, changing the state hash
  });

  it('tenure fire statistics stay exact when old fire records are trimmed (D16)', () => {
    const w = flatWorld(30, 30, { fm: 0.3 }); // too wet to spread: each fire burns one cell and goes out
    let k = 0;
    for (let f = 0; f < 470; f++) {
      const i = (f % 28) + 1 + (((f / 28) | 0) % 28 + 1) * w.W;
      w.L.fire[i] = 0;
      w.L.fid[i] = -1;
      const fe = startFire(w, i, 'human')!;
      if (f === 7) fe.area = 5000; // an old, large fire that will be trimmed from the save
      for (let s = 0; s < 20 && fe.active; s++) fireSubstep(w);
      k++;
    }
    // the simulation keeps the list bounded (the large early fire has been trimmed away)...
    expect(w.fires.length).toBeLessThanOrEqual(450);
    expect(w.fires.some((f) => f.area === 5000)).toBe(false);
    // ...but the tenure's facts are running totals: exact, and identical after a reload
    const before = wildfireFacts(w);
    expect(before.count).toBe(k); // v1.0: the trimmed list's length (400)
    expect(before.largest!.area).toBe(5000); // v1.0: the trimmed fire was forgotten
    const w2 = decodeWorld(encodeWorld(w));
    expect(w2.fires.length).toBe(w.fires.length); // a save is a pure serialisation now
    expect(stateHash(w2)).toBe(stateHash(w));
    const after = wildfireFacts(w2);
    expect(after.count).toBe(before.count);
    expect(after.largest!.area).toBe(5000);
  });
});
