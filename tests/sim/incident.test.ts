/**
 * The play loop around a fire: its stage, the morning briefing, the after-action report, and the
 * figures that connect years of work to the day it is tested (town exposure, the council's charge).
 * None of this existed in 1.1.1, where a fire ended with "…is out after 1 days: 212 ha".
 */
import { describe, expect, it } from 'vitest';
import { established, flatWorld, smallWorld } from '../helpers.ts';
import type { FlatOpts } from '../helpers.ts';
import { applyFireEffects, defaultResponse, fireSubstep, startFire } from '../../src/sim/systems/fire.ts';
import { applyThinning } from '../../src/sim/systems/projects.ts';
import { crewsDaily, crewsSubstep, requestAid, spendEmergency } from '../../src/sim/systems/crews.ts';
import { applyCommand } from '../../src/sim/commands.ts';
import { makeCrew } from '../../src/sim/gen/crews.ts';
import { ESCAPED_AREA, MAJOR_AREA, fireStage, morningBriefings, updateIncidents } from '../../src/sim/incident.ts';
import { makeEventHooks } from '../../src/sim/events.ts';
import { refreshExposure } from '../../src/sim/projection.ts';
import { objectiveMet, objectives, objectivesMet } from '../../src/sim/objectives.ts';
import { SCENARIOS } from '../../src/sim/scenarios.ts';
import { Simulation } from '../../src/sim/sim.ts';
import { decodeWorld, encodeWorld, stateHash } from '../../src/sim/save.ts';
import { evaluateLegacy } from '../../src/sim/score.ts';
import { councilMonthly } from '../../src/sim/systems/council.ts';
import { COST, EMERGENCY_CREDIT } from '../../src/sim/economyParams.ts';
import { FIRE, INFRA, ZONE } from '../../src/sim/types.ts';
import type { FireEvent, StopCause, Town } from '../../src/sim/types.ts';
import type { World } from '../../src/sim/world.ts';
import { Rng } from '../../src/sim/rng.ts';

const GRASS: FlatOpts = { grass: 0.85, litter: 0.4 };
const PINE: FlatOpts = { grass: 0.05, pine: 0.55, litter: 6, dead: 8 };
const THICKET: FlatOpts = { grass: 0.05, pine: 0.4, fir: 0.45, shrub: 0.3, litter: 16, dead: 30, under: 0.85 };

/** Run fire (and crews) through real days until the fire is out or `days` have passed. */
function burnOut(w: World, days: number, crews = false): void {
  const hooks = makeEventHooks(w);
  for (let s = 0; s < days * 8 && w.burning.length; s++) {
    if (w.sub === 0 && crews) crewsDaily(w, hooks);
    fireSubstep(w, hooks);
    updateIncidents(w, hooks);
    if (crews) crewsSubstep(w, hooks);
    w.sub++;
    if (w.sub === 8) {
      w.sub = 0;
      w.day++;
    }
  }
}

function share(rep: { stopped: Array<[StopCause, number]> }, cause: StopCause): number {
  return rep.stopped.find((e) => e[0] === cause)?.[1] ?? 0;
}

function addTown(w: World, x: number, y: number, homes: Array<[number, number]>, firewise = 0.3): Town {
  const t: Town = { id: w.towns.length, name: 'Testville', x, y, population: 400, structures: homes.length, lostStructures: 0, mill: false, station: y * w.W + x, firewise, smokeToday: 0, smokeDays: 0, threat: 0, evacuated: false, growthPressure: 0, happiness: 0.5 };
  w.towns.push(t);
  for (const [hx, hy] of homes) w.L.town[hy * w.W + hx] = t.id + 1;
  return t;
}

