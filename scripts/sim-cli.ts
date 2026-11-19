/**
 * Headless simulation runner for balancing:
 *   node scripts/sim-cli.ts --seed s --scenario tinderbox --years 50 [--png dir] [--strategy none]
 */
import { generateWorld } from '../src/sim/gen/index.ts';
import { makeConfig } from '../src/sim/scenarios.ts';
import type { ScenarioId } from '../src/sim/world.ts';
import { Simulation } from '../src/sim/sim.ts';
import { vegetationSummary } from '../src/sim/systems/vegetation.ts';
import { writePNG } from './lib/png.ts';
import { mapImage } from './lib/mapimage.ts';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const seed = opt('seed', 'cedar-otter-77');
const scen = opt('scenario', 'tinderbox') as ScenarioId;
const years = Number(opt('years', '30'));
const png = opt('png', '');
const noFire = args.includes('--nofire');
if (png) mkdirSync(png, { recursive: true });

const t0 = performance.now();
const w = generateWorld(makeConfig(scen, seed));
const sim = new Simulation(w, {
  onEnd: (fe) => {
    if (fe.area >= 30 && !args.includes('--quiet')) console.log(`   y${w.year} d${w.doy} ${fe.name} (${fe.cause}) ${fe.area} ha, crown ${fe.crownArea}, high ${fe.highSeverity}, structures ${fe.structuresLost}, ${fe.outDay - fe.startDay} days`);
  },
}, { ignitions: !noFire, autoReview: true });
const s0 = vegetationSummary(w);
console.log(`gen ${(performance.now() - t0).toFixed(0)}ms`, fmt(s0));
const t1 = performance.now();
for (let y = 0; y < years; y++) {
  sim.runDays(360);
  const s = vegetationSummary(w);
  const k = w.stats.burned.length - 1;
  if (args.includes('--econ')) console.log(econLine());
  console.log(
    `Y${String(w.year - 1).padStart(2)} wet ${w.climate.yearWet.toFixed(2)} T${w.climate.yearTemp >= 0 ? '+' : ''}${w.climate.yearTemp.toFixed(1)} P ${w.stats.precip[k]}mm  burned ${String(w.stats.burned[k]).padStart(5)} (high ${String(w.stats.burnedHigh[k]).padStart(4)}) fires ${w.fires.filter((f) => Math.floor(f.startDay / 360) === w.year - 2).length}  ${fmt(s)}`,
  );
  if (png && (y % 10 === 9 || y === years - 1)) writePNG(`${png}/${seed}-y${w.year - 1}.png`, w.W, w.H, mapImage(w, 'natural'), 3);
}
console.log(`sim ${years}y in ${((performance.now() - t1) / 1000).toFixed(1)}s`);

function econLine(): string {
  const ap = (f: 'residents' | 'timber' | 'ranchers' | 'conservation' | 'tourism') => Math.round(w.factions[f].approval);
  const deer = w.herds.reduce((a, h) => a + h.n, 0);
  const wolves = w.packs.reduce((a, p) => a + p.n, 0);
  const parts = [
    `   $${Math.round(w.economy.funds / 1000)}k`,
    `trust ${w.trust.toFixed(0)} [R${ap('residents')} T${ap('timber')} Ra${ap('ranchers')} C${ap('conservation')} Tu${ap('tourism')}]`,
    `pop ${w.population}`,
    `deer ${deer} wolves ${wolves}/${w.packs.length} beavers ${w.colonies.filter((c) => c.active).length}`,
    `beetle ${w.stats.beetle.at(-1)} res ${(w.reservoirLevel * 100).toFixed(0)}% silt ${(w.reservoirSilt * 100).toFixed(1)}%`,
    `harvest ${w.stats.harvest.at(-1)} visitors ${w.stats.visitors.at(-1)} mill ${w.economy.millOpen ? 'open' : 'CLOSED'}`,
    `notes ${Object.keys(w.discoveries).length} verdict ${w.review.verdict}`,
  ];
  return parts.join(' ');
}

function fmt(s: ReturnType<typeof vegetationSummary>): string {
  return `can ${(s.aspen + s.pine + s.fir).toFixed(2)} forest ${(s.forestFrac * 100).toFixed(0)}% old ${s.oldGrowth} G${s.grass.toFixed(2)} S${s.shrub.toFixed(2)} A${s.aspen.toFixed(3)} P${s.pine.toFixed(3)} F${s.fir.toFixed(3)} hz${s.hazard.toFixed(2)}`;
}
