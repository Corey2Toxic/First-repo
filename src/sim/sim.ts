/**
 * Simulation orchestrator. The clock advances in 3-hour sub-steps; daily
 * systems run at the first sub-step of each day, fast processes (fire,
 * smoke, crews) every sub-step. Everything is deterministic given the seed
 * and the sequence of player commands.
 */
import { SUBSTEPS_PER_DAY, FACTIONS } from './types.ts';
import type { Colony, Crew, FireEvent, Pack, Project } from './types.ts';
import type { World } from './world.ts';
import { generateWeather, newClimateYear, updateDanger } from './systems/climate.ts';
import { dailyMoisture, medianFuelMoisture, refreshSoilCapacity } from './systems/moisture.ts';
import { refreshSuitability, vegetationDaily, vegetationSummary } from './systems/vegetation.ts';
import { dailyIgnitions, detectFires, fireBanActive, fireSubstep, weatherOnFires } from './systems/fire.ts';
import type { FireStepHooks } from './systems/fire.ts';
import { smokeSubstep } from './systems/smoke.ts';
import { crewsDaily, crewsSubstep } from './systems/crews.ts';
import { holdBurns, maintainFuelbreaks, projectsDaily } from './systems/projects.ts';
import { closeEconomyYear, dailyEconomy } from './systems/economy.ts';
import { deerCount, wildlifeDaily, wolfCount } from './systems/wildlife.ts';
import { beetleSummary, beetleWinterKill, beetlesMonthly } from './systems/beetles.ts';
import { hydrologyDaily } from './systems/hydrology.ts';
import { maintainBuffers, townsDaily, townsYearly, updateFirewise } from './systems/towns.ts';
import { applyAllocation, beginReview, councilMonthly } from './systems/council.ts';
import { makeEventHooks, monthlyDiscoveries } from './events.ts';
import { discover } from './notes.ts';

export interface SimHooks extends FireStepHooks {
  onNewDay?: (w: World) => void;
  onNewYear?: (w: World) => void;
  onIgnition?: (fe: FireEvent) => void;
  onCrewRetreat?: (c: Crew, fe: FireEvent) => void;
  onBurnIgnited?: (pr: Project, fe: FireEvent) => void;
  onDepredation?: (p: Pack) => void;
  onWolvesKilled?: (p: Pack, n: number) => void;
  onPackFormed?: (p: Pack, parent: Pack) => void;
  onPackLost?: (p: Pack) => void;
  onColonyFounded?: (c: Colony) => void;
  onColonyAbandoned?: (c: Colony) => void;
  onDamBuilt?: (c: Colony) => void;
  onOutbreak?: (cells: number, x: number, y: number) => void;
  onDebrisFlow?: (x: number, y: number, damaged: number) => void;
}

export interface SimOptions {
  /** Disable natural/human ignitions (tests, succession experiments). */
  ignitions?: boolean;
  /** Close the annual council review automatically (headless experiments). */
  autoReview?: boolean;
}

export class Simulation {
  readonly w: World;
  readonly runoff: Float32Array;
  hooks: SimHooks;
  opts: SimOptions;

  constructor(w: World, extraHooks: SimHooks = {}, opts: SimOptions = {}) {
    this.w = w;
    this.runoff = new Float32Array(w.N);
    const base = makeEventHooks(w) as Record<string, unknown>;
    // merge: event hooks first, then caller hooks
    const merged: Record<string, unknown> = { ...base };
    for (const [k, fn] of Object.entries(extraHooks)) {
      const b = base[k] as ((...a: unknown[]) => void) | undefined;
      const f = fn as (...a: unknown[]) => void;
      merged[k] = b
        ? (...a: unknown[]) => {
            b(...a);
            f(...a);
          }
        : f;
    }
    this.hooks = merged as SimHooks;
    this.opts = { ignitions: true, autoReview: false, ...opts };
    if (w.memory.startPopulation === undefined) {
      w.memory.startPopulation = w.population;
      w.memory.startHazard = vegetationSummary(w).hazard;
      w.memory.startDeer = deerCount(w);
    }
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
    if (w.lastYearStarted !== w.year) this.startOfYear();
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
    crewsSubstep(w, this.hooks);
    holdBurns(w);
    if (w.smokePresent || w.burning.length > 0) smokeSubstep(w);
    w.sub++;
    if (w.sub >= SUBSTEPS_PER_DAY) {
      w.sub = 0;
      w.day++;
      if (w.doy === 0) this.endOfYear();
    }
  }

  /** Advance whole days (headless tools/tests). Reviews are closed by `onReview` or autoReview. */
  runDays(days: number, onReview?: (w: World) => void): void {
    const target = this.w.day + days;
    while (this.w.day < target && !this.w.outcome.ended) {
      if (this.w.review.pending) {
        if (onReview) onReview(this.w);
        else if (this.opts.autoReview) autoCloseReview(this.w);
        if (this.w.review.pending) return;
        if (this.w.outcome.ended) return;
      }
      this.tick();
    }
  }

  private daily(): void {
    const w = this.w;
    generateWeather(w);
    dailyMoisture(w, this.runoff);
    hydrologyDaily(w, this.runoff, this.hooks);
    updateDanger(w, medianFuelMoisture(w));
    const ban = fireBanActive(w);
    if (ban) w.memory.fireBanDays++;
    w.memory.fireBanActive = ban;
    weatherOnFires(w);
    vegetationDaily(w);
    if (w.doy % 30 === 0) {
      beetlesMonthly(w, this.hooks);
      updateFirewise(w);
      councilMonthly(w);
      monthlyDiscoveries(w);
      this.statsMonthly();
    }
    wildlifeDaily(w, this.hooks);
    townsDaily(w);
    dailyEconomy(w);
    crewsDaily(w);
    projectsDaily(w);
    decayTreatments(w);
    // snowpack tracking (valley mean SWE, sampled)
    if (w.season === 0 || w.season === 3) {
      let s = 0,
        n = 0;
      for (let i = 0; i < w.N; i += 11) {
        s += w.L.snow[i];
        n++;
      }
      w.climate.snowpackPeak = Math.max(w.climate.snowpackPeak, s / n);
    }
    if (this.hooks.onNewDay) this.hooks.onNewDay(w);
  }

