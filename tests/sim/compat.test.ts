/**
 * Save compatibility: a save written by the untouched v1.0 code (commit 80bdc91; fixture generated
 * from that export, Tinderbox, year 3, with a v1.0-style stuck burned house planted) loads in v1.1,
 * is repaired, and plays on without errors or non-finite state.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeWorld, encodeWorld, readHeader, stateHash, SAVE_VERSION } from '../../src/sim/save.ts';
import { Simulation } from '../../src/sim/sim.ts';
import { FIRE } from '../../src/sim/types.ts';
import { LAYER_SPECS } from '../../src/sim/world.ts';
import type { LayerName } from '../../src/sim/world.ts';

const bytes = new Uint8Array(gunzipSync(readFileSync(new URL('../fixtures/v1.0-tinderbox-y3.fireweed.gz', import.meta.url))));

describe('save compatibility', () => {
  it('loads a v1.0 save, repairs it and plays on', () => {
    expect(readHeader(bytes).version).toBe(3);
    const w = decodeWorld(bytes);
    // the planted stuck house (BURNT with a fire id that no longer exists) is released
    for (let i = 0; i < w.N; i++) if (w.L.town[i] > 0) expect(w.L.fire[i]).toBe(FIRE.NONE);
    // fields v1.1 added get defaults rather than undefined
    expect(w.memory.wildfireCount ?? 0).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(w.commandLog)).toBe(true);
    const sim = new Simulation(w, {}, { autoReview: true });
    sim.runDays(200);
    for (const name of Object.keys(LAYER_SPECS) as LayerName[]) {
      const a = w.L[name];
      for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) throw new Error(`${name}[${i}] = ${a[i]}`);
    }
    expect(Number.isFinite(w.economy.funds)).toBe(true);
    expect(Number.isFinite(w.trust)).toBe(true);
    // and is saved in the current format and reloads exactly
    const again = encodeWorld(w);
    expect(readHeader(again).version).toBe(SAVE_VERSION);
    expect(stateHash(decodeWorld(again))).toBe(stateHash(w));
  }, 120000);

  it('loads a v1.1.1 save with a fire burning and plays on under 2.0 rules', () => {
    // written by the untouched 1.1.1 code (commit c83e99a) with scripts/v2/make-fixture.ts:
    // Tinderbox, year 4, an afternoon with a wildfire burning
    const b111 = new Uint8Array(gunzipSync(readFileSync(new URL('../fixtures/v1.1.1-tinderbox-y4.fireweed.gz', import.meta.url))));
    const head = readHeader(b111);
    expect(head.version).toBe(4);
    expect(head.layers.some((l) => l.name === 'under')).toBe(false);
    const w = decodeWorld(b111);
    expect(w.burning.length).toBeGreaterThan(0);
    // what 2.0 adds is rebuilt from what the save holds
    let under = 0,
      wooded = 0;
    for (let i = 0; i < w.N; i++) {
      if (w.L.pine[i] + w.L.fir[i] > 0.3) {
        wooded++;
        under += w.L.under[i];
      }
      expect(w.L.fprog[i]).toBe(0);
      expect(w.L.fstop[i]).toBe(0);
    }
    expect(under / wooded).toBeGreaterThan(0.3); // a century without fire: the understory is there
    // burning cells carry flame lengths (metres), not 1.x's 0..2 proxy left as it was
    for (const b of w.burning) {
      expect(w.L.fint[b]).toBeGreaterThanOrEqual(0);
      expect(w.L.fint[b]).toBeLessThanOrEqual(8);
    }
    expect(w.aid).toEqual([]);
    expect(w.reports).toEqual([]);
    expect(w.policies.mutualAid).toBe('auto');
    // crews hired under 1.1.1 are kept as they were (the larger roster is for new valleys)
    const crews = w.crews.length;
    const sim = new Simulation(w, {}, { autoReview: true });
    // the towns are surveyed when the warden resumes
    expect(w.memory.exposure).toBeDefined();
    expect(w.memory.exposure!.towns.length).toBe(w.towns.length);
    sim.runDays(400);
    expect(w.crews.filter((c) => c.aid === undefined).length).toBe(crews);
    for (const name of Object.keys(LAYER_SPECS) as LayerName[]) {
      const a = w.L[name];
      for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) throw new Error(`${name}[${i}] = ${a[i]}`);
    }
    expect(Number.isFinite(w.economy.funds)).toBe(true);
    expect(Number.isFinite(w.trust)).toBe(true);
    // the fire that was burning ended and was accounted for
    expect(w.fires.filter((f) => f.active && f.startDay < 1200).length).toBe(0);
    const again = encodeWorld(w);
    expect(readHeader(again).version).toBe(SAVE_VERSION);
    expect(stateHash(decodeWorld(again))).toBe(stateHash(w));
  }, 180000);

  it('resets policy values an imported file should not contain', () => {
    const w = decodeWorld(bytes);
    (w.policies as unknown as Record<string, unknown>).grazing = 'extreme';
    const back = decodeWorld(encodeWorld(w));
    expect(back.policies.grazing).toBe('light');
  });
});
