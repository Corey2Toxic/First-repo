/**
 * Per-tick timing of the headless simulation (QA). Classifies every 3-hour tick as a plain sub-step,
 * a sub-step with fire, a daily tick, a month-boundary tick or the year end, and reports quantiles.
 *
 *   node scripts/qa/perf.ts [simRoot] [scenario] [size] [years] [seed]
 *
 * Run the v1.0 export and this checkout alternately on an otherwise idle machine to compare.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [rootArg, scen = 'tinderbox', size = 'medium', yearsS = '3', seed = 'qa-perf-1'] = process.argv.slice(2);
const root = resolve(rootArg && rootArg !== '-' ? rootArg : new URL('../../src/sim', import.meta.url).pathname);
const imp = (p: string) => import(pathToFileURL(`${root}/${p}`).href);
const { generateWorld } = await imp('gen/index.ts');
const { makeConfig } = await imp('scenarios.ts');
const { Simulation } = await imp('sim.ts');
const { applyAllocation } = await imp('systems/council.ts');
const close = (w: any) => {
  for (const p of w.review.petitions) p.resolved = true;
  w.review.pending = false;
  applyAllocation(w);
};
const tg = performance.now();
const w = generateWorld(makeConfig(scen, seed, size, { tenureYears: 999 }));
const genMs = performance.now() - tg;
const sim = new Simulation(w, {}, {});
const cat: Record<string, number[]> = { substep: [], substepFire: [], daily: [], monthly: [], yearEnd: [] };
const years = Number(yearsS);
for (let t = 0; t < 8 * 360 * years; t++) {
  if (w.review.pending) close(w);
  const kind = w.sub === 7 && w.doy === 359 ? 'yearEnd' : w.sub === 0 ? (w.doy % 30 === 0 ? 'monthly' : 'daily') : w.burning.length ? 'substepFire' : 'substep';
  const a = performance.now();
  sim.tick();
  cat[kind].push(performance.now() - a);
}
const q = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
};
const out: Record<string, unknown> = { root, scen, size, W: w.W, H: w.H, genMs: Math.round(genMs) };
let total = 0;
for (const [k, a] of Object.entries(cat)) {
  total += a.reduce((x, y) => x + y, 0);
  out[k] = `n=${a.length} p50 ${q(a, 0.5).toFixed(2)} p95 ${q(a, 0.95).toFixed(2)} p99 ${q(a, 0.99).toFixed(2)} max ${Math.max(0, ...a).toFixed(1)} ms`;
}
out.msPerSimYear = Math.round(total / years);
out.ticksOver14ms = Object.values(cat)
  .flat()
  .filter((x) => x > 14).length;
out.heapMB = Math.round(process.memoryUsage().heapUsed / 1e6);
console.log(JSON.stringify(out));
