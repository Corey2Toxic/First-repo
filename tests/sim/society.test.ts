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
