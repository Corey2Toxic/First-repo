/**
 * The valley economy: wages and upkeep, timber harvest from Timber zones
 * (selective or clearcut, optional salvage), grazing on Rangeland, summer
 * visitors drawn by scenery and wildlife, and the annual ledger.
 */
import { clamp01, smoothstep } from '../grid.ts';
import { FIRE, INFRA, ZONE } from '../types.ts';
import { COST, CREW_COST, REVENUE } from '../economyParams.ts';
import { distanceField, millCeiling } from '../gen/settle.ts';
import { FIREWISE_YEARS, firewiseProgress } from './towns.ts';
import type { LedgerYear } from '../types.ts';
import type { World } from '../world.ts';

interface EconCache {
  version: number;
  roadDist: Uint8Array;
  roadCells: number;
  rangeCells: number;
  recCells: number;
  timberCells: number;
  wildernessCells: number;
  breakCells: number;
}
const caches = new WeakMap<World, EconCache>();

export function econCache(w: World): EconCache {
  const version = w.dirty.infra * 1000 + w.dirty.zone;
  let c = caches.get(w);
  if (c && c.version === version) return c;
  const L = w.L;
  let roads = 0,
    range = 0,
    rec = 0,
    timber = 0,
    wild = 0,
    breaks = 0;
  for (let i = 0; i < w.N; i++) {
    if (L.infra[i] & INFRA.ROAD) roads++;
    if (L.infra[i] & INFRA.FUELBREAK) breaks++;
    const z = L.zone[i];
    if (z === ZONE.RANGE) range++;
    else if (z === ZONE.RECREATION) rec++;
    else if (z === ZONE.TIMBER) timber++;
    else if (z === ZONE.WILDERNESS) wild++;
  }
  c = {
    version,
    roadDist: distanceField(w, (i) => (L.infra[i] & INFRA.ROAD) !== 0, 40),
    roadCells: roads,
    rangeCells: range,
    recCells: rec,
    timberCells: timber,
    wildernessCells: wild,
    breakCells: breaks,
  };
  caches.set(w, c);
  return c;
}

export const GRAZE_LEVEL = { none: 0, light: 0.35, heavy: 0.7 } as const;
export const HARVEST_FACTOR = { low: 0.5, medium: 1, high: 1.55 } as const;

/** Timber harvest rules (shared with the mill sizing at world generation). */
export const HARVEST = {
  roadReach: 10, // cells from a road a stand can be logged
  minVolume: 35, // t/ha below which a stand is not worth a sale
  selectiveFrac: 0.35, // share of standing volume a selective cut takes
  selectiveReentry: 15, // years before a selectively cut stand can be cut again
  clearcutFrac: 0.92,
  clearcutReentry: 60,
} as const;
/** A mill starved three years running closes (townsYearly); it can reopen this many years later if the stands have recovered. */
export const MILL_REOPEN_YEARS = 3;

export function dailyEconomy(w: World): void {
  const c = econCache(w);
  let wages = 0;
  for (const cr of w.crews) wages += CREW_COST[cr.kind].yearly / 360;
  w.spend('Crew wages', wages);
  const upkeep =
    (w.towers.length * COST.towerUpkeep + w.camps.length * COST.campUpkeep + c.roadCells * COST.roadUpkeep + c.breakCells * COST.fuelbreakUpkeep) /
    360;
  w.spend('Upkeep', upkeep);
  if (w.policies.airPatrol && w.season <= 2) w.spend('Aviation', COST.airPatrol / 270);
  // home hardening under the firewise code: paid per house over the years the programme runs
  if (w.policies.buildingCode === 'firewise' && firewiseProgress(w) < 1) {
    let homes = 0;
    for (const t of w.towns) homes += t.structures;
    w.spend('Home hardening', (homes * COST.firewisePerHome) / (FIREWISE_YEARS * 360));
  }
  // grazing pressure follows the Rangeland zone at the chosen permit level
  if (w.doy % 30 === 0) updateGrazing(w);
  // summer and autumn visitors
  if (w.month >= 2 && w.month <= 8) visitorsToday(w);
  if (w.doy === 210) timberHarvest(w);
  if (w.doy === 355) yearEndRevenue(w);
}

