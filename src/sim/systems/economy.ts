/**
 * The valley economy: wages and upkeep, timber harvest from Timber zones
 * (selective or clearcut, optional salvage), grazing on Rangeland, summer
 * visitors drawn by scenery and wildlife, and the annual ledger.
 */
import { clamp01, smoothstep } from '../grid.ts';
import { FIRE, INFRA, ZONE } from '../types.ts';
import { COST, CREW_COST, REVENUE } from '../economyParams.ts';
import { distanceField } from '../gen/settle.ts';
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
    const old = Math.max(L.ageP[i], L.ageF[i]) > 120 ? 0.25 : 0;
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

function visitorsToday(w: World): void {
  const c = econCache(w);
  if (w.doy % 5 === 0 || w.memory.scenic === undefined) w.memory.scenic = scenicQuality(w);
  const scenic = w.memory.scenic;
  const capacity = 160 + 260 * w.camps.length + 0.35 * c.recCells;
  const autumnGold = w.month === 7 ? 1.25 : 1;
  const peak = w.month >= 3 && w.month <= 5 ? 1 : 0.55;
  let smoke = 0;
  for (const t of w.towns) smoke = Math.max(smoke, t.smokeToday);
  const closure = activeFireNear(w) ? 0.6 : 1;
  const ban = w.memory.fireBanActive ? 0.88 : 1;
  const v = capacity * (0.3 + 0.9 * scenic) * peak * autumnGold * (1 - 0.7 * clamp01(smoke)) * closure * ban;
  w.economy.visitorsThisYear += v;
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
  const target = e.millOpen ? e.millDemand * HARVEST_FACTOR[w.policies.harvest] : 0;
  const cands: Array<[number, number]> = [];
  for (let i = 0; i < w.N; i++) {
    if (L.zone[i] !== ZONE.TIMBER || c.roadDist[i] > 10 || L.fire[i] === FIRE.BURNING) continue;
    const since = w.yearF - L.lastLogged[i];
    if (since < (clearcut ? 60 : 15)) continue;
    let v = timberVolume(w, i);
    if (w.policies.salvage && w.yearF - L.lastBurn[i] < 2.5) v += L.snag[i] * 0.5;
    if (w.policies.salvage) v += L.red[i] * 60;
    if (v < 35) continue;
    cands.push([v, i]);
  }
  cands.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  let got = 0;
  let cells = 0;
  for (const [, i] of cands) {
    if (got >= target) break;
    const frac = clearcut ? 0.92 : 0.35;
    const live = timberVolume(w, i) * frac;
    let salv = 0;
    if (w.policies.salvage) {
      salv = (w.yearF - L.lastBurn[i] < 2.5 ? L.snag[i] * 0.5 : 0) + L.red[i] * 60;
      L.snag[i] *= 0.4;
      L.red[i] *= 0.3;
      L.hydro[i] = Math.max(L.hydro[i], 0.2);
    }
    L.pine[i] *= 1 - frac;
    L.fir[i] *= 1 - frac * 1.05;
    if (L.fir[i] < 0) L.fir[i] = 0;
    if (clearcut) {
      L.aspen[i] *= 0.3;
      L.hydro[i] = Math.max(L.hydro[i], 0.18);
    }
    const slash = clearcut ? 22 : 11;
    L.slash[i] += w.policies.slash === 'pileburn' ? slash * 0.25 : slash;
    if (w.policies.slash === 'pileburn') w.spend('Fuel treatments', COST.pileBurnPerHa);
    L.lastLogged[i] = w.yearF;
    got += live + salv;
    cells++;
  }
  e.harvestThisYear = got;
  w.earn('Timber', got * REVENUE.timberStumpage * (e.timberPrice / 60));
  w.counters.yearHarvestCells = cells;
  // the mill can only survive so many short years
  if (e.millOpen) {
    if (got < 0.6 * e.millDemand) e.millStrain++;
    else e.millStrain = Math.max(0, e.millStrain - 1);
  }
  w.dirty.veg++;
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
