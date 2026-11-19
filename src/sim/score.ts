/**
 * Legacy evaluation at the end of a tenure (or a dismissal): a 0–100 score
 * from community safety, ecological integrity, watershed health, finances
 * and political trust, with a generated epilogue drawn from the chronicle.
 */
import { clamp01 } from './grid.ts';
import type { World, GameOutcome } from './world.ts';
import { vegetationSummary } from './systems/vegetation.ts';
import { deerCount } from './systems/wildlife.ts';

export const GRADES: Array<[number, string, string]> = [
  [85, 'S', 'Legend of the Valley'],
  [72, 'A', 'Steward of the Long Fire'],
  [60, 'B', 'Trusted Warden'],
  [45, 'C', 'Weathered Warden'],
  [30, 'D', 'Firefighter, Not a Forester'],
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
  const regime = 8 * clamp01((lowShare - 0.4) / 0.5);
  const startHz = m.startHazard ?? v.hazard;
  const resilience = 7 * clamp01(0.5 + (startHz - v.hazard) * 4);
  const deer = deerCount(w);
  const wildlife =
    (w.packs.length > 0 ? 4 : 0) + Math.min(3, w.colonies.filter((c) => c.active).length * 0.75) + (deer > 250 && deer < 1300 ? 2 : 0);
  const diversity = 6 * clamp01(shannon([v.grass, v.shrub, v.aspen, v.pine, v.fir]) * 1.15);
  breakdown.push(['Fire doing its work', regime, `${burned.toLocaleString()} ha burned, ${Math.round(100 * (1 - lowShare))}% at high severity`]);
  breakdown.push(['A resilient forest', resilience, `fuel hazard ${(startHz * 100).toFixed(0)} → ${(v.hazard * 100).toFixed(0)}`]);
  breakdown.push(['Wild things', wildlife, `${w.packs.length} wolf packs, ${w.colonies.filter((c) => c.active).length} beaver colonies, ${deer} deer`]);
  breakdown.push(['A diverse landscape', diversity, `aspen ${(v.aspen * 100).toFixed(1)}%, pine ${(v.pine * 100).toFixed(0)}%, fir ${(v.fir * 100).toFixed(0)}% cover`]);

  // watershed (10)
  const water = 5 * clamp01(1 - w.reservoirSilt * 2.5) + 5 * clamp01(1 - (w.stats.burnedHigh.reduce((a, b) => a + b, 0) / Math.max(1, v.land)) * 1.5);
  breakdown.push(['Clean water', water, `reservoir ${(w.reservoirSilt * 100).toFixed(0)}% silted, ${w.counters.debrisFlows} debris flows`]);

  // finances (10)
  const fin = 6 * (w.economy.funds >= 0 ? 1 : clamp01(1 + w.economy.funds / 600000)) + 4 * (w.economy.millOpen ? 1 : 0.3);
  breakdown.push(['Sound finances', fin, `ending balance $${Math.round(w.economy.funds / 1000)}k${w.economy.millOpen ? '' : '; the mill closed'}`]);

  // trust (25 weighted by time served)
  const avgTrust = m.trustYears ? (m.trustSum ?? 0) / m.trustYears : w.trust;
  const served = clamp01(years / w.config.tenureYears);
  const trust = 25 * (avgTrust / 100) * (reason === 'tenure' ? 1 : 0.6 + 0.4 * served);
  breakdown.push(['The council’s trust', trust, `average trust ${avgTrust.toFixed(0)}`]);

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

function epilogue(w: World, reason: string, years: number, v: ReturnType<typeof vegetationSummary>): string[] {
  const out: string[] = [];
  const name = w.valleyName;
  if (reason === 'tenure') out.push(`You served ${years} years as warden of ${name}, and handed the keys to your successor on your own terms.`);
  else if (reason === 'bankrupt') out.push(`After ${years} years the council placed the Stewardship Service in receivership. The ledgers did not survive you.`);
  else out.push(`After ${years} years the council voted to dismiss you. The valley will remember some of it fondly.`);
  const fires = w.fires.filter((f) => !f.active && f.cause !== 'prescribed').sort((a, b) => b.area - a.area);
  if (fires.length) {
    const big = fires[0];
    out.push(
      `${w.fires.filter((f) => f.cause !== 'prescribed').length} wildfires burned on your watch. The largest, the ${big.name} of year ${Math.floor(big.startDay / 360) + 1}, covered ${big.area.toLocaleString()} ha${big.structuresLost ? ` and took ${big.structuresLost} homes` : ''}.`,
    );
  }
  if (w.counters.totalRx > 0) out.push(`Your crews lit ${w.counters.totalRx.toLocaleString()} ha of prescribed fire${w.counters.yearEscapes ? ', not all of it according to plan' : ''}.`);
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
