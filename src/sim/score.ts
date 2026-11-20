/**
 * Legacy evaluation at the end of a tenure (or a dismissal): a 0–100 score
 * from community safety, ecological integrity, watershed health, finances
 * and political trust, with a generated epilogue drawn from the chronicle.
 */
import { clamp01 } from './grid.ts';
import type { World, GameOutcome } from './world.ts';
import { vegetationSummary } from './systems/vegetation.ts';
import { deerCount } from './systems/wildlife.ts';
import { hazardIndex } from './systems/fuels.ts';
import { distanceField } from './gen/settle.ts';
import { objectives } from './objectives.ts';

/** Mean fuel hazard of the land within 5 cells of standing homes (0–1). */
export function homeHazard(w: World): number {
  const L = w.L;
  const d = distanceField(w, (i) => L.town[i] > 0, 6);
  let sum = 0,
    n = 0;
  for (let i = 0; i < w.N; i++) {
    if (d[i] === 0 || d[i] > 5 || L.water[i] || L.town[i]) continue;
    sum += hazardIndex(w, i);
    n++;
  }
  return n ? sum / n : 0;
}

/** Share of monthly samples meeting a condition (or the fallback when there are none). */
function shareOf(xs: number[], ok: (x: number) => boolean, fallback: number): number {
  if (!xs.length) return fallback;
  let k = 0;
  for (const x of xs) if (ok(x)) k++;
  return k / xs.length;
}

/**
 * Grade bands, re-based in v1.1 on strategy bots (scripts/strategies.ts, 6 paired seeds each):
 * doing nothing and refusing every petition averages 74 (Tinderbox, 25 y, and First Season, 30 y)
 * — an A on v1.0's bands — and now earns a C; active stewardship averages 88 and 83.
 */
export const GRADES: Array<[number, string, string]> = [
  [90, 'S', 'Legend of the Valley'],
  [83, 'A', 'Steward of the Long Fire'],
  [76, 'B', 'Trusted Warden'],
  [64, 'C', 'Weathered Warden'],
  [50, 'D', 'Firefighter, Not a Forester'],
  [0, 'E', 'A Cautionary Tale'],
];

function shannon(parts: number[]): number {
  const tot = parts.reduce((a, b) => a + b, 0);
  if (tot <= 0) return 0;
  let h = 0;
  for (const p of parts) if (p > 0) h -= (p / tot) * Math.log(p / tot);
  return h / Math.log(parts.length);
}

