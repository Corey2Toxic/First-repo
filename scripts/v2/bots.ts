/**
 * Does the warden matter? Strategy bots play whole tenures through the same command layer and
 * council review the player uses, on the same valleys, and the outcomes are compared.
 *
 *   node scripts/v2/bots.ts <scenario> <seeds> [strategies] [years]
 *   node scripts/v2/bots.ts tinderbox v1,v2,v3,v4
 *   node scripts/v2/bots.ts --one <scenario> <seed> <strategy> [years]
 *
 * Strategies
 *   passive   refuses every petition and does nothing else
 *   firefight hires one more hand crew, builds lookouts, flies air patrol; no treatment (what the
 *             budget sustains: two crews and a helicopter went bankrupt in year 8)
 *   steward   lookouts, one more hand crew, the firewise code; every year thins the ground nearest
 *             homes and burns the fireshed beyond it, choosing ground by the Fireshed and Bad-day
 *             fire lenses (the same information the player has); wilderness in the remote high country
 *   neglect   lays off a hand crew and an engine and never calls an outside team
 *
 * Seeds are prefixed with FW_SEED_PREFIX (default "ver-": verification seeds, never used in tuning).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateWorld } from '../../src/sim/gen/index.ts';
import { makeConfig } from '../../src/sim/scenarios.ts';
import type { ScenarioId, World } from '../../src/sim/world.ts';
import { Simulation } from '../../src/sim/sim.ts';
import { applyCommand } from '../../src/sim/commands.ts';
import { INFRA, ZONE } from '../../src/sim/types.ts';
import { distanceField } from '../../src/sim/gen/settle.ts';
import { computeFireshed } from '../../src/sim/projection.ts';
import { evaluateLegacy } from '../../src/sim/score.ts';
import { objectiveMet, objectives } from '../../src/sim/objectives.ts';
import { DX8, DY8 } from '../../src/sim/grid.ts';
import { beaverSiteScore } from '../../src/sim/gen/wildlife.ts';

type Strategy = 'passive' | 'firefight' | 'steward' | 'neglect' | 'rewilder';
const ALL: Strategy[] = ['passive', 'firefight', 'steward', 'neglect'];

function townDist(w: World) {
  return distanceField(w, (i) => w.L.town[i] > 0, 60);
}

/** Grow a contiguous block of cells around a seed. */
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

/** Lookouts on high ground near the two largest towns. */
function buildLookouts(w: World, n: number): void {
  const towns = [...w.towns].sort((a, b) => b.structures - a.structures).slice(0, n);
  for (const t of towns) {
    let best = -1,
      be = -Infinity;
    for (let dy = -22; dy <= 22; dy++)
      for (let dx = -22; dx <= 22; dx++) {
        const x = t.x + dx,
          y = t.y + dy;
        if (!w.inside(x, y)) continue;
        const i = y * w.W + x;
        if (w.L.water[i] || w.L.town[i] !== 0) continue;
        const d = Math.hypot(dx, dy);
        if (d < 8) continue;
        const score = w.L.elev[i] - d * 4;
        if (score > be) {
          be = score;
          best = i;
        }
      }
    if (best >= 0) applyCommand(w, { t: 'build', what: 'tower', cell: best });
  }
}

function stewardSetup(w: World): void {
  const near = distanceField(w, (i) => w.L.town[i] > 0 || (w.L.infra[i] & INFRA.ROAD) !== 0, 40);
  const td = townDist(w);
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
  buildLookouts(w, 2);
}

/**
 * The steward's yearly work, chosen as a player would from the lenses: thin what would torch within
 * 400 m of homes, burn the ground a bad day's fire would cross in its last hours.
 */
