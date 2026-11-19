/**
 * Simulation orchestrator. The clock advances in 3-hour sub-steps; daily
 * systems run at the first sub-step of each day, fast processes (fire,
 * smoke, crews) every sub-step. Everything is deterministic given the seed
 * and the sequence of player commands.
 */
import { SUBSTEPS_PER_DAY } from './types.ts';
import type { FireEvent } from './types.ts';
import type { World } from './world.ts';
import { generateWeather, newClimateYear, updateDanger } from './systems/climate.ts';
import { dailyMoisture, medianFuelMoisture, refreshSoilCapacity } from './systems/moisture.ts';
import { refreshSuitability, vegetationDaily } from './systems/vegetation.ts';
import { dailyIgnitions, detectFires, fireSubstep, weatherOnFires } from './systems/fire.ts';
import type { FireStepHooks } from './systems/fire.ts';
import { smokeSubstep } from './systems/smoke.ts';

export interface SimHooks extends FireStepHooks {
  onNewDay?: (w: World) => void;
  onNewYear?: (w: World) => void;
  onIgnition?: (fe: FireEvent) => void;
}

export interface SimOptions {
  /** Disable natural/human ignitions (tests, succession experiments). */
  ignitions?: boolean;
}

export class Simulation {
  readonly w: World;
  readonly runoff: Float32Array;
  hooks: SimHooks;
  opts: SimOptions;
  private started = false;

  constructor(w: World, hooks: SimHooks = {}, opts: SimOptions = {}) {
    this.w = w;
    this.runoff = new Float32Array(w.N);
    this.hooks = hooks;
    this.opts = { ignitions: true, ...opts };
  }

  /** True when the simulation is waiting on the player (annual review, game over). */
  get blocked(): boolean {
    return this.w.review.pending || this.w.outcome.ended;
  }

  /** Is anything happening on sub-day timescales right now? */
  get busy(): boolean {
    const w = this.w;
    return w.burning.length > 0 || w.smokePresent || w.crews.some((c) => c.state !== 'idle');
  }

  /** Advance one 3-hour sub-step. */
  tick(): void {
    const w = this.w;
    if (this.blocked) return;
    if (!this.started) {
      this.started = true;
      if (w.day === 0 && w.sub === 0 && w.stats.month.length === 0) this.startOfYear();
    }
    if (w.sub === 0) this.daily();
    // lightning and people start fires in the afternoon
    if (w.sub === 4 && this.opts.ignitions) {
      const started = dailyIgnitions(w);
      if (this.hooks.onIgnition) for (const fe of started) this.hooks.onIgnition(fe);
    }
    if (w.burning.length > 0) {
      fireSubstep(w, this.hooks);
      detectFires(w, this.hooks);
    }
    if (w.smokePresent || w.burning.length > 0) smokeSubstep(w);
    w.sub++;
    if (w.sub >= SUBSTEPS_PER_DAY) {
      w.sub = 0;
      w.day++;
      if (w.doy === 0) {
        this.endOfYear();
        this.startOfYear();
      }
    }
  }

  /** Advance whole days (headless tools/tests). */
  runDays(days: number): void {
    const target = this.w.day + days;
    while (this.w.day < target && !this.blocked) this.tick();
  }

  private daily(): void {
    const w = this.w;
    generateWeather(w);
    dailyMoisture(w, this.runoff);
    updateDanger(w, medianFuelMoisture(w));
    weatherOnFires(w);
    vegetationDaily(w);
    decayTreatments(w);
    if (this.hooks.onNewDay) this.hooks.onNewDay(w);
  }

  private startOfYear(): void {
    const w = this.w;
    newClimateYear(w);
    refreshSuitability(w);
    refreshSoilCapacity(w);
    w.economy.ledger = { year: w.year, income: {}, expense: {} };
  }

  private endOfYear(): void {
    const w = this.w;
    const c = w.counters;
    w.stats.year.push(w.year - 1);
    w.stats.burned.push(c.yearBurned);
    w.stats.burnedHigh.push(c.yearBurnedHigh);
    w.stats.structuresLost.push(c.yearStructuresLost);
    w.stats.precip.push(Math.round(c.yearPrecip));
    c.yearBurned = 0;
    c.yearBurnedHigh = 0;
    c.yearStructuresLost = 0;
    c.yearPrecip = 0;
    if (this.hooks.onNewYear) this.hooks.onNewYear(w);
  }
}

/** Fireline, retardant and water drops weather away. */
function decayTreatments(w: World): void {
  const L = w.L;
  for (let i = 0; i < w.N; i++) {
    if (L.retard[i] > 0) L.retard[i] = Math.max(0, L.retard[i] - 0.12 - w.weather.precip * 0.02);
    if (L.wet[i] > 0) L.wet[i] = Math.max(0, L.wet[i] - 0.35);
    if (L.fline[i] > 0) L.fline[i] = Math.max(0, L.fline[i] - 0.004);
  }
}