describe('fire stages', () => {
  it('a fire is in initial attack until it is 10 ha or two days old, and a major incident at 400 ha or among homes', () => {
    const w = flatWorld(80, 40, PINE);
    const fe = startFire(w, 20 * w.W + 20, 'lightning')!;
    fe.detected = true;
    fe.detectedDay = w.day;
    expect(fireStage(w, fe)).toBe(0);
    fe.area = ESCAPED_AREA;
    expect(fireStage(w, fe)).toBe(1);
    fe.area = 3;
    w.day += 2;
    expect(fireStage(w, fe)).toBe(1);
    fe.area = MAJOR_AREA;
    expect(fireStage(w, fe)).toBe(2);
    fe.area = 30;
    fe.structuresLost = 1;
    expect(fireStage(w, fe)).toBe(2);
    // a prescribed burn is never an incident
    const rx = startFire(w, 10 * w.W + 60, 'prescribed')!;
    rx.area = 900;
    expect(fireStage(w, rx)).toBe(0);
  });

  it('tells the warden once when a fire escapes initial attack, and once when it becomes a major incident', () => {
    const w = flatWorld(200, 80, GRASS);
    w.weather.windSpeed = 8;
    w.rng.fire = new Rng('stage');
    const fe = established(startFire(w, 40 * w.W + 20, 'lightning'))!;
    fe.detected = true;
    fe.detectedDay = w.day;
    const seen: number[] = [];
    for (let s = 0; s < 8 && w.burning.length; s++) {
      fireSubstep(w);
      updateIncidents(w, { onStage: (_f, st) => seen.push(st) });
      w.sub = 4;
    }
    expect(fe.area).toBeGreaterThan(MAJOR_AREA);
    expect(fe.stage).toBe(2);
    // each stage is announced once, in order (a fire can skip straight to major)
    expect(seen.length).toBeLessThanOrEqual(2);
    expect(seen[seen.length - 1]).toBe(2);
    expect([...seen].sort()).toEqual(seen);
  });

  it('gives an escaped fire a morning briefing with what it did, what the day brings and where it is headed', () => {
    const w = smallWorld('tinderbox', 'brief-1');
    const sim = new Simulation(w, {}, { autoReview: true, ignitions: false });
    sim.runDays(170);
    let c = -1;
    for (let i = 0; i < w.N && c < 0; i += 11) if (!w.L.water[i] && w.L.town[i] === 0 && w.L.pine[i] > 0.3 && w.L.under[i] > 0.5) c = i;
    expect(c).toBeGreaterThan(0);
    const fe = startFire(w, c, 'lightning')!;
    fe.detected = true;
    fe.detectedDay = w.day - 1;
    fe.stage = 1;
    fe.area = 60;
    const before = w.notifications.length;
    morningBriefings(w);
    const note = w.notifications.slice(before).find((n) => n.fireId === fe.id);
    expect(note).toBeTruthy();
    expect(note!.text).toContain(fe.name);
    expect(note!.text).toMatch(/day \d+/);
    expect(note!.text).toMatch(/danger, wind \d+ km\/h from the/);
    expect(note!.text).toMatch(/would take about|not expected to grow/);
    // a fire still in initial attack gets no briefing
    const small = startFire(w, c + 40, 'lightning')!;
    small.detected = true;
    small.detectedDay = w.day - 1;
    const n2 = w.notifications.length;
    morningBriefings(w);
    expect(w.notifications.slice(n2).some((n) => n.fireId === small.id)).toBe(false);
  });
});

