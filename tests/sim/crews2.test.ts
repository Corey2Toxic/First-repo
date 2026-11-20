/**
 * Crews, treatments, tools and mutual aid in v2. Where 1.1.1 behaved differently the test name or
 * a comment says what it did (from the study team's crew report and scripts/v2 runs on that tree).
 */
import { describe, expect, it } from 'vitest';
import { flatWorld, smallWorld } from '../helpers.ts';
import { AID_MAX_TEAMS, AID_TEAM, SECOND_TEAM_AREA, aidFor, assignProjects, autoDispatch, crewsDaily, crewsSubstep, openEdges, requestAid, teamsOn } from '../../src/sim/systems/crews.ts';
import { MAX_BURN_UNIT, burnCrewsNeeded, burnOutlook, createProject, createProjects, holdBurns, projectsDaily } from '../../src/sim/systems/projects.ts';
import { KNOCKED_DOWN, fireSubstep, igniteCell, startFire, structureProtection } from '../../src/sim/systems/fire.ts';
import { EMERGENCY_CREDIT, TANKER_LOADS_PER_DAY, TANKER_MAX_WIND, applyCommand } from '../../src/sim/commands.ts';
import { FIREWISE_YEARS, firewiseProgress, updateFirewise } from '../../src/sim/systems/towns.ts';
import { makeCrew } from '../../src/sim/gen/crews.ts';
import { COST, CREW_COST } from '../../src/sim/economyParams.ts';
import { Simulation } from '../../src/sim/sim.ts';
import { cellFuel } from '../../src/sim/systems/fuels.ts';
import { FIRE, ZONE } from '../../src/sim/types.ts';
import type { World } from '../../src/sim/world.ts';
import { Rng } from '../../src/sim/rng.ts';

/** One 3-hour step of fire and crews on a hand-built world, in the simulation's order. */
function tick(w: World): void {
  if (w.sub === 0) {
    crewsDaily(w);
    projectsDaily(w);
  }
  if (w.burning.length) fireSubstep(w);
  crewsSubstep(w);
  holdBurns(w);
  w.sub++;
  if (w.sub >= 8) {
    w.sub = 0;
    w.day++;
  }
}

/** A flat pine stand with hand crews based at its western edge. */
function standWithCrews(n: number, opts = {}): World {
  const w = flatWorld(80, 50, { grass: 0.1, pine: 0.5, litter: 8, dead: 12, under: 0.3, fm: 0.1, ...opts });
  w.weather.windSpeed = 3;
  w.weather.dangerClass = 1;
  w.economy.funds = 1_000_000;
  for (let k = 0; k < n; k++) w.crews.push(makeCrew(w, 'hand', 25 * w.W + 2, 'Test crew ' + (k + 1)));
  return w;
}

function block(w: World, x0: number, y0: number, wd: number, ht: number): number[] {
  const out: number[] = [];
  for (let y = y0; y < y0 + ht; y++) for (let x = x0; x < x0 + wd; x++) out.push(y * w.W + x);
  return out;
}

