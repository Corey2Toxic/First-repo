/**
 * Generate a world and dump PNG previews: node scripts/dump-map.ts [seed] [scenario] [outdir]
 */
import { generateWorld } from '../src/sim/gen/index.ts';
import { makeConfig } from '../src/sim/scenarios.ts';
import type { ScenarioId } from '../src/sim/world.ts';
import { writePNG } from './lib/png.ts';
import { mapImage } from './lib/mapimage.ts';
import { mkdirSync } from 'node:fs';

const seed = process.argv[2] ?? 'ember-raven-1234';
const scen = (process.argv[3] ?? 'tinderbox') as ScenarioId;
const out = process.argv[4] ?? 'tmp-maps';
mkdirSync(out, { recursive: true });
const t0 = performance.now();
const w = generateWorld(makeConfig(scen, seed));
const t1 = performance.now();
console.log(`generated ${w.W}x${w.H} in ${(t1 - t0).toFixed(0)} ms — ${w.valleyName}`);
console.log('towns:', w.towns.map((t) => `${t.name} pop ${t.population} structs ${t.structures}${t.mill ? ' (mill)' : ''}`).join('; '));
console.log('landmarks:', w.landmarks.map((l) => `${l.kind}:${l.name}`).join(', '));
console.log('herds', w.herds.length, 'packs', w.packs.length, 'colonies', w.colonies.length, 'reservoir cells', w.reservoirCells.length, 'towers', w.towers.length, 'camps', w.camps.length);
let lo = Infinity, hi = -Infinity;
for (const e of w.L.elev) { lo = Math.min(lo, e); hi = Math.max(hi, e); }
console.log('elev range', lo.toFixed(0), hi.toFixed(0));
for (const mode of ['natural', 'zones', 'fuel', 'age'] as const) writePNG(`${out}/${seed}-${mode}.png`, w.W, w.H, mapImage(w, mode), 3);
let alpine = 0, forest = 0, land = 0;
for (let i = 0; i < w.N; i++) { if (w.L.water[i]) continue; land++; if (w.L.elev[i] > 2850) alpine++; if (w.L.aspen[i] + w.L.pine[i] + w.L.fir[i] > 0.3) forest++; }
console.log(`alpine ${(100*alpine/land).toFixed(1)}%  forest ${(100*forest/land).toFixed(1)}%`);