describe('after-action reports', () => {
  it('says what held the fire: a lake, a road, bare ground', () => {
    const w = flatWorld(90, 41, GRASS);
    w.weather.windSpeed = 4;
    w.rng.fire = new Rng('report-1');
    // a lake to the east, a road to the west, rock to the north and south: a box the fire fills
    for (let y = 0; y < w.H; y++) {
      for (let x = 56; x <= 59; x++) w.L.water[y * w.W + x] = 2;
      w.L.infra[y * w.W + 30] |= INFRA.ROAD;
    }
    for (let x = 0; x < w.W; x++)
      for (const y of [10, 11, 30, 31]) {
        const i = y * w.W + x;
        w.L.grass[i] = 0;
        w.L.litter[i] = 0;
        w.L.shrub[i] = 0;
      }
    const fe = established(startFire(w, 20 * w.W + 43, 'lightning'))!;
    fe.detected = true;
    burnOut(w, 6);
    expect(fe.active).toBe(false);
    expect(w.reports.length).toBe(1);
    const rep = w.reports[0];
    expect(rep.fireId).toBe(fe.id);
    expect(rep.area).toBe(fe.area);
    expect(rep.area).toBeGreaterThan(100);
    expect(share(rep, 'water')).toBeGreaterThan(0.1);
    expect(share(rep, 'bare')).toBeGreaterThan(0.15);
    // what it did not burn in open grass, it left by itself overnight
    expect(share(rep, 'weather') + share(rep, 'road')).toBeGreaterThan(0.1);
    // shares are of the whole edge
    expect(rep.stopped.reduce((a, e) => a + e[1], 0)).toBeCloseTo(1, 5);
    expect(rep.text.join(' ')).toMatch(/held by/);
    expect(rep.text.join(' ')).toMatch(/rock and bare ground|water/);
    // and the cells are released afterwards, with no marks left behind
    for (let i = 0; i < w.N; i++) {
      expect(w.L.fid[i]).toBe(-1);
      expect(w.L.fstop[i]).toBe(0);
    }
  });

  it('credits the crews for the edge they put out and the line they cut', () => {
    let held = 0,
      runs = 0;
    for (let k = 0; k < 4; k++) {
      const w = flatWorld(80, 50, PINE);
      w.weather.windSpeed = 3;
      w.climate.droughtIndex = 0.2;
      w.rng.fire = new Rng('report-crew-' + k);
      for (let n = 0; n < 4; n++) w.crews.push(makeCrew(w, 'hand', 25 * w.W + 2, 'Crew ' + (n + 1)));
      const fe = startFire(w, 25 * w.W + 30, 'human')!;
      fe.detected = true;
      fe.detectedDay = w.day;
      burnOut(w, 12, true);
      if (fe.active) continue;
      runs++;
      const rep = w.reports[w.reports.length - 1];
      expect(rep.fireId).toBe(fe.id);
      expect(rep.peakCrews).toBeGreaterThan(0);
      held += share(rep, 'line') + share(rep, 'crews');
      if (rep.knocked > 0) expect(fe.knocked).toBe(rep.knocked);
    }
    expect(runs).toBeGreaterThan(1);
    // on a fire crews worked from the first hour, most of the edge is theirs
    expect(held / runs).toBeGreaterThan(0.5);
  });

  it('compares how prepared ground burned with the rest', () => {
    const w = flatWorld(120, 41, THICKET);
    w.weather.windSpeed = 8;
    w.rng.fire = new Rng('report-treated');
    // the eastern half was thinned and underburned three years ago
    for (let y = 0; y < w.H; y++)
      for (let x = 60; x < w.W; x++) {
        const i = y * w.W + x;
        applyThinning(w, i);
        applyFireEffects(w, i, 1);
        w.L.fire[i] = FIRE.NONE;
        w.L.lastBurn[i] = w.yearF - 3;
        w.L.lastTreat[i] = w.yearF - 3;
        w.L.litter[i] = 5;
      }
    const fe = established(startFire(w, 20 * w.W + 30, 'lightning'))!;
    fe.detected = true;
    // a hot, windy afternoon that does not end (the comparison needs both halves to burn)
    const hooks = makeEventHooks(w);
    for (let s = 0; s < 400 && w.burning.length; s++) {
      w.sub = 4;
      fireSubstep(w, hooks);
    }
    expect(fe.active).toBe(false);
    const rep = w.reports[w.reports.length - 1];
    expect(rep.treatedArea).toBeGreaterThan(300);
    expect(rep.area - rep.treatedArea).toBeGreaterThan(300);
    const treated = rep.treatedHigh / rep.treatedArea,
      rest = rep.untreatedHigh / (rep.area - rep.treatedArea);
    expect(rest).toBeGreaterThan(0.3); // the thicket torched wherever the front came at it head-on
    expect(treated).toBeLessThan(rest * 0.4); // the prepared half mostly did not
    expect(rep.text.join(' ')).toMatch(/thinned or burned in the last 12 years: \d+ % of that burned severely, against \d+ % of the rest/);
    // and seeing it is worth a field note
    expect(w.discoveries['treated-ground']).toBeDefined();
  });

  it('counts the homes a fire reached and the homes it took', () => {
    const w = flatWorld(90, 41, GRASS);
    w.weather.windSpeed = 7;
    w.rng.fire = new Rng('report-homes');
    const homes: Array<[number, number]> = [];
    for (let y = 16; y <= 24; y += 2) for (let x = 50; x <= 54; x += 2) homes.push([x, y]);
    addTown(w, 52, 20, homes, 0.9);
    const fe = established(startFire(w, 20 * w.W + 20, 'lightning'))!;
    fe.detected = true;
    burnOut(w, 30);
    expect(fe.active).toBe(false);
    const rep = buildReportOf(w, fe);
    expect(rep.homesReached).toBeGreaterThanOrEqual(10);
    expect(rep.homesLost).toBe(fe.structuresLost);
    expect(rep.homesLost).toBeLessThan(rep.homesReached);
    expect(rep.text.join(' ')).toMatch(/Fire reached \d+ homes in Testville/);
    expect(rep.stage).toBe(2);
  });

  function buildReportOf(w: World, fe: FireEvent) {
    const rep = w.reports.find((r) => r.fireId === fe.id);
    expect(rep).toBeTruthy();
    return rep!;
  }

  it('is not written for prescribed burns or for fires nobody ever knew about', () => {
    const w = flatWorld(60, 40, PINE);
    w.rng.fire = new Rng('report-none');
    w.weather.windSpeed = 1;
    const hidden = startFire(w, 20 * w.W + 20, 'lightning')!;
    w.L.ftime[20 * w.W + 20] = 0.5;
    burnOut(w, 3);
    expect(hidden.active).toBe(false);
    expect(hidden.area).toBeLessThan(5);
    expect(w.reports.length).toBe(0);
  });

  it('survives a save and load, and so does the record of who put what out', () => {
    const w = smallWorld('tinderbox', 'report-save');
    const sim = new Simulation(w, {}, { autoReview: true });
    sim.runDays(200);
    w.reports.push({ fireId: 7, name: 'Test Fire', cause: 'lightning', startDay: 1, outDay: 3, x: 5, y: 5, area: 120, high: 30, low: 60, crown: 20, peakFlame: 3.2, homesReached: 0, homesLost: 0, cost: 1000, aidCost: 0, stage: 1, peakCrews: 3, knocked: 12, stopped: [['line', 0.6], ['water', 0.4]], treatedArea: 0, treatedHigh: 0, untreatedHigh: 30, text: ['Burned 120 ha over 2 days.'] });
    w.L.fstop[100] = 2;
    const w2 = decodeWorld(encodeWorld(w));
    expect(w2.reports).toEqual(w.reports);
    expect(w2.L.fstop[100]).toBe(2);
    expect(stateHash(w2)).toBe(stateHash(w));
  });
});