describe('treatment work', () => {
  it('a project nobody can reach is passed over instead of blocking the queue (1.1.1: all treatment stopped)', () => {
    const w = standWithCrews(1);
    // an island: a patch of forest inside a moat of lake
    for (const c of block(w, 38, 18, 14, 14)) w.L.water[c] = 2;
    const island = block(w, 42, 22, 6, 6);
    for (const c of island) w.L.water[c] = 0;
    w.sub = 0;
    const a = createProject(w, 'thin', island)!;
    const b = createProject(w, 'thin', block(w, 10, 30, 6, 4))!;
    expect(a.id).toBeLessThan(b.id);
    assignProjects(w);
    expect(w.crews[0].task?.projectId).toBe(b.id);
    expect(a.note).toMatch(/reach/);
    expect(b.status).toBe('active');
  });

  it('a burn out of prescription does not hold a crew; thinning queued behind it starts (1.1.1: the crew stood on the burn)', () => {
    const w = standWithCrews(1, { fm: 0.3 }); // far too damp to carry
    w.sub = 0;
    const burn = createProject(w, 'burn', block(w, 10, 10, 8, 6))!;
    const thin = createProject(w, 'thin', block(w, 10, 30, 6, 4))!;
    expect(burnOutlook(w, burn).problem).toMatch(/damp/);
    assignProjects(w);
    expect(w.crews[0].task?.projectId).toBe(thin.id);
    expect(burn.note).toMatch(/damp/);
  });

  it('routine treatment work does not tire a crew, and it thins at the pace the tool promises', () => {
    const w = standWithCrews(1);
    w.sub = 0;
    const pr = createProject(w, 'thin', block(w, 6, 22, 12, 6))!; // 72 ha
    for (let s = 0; s < 8 * 10; s++) tick(w);
    // 1.1.1: fatigue pinned at 1.0 after four days, the dispatcher skipped the crew, and the pace
    // fell to 2.9 ha a day against the "~5 ha/crew/day" shown on the tool
    expect(w.crews[0].fatigue).toBeLessThan(0.2);
    expect(pr.done).toBeGreaterThan(38);
    expect(pr.done).toBeLessThanOrEqual(72);
  });

  it('several crews share a large project without treating any hectare twice', () => {
    const w = standWithCrews(3);
    w.sub = 0;
    const cells = block(w, 6, 20, 12, 10); // 120 ha
    const pr = createProject(w, 'thin', cells)!;
    const f0 = w.economy.funds;
    for (let s = 0; s < 8 * 12; s++) tick(w);
    expect(pr.status).toBe('done');
    expect(pr.done).toBe(120);
    // (the starting funds minus what was earned back from biomass)
    expect(f0 - w.economy.funds).toBeLessThanOrEqual(120 * pr.costPerCell + 1);
    expect(w.crews.filter((c) => c.hoursWorked >= 0).length).toBe(3);
  });

  it('a selection larger than one burn unit is split into units a crew can hold (1.1.1: one crew "held" 5,000 ha)', () => {
    const w = standWithCrews(1);
    const made = createProjects(w, 'burn', block(w, 5, 5, 40, 20)); // 800 ha
    expect(made.length).toBeGreaterThanOrEqual(3);
    for (const p of made) expect(p.unit.length).toBeLessThanOrEqual(MAX_BURN_UNIT);
    expect(made.reduce((a, p) => a + p.unit.length, 0)).toBe(800);
    expect(burnCrewsNeeded(made[0])).toBe(3);
    expect(burnCrewsNeeded(createProject(w, 'burn', block(w, 60, 30, 8, 6))!)).toBe(1);
  });

  it('a prescribed burn carries across its unit, stays inside it and is charged for what burned', () => {
    let covered = 0,
      outside = 0,
      trials = 0;
    for (let k = 0; k < 4; k++) {
      const w = standWithCrews(1);
      w.rng.fire = new Rng('rx-' + k);
      w.sub = 0;
      const unit = block(w, 20, 20, 10, 6); // 60 ha
      const pr = createProject(w, 'burn', unit)!;
      expect(burnOutlook(w, pr).problem).toBe('');
      const f0 = w.economy.funds;
      for (let s = 0; s < 8 * 14 && pr.status !== 'done'; s++) tick(w);
      expect(pr.status).toBe('done');
      trials++;
      covered += pr.done / 60;
      const inUnit = new Set(unit);
      for (let i = 0; i < w.N; i++) if (!inUnit.has(i) && w.L.lastBurn[i] > 0) outside++;
      // 1.1.1 billed the whole unit whatever burned; a median 41 % of it did
      const bill = pr.costPerCell * pr.done + 0.15 * pr.costPerCell * (60 - pr.done);
      expect(f0 - w.economy.funds).toBeCloseTo(bill, 3);
      // low-severity work: the big pines are still there, the understory is not
      const c = unit[25];
      if (w.L.lastBurn[c] > 0) {
        expect(w.L.pine[c]).toBeGreaterThan(0.4);
        expect(w.L.under[c]).toBeLessThan(0.15);
      }
    }
    expect(covered / trials).toBeGreaterThan(0.75);
    expect(outside).toBeLessThanOrEqual(3);
  });

  it('the go/no-go reads the fire model: too damp will not carry, a thicket in dry air would torch', () => {
    const damp = standWithCrews(1, { fm: 0.26 });
    expect(burnOutlook(damp, createProject(damp, 'burn', block(damp, 20, 20, 8, 6))!).problem).toMatch(/damp/);
    const thicket = standWithCrews(1, { fm: 0.05, under: 0.95, litter: 14 });
    thicket.weather.windSpeed = 6;
    const out = burnOutlook(thicket, createProject(thicket, 'burn', block(thicket, 20, 20, 8, 6))!);
    expect(out.hot).toBeGreaterThan(0.5);
    expect(out.problem).toMatch(/torch/);
    // the smoke rules policy now does what it says (1.1.1: read by nothing)
    const smoky = standWithCrews(1);
    const pr = createProject(smoky, 'burn', block(smoky, 20, 20, 8, 6))!;
    smoky.weather.dispersion = 0.2;
    expect(burnOutlook(smoky, pr).problem).toBe('');
    smoky.policies.smokeRules = true;
    expect(burnOutlook(smoky, pr).problem).toMatch(/smoke/i);
  });
});

