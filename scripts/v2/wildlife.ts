/**
 * Deer, wolves and beavers over the long run: densities every few years, so a change to the wildlife
 * rules can be compared with what went before (FW_ROOT picks the source tree, as in the other harnesses).
 *
 *   node scripts/v2/wildlife.ts <scenario> <seed> [years] [hunting]
 *   FW_ROOT=<1.1.1 checkout> node scripts/v2/wildlife.ts tinderbox wl-1 80
 */
import { loadSim, ROOT } from './lib.ts';

const scen = process.argv[2] ?? 'tinderbox';
const seed = process.argv[3] ?? 'wl-1';
const years = Number(process.argv[4] ?? 60);
const hunting = process.argv[5];
const S = await loadSim();
const wild = await import(ROOT + '/src/sim/systems/wildlife.ts');
const w = S.generateWorld(S.makeConfig(scen, seed));
w.config.tenureYears = years + 5;
if (hunting) w.policies.hunting = hunting;
const sim = new S.Simulation(w, {}, { autoReview: true });
let land = 0;
for (let i = 0; i < w.N; i++) if (w.L.water[i] < 2) land++;
const km2 = land / 100;
const rows: string[] = [];
let wolfYears = 0,
  lost = 0,
  formed = 0;
sim.hooks.onPackLost = () => lost++;
sim.hooks.onPackFormed = () => formed++;
let hunted = 0,
  revenue = 0;
for (let y = 1; y <= years; y++) {
  sim.runDays(360);
  if (w.outcome.ended) break;
  if (w.packs.length) wolfYears++;
  const led = w.economy.history?.at(-1);
  if (led) revenue += led.income['Hunting licenses'] ?? 0;
  hunted += w.stats ? 0 : 0;
  if (y % 5 === 0 || y === 1) {
    const deer = wild.deerCount(w);
    let cond = 0;
    for (const h of w.herds) cond += h.cond * h.n;
    let browse = 0,
      n = 0;
    for (let i = 0; i < w.N; i += 7) {
      if (w.L.water[i] >= 2) continue;
      browse += w.L.browse[i];
      n++;
    }
    rows.push(
      `  y${String(y).padStart(3)}  deer ${String(deer).padStart(6)} (${(deer / km2).toFixed(1).padStart(5)}/km², ${w.herds.length} herds, condition ${(deer ? cond / deer : 0).toFixed(2)})  wolves ${String(wild.wolfCount(w)).padStart(3)} in ${w.packs.length} packs  beavers ${String(w.colonies.filter((c: any) => c.active).length).padStart(3)}  mean browse ${(browse / n).toFixed(3)}`,
    );
  }
}
console.log(`${ROOT.split('/').pop()} ${scen} ${seed} hunting=${w.policies.hunting}: wolves present ${wolfYears}/${years} years, ${formed} packs formed, ${lost} lost; hunting licences $${Math.round(revenue / years / 1000)}k/yr`);
console.log(rows.join('\n'));