function stewardTreat(w: World, kind: 'burn' | 'thin', budget: number): number {
  if (budget < 20_000) return 0;
  const td = townDist(w);
  const shed = computeFireshed(w);
  const busy = new Set<number>();
  for (const p of w.projects) if (p.status !== 'done' && p.status !== 'cancelled') for (const c of p.unit) busy.add(c);
  const cands: Array<[number, number]> = [];
  const maxD = kind === 'thin' ? 5 : 22;
  const minD = kind === 'burn' ? 3 : 1;
  for (let i = 0; i < w.N; i++) {
    if (td[i] > maxD || td[i] < minD || w.L.water[i] || w.L.town[i] || busy.has(i)) continue;
    if (w.yearF - w.L.lastTreat[i] < 9 || w.yearF - w.L.lastBurn[i] < 7) continue;
    const b = shed.behaviour[i];
    if (b < 2) continue;
    if (kind === 'burn' && !(shed.hours[i] <= 9)) continue;
    // worst behaviour, nearest homes first
    cands.push([b * 10 - td[i] - (shed.hours[i] <= 36 ? shed.hours[i] * 0.3 : 12), i]);
  }
  cands.sort((a, b) => b[0] - a[0]);
  let spent = 0;
  const per = kind === 'burn' ? 230 : 1520;
  for (const [, seed] of cands) {
    if (spent > budget) break;
    if (busy.has(seed)) continue;
    const cells = blob(w, seed, kind === 'burn' ? 90 : 20, (n) => !busy.has(n) && !w.L.water[n] && !w.L.town[n] && td[n] >= minD && td[n] <= maxD + 2 && shed.behaviour[n] >= 2);
    if (cells.length < (kind === 'burn' ? 12 : 4)) continue;
    for (const c of cells) busy.add(c);
    const r = applyCommand(w, { t: 'project', kind, cells });
    if (r.ok) spent += cells.length * per;
  }
  return spent;
}

/**
 * The rewilder's yearly round: wolves released in the most remote country when the valley has none,
 * beaver families moved to the best free reaches until four colonies stand. No work on fuels.
 */
function rewild(w: World): void {
  if (w.packs.length === 0) {
    const td = townDist(w);
    let best = -1,
      bd = 0;
    for (let i = 0; i < w.N; i += 7) {
      if (w.L.water[i] >= 2 || td[i] < 20) continue;
      if (td[i] > bd) {
        bd = td[i];
        best = i;
      }
    }
    if (best >= 0) applyCommand(w, { t: 'reintroduceWolves', cell: best });
  }
  let need = 4 - w.colonies.filter((c) => c.active).length;
  if (need <= 0) return;
  const sites: Array<[number, number]> = [];
  for (let i = 0; i < w.N; i++) {
    const s = beaverSiteScore(w, i);
    if (s >= 0.11 && !w.colonies.some((c) => c.active && Math.hypot((c.cell % w.W) - (i % w.W), ((c.cell / w.W) | 0) - ((i / w.W) | 0)) < 12)) sites.push([s, i]);
  }
  sites.sort((a, b) => b[0] - a[0]);
  const used: number[] = [];
  for (const [, i] of sites) {
    if (need <= 0) break;
    if (used.some((u) => Math.hypot((u % w.W) - (i % w.W), ((u / w.W) | 0) - ((i / w.W) | 0)) < 12)) continue;
    if (applyCommand(w, { t: 'relocateBeavers', cell: i }).ok) {
      used.push(i);
      need--;
    }
  }
}