describe('dispatch', () => {
  it('crews are pulled off a backcountry fire when a fire reaches a Community Buffer (1.1.1: never reassigned)', () => {
    const w = standWithCrews(2);
    w.towns.push({ id: 0, name: 'Testville', x: 6, y: 25, population: 500, structures: 4, lostStructures: 0, mill: false, station: 25 * w.W + 2, firewise: 0.3, smokeToday: 0, smokeDays: 0, threat: 0, evacuated: false, growthPressure: 0, happiness: 0.5 });
    for (const c of block(w, 5, 24, 2, 2)) w.L.town[c] = 1;
    w.sub = 4;
    const far = startFire(w, 10 * w.W + 70, 'lightning')!;
    far.detected = true;
    autoDispatch(w);
    expect(w.crews.every((c) => c.task?.fireId === far.id)).toBe(true);
    // a second fire starts in the buffer beside town
    const edge = 25 * w.W + 12;
    w.L.zone[edge] = ZONE.BUFFER;
    const near = startFire(w, edge, 'human')!;
    near.detected = true;
    expect(near.inBuffer).toBe(true);
    autoDispatch(w);
    expect(w.crews.filter((c) => c.task?.fireId === near.id).length).toBeGreaterThanOrEqual(1);
  });

  it('the crews a fire is given follow the edge it still has open', () => {
    const w = standWithCrews(6);
    w.sub = 4;
    const fe = startFire(w, 25 * w.W + 40, 'lightning')!;
    fe.detected = true;
    autoDispatch(w);
    const small = w.crews.filter((c) => c.task?.fireId === fe.id).length;
    expect(small).toBe(2);
    // the same fire with forty cells of open edge
    for (let x = 41; x < 80; x++) igniteCell(w, 25 * w.W + x, fe, 0.5, false);
    expect(openEdges(w).get(fe.id)!.open).toBeGreaterThan(30);
    autoDispatch(w);
    expect(w.crews.filter((c) => c.task?.fireId === fe.id).length).toBe(6);
  });

  it('every engine within reach protects houses, standing by or working (1.1.1: the best one, and only if sent)', () => {
    const w = standWithCrews(0);
    const house = 25 * w.W + 10;
    expect(structureProtection(w, house)).toBe(0);
    w.crews.push(makeCrew(w, 'engine', 25 * w.W + 11, 'Engine 1'));
    const one = structureProtection(w, house);
    expect(one).toBeGreaterThan(0.3);
    w.crews.push(makeCrew(w, 'engine', 25 * w.W + 9, 'Engine 2'));
    const two = structureProtection(w, house);
    expect(two).toBeGreaterThan(one + 0.1);
    expect(two).toBeLessThanOrEqual(0.9);
  });
});