export function updateGrazing(w: World): void {
  const L = w.L;
  const lvl = GRAZE_LEVEL[w.policies.grazing];
  const season = w.season === 3 ? 0.3 : 1;
  for (let i = 0; i < w.N; i++) L.graze[i] = L.zone[i] === ZONE.RANGE && !L.water[i] ? lvl * season : 0;
}

/** Scenic attractiveness 0..1 for visitors: green forests, aspen gold, lakes, wildlife; minus scars and smoke. */
export function scenicQuality(w: World): number {
  const L = w.L;
  const c = econCache(w);
  let s = 0,
    n = 0,
    scar = 0,
    clear = 0;
  for (let i = 0; i < w.N; i += 3) {
    if (c.roadDist[i] > 6 && L.zone[i] !== ZONE.RECREATION) continue;
    n++;
    const can = L.aspen[i] + L.pine[i] + L.fir[i];
    const old = L.standAge[i] > 120 && can > 0.3 ? 0.25 : 0;
    s += clamp01(0.35 + can * 0.6 + old + L.aspen[i] * 0.6);
    const yrs = w.yearF - L.lastBurn[i];
    if (yrs >= 0 && yrs < 6 && L.burnSev[i] === 3) scar++;
    const yl = w.yearF - L.lastLogged[i];
    if (yl >= 0 && yl < 15 && can < 0.15) clear++;
  }
  if (n === 0) return 0.5;
  const base = s / n;
  const scarPen = (scar / n) * 0.9;
  const clearPen = (clear / n) * 1.2;
  const wolves = w.packs.length > 0 ? 0.08 : 0;
  const beavers = Math.min(0.06, w.colonies.filter((k) => k.active).length * 0.01);
  return clamp01(base - scarPen - clearPen + wolves + beavers);
}

/**
 * Visitors are limited by demand and by places to stay. Demand is how many people the valley draws
 * (scenery, season, smoke, fire bans); capacity is what the campgrounds and Recreation zones can
 * hold; the visitors who come are the smooth minimum of the two. v1.0 multiplied capacity by
 * attractiveness, so every new campground filled itself and earned ~$190k a year on a $45k
 * outlay (ten campgrounds: recreation income +500 %). Calibrated so that the starting valley
 * (one campground, scenery ~0.84) draws ~1.3x the room it has and sees the same visitors as
 * v1.0; a second campground relieves real crowding (~+$100k/yr), a third helps less (~+$20k),
 * a fourth about covers its $4k upkeep, and ten add ~+35 % in all.
 */
export const VISITOR_DRAW = 620; // would-be visitors a day at peak season with scenery attractiveness 1 (scenic 0.78)
export const CAMP_VISITORS = 290; // daily capacity of one campground
export const BASE_VISITORS = 180; // dispersed camping, lodges and day use
export const REC_VISITORS = 0.4; // daily capacity per hectare of Recreation zone
const SERVE_SHARPNESS = 6; // exponent of the smooth minimum: higher = campgrounds fill more abruptly

/** Daily visitor capacity at full season (before fire closures). */
export function visitorCapacity(w: World): number {
  return BASE_VISITORS + CAMP_VISITORS * w.camps.length + REC_VISITORS * econCache(w).recCells;
}

/** Visitors actually served when `demand` people want to come and there is room for `capacity`: a smooth minimum. */
export function visitorsServed(demand: number, capacity: number): number {
  if (!(demand > 0) || !(capacity > 0)) return 0;
  const m = Math.max(demand, capacity);
  const d = demand / m,
    c = capacity / m;
  return (m * d * c) / (d ** SERVE_SHARPNESS + c ** SERVE_SHARPNESS) ** (1 / SERVE_SHARPNESS);
}

