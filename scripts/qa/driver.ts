/**
 * Parallel driver for scripts/qa/longrun.ts.
 *
 *   node scripts/qa/driver.ts <jobs.json> <outDir> [concurrency] [simRoot]
 *
 * jobs.json: [{ "scen": "tinderbox", "seed": "x", "size": "medium", "years": 50, "tag": "opt", "variant": {...} }]
 * Existing outputs are skipped, so an interrupted batch can be resumed.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const [jobsFile, outDir, concS, simRoot] = process.argv.slice(2);
const jobs = JSON.parse(readFileSync(jobsFile, 'utf8')) as Array<Record<string, unknown>>;
const conc = Number(concS ?? 3);
mkdirSync(outDir, { recursive: true });
const script = new URL('./longrun.ts', import.meta.url).pathname;
let next = 0,
  done = 0;
function runOne(): Promise<void> {
  if (next >= jobs.length) return Promise.resolve();
  const j = jobs[next++];
  const name = `${j.scen}_${j.seed}_${j.size}_${j.years}${j.tag ? '_' + j.tag : ''}`;
  const out = `${outDir}/${name}.json`;
  if (existsSync(out)) {
    done++;
    return runOne();
  }
  return new Promise<void>((res) => {
    const args = [script, String(j.scen), String(j.seed), String(j.size), String(j.years), simRoot ?? '-'];
    if (j.variant) args.push(JSON.stringify(j.variant));
    const p = spawn('node', ['--max-old-space-size=3000', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let s = '',
      e = '';
    p.stdout.on('data', (d) => (s += d));
    p.stderr.on('data', (d) => (e += d));
    p.on('close', (code) => {
      done++;
      if (code === 0) writeFileSync(out, s);
      else writeFileSync(out + '.err', e + '\n' + s);
      console.log(`[${done}/${jobs.length}] ${name} exit ${code}`);
      res();
    });
  }).then(runOne);
}
await Promise.all(Array.from({ length: conc }, runOne));
console.log('ALL DONE');
