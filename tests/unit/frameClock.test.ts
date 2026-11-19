import { describe, expect, it } from 'vitest';
import { FrameClock, MAX_SIM_DT } from '../../src/app/frameClock.ts';

/** Drive a clock with frames `frameMs` apart; each tick costs `tickMs` of (fake) budget time. */
function run(clock: FrameClock, frames: number, frameMs: number, rate: number, opts: { start?: number; tickMs?: number } = {}) {
  let perf = 0;
  const c = clock as unknown as { now: () => number };
  c.now = () => perf;
  let t = opts.start ?? 0;
  let ticks = 0;
  for (let k = 0; k < frames; k++) {
    t += frameMs;
    clock.beginFrame(t);
    ticks += clock.advance(rate, () => {
      perf += opts.tickMs ?? 0;
      return true;
    });
    clock.endFrame();
  }
  return { ticks, t };
}

describe('FrameClock (D23)', () => {
  it('reads slow frame rates honestly (250 ms frames: about 4 fps, not 10)', () => {
    const clock = new FrameClock();
    clock.reset(0);
    const { ticks } = run(clock, 40, 250, 12);
    expect(clock.fps).toBeGreaterThan(3.9);
    expect(clock.fps).toBeLessThan(4.1);
    // ticks/s is ticks executed per real second
    expect(Math.abs(clock.ticksPerSec - ticks / 10) / (ticks / 10)).toBeLessThan(0.05);
    // and the simulation kept pace with real time at this speed (12 ticks per real second)
    expect(ticks / 10).toBeGreaterThan(12 * 0.95);
  });

  it('measures ticks/s against real time when the budget limits the simulation', () => {
    const clock = new FrameClock();
    clock.reset(0);
    // 4 fps, Fastest speed, 2 ms per tick: the 40 ms budget allows 20 ticks per frame
    const { ticks } = run(clock, 40, 250, 220, { tickMs: 2 });
    expect(clock.budgetMs).toBeCloseTo(40, 5);
    expect(ticks).toBeLessThanOrEqual(40 * 20);
    expect(Math.abs(clock.ticksPerSec - ticks / 10) / (ticks / 10)).toBeLessThan(0.05);
    // backlog never exceeds a quarter second of game time at this speed
    expect(clock.acc).toBeLessThanOrEqual(220 * MAX_SIM_DT);
  });

  it('leaves 60 fps behaviour unchanged', () => {
    const clock = new FrameClock();
    clock.reset(0);
    const { ticks } = run(clock, 600, 1000 / 60, 12);
    expect(clock.fps).toBeGreaterThan(59);
    expect(clock.fps).toBeLessThan(61);
    // 10 s at 12 ticks/s, accrued from real dt exactly as before
    expect(Math.abs(ticks - 120)).toBeLessThanOrEqual(1);
    expect(Math.abs(clock.ticksPerSec - 12) / 12).toBeLessThan(0.05);
    expect(clock.budgetMs).toBe(8);
    // the camera steps with real dt at this rate
    expect(clock.beginFrame(10000 + 1000 / 60)).toBeCloseTo(1 / 60, 6);
  });

  it('runs at most a quarter second of ticks after a 5 s gap, and ignores the gap in its counters', () => {
    const clock = new FrameClock();
    clock.reset(0);
    const { t } = run(clock, 120, 1000 / 60, 12);
    const fps = clock.fps;
    const tps = clock.ticksPerSec;
    const animDt = clock.beginFrame(t + 5000);
    const n = clock.advance(12, () => true);
    clock.endFrame();
    expect(n).toBeLessThanOrEqual(Math.ceil(12 * MAX_SIM_DT));
    expect(animDt).toBeLessThanOrEqual(0.1);
    expect(clock.fps).toBe(fps);
    expect(clock.ticksPerSec).toBe(tps);
    // and at Fastest speed the catch-up is a quarter second's worth, not five seconds'
    const fast = new FrameClock();
    fast.reset(0);
    const r = run(fast, 60, 1000 / 60, 220);
    fast.beginFrame(r.t + 5000);
    expect(fast.advance(220, () => true)).toBeLessThanOrEqual(220 * MAX_SIM_DT + 3);
  });

  it('stops a frame early when the tick callback asks', () => {
    const clock = new FrameClock();
    clock.reset(0);
    clock.beginFrame(250);
    let calls = 0;
    expect(
      clock.advance(48, () => {
        calls++;
        return calls < 2;
      }),
    ).toBe(2);
    expect(clock.acc).toBeGreaterThanOrEqual(3);
  });
});