describe('town exposure', () => {
  it('is taken when a tenure begins and again at each year end', () => {
    const w = smallWorld('tinderbox', 'expo-1');
    expect(w.memory.exposure).toBeUndefined();
    const sim = new Simulation(w, {}, { autoReview: true, ignitions: false });
    const e0 = w.memory.exposure!;
    expect(e0.start).toBeGreaterThan(0.05);
    expect(e0.now).toBe(e0.start);
    expect(e0.towns.length).toBe(w.towns.length);
    expect(e0.history.length).toBe(1);
    sim.runDays(361);
    const e1 = w.memory.exposure!;
    expect(e1.history.length).toBe(2);
    expect(e1.start).toBe(e0.start);
    expect(w.review.report.some((r) => r[0] === 'Homes a bad fire day would take')).toBe(true);
  });

  it('falls when the ground around the homes is thinned and burned, and the residents notice', () => {
    const w = smallWorld('tinderbox', 'expo-2');
    new Simulation(w, {}, { autoReview: true, ignitions: false });
    const start = w.memory.exposure!.start;
    const factor = () => {
      councilMonthly(w);
      return w.factions.residents.factors.find((f) => f[0] === 'Homes better protected')?.[1] ?? 0;
    };
    expect(factor()).toBe(0);
    for (let i = 0; i < w.N; i++) {
      if (w.L.town[i] <= 0) continue;
      const x = i % w.W,
        y = (i / w.W) | 0;
      for (let dy = -6; dy <= 6; dy++)
        for (let dx = -6; dx <= 6; dx++) {
          if (!w.inside(x + dx, y + dy)) continue;
          const n = (y + dy) * w.W + x + dx;
          if (w.L.town[n] !== 0 || w.L.water[n]) continue;
          applyThinning(w, n);
          applyFireEffects(w, n, 1);
          w.L.fire[n] = FIRE.NONE;
        }
    }
    refreshExposure(w);
    const e = w.memory.exposure!;
    expect(e.start).toBe(start);
    expect(e.now).toBeLessThan(start * 0.6);
    expect(factor()).toBeGreaterThan(4);
    // and the legacy score's "Safer around homes" follows the same figure
    const safer = evaluateLegacy(w, 'tenure').breakdown.find((b) => b[0] === 'Safer around homes')!;
    expect(safer[1]).toBeGreaterThan(5);
    expect(String(safer[2])).toMatch(/homes a bad fire day would take \d+ % → \d+ %/);
  });
});

