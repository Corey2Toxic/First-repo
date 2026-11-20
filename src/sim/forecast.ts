/**
 * Weather forecast and seasonal outlook.
 *
 * The valley's weather comes from its own random stream (`rng.weather`) and climate state, and
 * nothing else draws from that stream, so the days ahead can be generated on a copy without
 * touching the game: the forecaster knows the true future. What the warden is shown is that truth
 * through a noisy channel whose skill falls with lead time, the way a real forecast behaves:
 *
 *  - yes/no hazards (a downslope wind event, a wetting rain, thunderstorms) are *believed* correctly
 *    with probability `SKILL[lead]`, otherwise the forecaster's belief is a draw from climatology;
 *    the published chance is `skill × belief + (1 − skill) × climatology`, so a 5-day outlook hedges
 *    toward the seasonal odds and tomorrow's forecast is nearly certain;
 *  - continuous values (wind, humidity, temperature) carry an error that grows with lead.
 *
 * The error for a given target day and lead is a fixed function of the seed (a hash, not a random
 * draw), so the forecast is stable while the player looks at it, is revised as the day approaches,
 * and replays identically. Forecasting never advances any random stream or changes any state.
 */
import { Rng, hash2 } from './rng.ts';
import { clamp, clamp01 } from './grid.ts';
import { DAYS_PER_YEAR } from './types.ts';
import type { ClimateState, Weather } from './types.ts';
import { droughtSeverity, generateWeather, newClimateYear } from './systems/climate.ts';
import { emc, medianFuelMoisture } from './systems/moisture.ts';
import type { World } from './world.ts';

/** How many days ahead the forecast reaches. */
export const FORECAST_DAYS = 5;
/** Probability that the forecaster's belief about a yes/no hazard is right, by lead (index 0 = tomorrow). */
export const SKILL = [0.96, 0.88, 0.78, 0.68, 0.58] as const;

export interface DayForecast {
  /** absolute day this forecast is for */
  day: number;
  /** 1 = tomorrow */
  lead: number;
  tmax: number;
  /** relative humidity 0..1 */
  rh: number;
  /** m/s */
  windSpeed: number;
  /** radians, direction the wind blows toward */
  windDir: number;
  /** expected fire-danger class 0..4 */
  dangerClass: number;
  /** published chances 0..1 */
  windEventChance: number;
  rainChance: number;
  stormChance: number;
  /** thunderstorms are expected to be dry */
  dryStorm: boolean;
  /** convenience: a red-flag day is forecast (wind event likely, or very high danger with wind) */
  redFlag: boolean;
}

/** The true weather of the coming days (what will happen if the game runs on). */
export interface TrueDay {
  day: number;
  weather: Weather;
  droughtIndex: number;
  /** projected median dead-fuel moisture */
  fm: number;
  dangerClass: number;
}

interface Shadow {
  climate: ClimateState;
  rng: { weather: Rng };
  weather: Weather;
  config: World['config'];
  outletCell: number;
  W: number;
  counters: { yearPrecip: number };
  day: number;
  readonly doy: number;
  readonly yearsElapsed: number;
}

/** Danger class from median fuel moisture, wind and drought: the rule of climate.updateDanger. */
export function dangerClassFor(medianFm: number, windSpeed: number, droughtIndex: number): number {
  const dryness = clamp01((0.28 - medianFm) / 0.22);
  const windF = 0.55 + 0.45 * clamp01(windSpeed / 12);
  const d = clamp01(Math.pow(dryness, 1.15) * windF * (0.75 + 0.45 * droughtSeverity(droughtIndex)));
  return d < 0.15 ? 0 : d < 0.32 ? 1 : d < 0.52 ? 2 : d < 0.72 ? 3 : 4;
}

/**
 * Generate the next `days` days of weather on a copy of the weather state. Pure: the world is not
 * changed. Stops at the end of the tenure year count only if asked to (it does cross year ends).
 */
