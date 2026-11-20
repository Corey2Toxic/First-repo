/**
 * Run regime.ts on several seeds and scenarios in parallel and tabulate the result.
 *
 *   node scripts/v2/batch.ts <years> <seeds> <scenarios> [mode] [size]
 *   node scripts/v2/batch.ts 25 a,b,c,d tinderbox,firstseason
 *   FW_ROOT=<1.1.1 checkout> node scripts/v2/batch.ts 25 a,b,c,d tinderbox       # the same on 1.1.1
 *
 * Seeds are prefixed with FW_SEED_PREFIX (default "cal-") so that calibration and verification can
 * use disjoint sets.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const years = process.argv[2] ?? '25';
const seeds = (process.argv[3] ?? 'a,b,c,d').split(',');
const scenarios = (process.argv[4] ?? 'tinderbox,firstseason').split(',');
const mode = process.argv[5] ?? 'default';
const size = process.argv[6] ?? 'medium';
const prefix = process.env.FW_SEED_PREFIX ?? 'cal-';
const jobs = Number(process.env.FW_JOBS ?? 4);
const script = fileURLToPath(new URL('./regime.ts', import.meta.url));

interface Row {
  scenario: string;
  seed: string;
  [k: string]: number | string | number[];
}
const queue: Array<[string, string]> = [];
for (const sc of scenarios) for (const s of seeds) queue.push([sc, prefix + s]);
const rows: Row[] = [];

function runOne(sc: string, seed: string): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, sc, seed, years, mode, size, '--json'], { env: process.env });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => process.stderr.write(d));
    p.on('close', () => {
      const line = out.trim().split('\n').pop() ?? '';
      try {
        rows.push(JSON.parse(line) as Row);
      } catch {
        console.error(`no result for ${sc} ${seed}: ${line.slice(0, 200)}`);
      }
      resolve();
    });
  });
}

async function worker(): Promise<void> {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    await runOne(job[0], job[1]);
  }
}
await Promise.all(Array.from({ length: jobs }, () => worker()));

const num = (r: Row, k: string) => Number(r[k]);
const cols: Array<[string, string, (r: Row) => number, number]> = [
  ['fires/yr', 'firesPerYear', (r) => num(r, 'firesPerYear'), 1],
  ['<10ha %', 'under10', (r) => 100 * num(r, 'under10'), 0],
  ['<100ha %', 'under100', (r) => 100 * num(r, 'under100'), 0],
  ['100-1k', 'f100', (r) => num(r, 'f100'), 1],
  ['1k-5k', 'f1k', (r) => num(r, 'f1k'), 1],
  ['>5k', 'f5k', (r) => num(r, 'f5k'), 1],
  ['burn %/yr', 'burnedPctPerYear', (r) => num(r, 'burnedPctPerYear'), 2],
  ['worst yr %', 'worstYearPct', (r) => num(r, 'worstYearPct'), 0],
  ['high sev %', 'highSeverityShare', (r) => 100 * num(r, 'highSeverityShare'), 0],
  ['homes lost', 'homesLost', (r) => num(r, 'homesLost'), 1],
  ['supp $k/yr', 'suppressionPerYear', (r) => num(r, 'suppressionPerYear') / 1000, 0],
  ['aid calls', 'aidTeams', (r) => num(r, 'aidTeams'), 1],
  ['longest d', 'longestDays', (r) => num(r, 'longestDays'), 0],
  ['trust', 'trust', (r) => num(r, 'trust'), 0],
  ['funds $k', 'funds', (r) => num(r, 'funds') / 1000, 0],
  ['years run', 'years', (r) => num(r, 'years'), 1],
];
console.log(`${years} years, mode ${mode}, ${size}; mean [min..max] over seeds ${seeds.map((s) => prefix + s).join(' ')}`);
for (const sc of scenarios) {
  const rs = rows.filter((r) => r.scenario === sc);
  if (!rs.length) continue;
  console.log(`\n${sc} (${rs.length} runs${rs.some((r) => r.ended) ? '; ended early: ' + rs.filter((r) => r.ended).map((r) => `${r.seed} ${r.ended}`).join(', ') : ''})`);
  for (const [label, , f, digits] of cols) {
    const v = rs.map(f);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    console.log(`  ${label.padEnd(11)} ${mean.toFixed(digits).padStart(8)}   [${Math.min(...v).toFixed(digits)} .. ${Math.max(...v).toFixed(digits)}]`);
  }
}
if (process.env.FW_BATCH_JSON) console.log('\n' + JSON.stringify(rows));