describe('mutual aid', () => {
  function burningFire(w: World) {
    w.sub = 4;
    const fe = startFire(w, 25 * w.W + 40, 'lightning')!;
    fe.detected = true;
    for (let x = 41; x < 60; x++) igniteCell(w, 25 * w.W + x, fe, 0.5, false);
    return fe;
  }

  it('a team is called, reports the next morning, works only its fire, is paid by the day and leaves when the fire is out', () => {
    const w = standWithCrews(1);
    w.policies.mutualAid = 'manual';
    w.towns.push({ id: 0, name: 'Testville', x: 6, y: 25, population: 500, structures: 0, lostStructures: 0, mill: false, station: 25 * w.W + 2, firewise: 0.3, smokeToday: 0, smokeDays: 0, threat: 0, evacuated: false, growthPressure: 0, happiness: 0.5 });
    w.climate.droughtIndex = 0.15; // an ordinary summer: the region has teams to spare
    const fe = burningFire(w);
    const f0 = w.economy.funds;
    const res = applyCommand(w, { t: 'aid', fireId: fe.id, on: true });
    expect(res.ok).toBe(true);
    expect(f0 - w.economy.funds).toBeCloseTo(COST.aidMobilize, 3);
    const team = aidFor(w, fe.id)!;
    expect(team.arriveDay).toBe(w.day + 1);
    // a second call for the same fire is refused
    expect(applyCommand(w, { t: 'aid', fireId: fe.id, on: true }).ok).toBe(false);
    expect(w.crews.length).toBe(1);
    // next morning
    w.day++;
    w.sub = 0;
    for (const b of w.burning) w.L.ftime[b] = 48; // keep it alight
    crewsDaily(w);
    expect(team.arrived).toBe(true);
    const aid = w.crews.filter((c) => c.aid === fe.id);
    expect(aid.length).toBe(AID_TEAM.length);
    expect(aid.filter((c) => c.kind === 'hand').length).toBe(4);
    expect(team.cost).toBeCloseTo(COST.aidMobilize + COST.aidPerDay, 3);
    // an aid crew cannot be dismissed or sent to another fire
    expect(applyCommand(w, { t: 'dismiss', crewId: aid[0].id }).ok).toBe(false);
    const other = startFire(w, 5 * w.W + 70, 'lightning')!;
    other.detected = true;
    expect(applyCommand(w, { t: 'sendCrew', crewId: aid[0].id, fireId: other.id }).ok).toBe(false);
    autoDispatch(w);
    expect(w.crews.filter((c) => c.aid !== undefined && c.task?.fireId === other.id).length).toBe(0);
    expect(w.crews.filter((c) => c.aid !== undefined && c.task?.fireId === fe.id).length).toBeGreaterThan(3);
    // the fire goes out: the team is released and its crews leave the valley
    for (const b of w.burning) if (w.L.fid[b] === fe.id) w.L.ftime[b] = KNOCKED_DOWN;
    fireSubstep(w);
    expect(fe.active).toBe(false);
    w.day++;
    crewsDaily(w);
    expect(team.released).toBe(true);
    expect(w.crews.some((c) => c.aid === fe.id)).toBe(false);
    expect(w.economy.ledger.expense['Mutual aid']).toBeCloseTo(team.cost, 3);
  });

  it('the standing order calls a team for an escaped fire near a town, and "manual" leaves it to the warden', () => {
    for (const policy of ['auto', 'manual'] as const) {
      const w = standWithCrews(1);
      w.policies.mutualAid = policy;
      w.towns.push({ id: 0, name: 'Testville', x: 30, y: 25, population: 500, structures: 0, lostStructures: 0, mill: false, station: 25 * w.W + 2, firewise: 0.3, smokeToday: 0, smokeDays: 0, threat: 0, evacuated: false, growthPressure: 0, happiness: 0.5 });
      const fe = burningFire(w);
      fe.area = 400;
      w.sub = 0;
      crewsDaily(w);
      expect(!!aidFor(w, fe.id)).toBe(policy === 'auto');
    }
  });

  it('the region can spare only so many teams, and the county only so much credit', () => {
    const w = standWithCrews(1);
    w.policies.mutualAid = 'manual';
    w.towns.push({ id: 0, name: 'Testville', x: 6, y: 25, population: 500, structures: 0, lostStructures: 0, mill: false, station: 25 * w.W + 2, firewise: 0.3, smokeToday: 0, smokeDays: 0, threat: 0, evacuated: false, growthPressure: 0, happiness: 0.5 });
    w.sub = 4;
    const fires = [8, 18, 28, 38].map((y) => {
      const fe = startFire(w, y * w.W + 40, 'lightning')!;
      fe.detected = true;
      return fe;
    });
    for (let k = 0; k < AID_MAX_TEAMS; k++) expect(applyCommand(w, { t: 'aid', fireId: fires[k].id, on: true }).ok).toBe(true);
    expect(applyCommand(w, { t: 'aid', fireId: fires[AID_MAX_TEAMS].id, on: true }).ok).toBe(false);
    // sending a team home frees it for another fire
    expect(applyCommand(w, { t: 'aid', fireId: fires[0].id, on: false }).ok).toBe(true);
    // a call is never refused for want of money: past its emergency credit the state carries the team
    w.economy.funds = -EMERGENCY_CREDIT + 1000;
    expect(applyCommand(w, { t: 'aid', fireId: fires[AID_MAX_TEAMS].id, on: true }).ok).toBe(true);
    expect(w.economy.funds).toBe(-EMERGENCY_CREDIT);
    // an air drop is the warden's choice and is refused at the limit
    w.sub = 4;
    expect(applyCommand(w, { t: 'airdrop', cells: [10 * w.W + 60] }).msg).toMatch(/credit/);
    // a fire takes one team until it is a very large one; then a second, and no third
    const big = standWithCrews(1);
    big.policies.mutualAid = 'manual';
    big.sub = 4;
    const fb = startFire(big, 25 * big.W + 40, 'lightning')!;
    fb.detected = true;
    expect(applyCommand(big, { t: 'aid', fireId: fb.id, on: true }).ok).toBe(true);
    expect(applyCommand(big, { t: 'aid', fireId: fb.id, on: true }).msg).toMatch(/second can be called/);
    fb.area = SECOND_TEAM_AREA;
    expect(applyCommand(big, { t: 'aid', fireId: fb.id, on: true }).ok).toBe(true);
    expect(teamsOn(big, fb.id)).toBe(2);
    expect(applyCommand(big, { t: 'aid', fireId: fb.id, on: true }).msg).toMatch(/Two teams/);
    // sending them home sends both
    expect(applyCommand(big, { t: 'aid', fireId: fb.id, on: false }).ok).toBe(true);
    expect(teamsOn(big, fb.id)).toBe(0);
    // in a deep drought the whole region is burning and a team takes a day longer to come
    const dry = standWithCrews(1);
    dry.sub = 4;
    dry.climate.droughtIndex = 0.6;
    const fd = startFire(dry, 25 * dry.W + 40, 'lightning')!;
    fd.detected = true;
    expect(requestAid(dry, fd).arriveDay).toBe(dry.day + 2);
  });
});