function play(scen: ScenarioId, seed: string, strat: Strategy, years: number) {
  const w = generateWorld(makeConfig(scen, seed));
  if (years > 0) w.config.tenureYears = years;
  else years = w.config.tenureYears;
  const sim = new Simulation(w);
  if (strat === 'firefight') {
    applyCommand(w, { t: 'hire', kind: 'hand' });
    applyCommand(w, { t: 'policy', key: 'airPatrol', value: true });
    buildLookouts(w, 2);
  } else if (strat === 'steward') stewardSetup(w);
  else if (strat === 'rewilder') {
    applyCommand(w, { t: 'policy', key: 'wolfPolicy', value: 'protected' });
    rewild(w);
  } else if (strat === 'neglect') {
    const hand = w.crews.filter((c) => c.kind === 'hand');
    const eng = w.crews.filter((c) => c.kind === 'engine');
    if (hand.length > 2) applyCommand(w, { t: 'dismiss', crewId: hand[hand.length - 1].id });
    if (eng.length > 1) applyCommand(w, { t: 'dismiss', crewId: eng[eng.length - 1].id });
    applyCommand(w, { t: 'policy', key: 'mutualAid', value: 'manual' });
  }
  const exposure0 = w.memory.exposure?.start ?? 0;
  const fires: Array<{ area: number; days: number; homes: number; monitored: boolean }> = [];
  sim.hooks.onEnd = ((prev) => (fe) => {
    if (prev) prev(fe);
    if (fe.cause !== 'prescribed' && fe.cause !== 'pile') fires.push({ area: fe.area, days: fe.outDay - fe.startDay, homes: fe.structuresLost, monitored: fe.response === 'monitor' });
    // FW_FIRES=1: list the fires that mattered (stderr)
    if (process.env.FW_FIRES && (fe.area >= 300 || fe.structuresLost > 0))
      console.error(
        '  y' + (Math.floor(fe.startDay / 360) + 1) + ' d' + (fe.startDay % 360) + ' ' + fe.name + ' [' + fe.cause + ', ' + fe.response + '] ' + fe.area + ' ha in ' + (fe.outDay - fe.startDay) + ' d, ' + fe.structuresLost + ' homes, ' +
          Math.round((100 * fe.highSeverity) / Math.max(1, fe.area)) + '% severe, cost $' + Math.round(fe.cost / 1000) + 'k, funds $' + Math.round(w.economy.funds / 1000) + 'k',
      );
  })(sim.hooks.onEnd);
  let treatSpend = 0;
  const onReview = (ww: World) => {
    for (const p of ww.review.petitions) {
      let accept = false;
      if (strat === 'steward') accept = p.faction === 'residents' || p.faction === 'conservation' || (p.action.type === 'policy' && p.faction === 'tourism');
      else if (strat === 'rewilder') accept = p.faction === 'conservation';
      else if (strat === 'firefight') accept = p.faction === 'residents';
      applyCommand(ww, { t: 'petition', id: p.id, accept });
    }
    applyCommand(ww, { t: 'closeReview' });
  };
  while (!w.outcome.ended && w.yearsElapsed < years + 0.01) {
    if (strat === 'steward') {
      // a warden keeps a fire-season reserve: a bad summer costs several hundred thousand
      const reserve = 450_000;
      // burns are planned in late winter and at summer's end, thinning in autumn
      if (w.doy === 20 || w.doy === 235) treatSpend += stewardTreat(w, 'burn', Math.max(0, (w.economy.funds - reserve) * 0.3));
      if (w.doy === 280 || w.doy === 60) treatSpend += stewardTreat(w, 'thin', Math.max(0, (w.economy.funds - reserve) * 0.55));
    }
    if (strat === 'rewilder' && w.doy === 100) rewild(w);
    sim.runDays(5, onReview);
    if (w.review.pending) onReview(w);
  }
  if (!w.outcome.ended) w.outcome = evaluateLegacy(w, 'tenure');
  const burned = w.counters.totalBurned;
  let land = 0;
  for (let i = 0; i < w.N; i++) if (w.L.water[i] < 2) land++;
  const ex = w.memory.exposure;
  const obj = objectives(w);
    const yrs = Math.max(1, Math.floor(w.yearsElapsed));
  return {
    scen,
    seed,
    strat,
    years: yrs,
    reason: w.outcome.reason,
    score: w.outcome.score,
    homesLost: w.counters.totalStructuresLost,
    burnedPctYr: +((100 * burned) / yrs / land).toFixed(2),
    worstYearPct: +((100 * Math.max(0, ...w.stats.burned)) / land).toFixed(1),
    severePct: burned ? Math.round((100 * w.counters.totalHighSeverity) / burned) : 0,
    severeShare: burned ? +(w.counters.totalHighSeverity / burned).toFixed(4) : 0,
    // of the fires that were fought (a fire left to burn on purpose is not a failed attack)
    caughtPct: Math.round((100 * fires.filter((f) => !f.monitored && f.area < 10).length) / Math.max(1, fires.filter((f) => !f.monitored).length)),
    monitored: fires.filter((f) => f.monitored).length,
    monitoredHa: fires.filter((f) => f.monitored).reduce((a, f) => a + f.area, 0),
    fires: fires.length,
    big: fires.filter((f) => f.area >= 1000).length,
    rxHa: w.counters.totalRx,
    exposure0: Math.round(exposure0 * 100),
    exposure1: Math.round((ex?.now ?? 0) * 100),
    charges: obj.filter(objectiveMet).length,
    met: obj.map((o) => (objectiveMet(o) ? '+' : '-') + o.id).join(' '),
    read: obj.map((o) => o.id + ': ' + o.reading).join(' | '),
    deerKm2: +(w.herds.reduce((a, h) => a + h.n, 0) / (land / 100)).toFixed(1),
    deerSeries: w.stats.deer.filter((_: number, k: number) => k % 60 === 59).map((x: number) => +(x / (land / 100)).toFixed(1)).join(','),
    browse: +(() => {
      let b = 0;
      for (let i = 0; i < w.N; i++) if (w.L.water[i] < 2) b += w.L.browse[i];
      return b / land;
    })().toFixed(3),
    wolfYearsPct: Math.round((100 * w.stats.wolves.filter((x: number) => x > 0).length) / Math.max(1, w.stats.wolves.length)),
    colonies: w.colonies.filter((c) => c.active).length,
    trust: Math.round(w.memory.trustYears ? (w.memory.trustSum ?? 0) / w.memory.trustYears : w.trust),
    funds: Math.round(w.economy.funds / 1000),
    treatK: Math.round(treatSpend / 1000),
    aidK: Math.round(w.aid.reduce((a, t) => a + t.cost, 0) / 1000),
  };
}

