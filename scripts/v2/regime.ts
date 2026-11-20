/**
 * Fire regime of one valley under a fixed management style: how many fires, how many are caught
 * small, how large and how long the rest get, what burns and at what severity, what it costs.
 *
 *   node scripts/v2/regime.ts <scenario> <seed> <years> [default|nodispatch|noaid] [small|medium|large]
 *   FW_ROOT=<1.1.1 checkout> node scripts/v2/regime.ts tinderbox seed-a 25      # the same on 1.1.1
 *
 * Add --fires to list every fire of 100 ha or more, --json for one machine-readable line.
 */
import { loadSim } from './lib.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const scen = args[0] ?? 'tinderbox';
const seed = args[1] ?? 's1';
const years = Number(args[2] ?? 15);
const mode = args[3] ?? 'default';
const size = args[4] ?? 'medium';

const S = await loadSim();
const t0 = performance.now();
const w = S.generateWorld(S.makeConfig(scen, seed, size));
w.config.tenureYears = Math.max(w.config.tenureYears, years + 1);
if (mode === 'nodispatch') w.policies.autoDispatch = false;
if (mode === 'noaid' && 'mutualAid' in w.policies) w.policies.mutualAid = 'manual';
let land = 0;
for (let i = 0; i < w.N; i++) if (w.L.water[i] < 2) land++;
const homes0 = w.towns.reduce((a: number, t: any) => a + t.structures, 0);
const fires: any[] = [];
const sim = new S.Simulation(
  w,
  {
    onEnd: (fe: any) => {
      if (fe.cause === 'prescribed') return;
      fires.push({ y: Math.floor(fe.startDay / 360) + 1, doy: fe.startDay % 360, cause: fe.cause, area: fe.area, days: fe.outDay - fe.startDay, crown: fe.crownArea, hi: fe.highSeverity, lo: fe.lowSeverity, homes: fe.structuresLost, cost: fe.cost, flame: fe.maxIntensity });
    },
  },
  { autoReview: true },
);
sim.runDays(years * 360);

const n = Math.max(1, fires.length);
const cnt = (f: (x: any) => boolean) => fires.filter(f).length;
const burned: number[] = w.stats.burned;
const tot = burned.reduce((a, b) => a + b, 0);
const hi = (w.stats.burnedHigh as number[]).reduce((a, b) => a + b, 0);
const homes = (w.stats.structuresLost as number[]).reduce((a, b) => a + b, 0);
const cost = fires.reduce((a, f) => a + f.cost, 0);
const aidTeams = (w.aid ?? []).length;
const aidCost = (w.aid ?? []).reduce((a: number, t: any) => a + t.cost, 0);
const row = {
  scenario: scen,
  seed,
  mode,
  years: burned.length,
  firesPerYear: +(fires.length / years).toFixed(2),
  under10: +(cnt((f) => f.area < 10) / n).toFixed(3),
  under100: +(cnt((f) => f.area < 100) / n).toFixed(3),
  f100: cnt((f) => f.area >= 100 && f.area < 1000),
  f1k: cnt((f) => f.area >= 1000 && f.area < 5000),
  f5k: cnt((f) => f.area >= 5000),
  burnedPctPerYear: +((100 * tot) / years / land).toFixed(2),
  worstYearPct: +((100 * Math.max(0, ...burned)) / land).toFixed(1),
  highSeverityShare: +(hi / Math.max(1, tot)).toFixed(3),
  homesLost: homes,
  homesAtStart: homes0,
  suppressionPerYear: Math.round(cost / years),
  aidTeams,
  aidCost: Math.round(aidCost),
  longFires: cnt((f) => f.days >= 7),
  longestDays: Math.max(0, ...fires.map((f) => f.days)),
  trust: Math.round(w.trust),
  funds: Math.round(w.economy.funds),
  ended: w.outcome.ended ? w.outcome.reason + '@' + w.outcome.year : '',
  seconds: +((performance.now() - t0) / 1000).toFixed(0),
};
if (flags.has('--json')) console.log(JSON.stringify({ ...row, burned }));
else {
  console.log(
    `${scen.padEnd(11)} ${seed.padEnd(10)} ${mode.padEnd(10)} fires/yr ${row.firesPerYear.toFixed(1)} | <10ha ${Math.round(row.under10 * 100)}% <100ha ${Math.round(row.under100 * 100)}% | 100-1k ${row.f100} 1k-5k ${row.f1k} >5k ${row.f5k} | burned ${row.burnedPctPerYear.toFixed(2)}%/yr worst ${row.worstYearPct.toFixed(0)}% hi ${Math.round(row.highSeverityShare * 100)}% | homes ${homes}/${homes0} | supp $${Math.round(row.suppressionPerYear / 1000)}k/yr aid ${aidTeams}x $${Math.round(aidCost / 1000)}k | >=7d ${row.longFires} max ${row.longestDays}d | trust ${row.trust} $${Math.round(row.funds / 1000)}k ${row.ended} | ${row.seconds}s`,
  );
  console.log('   burned/yr ' + burned.join(','));
}
if (flags.has('--fires'))
  for (const f of fires.filter((x) => x.area >= 100).sort((a, b) => b.area - a.area))
    console.log(`   y${f.y} doy${f.doy} ${String(f.cause).padEnd(9)} ${String(f.area).padStart(6)} ha ${String(f.days).padStart(3)} d  crown ${f.crown} high ${f.hi} low ${f.lo} homes ${f.homes} $${Math.round(f.cost / 1000)}k`);
