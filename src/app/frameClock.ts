/**
 * The game loop's clocks, kept apart (audit D23). v1.0 clamped every frame's dt to 0.1 s and
 * used that one number for everything: the FPS meter could never read below 10, ticks/s was
 * measured against clamped time (overstated on slow devices), and the simulation accrued
 * time from the clamped dt.
 *
 * - Counters (fps, ticks/s) use real frame time, smoothed with a time-based moving average,
 *   and ignore gaps of more than a second (a hidden tab, a breakpoint).
 * - The camera animates with dt capped at 0.1 s, so a stall never makes it jump.
 * - The simulation accrues min(real dt, 0.25 s) x speed ticks, runs them within a per-frame
 *   budget that adapts to the frame rate (40% of a smoothed frame, 8-40 ms), and carries
 *   at most max(3, speed x 0.25 s) ticks of backlog.
 *
 * Pure and DOM-free: timestamps come from the caller, the budget clock is injectable.
 * (UI-side only: the simulation never depends on wall-clock time.)
 */

/** Longest step the camera animates in one frame, s. */
export const MAX_ANIM_DT = 0.1;
/** Longest real time the simulation catches up on in one frame, s. */
export const MAX_SIM_DT = 0.25;
/** Frames further apart than this (s) are gaps, not frames: counters skip them. */
export const MAX_COUNTED_DT = 1;
/** Time constant of the frame-time moving average, s. */
const EMA_SECONDS = 0.5;

export class FrameClock {
  /** Smoothed frames per second, from real frame times. */
  fps = 60;
  /** Smoothed real frame time, ms. */
  frameMs = 1000 / 60;
  /** Simulation ticks executed per real second, over the last second or so of visible time. */
  ticksPerSec = 0;
  /** Ticks owed to the simulation; its fractional part drives in-between-tick interpolation. */
  acc = 0;
  /** Real seconds since the previous frame (unclamped). */
  rawDt = 0;
  private last = -1;
  private gap = false;
  private winTicks = 0;
  private winTime = 0;
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** Restart frame timing at `t` (ms), e.g. when the loop starts. */
  reset(t: number): void {
    this.last = t;
  }

  /** Begin a frame at timestamp `t` (ms). Returns the camera's animation step in seconds. */
  beginFrame(t: number): number {
    const raw = this.last < 0 ? 0 : Math.max(0, (t - this.last) / 1000);
    this.last = t;
    this.rawDt = raw;
    this.gap = raw > MAX_COUNTED_DT;
    if (!this.gap && raw > 0) {
      const a = 1 - Math.exp(-raw / EMA_SECONDS);
      this.frameMs += (raw * 1000 - this.frameMs) * a;
      this.fps = 1000 / this.frameMs;
      this.winTime += raw;
    }
    return Math.min(MAX_ANIM_DT, raw);
  }

  /** How long the simulation may run in one frame, ms: modest on fast devices, more on slow ones. */
  get budgetMs(): number {
    return Math.min(40, Math.max(8, 0.4 * this.frameMs));
  }

  /**
   * Run this frame's share of the simulation at `rate` ticks per real second. `tick` runs one
   * tick and returns false to stop for this frame (the game blocked, time slowed for a new
   * fire). Returns the number of ticks run.
   */
  advance(rate: number, tick: () => boolean): number {
    this.acc += Math.min(this.rawDt, MAX_SIM_DT) * rate;
    const budget = this.budgetMs;
    const t0 = this.now();
    let n = 0;
    while (this.acc >= 1 && this.now() - t0 < budget) {
      this.acc -= 1;
      n++;
      if (!tick()) break;
    }
    this.capBacklog(rate);
    if (!this.gap) this.winTicks += n;
    return n;
  }

  /** Limit owed ticks to a quarter second of game time at `rate` (and call it when the speed drops). */
  capBacklog(rate: number): void {
    this.acc = Math.min(this.acc, Math.max(3, rate * MAX_SIM_DT));
  }

  /** End the frame: refresh ticks/s once a second of visible time has been measured. */
  endFrame(): void {
    if (this.winTime >= 1) {
      this.ticksPerSec = this.winTicks / this.winTime;
      this.winTicks = 0;
      this.winTime = 0;
    }
  }
}
