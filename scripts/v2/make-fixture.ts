/**
 * Write a save file with the code of another source tree, for the save-compatibility tests:
 *
 *   FW_ROOT=<1.1.1 checkout> node scripts/v2/make-fixture.ts tests/fixtures/v1.1.1-tinderbox-y4.fireweed.gz
 *
 * A small Tinderbox valley played passively into its fourth year and saved on an afternoon with a
 * wildfire burning, so that loading it exercises everything a 2.0 load has to rebuild (understory,
 * flame lengths of burning cells, exposure, defaults of new state).
 */
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { loadSim, ROOT } from './lib.ts';

const out = process.argv[2];
if (!out) throw new Error('usage: make-fixture.ts <out.fireweed.gz>');
const S = await loadSim();
const save = await import(ROOT + '/src/sim/save.ts');
// (a valley smaller than the game offers keeps the fixture under a megabyte)
const w = S.generateWorld(S.makeConfig('tinderbox', 'fixture-111', 'small', { width: 120, height: 84 }));
const sim = new S.Simulation(w, {}, { autoReview: true });
sim.runDays(360 * 3 + 60);
let caught = false;
for (let t = 0; t < 8 * 360 * 3 && !caught; t++) {
  if (w.review.pending) S.autoCloseReview(w, false);
  sim.tick();
  if (w.burning.length >= 3 && w.sub >= 4 && w.sub <= 6 && w.fires.some((f: any) => f.active && f.cause !== 'prescribed')) caught = true;
}
const bytes = save.encodeWorld(w);
writeFileSync(out, gzipSync(bytes, { level: 9 }));
console.log(`${ROOT}: saved day ${w.day} (year ${w.year}), sub ${w.sub}, ${w.burning.length} cells burning, ${w.fires.filter((f: any) => f.active).length} active fires, save version ${save.SAVE_VERSION}, ${bytes.length} bytes -> ${out}`);