function visitorsToday(w: World): void {
  const m = w.memory;
  if (w.doy % 5 === 0 || m.scenic === undefined) m.scenic = scenicQuality(w);
  const scenic = m.scenic;
  // shoulder months: fewer people come, and fewer campground loops are open for them
  const season = w.month >= 3 && w.month <= 5 ? 1 : 0.55;
  const autumnGold = w.month === 7 ? 1.25 : 1;
  let smoke = 0;
  for (const t of w.towns) smoke = Math.max(smoke, t.smokeToday);
  const closure = activeFireNear(w) ? 0.6 : 1;
  const ban = m.fireBanActive ? 0.88 : 1;
  const demand = VISITOR_DRAW * (0.3 + 0.9 * scenic) * season * autumnGold * (1 - 0.7 * clamp01(smoke)) * ban;
  const capacity = visitorCapacity(w) * season * closure;
  const v = visitorsServed(demand, capacity);
  w.economy.visitorsThisYear += v;
  m.visitDemand = (m.visitDemand ?? 0) + demand;
  m.turnedAway = (m.turnedAway ?? 0) + (demand - v);
  w.earn('Recreation fees', v * REVENUE.visitorFee);
  if (closure < 1) w.counters.yearClosedDays++;
}

function activeFireNear(w: World): boolean {
  for (const f of w.fires) {
    if (!f.active || !f.detected || f.cause === 'prescribed') continue;
    if (f.area > 40) return true;
  }
  return false;
}

// ------------------------------------------------------------ campgrounds
export const CAMP_SPACING = 5; // no two campgrounds within 5 cells (500 m)
export const CAMP_ROAD_REACH = 4; // a road within 400 m
export const CAMP_MAX_SLOPE = 0.15;

/** Why no campground can be built on cell `i` right now, or null if one can. */
export function campSiteProblem(w: World, i: number): string | null {
  const L = w.L;
  if (!Number.isInteger(i) || i < 0 || i >= w.N) return 'That place is off the map.';
  if (L.water[i] || L.town[i] !== 0) return 'Cannot build there.';
  if (L.zone[i] === ZONE.WILDERNESS) return 'No developed campgrounds in wilderness.';
  if (L.fire[i] === FIRE.BURNING) return 'That ground is on fire.';
  if (L.slope[i] >= CAMP_MAX_SLOPE) return 'Too steep for a campground.';
  if (econCache(w).roadDist[i] > CAMP_ROAD_REACH) return 'Campgrounds need a road within 400 m.';
  const x = i % w.W,
    y = (i / w.W) | 0;
  // one campground per site: v1.0 let ten be stacked on one hectare for ten times the visitors
  if (w.camps.some((c) => Math.hypot((c % w.W) - x, ((c / w.W) | 0) - y) <= CAMP_SPACING)) return 'Too close to an existing campground.';
  return null;
}

export function campSiteValid(w: World, i: number): boolean {
  return campSiteProblem(w, i) === null;
}

/** Build a campground on a (validated) cell and pay for it. */
export function buildCampground(w: World, i: number): void {
  w.L.infra[i] |= INFRA.CAMP;
  w.camps.push(i);
  w.spend('Infrastructure', COST.camp);
  w.dirty.infra++;
}

/** What makes a pleasant place to camp: shade, aspen, water close by. */
function campScenery(w: World, i: number): number {
  const L = w.L;
  const x0 = i % w.W,
    y0 = (i / w.W) | 0;
  let can = 0,
    aspen = 0,
    n = 0,
    water = 0;
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const x = x0 + dx,
        y = y0 + dy;
      if (!w.inside(x, y)) continue;
      const j = y * w.W + x;
      n++;
      can += L.aspen[j] + L.pine[j] + L.fir[j];
      aspen += L.aspen[j];
      if (L.water[j]) water = Math.max(water, L.water[j] >= 2 ? 1 : 0.6);
    }
  return (0.6 * can) / n + (1.2 * aspen) / n + 0.4 * water;
}