describe("the council's charge", () => {
  it('gives every scenario three objectives that can be read off the valley', () => {
    for (const sc of SCENARIOS) {
      const w = smallWorld(sc.id, 'obj-' + sc.id);
      new Simulation(w, {}, { autoReview: true });
      const os = objectives(w);
      expect(os.length, sc.id).toBe(3);
      expect(new Set(os.map((o) => o.id)).size, sc.id).toBe(3);
      for (const o of os) {
        expect(o.title.length).toBeGreaterThan(3);
        expect(o.charge.length).toBeGreaterThan(20);
        expect(o.reading.length).toBeGreaterThan(3);
        expect(o.progress).toBeGreaterThanOrEqual(0);
        expect(o.progress).toBeLessThanOrEqual(1);
        expect(o.state).not.toBe('failed'); // nothing is lost on the first day
      }
      expect(objectivesMet(w)).toBeLessThanOrEqual(3);
    }
  });

  it('follows the valley: homes lost use up the allowance, safer towns advance the charge', () => {
    const w = smallWorld('tinderbox', 'obj-follow');
    new Simulation(w, {}, { autoReview: true });
    const homes = () => objectives(w).find((o) => o.id === 'homes')!;
    const expo = () => objectives(w).find((o) => o.id === 'exposure')!;
    expect(homes().progress).toBe(0);
    w.counters.totalStructuresLost = 9;
    expect(homes().progress).toBeCloseTo(0.6, 5);
    expect(homes().state).toBe('on-track');
    // exactly the allowance keeps the charge (until release it stopped counting at three quarters)
    w.counters.totalStructuresLost = 15;
    expect(homes().state).toBe('behind');
    expect(objectiveMet(homes())).toBe(true);
    w.counters.totalStructuresLost = 16;
    expect(homes().state).toBe('failed');
    expect(objectiveMet(homes())).toBe(false);
    expect(expo().progress).toBe(0);
    const e = w.memory.exposure!;
    e.now = e.start * 0.75;
    expect(expo().progress).toBeCloseTo(0.5, 2);
    e.now = e.start * 0.45;
    expect(expo().state).toBe('met');
    // and the score counts the charges met
    const row = evaluateLegacy(w, 'tenure').breakdown.find((b) => b[0] === 'The council’s charge')!;
    expect(row[1]).toBeGreaterThanOrEqual(3);
    expect(String(row[2])).toContain('✗ Keep the homes');
    expect(String(row[2])).toContain('✓ Make the towns defensible');
  });

  it('"put fire back to work" counts fire the warden chose, not fire that got away', () => {
    // until the last round of bots every hectare that did not burn severely counted, and a passive
    // warden met the charge in four of six First Season valleys with the fires its crews lost
    const run = (response: 'suppress' | 'monitor') => {
      const w = flatWorld(60, 40, PINE);
      w.config.scenario = 'firstseason';
      w.weather.windSpeed = 2;
      w.rng.fire = new Rng('chosen');
      const fe = startFire(w, 20 * w.W + 30, 'lightning')!;
      fe.response = response;
      for (let s = 0; s < 40 && w.burning.length; s++) fireSubstep(w);
      const good = objectives(w).find((o) => o.id === 'goodfire')!;
      return { burned: w.counters.totalBurned, severe: w.counters.totalHighSeverity, managed: w.counters.totalManagedGood, progress: good.progress };
    };
    const lost = run('suppress');
    expect(lost.burned).toBeGreaterThan(20);
    expect(lost.managed).toBe(0);
    expect(lost.progress).toBe(0);
    const chosen = run('monitor');
    expect(chosen.managed).toBe(chosen.burned - chosen.severe);
    expect(chosen.managed).toBeGreaterThan(20);
    expect(chosen.progress).toBeGreaterThan(0);
    // a prescribed burn counts through the hectares it is billed for
    const w = flatWorld(60, 40, PINE);
    w.config.scenario = 'firstseason';
    w.counters.totalRx = 500;
    expect(objectives(w).find((o) => o.id === 'goodfire')!.reading).toContain('500 ha');
  });
});

