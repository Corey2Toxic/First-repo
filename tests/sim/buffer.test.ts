/**
 * Community Buffer zone (audit D2): the zone tool, tutorial and tooltip promise that fires reaching
 * a buffer are always fought and dispatched first, and that treated buffer raises the town's
 * firewise rating. v1.0 never read the zone anywhere in the simulation.
 */
import { describe, expect, it } from 'vitest';
import { smallWorld } from '../helpers.ts';
import { applyCommand } from '../../src/sim/commands.ts';
import { startFire, igniteCell } from '../../src/sim/systems/fire.ts';
import { autoDispatch } from '../../src/sim/systems/crews.ts';
import { maintainBuffers, surroundingsSafety, updateFirewise, BUFFER_REACH } from '../../src/sim/systems/towns.ts';
import { COST } from '../../src/sim/economyParams.ts';
import { ZONE } from '../../src/sim/types.ts';
import type { World } from '../../src/sim/world.ts';

/** Land cells 3..BUFFER_REACH cells from the first town's centre (a ring around it). */
function ring(w: World, t = w.towns[0]): number[] {
  const out: number[] = [];
  for (let y = t.y - BUFFER_REACH - 4; y <= t.y + BUFFER_REACH + 4; y++)
    for (let x = t.x - BUFFER_REACH - 4; x <= t.x + BUFFER_REACH + 4; x++) {
      if (!w.inside(x, y)) continue;
      const i = y * w.W + x;
      const d = Math.hypot(x - t.x, y - t.y);
      if (d < 3 || d > BUFFER_REACH + 3 || w.L.water[i] || w.L.town[i]) continue;
      out.push(i);
    }
  return out;
}

describe('Community Buffer', () => {
  it('a wildfire that reaches a buffer is always fought', () => {
    const w = smallWorld('firstseason', 'buffer-1');
    const cells = ring(w);
    expect(applyCommand(w, { t: 'zone', cells, zone: ZONE.BUFFER }).ok).toBe(true);
    // a fire in the open, set to be monitored...
    const far = cells.find((c) => w.L.zone[c] !== ZONE.BUFFER) ?? -1;
    const outside = (() => {
      for (let i = 0; i < w.N; i += 97) if (!w.L.water[i] && !w.L.town[i] && w.L.zone[i] !== ZONE.BUFFER) return i;
      return -1;
    })();
    expect(far === -1 || far >= 0).toBe(true);
    const fe = startFire(w, outside, 'lightning')!;
    fe.detected = true;
    expect(applyCommand(w, { t: 'fireResponse', fireId: fe.id, response: 'monitor' }).ok).toBe(true);
    // ...that spreads into the buffer is upgraded to suppression and cannot be monitored again
    const inBuf = cells.find((c) => w.L.zone[c] === ZONE.BUFFER && w.L.fire[c] === 0)!;
    igniteCell(w, inBuf, fe, 0.3, false);
    expect(fe.inBuffer).toBe(true);
    expect(fe.response).toBe('suppress');
    expect(applyCommand(w, { t: 'fireResponse', fireId: fe.id, response: 'monitor' }).ok).toBe(false);
    // a fire that starts inside a buffer is fought from the outset
    const inside = cells.find((c) => w.L.zone[c] === ZONE.BUFFER && w.L.fire[c] === 0 && c !== inBuf)!;
    const fe2 = startFire(w, inside, 'human')!;
    expect(fe2.response).toBe('suppress');
  });

  it('crews go to a fire in the buffer before a larger fire elsewhere', () => {
    const w = smallWorld('firstseason', 'buffer-2');
    const cells = ring(w);
    applyCommand(w, { t: 'zone', cells, zone: ZONE.BUFFER });
    // keep only one hand crew free
    const hands = w.crews.filter((c) => c.kind === 'hand');
    for (const c of hands.slice(1)) c.fatigue = 1;
    // a big remote fire and a small buffer fire, both reported
    let remote = -1;
    for (let i = w.N - 1; i >= 0 && remote < 0; i -= 13) if (!w.L.water[i] && !w.L.town[i] && w.L.zone[i] !== ZONE.BUFFER) remote = i;
    const big = startFire(w, remote, 'lightning')!;
    big.detected = true;
    big.area = 400;
    const small = startFire(w, cells.find((c) => w.L.zone[c] === ZONE.BUFFER)!, 'human')!;
    small.detected = true;
    autoDispatch(w);
    expect(hands[0].task?.fireId).toBe(small.id);
  });

  it('only treated buffer raises the firewise rating, and it is kept treated at a cost', () => {
    // a forested, fuel-heavy ring, so that only treatment can make it light
    const mk = () => {
      const w = smallWorld('firstseason', 'buffer-3');
      for (const c of ring(w)) {
        w.L.litter[c] = 16;
        w.L.shrub[c] = 0.6;
        w.L.fir[c] = 0.5;
        w.L.ageF[c] = 20;
        w.L.lastBurn[c] = -999;
        w.L.twi[c] = 0.3;
        w.L.pond[c] = 0;
      }
      return w;
    };
    const treat = (w: World, cells: number[]) => {
      for (const c of cells) w.L.lastTreat[c] = w.yearF;
    };
    const t0 = (w: World) => (updateFirewise(w), w.towns[0].firewise);
    // reference: treated but not zoned
    const a = mk();
    const cells = ring(a);
    treat(a, cells);
    const treatedOnly = t0(a);
    // zoned but untreated: no free lunch from the label alone
    const b = mk();
    applyCommand(b, { t: 'zone', cells, zone: ZONE.BUFFER });
    for (const c of cells) b.L.lastTreat[c] = -999;
    const zonedOnly = surroundingsSafety(b, b.towns[0]).buffer;
    // zoned and treated: the promise
    const c = mk();
    applyCommand(c, { t: 'zone', cells, zone: ZONE.BUFFER });
    treat(c, cells);
    const both = t0(c);
    expect(both).toBeGreaterThan(treatedOnly + 0.05);
    expect(zonedOnly).toBeLessThan(0.1);
    expect(surroundingsSafety(c, c.towns[0]).buffer).toBeGreaterThan(0.9);
    // year-end upkeep keeps it treated and is charged per hectare
    const f0 = c.economy.funds;
    c.day += 360 * 7; // seven years later the original treatment is nearly stale
    const n = maintainBuffers(c);
    expect(n).toBeGreaterThan(20);
    expect(f0 - c.economy.funds).toBeCloseTo(n * COST.bufferUpkeep, 3);
    const kept = cells.filter((x) => c.L.zone[x] === ZONE.BUFFER && c.yearF - c.L.lastTreat[x] < 1).length;
    expect(kept).toBe(n);
    // untreated buffer is not maintained (and not charged)
    const fb = b.economy.funds;
    expect(maintainBuffers(b)).toBe(0);
    expect(b.economy.funds).toBe(fb);
  });
});
