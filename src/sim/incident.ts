/**
 * Incidents: the stage a fire has reached, and — when it is out — an account of what it did, what
 * stopped it, and whether the ground the warden had prepared made a difference.
 *
 * FIREWEED 1.x ended every fire with one line ("…is out after 1 days: 212 ha"). Nothing told the
 * player whether a fuel break held, whether thinned ground burned any cooler, or whether crews or
 * the weather put it out, so nothing connected years of work to the day it was tested.
 */
import { DX8, DY8 } from './grid.ts';
import { FIRE, INFRA } from './types.ts';
import type { FireEvent, FireReport, StopCause } from './types.ts';
import type { World } from './world.ts';
import { TREATED_YEARS, containment } from './systems/fire.ts';
import { DANGER_NAMES } from './systems/climate.ts';
import { forecast, seasonOutlook } from './forecast.ts';
import { projectSpread } from './projection.ts';
import { discover } from './notes.ts';
import { cellFuel } from './systems/fuels.ts';
import type { CellFuel } from './systems/fuels.ts';

/** 0 initial attack, 1 extended attack, 2 major incident. */
export type FireStage = 0 | 1 | 2;
export const STAGE_NAME = ['Initial attack', 'Extended attack', 'Major incident'] as const;
/** A fire this large (ha) has escaped initial attack. */
export const ESCAPED_AREA = 10;
/** A fire this large (ha) is a major incident whatever else is true of it. */
export const MAJOR_AREA = 400;

/** Was this cell thinned, cleared or burned (by anyone, or by an earlier fire) recently enough to matter? */
export function recentlyTreated(w: World, i: number): boolean {
  return w.yearF - w.L.lastTreat[i] < TREATED_YEARS || w.yearF - w.L.lastBurn[i] < TREATED_YEARS;
}

/** The stage a wildfire is at now, from its size, its age and what it threatens. */
export function fireStage(w: World, fe: FireEvent): FireStage {
  if (fe.cause === 'prescribed' || fe.cause === 'pile') return 0;
  const aid = w.aid.some((t) => t.fireId === fe.id && !t.released);
  if (fe.area >= MAJOR_AREA || fe.structuresLost > 0 || aid || (fe.inBuffer && fe.area >= ESCAPED_AREA)) return 2;
  const days = fe.detected && fe.detectedDay >= 0 ? w.day - fe.detectedDay : 0;
  if (fe.area >= ESCAPED_AREA || days >= 2) return 1;
  return 0;
}

export interface IncidentHooks {
  /** a fire moved up a stage (1: escaped initial attack, 2: major incident) */
  onStage?: (fe: FireEvent, stage: FireStage) => void;
}

/** Note the highest stage every reported fire has reached; tell the hooks when one moves up. */
export function updateIncidents(w: World, hooks: IncidentHooks = {}): void {
  for (const fe of w.fires) {
    if (!fe.active || !fe.detected) continue;
    const s = fireStage(w, fe);
    if (s > (fe.stage ?? 0)) {
      fe.stage = s;
      if (hooks.onStage) hooks.onStage(fe, s);
    }
    let crews = 0;
    for (const c of w.crews) if (c.task?.fireId === fe.id) crews++;
    if (crews > (fe.peakCrews ?? 0)) fe.peakCrews = crews;
  }
}

const STOP_TEXT: Record<StopCause, string> = {
  water: 'water',
  road: 'a road',
  fuelbreak: 'a fuel break',
  line: 'line the crews cut',
  scar: 'an earlier burn',
  treated: 'ground you had treated',
  bare: 'rock and bare ground',
  green: 'aspen and wet ground',
  crews: 'crews putting the edge out',
  weather: 'damp nights and rain',
};
export function stopText(c: StopCause): string {
  return STOP_TEXT[c];
}

const fuel: CellFuel = { fine: 0, grassShare: 0, ladder: 0, canopy: 0, heavy: 0, green: 0 };