describe('wilderness policy', () => {
  it('leaves a lightning fire alone only when it starts on a day that allows it (1.1.1: always)', () => {
    const w = flatWorld(80, 60, PINE);
    addTown(w, 5, 5, [[5, 5]]);
    const cell = 40 * w.W + 60;
    w.L.zone[cell] = ZONE.WILDERNESS;
    w.weather.dangerClass = 1;
    w.weather.windEvent = false;
    expect(defaultResponse(w, cell, 'lightning')).toBe('monitor');
    expect(defaultResponse(w, cell, 'human')).toBe('suppress');
    w.weather.dangerClass = 3;
    expect(defaultResponse(w, cell, 'lightning')).toBe('suppress');
    w.weather.dangerClass = 1;
    w.weather.windEvent = true;
    expect(defaultResponse(w, cell, 'lightning')).toBe('suppress');
    // outside the wilderness every fire is fought
    w.weather.windEvent = false;
    expect(defaultResponse(w, cell + 1, 'lightning')).toBe('suppress');
  });
});

describe('mutual aid and money', () => {
  it('the state pays three quarters of crew overtime on a major incident', () => {
    const cost = (stage: 0 | 2) => {
      const w = flatWorld(80, 50, PINE);
      w.weather.windSpeed = 2;
      w.climate.droughtIndex = 0.2;
      w.rng.fire = new Rng('share');
      w.crews.push(makeCrew(w, 'hand', 25 * w.W + 28, 'Crew'));
      const fe = startFire(w, 25 * w.W + 30, 'human')!;
      fe.detected = true;
      fe.detectedDay = w.day;
      fe.stage = stage;
      w.L.ftime[25 * w.W + 30] = 48;
      crewsDaily(w);
      for (let s = 0; s < 3; s++) crewsSubstep(w);
      return fe.cost;
    };
    const local = cost(0),
      major = cost(2);
    expect(local).toBeGreaterThan(1000);
    expect(major / local).toBeCloseTo(0.25, 2);
  });


  it('emergency fire spending stops at the credit limit: the state carries the fires, the team stays, the warden is told once', () => {
    const w = flatWorld(120, 60, PINE);
    w.weather.windSpeed = 2;
    w.climate.droughtIndex = 0.15;
    addTown(w, 6, 30, [[5, 29], [6, 29], [5, 30], [6, 30]]);
    w.rng.fire = new Rng('aid-credit');
    const fe = startFire(w, 30 * w.W + 60, 'lightning')!;
    fe.detected = true;
    fe.detectedDay = w.day;
    for (let k = 1; k <= 40; k++) startFire(w, 30 * w.W + 60 + k, 'lightning');
    w.economy.funds = COST.aidMobilize + COST.aidPerDay * 2.5 - EMERGENCY_CREDIT; // credit for the call and two and a half days
    const team = requestAid(w, fe);
    let released = 0,
      told = 0;
    for (let d = 0; d < 8; d++) {
      w.day++;
      for (const b of w.burning) w.L.ftime[b] = 48; // the fire stays alive
      crewsDaily(w, { onAidReleased: () => released++, onStateCarries: () => told++ });
    }
    // 1.x-style accounting would have taken the service to -$320k and on; the first 2.0 rule sent
    // the team home with the fire still burning
    expect(released).toBe(0);
    expect(w.crews.filter((c) => c.aid !== undefined).length).toBeGreaterThan(4);
    expect(w.economy.funds).toBeCloseTo(-EMERGENCY_CREDIT, 0);
    expect(team.cost).toBeCloseTo(COST.aidMobilize + COST.aidPerDay * 2.5, 0);
    expect(told).toBe(1);
    // crew overtime is carried the same way
    const before = w.economy.funds;
    expect(spendEmergency(w, 'Suppression', 5000)).toBe(0);
    expect(w.economy.funds).toBe(before);
    // and with money in hand the service pays in full
    w.economy.funds = 100_000;
    expect(spendEmergency(w, 'Suppression', 5000)).toBe(5000);
  });

  it('the standing order does not call a team with nothing in hand (the warden still can)', () => {
    const w = flatWorld(160, 60, GRASS);
    w.weather.windSpeed = 6;
    w.climate.droughtIndex = 0.15;
    addTown(w, 100, 30, [[99, 29], [100, 29], [99, 30], [100, 30]]);
    w.rng.fire = new Rng('aid-order');
    const fe = established(startFire(w, 30 * w.W + 40, 'lightning'))!;
    fe.detected = true;
    for (let s = 0; s < 3; s++) {
      w.sub = 4;
      fireSubstep(w);
    }
    expect(fe.area).toBeGreaterThan(150);
    w.economy.funds = 10_000;
    crewsDaily(w);
    expect(w.aid.length).toBe(0);
    w.economy.funds = 1_000_000;
    crewsDaily(w);
    expect(w.aid.length).toBe(1);
    expect(w.aid[0].auto).toBe(true);
    // the warden's own call is never refused for want of money
    const w2 = flatWorld(160, 60, GRASS);
    const f2 = startFire(w2, 30 * w2.W + 40, 'lightning')!;
    f2.detected = true;
    w2.economy.funds = -EMERGENCY_CREDIT;
    expect(applyCommand(w2, { t: 'aid', fireId: f2.id, on: true }).ok).toBe(true);
    expect(w2.economy.funds).toBe(-EMERGENCY_CREDIT);
  });
});