describe('tools', () => {
  it('the air tanker is one aircraft: daylight, a wind limit and six loads a day (1.1.1: 40 loads at night in a gale, in debt)', () => {
    const w = standWithCrews(0);
    const line = (y: number) => block(w, 30, y, 10, 1);
    w.sub = 0;
    expect(applyCommand(w, { t: 'airdrop', cells: line(5) }).msg).toMatch(/daylight/);
    w.sub = 4;
    w.weather.windSpeed = TANKER_MAX_WIND + 1;
    expect(applyCommand(w, { t: 'airdrop', cells: line(5) }).msg).toMatch(/grounded/);
    w.weather.windSpeed = 5;
    for (let k = 0; k < TANKER_LOADS_PER_DAY; k++) expect(applyCommand(w, { t: 'airdrop', cells: line(5 + k) }).ok).toBe(true);
    expect(applyCommand(w, { t: 'airdrop', cells: line(20) }).ok).toBe(false);
    expect(w.economy.ledger.expense.Aviation).toBeCloseTo(TANKER_LOADS_PER_DAY * COST.retardantDrop, 3);
    w.day++;
    expect(applyCommand(w, { t: 'airdrop', cells: line(20) }).ok).toBe(true);
  });

  it('planned spending needs the money in hand (1.1.1: no command checked funds)', () => {
    const w = smallWorld('firstseason', 'funds-1');
    w.economy.funds = 1000;
    expect(applyCommand(w, { t: 'hire', kind: 'hand' }).msg).toMatch(/funds/i);
    expect(applyCommand(w, { t: 'build', what: 'tower', cell: w.towns[0].station + 40 }).ok).toBe(false);
    expect(w.economy.funds).toBe(1000);
    w.economy.funds = CREW_COST.hand.hire;
    expect(applyCommand(w, { t: 'hire', kind: 'hand' }).ok).toBe(true);
  });

  it('a fireline can be ordered while the dispatcher has the crews; only hand crews cut it; the crew walks it', () => {
    const w = standWithCrews(1);
    w.crews.push(makeCrew(w, 'engine', 25 * w.W + 2, 'Engine 1'));
    w.sub = 4;
    const fe = startFire(w, 25 * w.W + 40, 'lightning')!;
    fe.detected = true;
    autoDispatch(w);
    const hand = w.crews[0];
    expect(hand.task?.kind).toBe('suppress');
    // 1.1.1 refused: "No ground crew is free. Recall one first."
    const cells = block(w, 50, 15, 1, 12);
    const res = applyCommand(w, { t: 'fireline', cells });
    expect(res.ok).toBe(true);
    expect(hand.task?.kind).toBe('line');
    expect(hand.manual).toBe(true);
    expect(applyCommand(w, { t: 'fireline', cells, crewId: w.crews[1].id }).msg).toMatch(/hand crews/);
    // knock the fire down so the test is about the line; the crew walks there and cuts about 600 m in
    // its first three hours (1.1.1 moved the crew along the line for free)
    for (const b of w.burning) w.L.ftime[b] = KNOCKED_DOWN;
    fireSubstep(w);
    tick(w);
    const cut = cells.filter((c) => w.L.fline[c] >= 1).length;
    expect(cut).toBeGreaterThan(0);
    expect(cut).toBeLessThan(cells.length);
    for (let s = 0; s < 16; s++) tick(w);
    expect(cells.every((c) => w.L.fline[c] > 0.8)).toBe(true);
    // done: back in the dispatcher's pool
    expect(hand.manual).toBe(false);
  });

  it('a scraped line weathers in within weeks (1.1.1: good for most of a year; a ring round town beat every other defence)', () => {
    const w = smallWorld('firstseason', 'line-decay');
    const sim = new Simulation(w, {}, { ignitions: false, autoReview: true });
    sim.runDays(100);
    const c = w.towns[0].station + 30;
    w.L.fline[c] = 1;
    sim.runDays(45);
    expect(w.L.fline[c]).toBeLessThan(0.6);
    sim.runDays(60);
    expect(w.L.fline[c]).toBe(0);
  });

  it('the firewise code is a five-year programme that costs money, not a free switch', () => {
    const w = smallWorld('firstseason', 'firewise-1');
    const sim = new Simulation(w, {}, { ignitions: false, autoReview: true });
    sim.runDays(5);
    updateFirewise(w);
    const before = w.towns[0].firewise;
    expect(applyCommand(w, { t: 'policy', key: 'buildingCode', value: 'firewise' }).ok).toBe(true);
    expect(firewiseProgress(w)).toBe(0);
    updateFirewise(w);
    // 1.1.1: +0.32 the next month, for nothing
    expect(w.towns[0].firewise).toBeCloseTo(before, 6);
    sim.runDays(360);
    expect(firewiseProgress(w)).toBeCloseTo(1 / FIREWISE_YEARS, 2);
    const spent = (w.economy.history.at(-1)?.expense['Home hardening'] ?? 0) + (w.economy.ledger.expense['Home hardening'] ?? 0);
    const homes = w.towns.reduce((a, t) => a + t.structures, 0);
    expect(spent).toBeGreaterThan(0.15 * homes * COST.firewisePerHome);
    expect(spent).toBeLessThan(0.25 * homes * COST.firewisePerHome);
    updateFirewise(w);
    expect(w.towns[0].firewise).toBeGreaterThan(before + 0.03);
    expect(w.towns[0].firewise).toBeLessThan(before + 0.15);
  });
});

describe('thinning in a generated valley', () => {
  it('lowers the hazard of the ground it treats (1.1.1 default: hazard index 0.40 -> 0.62)', async () => {
    const { hazardIndex } = await import('../../src/sim/systems/fuels.ts');
    const { applyThinning } = await import('../../src/sim/systems/projects.ts');
    const w = smallWorld('tinderbox', 'thin-haz');
    let n = 0,
      before = 0,
      after = 0,
      ladderBefore = 0,
      ladderAfter = 0;
    for (let i = 0; i < w.N && n < 400; i += 7) {
      if (w.L.water[i] || w.L.town[i] || hazardIndex(w, i) < 0.3) continue;
      if (w.L.pine[i] + w.L.fir[i] < 0.3) continue;
      n++;
      before += hazardIndex(w, i);
      ladderBefore += cellFuel(w, i).ladder;
      applyThinning(w, i);
      after += hazardIndex(w, i);
      ladderAfter += cellFuel(w, i).ladder;
    }
    expect(n).toBeGreaterThan(100);
    expect(after).toBeLessThan(0.85 * before);
    expect(ladderAfter).toBeLessThan(0.45 * ladderBefore);
    void FIRE;
  });
});
