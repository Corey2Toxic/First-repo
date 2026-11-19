import { describe, expect, it } from 'vitest';
import { Simulation, autoCloseReview } from '../../src/sim/sim.ts';
import { applyCommand } from '../../src/sim/commands.ts';
import { ledgerTotals } from '../../src/sim/systems/economy.ts';
import { generatePetitions, beginReview } from '../../src/sim/systems/council.ts';
import { CREW_COST, COST } from '../../src/sim/economyParams.ts';
import { ZONE, FACTIONS } from '../../src/sim/types.ts';
import { LAYER_SPECS } from '../../src/sim/world.ts';
import type { LayerName } from '../../src/sim/world.ts';
import { SCENARIOS } from '../../src/sim/scenarios.ts';
import { startFire } from '../../src/sim/systems/fire.ts';
import { cellFuel } from '../../src/sim/systems/fuels.ts';
import { hydrologyDaily } from '../../src/sim/systems/hydrology.ts';
import { townsYearly } from '../../src/sim/systems/towns.ts';
import { evaluateLegacy } from '../../src/sim/score.ts';
import { decodeWorld, encodeWorld } from '../../src/sim/save.ts';
import { smallWorld } from '../helpers.ts';

describe('economy, commands and politics', () => {
  it('the ledger accounts for every dollar', () => {
    const w = smallWorld('firstseason', 'ledger-1');
    const sim = new Simulation(w, {}, { autoReview: true });
    sim.runDays(1);
    const f0 = w.economy.funds;
    const t0 = ledgerTotals(w.economy.ledger);
    sim.runDays(300);
    const t1 = ledgerTotals(w.economy.ledger);
    expect(w.economy.funds - f0).toBeCloseTo(t1.income - t0.income - (t1.expense - t0.expense), 3);
    expect(t1.expense).toBeGreaterThan(t0.expense); // wages and upkeep accrue
  }, 120000);

  it('commands validate, apply and charge their costs', () => {
    const w = smallWorld('firstseason', 'cmd-1');
    const f0 = w.economy.funds;
    const crews = w.crews.length;
    expect(applyCommand(w, { t: 'hire', kind: 'heli' }).ok).toBe(true);
    expect(w.crews.length).toBe(crews + 1);
    expect(f0 - w.economy.funds).toBeCloseTo(CREW_COST.heli.hire, 3);
    // zoning
    const t = w.towns[0];
    const cells = Array.from({ length: 30 }, (_, k) => (t.y + 8) * w.W + t.x - 15 + k);
    expect(applyCommand(w, { t: 'zone', cells, zone: ZONE.WILDERNESS }).ok).toBe(true);
    expect(cells.filter((c) => w.L.zone[c] === ZONE.WILDERNESS).length).toBeGreaterThan(10);
    // roads are refused into wilderness
    const r = applyCommand(w, { t: 'road', from: t.station, to: cells[15] });
    expect(r.ok).toBe(false);
    // air drop charges per 10 cells
    const f1 = w.economy.funds;
    expect(applyCommand(w, { t: 'airdrop', cells: cells.slice(0, 12) }).ok).toBe(true);
    expect(f1 - w.economy.funds).toBeCloseTo(2 * COST.retardantDrop, 3);
    expect(w.L.retard[cells[0]]).toBe(1);
    // a burn project is queued but costs nothing until it is done
    const f2 = w.economy.funds;
    const pr = applyCommand(w, { t: 'project', kind: 'burn', cells: cells.map((c) => c - 3 * w.W) });
    expect(pr.ok).toBe(true);
    expect(w.economy.funds).toBe(f2);
    // invalid actions fail without side effects
    expect(applyCommand(w, { t: 'dismiss', crewId: -5 }).ok).toBe(false);
    expect(applyCommand(w, { t: 'build', what: 'tower', cell: w.reservoirCells[0] }).ok).toBe(false);
  });

  it('malformed commands are refused with no side effects (D12, D13, D7)', () => {
    const w = smallWorld('firstseason', 'cmd-hard');
    const before = JSON.stringify(w.policies);
    const f0 = w.economy.funds;
    // out-of-range policy values (v1.0: grazing 'extreme' NaN-poisoned the grazing layer)
    expect(applyCommand(w, { t: 'policy', key: 'grazing', value: 'extreme' } as never).ok).toBe(false);
    expect(applyCommand(w, { t: 'policy', key: 'harvest', value: 'max' } as never).ok).toBe(false);
    expect(applyCommand(w, { t: 'policy', key: 'noSuchPolicy', value: true } as never).ok).toBe(false);
    expect(applyCommand(w, { t: 'policy', key: 'airPatrol', value: 'yes' } as never).ok).toBe(false);
    expect(JSON.stringify(w.policies)).toBe(before);
    expect(applyCommand(w, { t: 'policy', key: 'grazing', value: 'heavy' }).ok).toBe(true);
    // off-grid or fractional cells (v1.0: A* path reconstruction looped until out of memory)
    const c = w.crews[0];
    for (const cell of [-5, w.N + 7, 12.5, NaN]) {
      expect(applyCommand(w, { t: 'sendCrew', crewId: c.id, cell }).ok).toBe(false);
      expect(applyCommand(w, { t: 'build', what: 'tower', cell }).ok).toBe(false);
      expect(applyCommand(w, { t: 'reintroduceWolves', cell }).ok).toBe(false);
    }
    expect(applyCommand(w, { t: 'zone', cells: [0, -1], zone: ZONE.BUFFER }).ok).toBe(false);
    expect(applyCommand(w, { t: 'zone', cells: [0], zone: 99 }).ok).toBe(false);
    expect(applyCommand(w, { t: 'hire', kind: 'tank' } as never).ok).toBe(false);
    expect(applyCommand(w, { t: 'fireResponse', fireId: 1, response: 'ignore' } as never).ok).toBe(false);
    expect(w.economy.funds).toBe(f0);
    expect(w.crews[0].state).toBe(c.state);
    // one campground per site (v1.0 stacked ten on one hectare for ten times the visitors)
    const camp = w.camps[0];
    expect(applyCommand(w, { t: 'build', what: 'camp', cell: camp }).ok).toBe(false);
    expect(applyCommand(w, { t: 'build', what: 'camp', cell: camp + 1 }).ok).toBe(false);
  });

  it('initial attack: crews roll in the step a fire is reported and reach it within hours (D3)', () => {
    const w = smallWorld('firstseason', 'dispatch-1');
    const sim = new Simulation(w, {}, { ignitions: false, autoReview: true });
    sim.runDays(150); // midsummer
    // a burnable cell 2–4 km from the first town
    const t = w.towns[0];
    let cell = -1;
    for (let r = 20; r < 40 && cell < 0; r++)
      for (let a = 0; a < 16 && cell < 0; a++) {
        const x = Math.round(t.x + Math.cos(a) * r),
          y = Math.round(t.y + Math.sin(a) * r);
        if (!w.inside(x, y)) continue;
        const i = y * w.W + x;
        if (!w.L.water[i] && !w.L.town[i] && w.L.pond[i] < 0.1 && cellFuel(w, i).fine > 2) cell = i;
      }
    expect(cell).toBeGreaterThanOrEqual(0);
    while (w.sub !== 4) sim.tick(); // mid-afternoon, when most fires are reported
    const fe = startFire(w, cell, 'human')!;
    fe.detected = true;
    fe.detectedDay = w.day;
    fe.response = 'suppress';
    sim.tick();
    expect(w.crews.some((c) => c.task?.fireId === fe.id)).toBe(true); // v1.0: not until midnight
    let arrived = -1;
    for (let k = 1; k <= 4 && arrived < 0 && fe.active; k++) {
      sim.tick();
      if (w.crews.some((c) => c.task?.fireId === fe.id && c.kind !== 'heli' && c.state === 'working')) arrived = k;
    }
    expect(fe.active === false || arrived > 0).toBe(true); // on the line within 12 hours (or already out)
  }, 60000);

  it('a crew pulled off a treatment puts the treatment back in the queue', () => {
    const w = smallWorld('firstseason', 'requeue-1');
    const t = w.towns[0];
    const cells = Array.from({ length: 12 }, (_, k) => (t.y + 6) * w.W + t.x - 6 + k);
    expect(applyCommand(w, { t: 'project', kind: 'thin', cells }).ok).toBe(true);
    const sim = new Simulation(w, {}, { ignitions: false, autoReview: true });
    sim.runDays(2);
    const pr = w.projects[w.projects.length - 1];
    const crew = w.crews.find((c) => c.task?.projectId === pr.id)!;
    expect(crew).toBeTruthy();
    expect(applyCommand(w, { t: 'recallCrew', crewId: crew.id }).ok).toBe(true);
    expect(pr.status).toBe('queued');
    sim.runDays(8);
    expect(pr.status).toBe('done'); // v1.0: stayed 'active' with nobody on it, forever
  }, 60000);

  it('homes buried by a debris flow count as homes lost (D14)', () => {
    const w = smallWorld('firstseason', 'd14-probe');
    const L = w.L;
    let i0 = -1;
    for (let i = 0; i < w.N && i0 < 0; i++) {
      if (L.water[i] || L.town[i]) continue;
      let c = i,
        ok = true;
      for (let k = 0; k < 6; k++) {
        c = L.flowTo[c];
        if (c < 0 || L.water[c] || L.town[c]) {
          ok = false;
          break;
        }
      }
      if (ok) i0 = i;
    }
    const path: number[] = [];
    for (let c = i0, k = 0; k < 40 && c >= 0; k++, c = L.flowTo[c]) path.push(c);
    const t = w.towns[0];
    L.town[path[3]] = t.id + 1;
    t.structures++;
    L.hydro.fill(0);
    L.hydro[i0] = 0.8;
    L.slope[i0] = 0.3;
    L.grass[i0] = L.shrub[i0] = L.aspen[i0] = L.pine[i0] = L.fir[i0] = L.litter[i0] = 0;
    w.weather.precip = 30;
    const runoff = new Float32Array(w.N);
    runoff[i0] = 50;
    let damaged = -1;
    hydrologyDaily(w, runoff, { onDebrisFlow: (_x: number, _y: number, d: number) => (damaged = d) });
    expect(damaged).toBeGreaterThanOrEqual(1);
    expect(L.town[path[3]]).toBeLessThan(0);
    expect(w.counters.totalStructuresLost).toBe(damaged);
    expect(w.counters.yearStructuresLost).toBe(damaged);
    expect(w.towns.reduce((a, x) => a + x.lostStructures, 0)).toBe(w.counters.totalStructuresLost);
    expect(evaluateLegacy(w, 'tenure').breakdown[0][1]).toBeLessThanOrEqual(15);
  });

  it("a town's growth is charged only for its own losses (D17)", () => {
    const base = smallWorld('boomtown', 'd17-probe');
    const bytes = encodeWorld(base);
    const run = (earlierLoss: number, valleyLoss: number) => {
      const w = decodeWorld(bytes);
      const A = w.towns[0],
        B = w.towns[w.towns.length - 1];
      B.lostStructures = earlierLoss; // B lost homes in some earlier year
      w.counters.yearStructuresLost = valleyLoss; // this year's losses are all in A
      A.yearLost = valleyLoss;
      const p0 = B.population;
      townsYearly(w);
      return B.population / p0;
    };
    for (const valley of [0, 5, 20]) expect(run(1, valley)).toBeCloseTo(run(0, valley), 6);
    expect(run(1, 20)).toBeGreaterThan(0.95); // v1.0: -29 %
  });

  it('petitions arise from real grievances', () => {
    const w = smallWorld('silentwoods', 'pet-1');
    w.memory.lastPetitionYear = {};
    const ps = generatePetitions(w);
    // no wolves in Silent Woods → conservationists ask for them back
    expect(ps.some((p) => p.faction === 'conservation')).toBe(true);
    expect(ps.length).toBeLessThanOrEqual(3);
    expect(new Set(ps.map((p) => p.faction)).size).toBe(ps.length);
  });

  it('a warden who loses the council twice is dismissed', () => {
    const w = smallWorld('firstseason', 'dismiss-1');
    for (const f of FACTIONS) w.factions[f].approval = 20;
    w.review.lowTrustYears = 1;
    w.day = 360;
    beginReview(w);
    expect(w.review.verdict).toBe('dismissed');
    expect(applyCommand(w, { t: 'closeReview' }).ok).toBe(true);
    expect(w.outcome.ended).toBe(true);
    expect(w.outcome.reason).toBe('dismissed');
    expect(w.outcome.score).toBeGreaterThanOrEqual(0);
    expect(w.outcome.epilogue.length).toBeGreaterThan(2);
  });

  for (const sc of SCENARIOS.filter((s) => s.id !== 'custom')) {
    it(`scenario "${sc.title}" runs 30 years without numerical blow-ups`, () => {
      const w = smallWorld(sc.id, 'stab-' + sc.id);
      w.config.tenureYears = 100;
      const sim = new Simulation(w, {}, { autoReview: true });
      const t0 = performance.now();
      sim.runDays(360 * 30);
      const secs = (performance.now() - t0) / 1000;
      for (const name of Object.keys(LAYER_SPECS) as LayerName[]) {
        const a = w.L[name];
        for (let i = 0; i < a.length; i += 11) expect(Number.isFinite(a[i])).toBe(true);
      }
      for (let i = 0; i < w.N; i += 3) {
        expect(w.L.aspen[i] + w.L.pine[i] + w.L.fir[i]).toBeLessThanOrEqual(1.0001);
        expect(w.L.grass[i]).toBeLessThanOrEqual(1);
        expect(w.L.litter[i]).toBeLessThan(200);
      }
      for (const f of FACTIONS) {
        expect(w.factions[f].approval).toBeGreaterThanOrEqual(0);
        expect(w.factions[f].approval).toBeLessThanOrEqual(100);
      }
      expect(Number.isFinite(w.economy.funds)).toBe(true);
      expect(w.herds.every((h) => h.n > 0 && Number.isFinite(h.x))).toBe(true);
      expect(w.stats.year.length).toBeGreaterThanOrEqual(29);
      expect(secs).toBeLessThan(150);
      autoCloseReview(w);
    }, 300000);
  }
});