/**
 * The best place for a new campground: a valid site at least 8 cells from any town with the most
 * scenic surroundings (ties to the lowest cell index). Deterministic; -1 when there is none.
 */
export function bestCampSite(w: World): number {
  const L = w.L;
  const townDist = distanceField(w, (i) => L.town[i] !== 0, 9);
  let best = -1,
    bestS = -Infinity;
  for (let i = 0; i < w.N; i++) {
    if (townDist[i] < 8 || campSiteProblem(w, i) !== null) continue;
    const s = campScenery(w, i);
    if (s > bestS) {
      bestS = s;
      best = i;
    }
  }
  return best;
}

// ------------------------------------------------------------ timber
/** Harvestable standing timber (t/ha) in a cell. */
export function timberVolume(w: World, i: number): number {
  const L = w.L;
  const af = (a: number) => smoothstep(25, 110, a);
  return L.pine[i] * 240 * af(L.ageP[i]) + L.fir[i] * 220 * af(L.ageF[i]);
}

export function timberHarvest(w: World): void {
  const L = w.L;
  const e = w.economy;
  const c = econCache(w);
  const clearcut = w.policies.harvestMethod === 'clearcut';
  const frac = clearcut ? HARVEST.clearcutFrac : HARVEST.selectiveFrac;
  const reentry = clearcut ? HARVEST.clearcutReentry : HARVEST.selectiveReentry;
  // [sort value, cell, tonnes a cut would yield]
  const cands: Array<[number, number, number]> = [];
  let stock = 0;
  for (let i = 0; i < w.N; i++) {
    if (L.zone[i] !== ZONE.TIMBER || c.roadDist[i] > HARVEST.roadReach || L.fire[i] === FIRE.BURNING) continue;
    const since = w.yearF - L.lastLogged[i];
    if (since < reentry) continue;
    const live = timberVolume(w, i);
    const salv = w.policies.salvage ? (w.yearF - L.lastBurn[i] < 2.5 ? L.snag[i] * 0.5 : 0) + L.red[i] * 60 : 0;
    const v = live + salv;
    if (v < HARVEST.minVolume) continue;
    cands.push([v, i, live * frac + salv]);
    stock += live * frac + salv;
  }
  cands.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  if (!e.millOpen) maybeReopenMill(w, stock);
  const target = e.millOpen ? e.millDemand * HARVEST_FACTOR[w.policies.harvest] : 0;
  let got = 0;
  let cells = 0;
  for (const [, i, cut] of cands) {
    if (got >= target) break;
    if (w.policies.salvage) {
      L.snag[i] *= 0.4;
      L.red[i] *= 0.3;
      L.hydro[i] = Math.max(L.hydro[i], 0.2);
    }
    L.pine[i] *= 1 - frac;
    L.fir[i] *= 1 - frac * 1.05;
    if (L.fir[i] < 0) L.fir[i] = 0;
    // logging knocks down part of the regeneration; a clearcut most of it (it comes back as a thicket)
    L.under[i] *= clearcut ? 0.4 : 0.85;
    if (clearcut) {
      L.aspen[i] *= 0.3;
      L.hydro[i] = Math.max(L.hydro[i], 0.18);
    }
    const slash = clearcut ? 22 : 11;
    L.slash[i] += w.policies.slash === 'pileburn' ? slash * 0.25 : slash;
    if (w.policies.slash === 'pileburn') w.spend('Fuel treatments', COST.pileBurnPerHa);
    L.lastLogged[i] = w.yearF;
    got += cut;
    cells++;
  }
  // add to (not overwrite) whatever else reached the mill this year
  e.harvestThisYear += got;
  w.earn('Timber', got * REVENUE.timberStumpage * (e.timberPrice / 60));
  w.counters.yearHarvestCells = cells;
  // the quota could not be met because no more stands were ready to cut
  w.memory.harvestStockLimited = e.millOpen && got < target;
  // the mill can only survive so many short years in a row. A quota set below the mill's demand is
  // a choice, not a shortage: the mill strains when it gets under 60 % of what the quota allows
  // (v1.0 compared with full demand, so the 'low' quota (50 %) closed the mill in exactly 3 years,
  // and counted net rather than consecutive short years)
  if (e.millOpen) {
    const need = 0.6 * Math.min(target, e.millDemand);
    if (got < need) e.millStrain++;
    else e.millStrain = 0;
  }
  w.dirty.veg++;
}