/** What an unburned cell on a fire's final edge is, as a reason the fire is not in it. */
function classifyEdge(w: World, n: number, from: number): StopCause {
  const L = w.L;
  if (L.water[n] >= 1 || L.pond[n] > 0.35 || L.flowAcc[n] > 1000) return 'water';
  if (L.fline[n] >= 0.6 || L.retard[n] > 0.3) return 'line';
  if (L.infra[n] & INFRA.FUELBREAK) return 'fuelbreak';
  if (L.infra[n] & INFRA.ROAD) return 'road';
  if (w.yearF - L.lastBurn[n] < TREATED_YEARS) return 'scar';
  if (w.yearF - L.lastTreat[n] < TREATED_YEARS) return 'treated';
  cellFuel(w, n, fuel);
  if (fuel.fine < 1) return 'bare';
  if (L.aspen[n] > 0.3 || L.sm[n] > 0.75 || L.twi[n] > 0.8) return 'green';
  // burnable ground the fire did not take: someone put that edge out, or it went out by itself
  return L.fstop[from] > 0 ? 'crews' : 'weather';
}

/**
 * The after-action report of a fire that has just gone out. Call it before the fire's cells are
 * released (they are found by their fire id).
 */
export function buildFireReport(w: World, fe: FireEvent): FireReport {
  const L = w.L;
  const W = w.W;
  const tally: Record<StopCause, number> = { water: 0, road: 0, fuelbreak: 0, line: 0, scar: 0, treated: 0, bare: 0, green: 0, crews: 0, weather: 0 };
  let edge = 0;
  const reached = new Set<number>();
  const x0 = Math.max(1, fe.minX),
    x1 = Math.min(w.W - 2, fe.maxX),
    y0 = Math.max(1, fe.minY),
    y1 = Math.min(w.H - 2, fe.maxY);
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if (L.fid[i] !== fe.id || L.town[i] !== 0) continue;
      for (let d = 0; d < 8; d++) {
        const n = i + DY8[d] * W + DX8[d];
        if (L.town[n] !== 0) {
          reached.add(n);
          continue;
        }
        if (d & 1) continue; // the edge is counted across the four sides
        if (L.fid[n] === fe.id || L.fire[n] !== FIRE.NONE) continue;
        tally[classifyEdge(w, n, i)]++;
        edge++;
      }
    }
  const stopped = (Object.keys(tally) as StopCause[])
    .filter((k) => tally[k] > 0)
    .map((k): [StopCause, number] => [k, tally[k] / Math.max(1, edge)])
    .sort((a, b) => b[1] - a[1]);
  const aidCost = w.aid.filter((t) => t.fireId === fe.id).reduce((a, t) => a + t.cost, 0);
  const treatedArea = fe.treatedArea ?? 0,
    treatedHigh = fe.treatedHigh ?? 0;
  const days = Math.max(0, w.day - fe.startDay);
  const rep: FireReport = {
    fireId: fe.id,
    name: fe.name,
    cause: fe.cause,
    startDay: fe.startDay,
    outDay: w.day,
    x: Math.round((fe.minX + fe.maxX) / 2),
    y: Math.round((fe.minY + fe.maxY) / 2),
    area: fe.area,
    high: fe.highSeverity,
    low: fe.lowSeverity,
    crown: fe.crownArea,
    peakFlame: Math.round(fe.maxIntensity * 10) / 10,
    homesReached: reached.size,
    homesLost: fe.structuresLost,
    cost: Math.round(fe.cost),
    aidCost: Math.round(aidCost),
    stage: fe.stage ?? 0,
    peakCrews: fe.peakCrews ?? 0,
    knocked: fe.knocked ?? 0,
    stopped,
    treatedArea,
    treatedHigh,
    untreatedHigh: Math.max(0, fe.highSeverity - treatedHigh),
    text: [],
  };
  rep.text = narrate(w, fe, rep, days);
  return rep;
}

const pct = (x: number) => Math.round(100 * x) + ' %';
const ha = (n: number) => n.toLocaleString('en-US') + ' ha';
const money = (n: number) => (n >= 1e6 ? '$' + (n / 1e6).toFixed(2) + 'M' : '$' + Math.round(n / 1000) + 'k');

