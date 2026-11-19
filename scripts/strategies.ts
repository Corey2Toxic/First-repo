/**
 * Strategy bots for balancing. Each plays a full tenure headlessly through the
 * same command layer and council review the player uses.
 *
 *   node scripts/strategies.ts [scenario] [years] [seeds...]
 *   node scripts/strategies.ts --one <seed> <strategy> <scenario> <years>
 */
import { spawn } from 'node:child_process';
import { generateWorld } from '../src/sim/gen/index.ts';
import { makeConfig } from '../src/sim/scenarios.ts';
import type { ScenarioId, World } from '../src/sim/world.ts';
import { Simulation } from '../src/sim/sim.ts';
import { applyCommand } from '../src/sim/commands.ts';
import { ZONE, INFRA } from '../src/sim/types.ts';
import { hazardIndex } from '../src/sim/systems/fuels.ts';
import { distanceField } from '../src/sim/gen/settle.ts';
import { vegetationSummary } from '../src/sim/systems/vegetation.ts';
import { deerCount } from '../src/sim/systems/wildlife.ts';
import { evaluateLegacy } from '../src/sim/score.ts';
import { DX8, DY8 } from '../src/sim/grid.ts';

type Strategy = 'passive' | 'suppress' | 'steward' | 'baron';
const STRATS: Strategy[] = ['passive', 'suppress', 'steward', 'baron'];

function townDist(w: World) {
  return distanceField(w, (i) => w.L.town[i] > 0, 60);
}

/** Grow a contiguous blob of high-hazard cells around a seed. */
function blob(w: World, seed: number, size: number, ok: (i: number) => boolean): number[] {
  const out = [seed];
  const seen = new Set([seed]);
  for (let k = 0; k < out.length && out.length < size; k++) {
    const c = out[k];
    const x = c % w.W,
      y = (c / w.W) | 0;
    for (let d = 0; d < 8; d += 2) {
      const nx = x + DX8[d],
        ny = y + DY8[d];
      if (!w.inside(nx, ny)) continue;
      const n = ny * w.W + nx;
      if (seen.has(n) || !ok(n)) continue;
      seen.add(n);
      out.push(n);
      if (out.length >= size) break;
    }
  }
  return out;
}

function stewardSetup(w: World): void {
  const td = townDist(w);
  const near = distanceField(w, (i) => w.L.town[i] > 0 || (w.L.infra[i] & INFRA.ROAD) !== 0, 40);
  const buffer: number[] = [],
    wild: number[] = [];
  for (let i = 0; i < w.N; i++) {
    if (w.L.water[i] || w.L.town[i]) continue;
    if (td[i] <= 6) buffer.push(i);
    else if (near[i] >= 14 && w.L.elev[i] > 1900 && w.L.zone[i] === ZONE.NONE) wild.push(i);
  }
  applyCommand(w, { t: 'zone', cells: buffer, zone: ZONE.BUFFER });
  applyCommand(w, { t: 'zone', cells: wild, zone: ZONE.WILDERNESS });
  applyCommand(w, { t: 'policy', key: 'buildingCode', value: 'firewise' });
  applyCommand(w, { t: 'policy', key: 'slash', value: 'pileburn' });
  applyCommand(w, { t: 'hire', kind: 'hand' });
}

function stewardTreat(w: World, kind: 'burn' | 'thin', budget: number): void {
  const td = townDist(w);
  const busy = new Set<number>();
  for (const p of w.projects) if (p.status !== 'done' && p.status !== 'cancelled') for (const c of p.unit) busy.add(c);
  const cands: Array<[number, number]> = [];
  const maxD = kind === 'thin' ? 6 : 18;
  for (let i = 0; i < w.N; i++) {
    if (td[i] > maxD || w.L.water[i] || w.L.town[i] || busy.has(i)) continue;
    if (w.yearF - w.L.lastTreat[i] < 6 || w.yearF - w.L.lastBurn[i] < 4) continue;
    const h = hazardIndex(w, i);
    if (h > 0.3) cands.push([h - td[i] * 0.01, i]);
  }
  cands.sort((a, b) => b[0] - a[0]);
  let spent = 0;
  const per = kind === 'burn' ? 230 : 1520;
  for (const [, seed] of cands) {
    if (spent > budget) break;
    if (busy.has(seed)) continue;
    const cells = blob(w, seed, kind === 'burn' ? 45 : 14, (n) => !busy.has(n) && !w.L.water[n] && !w.L.town[n] && hazardIndex(w, n) > 0.22);
    for (const c of cells) busy.add(c);
    const r = applyCommand(w, { t: 'project', kind, cells });
    if (r.ok) spent += cells.length * per;
  }
}