export function trueWeatherAhead(w: World, days: number): TrueDay[] {
  const shadow: Shadow = {
    climate: { ...w.climate },
    rng: { weather: Rng.fromState(w.rng.weather.getState()) },
    weather: { ...w.weather },
    config: w.config,
    outletCell: w.outletCell,
    W: w.W,
    counters: { yearPrecip: 0 },
    day: w.day,
    get doy() {
      return this.day % DAYS_PER_YEAR;
    },
    get yearsElapsed() {
      return this.day / DAYS_PER_YEAR;
    },
  };
  const sw = shadow as unknown as World;
  const out: TrueDay[] = [];
  // the valley's median fuel moisture follows the day's equilibrium moisture with a lag, and jumps
  // with rain (the same relaxation moisture.ts applies to every cell)
  let fm = medianFuelMoisture(w);
  // has today's weather been drawn yet? (daily systems run in the first sub-step of the day)
  const todayDrawn = w.sub > 0;
  for (let k = 0; k < days; k++) {
    if (k > 0 || todayDrawn) shadow.day++;
    // a new year draws its climate anomaly first (unless the game already did, for today)
    if (shadow.doy === 0 && !(k === 0 && !todayDrawn && w.lastYearStarted === w.year)) newClimateYear(sw);
    generateWeather(sw);
    const wx = shadow.weather;
    const winter = wx.temp < 0.5 && wx.precip > 0.5;
    if (winter) fm = 0.4;
    else {
      // (site offset fitted to the valley median; left a few thousandths dry so errors lean cautious)
      fm += (emc(wx.rh, wx.tmax) + 0.017 - fm) * 0.55;
      if (wx.precip > 0.5) fm = Math.max(fm, Math.min(0.42, 0.16 + wx.precip * 0.018));
    }
    out.push({ day: shadow.day, weather: { ...wx }, droughtIndex: shadow.climate.droughtIndex, fm, dangerClass: dangerClassFor(fm, wx.windSpeed, shadow.climate.droughtIndex) });
  }
  return out;
}

/** Seasonal odds used when the forecaster has no skill (per day, by month). */
const CLIM_WIND_EVENT = [0.01, 0.007, 0.003, 0.003, 0.012, 0.025, 0.05, 0.05, 0.035, 0.012, 0.008, 0.008];
const CLIM_RAIN = [0.2, 0.2, 0.18, 0.16, 0.14, 0.12, 0.12, 0.14, 0.18, 0.25, 0.25, 0.25];
const CLIM_STORM = [0, 0.01, 0.04, 0.1, 0.15, 0.15, 0.1, 0.04, 0.01, 0, 0, 0];