const args = process.argv.slice(2);
if (args[0] === '--one') {
  const [, scen, seed, strat, years] = args;
  console.log(JSON.stringify(play(scen as ScenarioId, seed, strat as Strategy, Number(years ?? 0))));
} else {
  const scen = args[0] ?? 'tinderbox';
  const prefix = process.env.FW_SEED_PREFIX ?? 'ver-';
  const seeds = (args[1] ?? '1,2,3,4').split(',').map((s) => prefix + s);
  const strats = (args[2] ? args[2].split(',') : ALL) as Strategy[];
  const years = args[3] ?? '0';
  const jobs = seeds.flatMap((s) => strats.map((st) => [s, st] as const));
  const results: Array<Record<string, number | string>> = [];
  let k = 0;
  const self = fileURLToPath(import.meta.url);
  const worker = async () => {
    while (k < jobs.length) {
      const [s, st] = jobs[k++];
      const out = await new Promise<string>((resolve) => {
        const p = spawn(process.execPath, [self, '--one', scen, s, st, years]);
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
        console.log('failed', s, st, out.slice(0, 300));
      }
    }
  };
  await Promise.all(Array.from({ length: Number(process.env.FW_JOBS ?? 4) }, worker));
  const cols: Array<[string, string]> = [
    ['score', 'score'],
    ['charges', 'charges'],
    ['homes lost', 'homesLost'],
    ['caught <10ha %', 'caughtPct'],
    ['left to burn', 'monitored'],
    ['fires >=1k ha', 'big'],
    ['burned %/yr', 'burnedPctYr'],
    ['worst year %', 'worstYearPct'],
    ['severe %', 'severePct'],
    ['exposure start', 'exposure0'],
    ['exposure end', 'exposure1'],
    ['rx ha', 'rxHa'],
    ['trust', 'trust'],
    ['years', 'years'],
    ['funds $k', 'funds'],
    ['treatment $k', 'treatK'],
    ['aid $k', 'aidK'],
  ];
  console.log(`\n${scen}, seeds ${seeds.join(' ')}: mean [min..max]`);
  console.log('strategy'.padEnd(11) + cols.map(([n]) => n.padStart(16)).join(''));
  for (const st of strats) {
    const rs = results.filter((r) => r.strat === st);
    if (!rs.length) continue;
    const cell = (key: string) => {
      const v = rs.map((r) => Number(r[key]));
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      const f = (x: number) => (Math.abs(x) >= 100 || Number.isInteger(x) ? x.toFixed(0) : x.toFixed(1));
      return `${f(m)} [${f(Math.min(...v))}..${f(Math.max(...v))}]`.padStart(16);
    };
    console.log(st.padEnd(11) + cols.map(([, k2]) => cell(k2)).join(''));
  }
  // paired differences against the passive warden, seed by seed
  if (strats.includes('passive')) {
    console.log('\nagainst the passive warden on the same valley (strategy minus passive), by seed:');
    for (const st of strats) {
      if (st === 'passive') continue;
      const d = seeds
        .map((s) => {
          const a = results.find((r) => r.seed === s && r.strat === st),
            b = results.find((r) => r.seed === s && r.strat === 'passive');
          return a && b ? `${s}: score ${Number(a.score) - Number(b.score) >= 0 ? '+' : ''}${Number(a.score) - Number(b.score)}, homes ${Number(a.homesLost) - Number(b.homesLost) >= 0 ? '+' : ''}${Number(a.homesLost) - Number(b.homesLost)}` : '';
        })
        .filter(Boolean);
      console.log(`  ${st.padEnd(10)} ${d.join(' | ')}`);
    }
  }
}