/** Smallest mill worth reopening (t/yr). */
export const MILL_MIN_VIABLE = 1000;

/**
 * A closed mill reopens (resized to what the Timber zone can now sustain) once it has stood idle
 * for a few years and the stands ready to cut hold at least two years of its demand.
 */
function maybeReopenMill(w: World, stock: number): void {
  const e = w.economy;
  const m = w.memory;
  if (w.year - (m.millClosedYear ?? w.year - MILL_REOPEN_YEARS) < MILL_REOPEN_YEARS) return;
  const demand = sustainableMillDemand(millCeiling(w, econCache(w).roadDist));
  if (demand < MILL_MIN_VIABLE || stock < 2 * demand) return;
  e.millOpen = true;
  e.millDemand = demand;
  e.millStrain = 0;
  m.millReopenedYear = w.year;
  const mt = w.towns.find((t) => t.mill);
  const where = mt ? ` in ${mt.name}` : '';
  w.record('people', `The sawmill${where} reopened: the Timber zone has grown back enough to keep it in logs (${demand.toLocaleString()} t a year).`, 3, mt?.x, mt?.y);
  w.notify(`The sawmill${where} has reopened.`, 'good', mt?.x, mt?.y);
}

/** A mill sized to run on 75 % of the zone's sustainable yield, in round hundreds of tonnes (max 9000). */
export function sustainableMillDemand(ceiling: number): number {
  return Math.round(Math.min(9000, 0.75 * ceiling) / 100) * 100;
}

function yearEndRevenue(w: World): void {
  const c = econCache(w);
  const lvl = GRAZE_LEVEL[w.policies.grazing];
  w.earn('Grazing fees', c.rangeCells * (lvl / 0.35) * REVENUE.grazingPerHa);
}

/** Called at the year boundary: roll the ledger and market. Returns the closed year's ledger. */
export function closeEconomyYear(w: World): LedgerYear {
  const e = w.economy;
  const closed = e.ledger;
  e.history.push(closed);
  if (e.history.length > 80) e.history.shift();
  e.harvestLastYear = e.harvestThisYear;
  e.harvestThisYear = 0;
  e.visitorsLastYear = e.visitorsThisYear;
  e.visitorsThisYear = 0;
  const m = w.memory;
  m.turnedAwayShare = (m.turnedAway ?? 0) / Math.max(1, m.visitDemand ?? 0);
  m.turnedAway = 0;
  m.visitDemand = 0;
  // timber prices wander (log-normal random walk with mean reversion)
  const r = w.rng.human;
  e.timberPrice = Math.max(30, Math.min(110, e.timberPrice * Math.exp(r.normal(0, 0.12)) * 0.9 + 6));
  e.ledger = { year: w.year, income: {}, expense: {} };
  return closed;
}

export function ledgerTotals(l: { income: Record<string, number>; expense: Record<string, number> }): { income: number; expense: number } {
  let income = 0,
    expense = 0;
  for (const v of Object.values(l.income)) income += v;
  for (const v of Object.values(l.expense)) expense += v;
  return { income, expense };
}