function narrate(w: World, fe: FireEvent, r: FireReport, days: number): string[] {
  const out: string[] = [];
  const span = days <= 0 ? 'the day it started' : days === 1 ? 'a day' : days + ' days';
  // 1. what it was
  const sevHigh = r.area > 0 ? r.high / r.area : 0;
  const character = r.crown / Math.max(1, r.area) > 0.4 ? 'much of it as crown fire' : sevHigh > 0.3 ? pct(sevHigh) + ' of it severely' : r.low / Math.max(1, r.area) > 0.6 ? 'most of it as a light surface fire' : pct(sevHigh) + ' of it severely';
  if (r.stage === 0) out.push(`Caught in initial attack at ${ha(r.area)}, ${days <= 0 ? 'on ' + span : 'within ' + span}.`);
  else out.push(`Burned ${ha(r.area)} over ${span}, ${character}.`);
  // 2. what stopped it
  const main = r.stopped.filter((e) => e[1] >= 0.12).slice(0, 3);
  if (main.length && r.area >= 3) {
    const parts = main.map((e) => `${stopText(e[0])} (${pct(e[1])})`);
    const list = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
    out.push(`Its edge was held by ${list}.`);
  }
  // 3. did prepared ground matter?
  const untreatedArea = r.area - r.treatedArea;
  if (r.treatedArea >= 10 && untreatedArea >= 10) {
    const a = r.treatedHigh / r.treatedArea,
      b = r.untreatedHigh / untreatedArea;
    if (b > 0.05 && a < b * 0.6) out.push(`${ha(r.treatedArea)} of it was ground thinned or burned in the last ${TREATED_YEARS} years: ${pct(a)} of that burned severely, against ${pct(b)} of the rest.`);
    else if (b > 0.05) out.push(`${ha(r.treatedArea)} of it was ground thinned or burned in the last ${TREATED_YEARS} years, and it burned about as hard as the rest (${pct(a)} severe against ${pct(b)}): the day was beyond what treatment could do.`);
    else out.push(`${ha(r.treatedArea)} of it was ground thinned or burned in the last ${TREATED_YEARS} years.`);
  } else if (r.treatedArea >= 10 && r.area > 0) {
    out.push(`Nearly all of it was ground thinned or burned in the last ${TREATED_YEARS} years, and ${pct(r.treatedHigh / r.treatedArea)} burned severely.`);
  }
  // 4. homes
  if (r.homesReached > 0) {
    const towns = fe.threatenedTowns.map((t) => w.towns[t]?.name).filter(Boolean);
    const where = towns.length ? ' in ' + towns.join(' and ') : '';
    if (r.homesLost === 0) out.push(`Fire reached ${r.homesReached} homes${where}; none was lost.`);
    else out.push(`Fire reached ${r.homesReached} homes${where}; ${r.homesLost} burned.`);
  } else if (r.homesLost > 0) out.push(`${r.homesLost} homes burned.`);
  // 5. what it took
  if (r.cost + r.aidCost >= 20_000) {
    const aid = r.aidCost > 0 ? `, ${money(r.aidCost)} of it for the outside team` : '';
    const crews = r.peakCrews > 0 ? ` and up to ${r.peakCrews} crews` : '';
    out.push(`It took ${money(r.cost + r.aidCost)}${aid}${crews}.`);
  }
  return out;
}

/** File a finished fire's report (the most recent 60 are kept). */
export function fileFireReport(w: World, rep: FireReport): void {
  w.reports.push(rep);
  if (w.reports.length > 60) w.reports.splice(0, w.reports.length - 60);
}

// ---------------------------------------------------------------- the day's rhythm
const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];
/** Where a wind blowing toward `dir` (radians, y down the map) comes from. */
function windFrom(dir: number): string {
  const k = Math.round(((dir + Math.PI) / (Math.PI / 4)) % 8 + 8) % 8;
  return COMPASS[k];
}

function etaText(hours: number): string {
  if (hours < 6) return 'within hours';
  if (hours < 14) return 'by tonight';
  if (hours < 30) return 'tomorrow';
  return 'in about two days';
}

/**
 * 06:00: where each escaped fire stands, what the day will bring and where the fire is expected to
 * go. One line per fire per day: a long incident keeps a pulse without a wall of messages.
 */