function play(seed: string, strat: Strategy, scen: ScenarioId, years: number) {
  const w = generateWorld(makeConfig(scen, seed));
  w.config.tenureYears = years;
  const sim = new Simulation(w);
  if (strat === 'suppress') {
    applyCommand(w, { t: 'hire', kind: 'hand' });
    applyCommand(w, { t: 'hire', kind: 'hand' });
    applyCommand(w, { t: 'hire', kind: 'heli' });
    applyCommand(w, { t: 'policy', key: 'fireBan', value: 'summer' });
  } else if (strat === 'steward') stewardSetup(w);
  else if (strat === 'baron') {
    applyCommand(w, { t: 'policy', key: 'harvest', value: 'high' });
    applyCommand(w, { t: 'policy', key: 'harvestMethod', value: 'clearcut' });
    applyCommand(w, { t: 'policy', key: 'salvage', value: true });
    applyCommand(w, { t: 'policy', key: 'grazing', value: 'heavy' });
    applyCommand(w, { t: 'policy', key: 'wolfPolicy', value: 'bounty' });
    // expand timber zones to every forested cell near roads
    const rd = distanceField(w, (i) => (w.L.infra[i] & INFRA.ROAD) !== 0, 20);
    const cells: number[] = [];
    for (let i = 0; i < w.N; i++) if (rd[i] <= 14 && w.L.pine[i] + w.L.fir[i] > 0.3 && w.L.zone[i] === ZONE.NONE) cells.push(i);
    applyCommand(w, { t: 'zone', cells, zone: ZONE.TIMBER });
  }
  let trustSum = 0,
    trustN = 0;
  const onReview = (ww: World) => {
    for (const p of ww.review.petitions) {
      let accept = false;
      if (strat === 'steward') accept = p.faction === 'residents' || p.faction === 'conservation' || (p.action.type === 'policy' && p.faction === 'tourism');
      else if (strat === 'suppress') accept = p.faction !== 'conservation';
      else if (strat === 'baron') accept = p.faction === 'timber' || p.faction === 'ranchers';
      applyCommand(ww, { t: 'petition', id: p.id, accept });
    }
    trustSum += ww.trust;
    trustN++;
    applyCommand(ww, { t: 'closeReview' });
  };
  while (!w.outcome.ended && w.yearsElapsed < years + 0.01) {
    // seasonal bot actions
    if (strat === 'steward') {
      const reserve = 350_000;
      if (w.doy === 5 || w.doy === 185) stewardTreat(w, 'burn', Math.max(0, (w.economy.funds - reserve) * 0.35));
      if (w.doy === 280) stewardTreat(w, 'thin', Math.max(0, (w.economy.funds - reserve) * 0.6));
    }
    if (strat === 'suppress') for (const f of w.fires) if (f.active && f.detected && f.response !== 'suppress' && f.cause !== 'prescribed') f.response = 'suppress';
    sim.runDays(5, onReview);
    if (w.review.pending) onReview(w);
  }
  if (!w.outcome.ended) w.outcome = evaluateLegacy(w, 'tenure');
  const v = vegetationSummary(w);
  const burned = w.counters.totalBurned;
  return {
    seed,
    strat,
    scen,
    yearsServed: Math.floor(w.yearsElapsed),
    reason: w.outcome.reason,
    score: w.outcome.score,
    avgTrust: Math.round(trustN ? trustSum / trustN : w.trust),
    burned,
    severePct: burned ? Math.round((100 * w.counters.totalHighSeverity) / burned) : 0,
    megafires: w.counters.megafires,
    homesLost: w.counters.totalStructuresLost,
    rxHa: w.counters.totalRx,
    hazard: Math.round(v.hazard * 100),
    deer: deerCount(w),
    wolves: w.packs.length,
    beavers: w.colonies.filter((c) => c.active).length,
    funds: Math.round(w.economy.funds / 1000),
    mill: w.economy.millOpen,
    silt: Math.round(w.reservoirSilt * 100),
  };
}

const args = process.argv.slice(2);
if (args[0] === '--one') {
  const [, seed, strat, scen, years] = args;
  console.log(JSON.stringify(play(seed, strat as Strategy, scen as ScenarioId, Number(years))));
} else {
  const scen = (args[0] ?? 'tinderbox') as ScenarioId;
  const years = Number(args[1] ?? 30);
  const seeds = args.slice(2).length ? args.slice(2) : ['bal-1', 'bal-2'];
  const jobs = seeds.flatMap((s) => STRATS.map((st) => [s, st] as const));
  const results: Array<Record<string, unknown>> = [];
  let k = 0;
  const worker = async () => {
    while (k < jobs.length) {
      const [s, st] = jobs[k++];
      const out = await new Promise<string>((resolve) => {
        const p = spawn(process.execPath, [new URL(import.meta.url).pathname, '--one', s, st, scen, String(years)]);
        let buf = '';
        p.stdout.on('data', (d) => (buf += d));
        p.stderr.on('data', (d) => process.stderr.write(d));
        p.on('close', () => resolve(buf.trim().split('\n').pop() ?? '{}'));
      });
      try {
        const r = JSON.parse(out);
        results.push(r);
        console.log(JSON.stringify(r));
      } catch {
        console.log('failed', s, st, out.slice(0, 200));
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log('\nstrategy   score trust served burned sev% mega homes  rx   hazard deer wolves beavers funds mill silt');
  for (const st of STRATS) {
    const rs = results.filter((r) => r.strat === st);
    const avg = (key: string) => (rs.reduce((a, r) => a + Number(r[key]), 0) / Math.max(1, rs.length)).toFixed(0);
    console.log(
      `${st.padEnd(10)} ${avg('score').padStart(5)} ${avg('avgTrust').padStart(5)} ${avg('yearsServed').padStart(6)} ${avg('burned').padStart(6)} ${avg('severePct').padStart(4)} ${avg('megafires').padStart(4)} ${avg('homesLost').padStart(5)} ${avg('rxHa').padStart(5)} ${avg('hazard').padStart(6)} ${avg('deer').padStart(5)} ${avg('wolves').padStart(5)} ${avg('beavers').padStart(7)} ${avg('funds').padStart(6)} ${rs.filter((r) => r.mill).length}/${rs.length} ${avg('silt').padStart(4)}`,
    );
  }
}
