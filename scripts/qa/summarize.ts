/**
 * Summarise scripts/qa/longrun.ts outputs, one line per run plus per-directory means.
 *
 *   node scripts/qa/summarize.ts <dir> [<dir> ...]
 */
import { readdirSync, readFileSync } from 'node:fs';

const dirs = process.argv.slice(2);
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
for (const dir of dirs) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  console.log(`\n=== ${dir} (${files.length} runs)`);
  console.log('run'.padEnd(44) + 'burn/yr  sev%  homes  stuck  maxFire  fires  deer0→end(min) wolves(yrs>0) ext  col0→end  aspY  og0→end  mill trust ms/yr');
  const agg: Record<string, number[]> = {};
  const push = (k: string, v: number) => (agg[k] ??= []).push(v);
  for (const f of files) {
    const d = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
    const rows = d.rows.slice(1);
    const burned = rows.reduce((a: number, r: any) => a + r.burned, 0);
    const high = rows.reduce((a: number, r: any) => a + r.high, 0);
    const last = d.rows.at(-1),
      first = d.rows[0];
    const wolfYears = rows.filter((r: any) => r.wolves > 0).length;
    const minDeer = Math.min(...rows.map((r: any) => r.deer));
    const maxFire = d.fires ? Math.max(0, ...d.fires.map((x: any) => x.area)) : -1;
    const landHa = d.W * d.H;
    const youngAsp = mean(rows.slice(Math.floor(rows.length / 2)).map((r: any) => r.youngAspen));
    const line = [
      ((burned / rows.length / landHa) * 100).toFixed(2).padStart(6) + '%',
      ((high / Math.max(1, burned)) * 100).toFixed(0).padStart(5),
      String(last.homesLostTotal).padStart(6),
      String(last.stuckHouse ?? 0).padStart(6),
      String(maxFire).padStart(8),
      String(last.fires).padStart(6),
      `${first.deer}→${last.deer}(${minDeer})`.padStart(16),
      `${last.wolves}(${wolfYears})`.padStart(13),
      String(last.packExtinctions ?? 0).padStart(4),
      `${first.colonies}→${last.colonies}`.padStart(9),
      (youngAsp * 1000).toFixed(2).padStart(6),
      `${first.og}→${last.og}`.padStart(12),
      (last.mill ? ' open' : ' shut'),
      (last.trust ?? 0).toFixed(0).padStart(5),
      String(Math.round(mean(d.yearMs ?? [0]))).padStart(6),
    ].join(' ');
    console.log(f.replace('.json', '').padEnd(44) + line);
    push('burnPct', (burned / rows.length / landHa) * 100);
    push('sev', high / Math.max(1, burned));
    push('homes', last.homesLostTotal);
    push('stuck', last.stuckHouse ?? 0);
    push('wolfYears', wolfYears / rows.length);
    push('ext', last.packExtinctions ?? 0);
    push('ms', mean(d.yearMs ?? [0]));
  }
  console.log(
    `MEAN burn ${mean(agg.burnPct).toFixed(2)}%/yr, severe ${(mean(agg.sev) * 100).toFixed(0)}%, homes ${mean(agg.homes).toFixed(1)}, stuck ${mean(agg.stuck).toFixed(1)}, wolves present ${(mean(agg.wolfYears) * 100).toFixed(0)}% of years, pack extinctions ${mean(agg.ext).toFixed(1)}, ${mean(agg.ms).toFixed(0)} ms/yr`,
  );
}
