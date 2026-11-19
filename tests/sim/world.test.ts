import { describe, expect, it } from 'vitest';
import { smallWorld } from '../helpers.ts';
import { LAYER_SPECS } from '../../src/sim/world.ts';
import type { LayerName } from '../../src/sim/world.ts';
import { generateWorld } from '../../src/sim/gen/index.ts';
import { makeConfig } from '../../src/sim/scenarios.ts';
import { stateHash } from '../../src/sim/save.ts';

describe('world generation', () => {
  const seeds = ['alpha-1', 'ember-raven-2', 'larch-wren-5'];
  for (const seed of seeds) {
    it(`produces a valid valley for seed ${seed}`, () => {
      const w = smallWorld('tinderbox', seed);
      // every cell drains to the map edge (no sinks, no loops)
      for (let i = 0; i < w.N; i += 7) {
        let c = i,
          steps = 0;
        while (w.L.flowTo[c] >= 0 && steps < w.N) {
          const t = w.L.flowTo[c];
          expect(w.L.elev[t]).toBeLessThanOrEqual(w.L.elev[c] + 1e-3);
          c = t;
          steps++;
        }
        const x = c % w.W,
          y = (c / w.W) | 0;
        expect(x === 0 || y === 0 || x === w.W - 1 || y === w.H - 1).toBe(true);
      }
      // no NaNs anywhere, vegetation fractions bounded
      for (const name of Object.keys(LAYER_SPECS) as LayerName[]) {
        const a = w.L[name];
        for (let i = 0; i < a.length; i += 3) expect(Number.isFinite(a[i])).toBe(true);
      }
      for (let i = 0; i < w.N; i++) {
        const can = w.L.aspen[i] + w.L.pine[i] + w.L.fir[i];
        expect(can).toBeLessThanOrEqual(1.0001);
        expect(w.L.grass[i]).toBeGreaterThanOrEqual(0);
        expect(w.L.grass[i]).toBeLessThanOrEqual(1);
      }
      expect(w.towns.length).toBeGreaterThanOrEqual(2);
      for (const t of w.towns) expect(t.structures).toBeGreaterThan(3);
      expect(w.reservoirCells.length).toBeGreaterThan(20);
      expect(w.landmarks.filter((l) => l.kind === 'peak').length).toBeGreaterThan(2);
      expect(new Set(w.landmarks.map((l) => l.name)).size).toBe(w.landmarks.length);
      expect(w.roads.length).toBeGreaterThan(2);
      expect(w.crews.length).toBe(3);
    });
  }

  it('is deterministic for a given seed', () => {
    const a = generateWorld(makeConfig('firstseason', 'same-seed', 'small'));
    const b = generateWorld(makeConfig('firstseason', 'same-seed', 'small'));
    expect(stateHash(a)).toBe(stateHash(b));
    const c = generateWorld(makeConfig('firstseason', 'other-seed', 'small'));
    expect(stateHash(c)).not.toBe(stateHash(a));
  });

  it('scenarios set up their distinctive starting conditions', () => {
    const burned = smallWorld('afterburn', 's1');
    let scar = 0;
    for (let i = 0; i < burned.N; i++) if (burned.L.burnSev[i] === 3 && burned.L.lastBurn[i] === 0) scar++;
    expect(scar).toBeGreaterThan(150);
    const silent = smallWorld('silentwoods', 's1');
    expect(silent.packs.length).toBe(0);
    expect(silent.colonies.length).toBe(0);
  });
});