  private startOfYear(): void {
    const w = this.w;
    w.lastYearStarted = w.year;
    newClimateYear(w);
    refreshSuitability(w);
    refreshSoilCapacity(w);
    if (w.day > 0) beetleWinterKill(w);
    if (w.economy.ledger.year !== w.year) w.economy.ledger = { year: w.year, income: {}, expense: {} };
  }

  private endOfYear(): void {
    const w = this.w;
    // the clock has already rolled over: what is recorded here belongs to the closing year
    w.closingYear = true;
    const c = w.counters;
    const yr = w.year - 1;
    const s = w.stats;
    s.year.push(yr);
    s.burned.push(c.yearBurned);
    s.burnedHigh.push(c.yearBurnedHigh);
    s.structuresLost.push(c.yearStructuresLost);
    s.harvest.push(Math.round(w.economy.harvestThisYear));
    s.visitors.push(Math.round(w.economy.visitorsThisYear));
    s.smokeDays.push(c.yearSmokeDays);
    s.precip.push(Math.round(c.yearPrecip));
    s.snowPeak.push(Math.round(w.climate.snowpackPeak));
    // snow drought: a thin snowpack relative to the first years
    const peaks = s.snowPeak;
    if (peaks.length >= 3) {
      const k = Math.min(5, peaks.length - 1);
      const ref = peaks.slice(0, k).reduce((a, b) => a + b, 0) / k;
      if (peaks[peaks.length - 1] < ref * 0.55) discover(w, 'snow-drought');
    }
    if (w.climate.yearWet < 0.68) w.record('climate', `A drought year: only ${Math.round(c.yearPrecip)} mm of precipitation fell.`, 2);
    const closedLedger = closeEconomyYear(w);
    townsYearly(w);
    maintainFuelbreaks(w);
    maintainBuffers(w);
    if (w.memory.millClosedYear === w.year) w.record('people', 'The sawmill shut its doors for want of logs.', 3);
    w.memory.lastYearSmoke = c.yearSmokeDays;
    w.memory.trustSum = (w.memory.trustSum ?? 0) + w.trust;
    w.memory.trustYears = (w.memory.trustYears ?? 0) + 1;
    w.memory.rxSmokeDays = Math.floor((w.memory.rxSmokeDays ?? 0) * 0.5);
    c.yearBurned = 0;
    c.yearBurnedHigh = 0;
    c.yearStructuresLost = 0;
    c.yearPrecip = 0;
    c.yearSmokeDays = 0;
    c.yearDepredations = 0;
    c.yearWolvesKilled = 0;
    c.yearHunted = 0;
    c.yearEscapes = 0;
    c.yearRxBurned = 0;
    c.yearTreated = 0;
    c.yearFloods = 0;
    c.yearWaterShortDays = 0;
    c.yearClosedDays = 0;
    w.memory.fireBanDays = 0;
    if (this.hooks.onNewYear) this.hooks.onNewYear(w);
    w.closingYear = false;
    beginReview(w, closedLedger);
  }

  private statsMonthly(): void {
    const w = this.w;
    const s = w.stats;
    const v = vegetationSummary(w);
    s.month.push(w.day / 30);
    s.funds.push(Math.round(w.economy.funds));
    s.trust.push(Math.round(w.trust * 10) / 10);
    s.population.push(w.population);
    s.deer.push(deerCount(w));
    s.wolves.push(wolfCount(w));
    s.beavers.push(w.colonies.filter((c) => c.active).length);
    s.fuel.push(Math.round(v.hazard * 1000) / 1000);
    s.forest.push(Math.round(v.forestFrac * 1000) / 1000);
    s.oldGrowth.push(v.oldGrowth);
    s.beetle.push(beetleSummary(w));
    s.reservoir.push(Math.round(w.reservoirLevel * 1000) / 1000);
    for (const f of FACTIONS) s.approvals[f].push(Math.round(w.factions[f].approval * 10) / 10);
  }
}

/** Headless review handling: answer every petition the same way and continue. */
export function autoCloseReview(w: World, accept = false): void {
  for (const p of w.review.petitions) {
    if (!p.resolved) {
      p.resolved = true;
      p.accepted = accept;
    }
  }
  w.review.pending = false;
  const v = w.review.verdict;
  if (v === 'dismissed' || v === 'bankrupt' || v === 'tenure') {
    w.outcome.ended = true;
    w.outcome.reason = v === 'tenure' ? 'tenure' : v === 'bankrupt' ? 'bankrupt' : 'dismissed';
    w.outcome.year = w.review.year;
    return;
  }
  applyAllocation(w);
}

/** Fireline, retardant and water drops weather away. */
function decayTreatments(w: World): void {
  const L = w.L;
  const rain = w.weather.precip * 0.02;
  for (let i = 0; i < w.N; i++) {
    if (L.retard[i] > 0) L.retard[i] = Math.max(0, L.retard[i] - 0.12 - rain);
    if (L.wet[i] > 0) L.wet[i] = Math.max(0, L.wet[i] - 0.35);
    if (L.fline[i] > 0) L.fline[i] = Math.max(0, L.fline[i] - 0.004);
  }
}