/** A stable pseudo-random number in [0, 1) for (seed, target day, lead, channel). */
function noise(seedHash: number, day: number, lead: number, channel: number): number {
  return hash2(day * 7 + channel, lead * 13 + (seedHash & 0xffff), (seedHash >>> 16) + channel * 101);
}
/** A stable standard-normal-ish number from two uniform hashes. */
function gauss(seedHash: number, day: number, lead: number, channel: number): number {
  const u = Math.max(1e-6, noise(seedHash, day, lead, channel));
  const v = noise(seedHash, day, lead, channel + 31);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function seedHashOf(w: World): number {
  let h = 2166136261;
  const s = w.config.seed;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The published chance of a yes/no hazard: truth seen through a channel of the given skill. */
function hedged(truth: boolean, skill: number, clim: number, u: number, u2: number): number {
  const belief = u < skill ? truth : u2 < clim;
  return clamp01(skill * (belief ? 1 : 0) + (1 - skill) * clim);
}

/** The forecast the warden sees for the coming days. Pure; stable within a day. */
export function forecast(w: World, days: number = FORECAST_DAYS): DayForecast[] {
  const truth = trueWeatherAhead(w, Math.min(days, SKILL.length));
  const sh = seedHashOf(w);
  const out: DayForecast[] = [];
  for (let k = 0; k < truth.length; k++) {
    const t = truth[k];
    const lead = k + 1;
    const skill = SKILL[k];
    const wx = t.weather;
    const m = Math.floor((t.day % DAYS_PER_YEAR) / 30);
    const err = 1 - skill; // 0.04 .. 0.42
    const windSpeed = clamp(wx.windSpeed * Math.exp(gauss(sh, t.day, lead, 1) * err * 0.7), 0.3, 20);
    const windDir = wx.windDir + gauss(sh, t.day, lead, 2) * err * 1.2;
    const rh = clamp(wx.rh + gauss(sh, t.day, lead, 3) * err * 0.22, 0.05, 1);
    const tmax = wx.tmax + gauss(sh, t.day, lead, 4) * err * 6;
    const windEventChance = hedged(wx.windEvent, skill, CLIM_WIND_EVENT[m], noise(sh, t.day, lead, 5), noise(sh, t.day, lead, 6));
    const rainChance = hedged(wx.precip > 2, skill, CLIM_RAIN[m], noise(sh, t.day, lead, 7), noise(sh, t.day, lead, 8));
    const stormChance = hedged(wx.storm, skill, CLIM_STORM[m], noise(sh, t.day, lead, 9), noise(sh, t.day, lead, 10));
    // expected danger: the projected fuel moisture nudged by the humidity error, with the forecast wind
    const fm = clamp(t.fm + (rh - wx.rh) * 0.12 + (rainChance > 0.6 && wx.precip <= 2 ? 0.06 : 0), 0.02, 0.42);
    const wind = windEventChance > 0.5 ? Math.max(windSpeed, 11) : windSpeed;
    const dangerClass = dangerClassFor(fm, wind, t.droughtIndex);
    out.push({
      day: t.day,
      lead,
      tmax,
      rh,
      windSpeed,
      windDir,
      dangerClass,
      windEventChance,
      rainChance,
      stormChance,
      dryStorm: wx.dryLightning,
      redFlag: windEventChance >= 0.5 || (dangerClass >= 3 && windSpeed >= 8),
    });
  }
  return out;
}

export type OutlookLevel = 'below' | 'normal' | 'above';
export interface SeasonOutlook {
  /** expected fire-season severity */
  fireSeason: OutlookLevel;
  /** this winter's peak snowpack as a fraction of the valley's normal (if known) */
  snowpack: number;
  /** the year's precipitation and temperature tendency as the forecasters see it */
  wet: OutlookLevel;
  warm: OutlookLevel;
  text: string;
}

/**
 * The seasonal outlook issued at the start of each year: this year's climate anomaly (already drawn
 * at the year's first day) seen with about 70 % skill, plus the snowpack that has actually fallen.
 */
export function seasonOutlook(w: World): SeasonOutlook {
  const c = w.climate;
  const sh = seedHashOf(w);
  const y = w.year;
  const nWet = gauss(sh, y, 40, 1) * 0.1;
  const nWarm = gauss(sh, y, 40, 2) * 0.45;
  const wetSeen = c.yearWet / Math.max(0.05, w.config.dryness) + nWet;
  const warmSeen = c.yearTemp - (c.trendPerDecade * w.yearsElapsed) / 10 + nWarm;
  const wet: OutlookLevel = wetSeen < 0.9 ? 'below' : wetSeen > 1.1 ? 'above' : 'normal';
  const warm: OutlookLevel = warmSeen < -0.35 ? 'below' : warmSeen > 0.35 ? 'above' : 'normal';
  const peaks = w.stats.snowPeak;
  const ref = peaks.length ? peaks.slice(0, Math.min(5, peaks.length)).reduce((a, b) => a + b, 0) / Math.min(5, peaks.length) : 0;
  const snowpack = ref > 0 && c.snowpackPeak > 0 ? c.snowpackPeak / ref : 1;
  const score = (wet === 'below' ? 1 : wet === 'above' ? -1 : 0) + (warm === 'above' ? 0.6 : warm === 'below' ? -0.6 : 0) + (snowpack < 0.7 ? 0.8 : snowpack > 1.25 ? -0.5 : 0) + droughtSeverity(c.droughtIndex);
  const fireSeason: OutlookLevel = score >= 1 ? 'above' : score <= -0.8 ? 'below' : 'normal';
  const bits: string[] = [];
  bits.push(wet === 'below' ? 'a dry year is likely' : wet === 'above' ? 'a wet year is likely' : 'near-normal precipitation is expected');
  bits.push(warm === 'above' ? 'warmer than usual' : warm === 'below' ? 'cooler than usual' : 'near-normal temperatures');
  if (snowpack < 0.7) bits.push(`snowpack at ${Math.round(snowpack * 100)} % of normal`);
  else if (snowpack > 1.25) bits.push(`a deep snowpack (${Math.round(snowpack * 100)} % of normal)`);
  const head = fireSeason === 'above' ? 'An early, long fire season is likely' : fireSeason === 'below' ? 'A late, short fire season is likely' : 'A normal fire season is expected';
  return { fireSeason, snowpack, wet, warm, text: `${head}: ${bits.join(', ')}.` };
}