export function evaluateLegacy(w: World, reason: 'tenure' | 'dismissed' | 'bankrupt'): GameOutcome {
  const m = w.memory;
  const v = vegetationSummary(w);
  const years = Math.max(1, Math.floor(w.yearsElapsed));
  const totalStructures = w.towns.reduce((a, t) => a + t.structures + t.lostStructures, 0);
  const lost = w.counters.totalStructuresLost;
  const breakdown: Array<[string, number, string]> = [];

  // community (25)
  const safety = 15 * (1 - Math.min(1, lost / Math.max(10, 0.15 * totalStructures)));
  const popStart = m.startPopulation ?? w.population;
  const growth = 5 * clamp01((w.population / popStart - 0.9) / 0.3);
  const avgSmoke = w.stats.smokeDays.length ? w.stats.smokeDays.reduce((a, b) => a + b, 0) / w.stats.smokeDays.length : 0;
  const smoke = 5 * clamp01(1 - avgSmoke / 40);
  breakdown.push(['Homes kept safe', safety, `${lost} homes lost over ${years} years`]);
  breakdown.push(['A living community', growth + smoke, `population ${popStart.toLocaleString()} → ${w.population.toLocaleString()}; ${avgSmoke.toFixed(0)} smoke days/yr`]);

  // ecology (30)
  const burned = w.counters.totalBurned;
  const severe = w.counters.totalHighSeverity;
  const lowShare = burned > 200 ? 1 - severe / burned : 0.6;
  // fire doing its work needs both quality (mostly low and moderate severity) and quantity. v1.0
  // scored quality alone, so excluding fire altogether earned full marks. 1 %/yr of the valley in
  // good fire (wild or prescribed) is a deliberately lenient bar: historical rotations of 5–30 years
  // in dry pine and 20–60 in mixed conifer imply more
  const goodRate = (burned - severe) / years / Math.max(1, v.land);
  const regime = 8 * clamp01(goodRate / 0.01) * clamp01((lowShare - 0.4) / 0.5);
  // v1.0 scored the change in the valley-wide fuel index, which the player barely moves; what
  // protective work changes is the fuel next to homes
  // v2: scored on what a design-day fire would do to the homes (the fireshed's exposure), which is
  // what thinning, burning and hardening around the towns actually change. Leaving it as found
  // earns a third; halving it earns it all. (v1.1 scored the fuel index within 500 m of homes.)
  const ex = m.exposure;
  const startEx = ex?.start ?? 0,
    endEx = ex?.now ?? startEx;
  const resilience = 7 * clamp01(0.33 + (startEx > 0.01 ? ((startEx - endEx) / startEx) * 1.34 : 0.67));
  const deer = deerCount(w);
  // a healthy herd: 1–10 deer per km² (map-size independent) in fair condition. v1.0 used a fixed
  // 250–1,300 deer, i.e. 24 % of carrying capacity on large maps and 65 % on small ones (D15)
  const km2 = v.land / 100;
  let condSum = 0;
  for (const h of w.herds) condSum += h.cond * h.n;
  const density = deer / Math.max(1, km2);
  const cond = deer ? condSum / deer : 0;
  // wildlife is scored over the whole tenure, not on the last day: in v1.0 a wolf release granted at
  // the final review earned the full wolf credit
  const st = w.stats;
  const wolfShare = shareOf(st.wolves, (x) => x > 0, w.packs.length > 0 ? 1 : 0);
  const beaverMean = st.beavers.length ? st.beavers.reduce((a, b) => a + b, 0) / st.beavers.length : w.colonies.filter((c) => c.active).length;
  const herdShare = shareOf(st.deer, (x) => x / Math.max(1, km2) >= 1 && x / Math.max(1, km2) <= 10, density >= 1 && density <= 10 ? 1 : 0);
  const herd = 2 * herdShare * (cond >= 0.45 ? 1 : 0.5);
  const wildlife = 4 * wolfShare + Math.min(3, beaverMean * 0.75) + herd;
  // old growth kept (or grown) since the tenure began
  const og0 = st.oldGrowth[0] ?? v.oldGrowth;
  const ogKept = og0 > 0 ? clamp01(v.oldGrowth / og0) : 1;
  const diversity = 4 * clamp01(shannon([v.grass, v.shrub, v.aspen, v.pine, v.fir]) * 1.15) + 2 * ogKept;
  breakdown.push([
    'Fire doing its work',
    regime,
    `${burned.toLocaleString()} ha burned (${(goodRate * 100).toFixed(2)}% of the valley a year in good fire), ${Math.round(100 * (1 - lowShare))}% at high severity`,
  ]);
  breakdown.push(['Safer around homes', resilience, `homes a bad fire day would take ${(startEx * 100).toFixed(0)} % → ${(endEx * 100).toFixed(0)} %`]);
  breakdown.push([
    'Wild things',
    wildlife,
    `wolves present ${Math.round(wolfShare * 100)}% of the time, ${beaverMean.toFixed(1)} beaver colonies on average, ${deer} deer now (${density.toFixed(1)}/km²${herd >= 2 ? ', healthy' : ''})`,
  ]);
  breakdown.push(['A diverse landscape', diversity, `aspen ${(v.aspen * 100).toFixed(1)}%, pine ${(v.pine * 100).toFixed(0)}%, fir ${(v.fir * 100).toFixed(0)}% cover; old growth ${og0.toLocaleString()} → ${v.oldGrowth.toLocaleString()} ha`]);

  // watershed (10): the reservoir is judged on its average state over the tenure
  const meanSilt = m.siltYears ? (m.siltSum ?? 0) / m.siltYears : w.reservoirSilt;
  const water = 5 * clamp01(1 - meanSilt * 2.5) + 5 * clamp01(1 - (w.stats.burnedHigh.reduce((a, b) => a + b, 0) / Math.max(1, v.land)) * 1.5);
  breakdown.push(['Clean water', water, `reservoir ${(meanSilt * 100).toFixed(0)}% silted on average (${(w.reservoirSilt * 100).toFixed(0)}% now), ${w.counters.debrisFlows} debris flows`]);

  // finances (10): stay out of debt and keep the mill alive. v1.0 also paid 3 points for spending
  // the allocation, which rewarded spending for its own sake
  const returned = m.returnedTotal ?? 0;
  const fin = 6 * (w.economy.funds >= 0 ? 1 : clamp01(1 + w.economy.funds / 600000)) + 4 * (w.economy.millOpen ? 1 : 0.3);
  const finNote = `ending balance ${Math.round(w.economy.funds / 1000)}k; ${Math.round(returned / 1000)}k returned unspent`;
  breakdown.push(['Sound finances', fin, '$' + finNote.replace('; ', '; $') + (w.economy.millOpen ? '' : '; the mill closed')]);

  // trust (16 weighted by time served), counted from a baseline of indifference (~38) to enthusiasm (80)
  const avgTrust = m.trustYears ? (m.trustSum ?? 0) / m.trustYears : w.trust;
  const served = clamp01(years / w.config.tenureYears);
  const trust = 16 * clamp01((avgTrust - 38) / 42) * (reason === 'tenure' ? 1 : 0.6 + 0.4 * served);
  breakdown.push(['The council’s trust', trust, `average trust ${avgTrust.toFixed(0)}`]);

  // the council's charge (9): what this valley asked of its warden in particular (v2; v1.x gave
  // every scenario the same goal). Three points for each charge met.
  const charges = objectives(w);
  const metNow = charges.filter((o) => (o.kind === 'reach' ? o.progress >= 1 : o.state !== 'failed' && o.state !== 'behind'));
  breakdown.push(['The council’s charge', 3 * metNow.length * (reason === 'tenure' ? 1 : served), charges.map((o) => `${metNow.includes(o) ? '✓' : '✗'} ${o.title}`).join(' · ')]);

  let score = breakdown.reduce((a, b) => a + b[1], 0);
  if (reason !== 'tenure') score *= 0.55 + 0.45 * served;
  score = Math.round(Math.max(0, Math.min(100, score)));
  const g = GRADES.find(([t]) => score >= t)!;

  return {
    ended: true,
    reason,
    year: w.year - 1,
    score,
    grade: `${g[1]} — ${g[2]}`,
    breakdown: breakdown.map(([a, b, c]) => [a, Math.round(b * 10) / 10, c]),
    epilogue: epilogue(w, reason, years, v),
  };
}