export function morningBriefings(w: World): void {
  const fc = forecast(w, 1)[0];
  for (const fe of w.fires) {
    if (!fe.active || !fe.detected || fe.cause === 'prescribed' || fe.cause === 'pile') continue;
    const grew = fe.area - (fe.areaYesterday ?? fe.area);
    fe.areaYesterday = fe.area;
    if ((fe.stage ?? 0) < 1 || w.day <= fe.detectedDay) continue;
    const day = w.day - fe.startDay + 1;
    const lined = Math.round(containment(w, fe) * 100);
    const pr = projectSpread(w, { fireId: fe.id, hours: 36 });
    const next = pr.area[2];
    const wx = w.weather;
    let line = `${fe.name}, day ${day}: ${fe.area.toLocaleString('en-US')} ha`;
    if (grew > 0) line += ` (+${grew.toLocaleString('en-US')} since yesterday)`;
    line += `, ${lined} % of its edge held. Today: ${DANGER_NAMES[wx.dangerClass].toLowerCase()} danger, wind ${Math.round(wx.windSpeed * 3.6)} km/h from the ${windFrom(wx.windDir)}${wx.windEvent ? ' — the ' + w.climate.localWindName : ''}.`;
    if (next >= 5) line += ` Left alone it would take about ${next.toLocaleString('en-US')} ha more by tomorrow morning.`;
    else {
      line += ' It is not expected to grow much today.';
      if (fe.area >= 50) discover(w, 'night-recovery');
    }
    let level: 'info' | 'warn' | 'danger' = next >= 200 ? 'warn' : 'info';
    let stop: 1 | 2 | undefined = undefined;
    const hit = pr.towns.filter((t) => t.homes > 0).sort((a, b) => a.hours - b.hours)[0];
    if (hit) {
      const town = w.towns[hit.id];
      line += ` It could reach ${town ? town.name : 'homes'} ${etaText(hit.hours)}${hit.crown ? ', as a crown fire' : ''}.`;
      level = 'danger';
      stop = 2;
    }
    if (fc && fc.redFlag && !wx.windEvent) line += ' A fire-weather watch is in force for tomorrow.';
    w.notify(line, level, Math.round((fe.minX + fe.maxX) / 2), Math.round((fe.minY + fe.maxY) / 2), fe.id, stop);
  }
}

/** 18:00 in fire season: warn of a red-flag day tomorrow (the forecast is good but not perfect). */
export function fireWeatherWatch(w: World): void {
  const doy = w.doy;
  if (doy < 60 || doy > 300) return;
  const f = forecast(w, 2)[0];
  if (!f || !f.redFlag || w.memory.watchDay === f.day) return;
  w.memory.watchDay = f.day;
  const what = f.windEventChance >= 0.5 ? `a dry ${w.climate.localWindName} wind, ${Math.round(Math.max(f.windSpeed, 11) * 3.6)} km/h` : `${DANGER_NAMES[f.dangerClass].toLowerCase()} danger with wind ${Math.round(f.windSpeed * 3.6)} km/h from the ${windFrom(f.windDir)}`;
  const burning = w.fires.some((x) => x.active && x.detected && x.cause !== 'prescribed');
  w.notify(`Fire-weather watch for tomorrow: ${what}${f.stormChance >= 0.5 && f.dryStorm ? ', and dry lightning' : ''}. ${burning ? 'Fires burning now will run.' : 'A start tomorrow will be hard to catch.'}`, 'warn', undefined, undefined, undefined, burning ? 2 : 1);
}

/** Mid-spring: the season outlook, once the snowpack is known. */
export function seasonBriefing(w: World): void {
  if (w.doy !== 75 || w.memory.outlookYear === w.year) return;
  w.memory.outlookYear = w.year;
  const o = seasonOutlook(w);
  w.notify(`Season outlook: ${o.text}`, o.fireSeason === 'above' ? 'warn' : 'info', undefined, undefined, undefined, 1);
  if (o.fireSeason === 'above') w.record('climate', `The spring outlook warned of a long fire season: ${o.text}`, 1);
}