/** Wildfire count and largest fire of the tenure, exact even after saves trimmed old fire records. */
export function wildfireFacts(w: World): { count: number; largest: { name: string; area: number; startDay: number; structuresLost: number } | null } {
  const wild = w.fires.filter((f) => f.cause !== 'prescribed' && f.cause !== 'pile');
  const finished = wild.filter((f) => !f.active);
  const active = wild.length - finished.length;
  // saves from v1.0 have no running totals: fall back to what the (possibly trimmed) list holds
  const count = Math.max(w.memory.wildfireCount ?? 0, finished.length) + active;
  let largest = w.memory.largestWildfire ?? null;
  for (const f of finished) if (!largest || f.area > largest.area) largest = { name: f.name, area: f.area, startDay: f.startDay, structuresLost: f.structuresLost };
  return { count, largest };
}

function epilogue(w: World, reason: string, years: number, v: ReturnType<typeof vegetationSummary>): string[] {
  const out: string[] = [];
  const name = w.valleyName;
  if (reason === 'tenure') out.push(`You served ${years} years as warden of ${name}, and handed the keys to your successor on your own terms.`);
  else if (reason === 'bankrupt') out.push(`After ${years} years the council placed the Stewardship Service in receivership. The ledgers did not survive you.`);
  else out.push(`After ${years} years the council voted to dismiss you. The valley will remember some of it fondly.`);
  const { count, largest } = wildfireFacts(w);
  if (largest) {
    out.push(
      `${count} wildfires burned on your watch. The largest, the ${largest.name} of year ${Math.floor(largest.startDay / 360) + 1}, covered ${largest.area.toLocaleString()} ha${largest.structuresLost ? ` and took ${largest.structuresLost} homes` : ''}.`,
    );
  }
  // v1.0 read this year's escape counter after it had been reset, so escapes were never mentioned (D16)
  const escapes = w.memory.totalEscapes ?? 0;
  if (w.counters.totalRx > 0) out.push(`Your crews lit ${w.counters.totalRx.toLocaleString()} ha of prescribed fire${escapes ? `, and ${escapes === 1 ? 'one burn' : `${escapes} burns`} got away` : ''}.`);
  if (w.packs.length) out.push(`${w.packs.length} wolf pack${w.packs.length > 1 ? 's' : ''} — ${w.packs.map((p) => `the ${p.name}`).join(', ')} — still ${w.packs.length > 1 ? 'roam' : 'roams'} the valley.`);
  else out.push('No wolves remain in the valley.');
  const beavers = w.colonies.filter((c) => c.active).length;
  if (beavers) out.push(`${beavers} beaver ${beavers > 1 ? 'colonies keep' : 'colony keeps'} the creeks slow and green.`);
  out.push(
    `Aspen covers ${(v.aspen * 100).toFixed(1)}% of the land, pine ${(v.pine * 100).toFixed(0)}%, fir ${(v.fir * 100).toFixed(0)}%; ${v.oldGrowth.toLocaleString()} ha of old growth stand.`,
  );
  if (!w.economy.millOpen) out.push('The sawmill closed during your tenure.');
  const notable = w.chronicle.filter((c) => c.importance >= 3).slice(-3);
  for (const c of notable) out.push(`Year ${Math.floor(c.day / 360) + 1}: ${c.text}`);
  return out;
}
