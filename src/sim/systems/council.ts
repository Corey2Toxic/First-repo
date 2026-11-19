/**
 * Politics: five constituencies whose approval drifts toward targets computed
 * from the state of the valley, plus sudden shocks from events. Once a year
 * the council reviews the warden: it reports, hears petitions that arise from
 * real grievances, sets next year's budget — and can dismiss you.
 */
import { clamp, clamp01 } from '../grid.ts';
import { FACTIONS, FACTION_NAMES, ZONE } from '../types.ts';
import type { FactionId, LedgerYear, Petition, PetitionAction } from '../types.ts';
import { bestCampSite, buildCampground, campSiteValid, econCache, ledgerTotals } from './economy.ts';
import { vegetationSummary } from './vegetation.ts';
import { createProject } from './projects.ts';
import { hazardIndex } from './fuels.ts';
import { dredge } from './hydrology.ts';
import { COST } from '../economyParams.ts';
import { NameBank } from '../gen/names.ts';
import { distanceField, timberExpansionCells } from '../gen/settle.ts';
import { evaluateLegacy } from '../score.ts';
import type { Command, CommandResult } from '../commands.ts';
import type { World } from '../world.ts';

export function shock(w: World, f: FactionId, delta: number, reason?: string): void {
  const s = w.factions[f];
  s.approval = clamp(s.approval + delta, 0, 100);
  if (reason) {
    s.factors.unshift([reason, delta]);
    if (s.factors.length > 6) s.factors.length = 6;
  }
}

/** Monthly drift of approval toward state-driven targets. */
export function councilMonthly(w: World): void {
  const m = w.memory;
  const e = w.economy;
  const c = econCache(w);
  let land = 0;
  for (let i = 0; i < w.N; i += 4) if (!w.L.water[i]) land++;
  land *= 4;
  if (m.oldGrowthStart === undefined) {
    m.oldGrowthStart = vegetationSummary(w).oldGrowth;
    m.visitorsBase = 0;
    m.rangeStart = c.rangeCells;
  }
  m.recentLoss = (m.recentLoss ?? 0) * 0.9;
  m.recentDepredations = (m.recentDepredations ?? 0) * 0.85;
  m.recentEscapes = (m.recentEscapes ?? 0) * 0.88;
  m.recentWolfKills = (m.recentWolfKills ?? 0) * 0.9;
  if (w.doy % 90 === 0) m.ogNow = vegetationSummary(w).oldGrowth;
  const ogTrend = m.oldGrowthStart ? (m.ogNow ?? m.oldGrowthStart) / Math.max(1, m.oldGrowthStart) - 1 : 0;
  const debt = e.funds < 0 ? Math.min(15, (-e.funds / 200000) * 4) : 0;
  const smokeDays = w.counters.yearSmokeDays + (m.lastYearSmoke ?? 0) * 0.4;

  const T: Record<FactionId, Array<[string, number]>> = {
    residents: [],
    timber: [],
    ranchers: [],
    conservation: [],
    tourism: [],
  };
  // residents
  T.residents.push(['Baseline', 58]);
  if (m.recentLoss > 0.5) T.residents.push(['Homes lost to fire', -Math.min(38, m.recentLoss * 2.6)]);
  if (m.nearTownFireDays > 0) T.residents.push(['Fires near town', -Math.min(10, m.nearTownFireDays * 0.6)]);
  if (smokeDays > 2) T.residents.push(['Smoky days', -Math.min(14, smokeDays * 0.45)]);
  if (w.counters.yearWaterShortDays > 0) T.residents.push(['Water shortages', -Math.min(14, w.counters.yearWaterShortDays * 0.4)]);
  if (w.reservoirTurbidity > 0.2) T.residents.push(['Muddy tap water', -8 * w.reservoirTurbidity]);
  const jobs = (e.millOpen ? 4 : -8) + Math.min(6, e.visitorsLastYear / 25000);
  T.residents.push(['Local jobs', jobs]);
  if (w.policies.buildingCode === 'firewise') {
    const yrs = (w.day - (m.codeAdoptedDay ?? -9999)) / 360;
    T.residents.push(yrs < 3 ? ['Firewise retrofit costs', -5] : ['Feeling fire-safe', 3]);
  }
  const fw = w.towns.length ? w.towns.reduce((s, t) => s + t.firewise, 0) / w.towns.length : 0;
  if (fw > 0.45) T.residents.push(['Protected surroundings', (fw - 0.45) * 14]);
  if (debt) T.residents.push(['Service in debt', -debt]);
  // timber
  const ratio = e.millOpen ? (e.harvestLastYear || e.millDemand * 0.8) / e.millDemand : 0;
  T.timber.push(['Baseline', 50]);
  if (!e.millOpen) T.timber.push(['The mill has closed', -32]);
  else T.timber.push(['Harvest vs. mill demand', clamp((ratio - 0.85) * 45, -30, 18)]);
  if (w.counters.yearTreated > 20) T.timber.push(['Thinning contracts', Math.min(6, w.counters.yearTreated / 25)]);
  if (w.policies.salvage) T.timber.push(['Salvage logging', 5]);
  if (w.policies.harvestMethod === 'clearcut') T.timber.push(['Clearcutting allowed', 4]);
  const timberShare = c.timberCells / Math.max(1, land);
  T.timber.push(['Timber land base', clamp((timberShare - 0.08) * 80, -10, 8)]);
  // ranchers
  T.ranchers.push(['Baseline', 54]);
  T.ranchers.push(['Grazing permits', w.policies.grazing === 'none' ? -30 : w.policies.grazing === 'heavy' ? 9 : 0]);
  const rangeRatio = c.rangeCells / Math.max(1, m.rangeStart ?? c.rangeCells);
  if (Math.abs(rangeRatio - 1) > 0.05) T.ranchers.push(['Rangeland area', clamp((rangeRatio - 1) * 30, -18, 10)]);
  if (m.recentDepredations > 0.3) T.ranchers.push(['Wolves taking livestock', -Math.min(25, m.recentDepredations * 6)]);
  T.ranchers.push(['Wolf policy', w.policies.wolfPolicy === 'protected' ? -9 : w.policies.wolfPolicy === 'bounty' ? 8 : 0]);
  if (w.policies.hunting === 'heavy') T.ranchers.push(['Generous hunting', 3]);
  // conservation
  const wildShare = c.wildernessCells / Math.max(1, land);
  T.conservation.push(['Baseline', 46]);
  T.conservation.push(['Protected wilderness', Math.min(18, wildShare * 70)]);
  const wolves = w.packs.length;
  T.conservation.push(['Wolves in the valley', wolves === 0 ? -8 : Math.min(12, 5 + wolves * 2.5)]);
  const beavers = w.colonies.filter((k) => k.active).length;
  if (beavers > 0) T.conservation.push(['Beaver wetlands', Math.min(7, beavers * 1.2)]);
  T.conservation.push(['Old-growth trend', clamp(ogTrend * 40, -15, 8)]);
  const hiShare = recentHighSeverityShare(w);
  if (hiShare !== null) T.conservation.push(['Fire severity', clamp((0.35 - hiShare) * 22, -10, 6)]);
  if (w.policies.harvestMethod === 'clearcut') T.conservation.push(['Clearcutting', -10]);
  if (w.policies.salvage) T.conservation.push(['Salvage logging', -7]);
  if (w.policies.wolfPolicy === 'bounty') T.conservation.push(['Wolf bounty', -18]);
  if (m.recentWolfKills > 0.5) T.conservation.push(['Wolves killed', -Math.min(12, m.recentWolfKills * 3)]);
  if (w.policies.grazing === 'heavy') T.conservation.push(['Heavy grazing', -5]);
  if ((m.roadsBuilt ?? 0) > 20) T.conservation.push(['New roads', -Math.min(8, (m.roadsBuilt ?? 0) / 30)]);
  // tourism
  T.tourism.push(['Baseline', 52]);
  if (!m.visitorsBase && e.visitorsLastYear > 0) m.visitorsBase = e.visitorsLastYear;
  if (m.visitorsBase) T.tourism.push(['Visitor numbers', clamp((e.visitorsLastYear / m.visitorsBase - 1) * 40, -20, 15)]);
  T.tourism.push(['Scenery', clamp(((m.scenic ?? 0.5) - 0.5) * 30, -12, 10)]);
  if (smokeDays > 2) T.tourism.push(['Smoke', -Math.min(14, smokeDays * 0.5)]);
  if (w.counters.yearClosedDays > 0) T.tourism.push(['Fire closures', -Math.min(10, w.counters.yearClosedDays * 0.25)]);
  if (w.policies.fireBan === 'summer') T.tourism.push(['Summer-long fire ban', -6]);
  T.tourism.push(['Campgrounds', Math.min(8, w.camps.length * 2.5)]);
  if (wolves > 0) T.tourism.push(['Wolf watching', 3]);

  for (const f of FACTIONS) {
    const s = w.factions[f];
    const target = clamp(T[f].reduce((a, [, v]) => a + v, 0), 2, 98);
    s.target = target;
    s.approval += (target - s.approval) * 0.14;
    s.approval = clamp(s.approval, 0, 100);
    s.factors = T[f]
      .filter(([k]) => k !== 'Baseline')
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 6);
  }
  m.nearTownFireDays *= 0.7;
}

function recentHighSeverityShare(w: World): number | null {
  const n = w.stats.burned.length;
  let tot = 0,
    hi = 0;
  for (let k = Math.max(0, n - 6); k < n; k++) {
    tot += w.stats.burned[k];
    hi += w.stats.burnedHigh[k];
  }
  tot += w.counters.yearBurned;
  hi += w.counters.yearBurnedHigh;
  if (tot < 60) return null;
  return hi / tot;
}

// ------------------------------------------------------------ petitions
interface PetitionTemplate {
  key: string;
  faction: FactionId;
  when: (w: World) => number; // urgency 0..1 (0 = not applicable)
  make: (w: World) => Omit<Petition, 'id' | 'faction'>;
}

function remoteUnzoned(w: World): number[] {
  const L = w.L;
  const near = distanceField(w, (i) => L.town[i] !== 0 || (L.infra[i] & 1) !== 0, 30);
  const out: number[] = [];
  for (let i = 0; i < w.N; i++) if (L.zone[i] === ZONE.NONE && !L.water[i] && near[i] >= 12 && L.elev[i] > 1900) out.push(i);
  return out;
}

function townBufferCells(w: World, townId: number): number[] {
  const L = w.L;
  const t = w.towns[townId];
  const tid = townId + 1;
  const out: Array<[number, number]> = [];
  const r = 10 + Math.sqrt(t.structures);
  for (let y = Math.max(0, Math.floor(t.y - r)); y <= Math.min(w.H - 1, Math.ceil(t.y + r)); y++)
    for (let x = Math.max(0, Math.floor(t.x - r)); x <= Math.min(w.W - 1, Math.ceil(t.x + r)); x++) {
      const i = y * w.W + x;
      if (L.town[i] || L.water[i]) continue;
      let near = false;
      for (let dy = -4; dy <= 4 && !near; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (w.inside(xx, yy) && L.town[yy * w.W + xx] === tid) {
            near = true;
            break;
          }
        }
      if (!near) continue;
      const h = hazardIndex(w, i);
      if (h > 0.3) out.push([h, i]);
    }
  out.sort((a, b) => b[0] - a[0]);
  return out.slice(0, 40).map((p) => p[1]);
}

const COMPASS = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'];

/** “near Mirror Lake, 2.4 km northeast of Pinecrest”: where a cell is, in words. */
export function placeName(w: World, i: number): string {
  const x = (i % w.W) + 0.5,
    y = ((i / w.W) | 0) + 0.5;
  let mark = '',
    md = 8;
  for (const m of w.landmarks) {
    if (m.kind === 'town') continue;
    const d = Math.hypot(m.x - x, m.y - y);
    if (d < md) {
      md = d;
      mark = m.name;
    }
  }
  let town = w.towns[0],
    td = Infinity;
  for (const t of w.towns) {
    const d = Math.hypot(t.x - x, t.y - y);
    if (d < td) {
      td = d;
      town = t;
    }
  }
  if (!town) return mark ? `near ${mark}` : 'in the valley';
  const dir = COMPASS[Math.round(Math.atan2(y - town.y, x - town.x) / (Math.PI / 4)) & 7];
  const where = `${(td / 10).toFixed(1)} km ${dir} of ${town.name}`;
  return mark ? `near ${mark}, ${where}` : where;
}

/** Share of last year's would-be visitors turned away for want of room above which tourism asks for a campground. */
export const CAMP_PETITION_SHARE = 0.15;

/** The last harvest ran short because the Timber zone had no more stands ready to cut (not because of the quota). */
function stockLimited(w: World): boolean {
  return !!w.memory.harvestStockLimited;
}

function timberShortfallCells(w: World): number[] {
  const e = w.economy;
  return timberExpansionCells(w, Math.max(0, e.millDemand - e.harvestLastYear), econCache(w).roadDist);
}

const TEMPLATES: PetitionTemplate[] = [
  {
    key: 'raise-harvest',
    faction: 'timber',
    when: (w) => {
      const e = w.economy;
      if (!e.millOpen || e.harvestLastYear >= 0.8 * e.millDemand) return 0;
      // when the stands are exhausted a higher quota only hastens the closure: ask for more forest
      if (stockLimited(w)) return timberShortfallCells(w).length > 0 ? 1 : 0;
      return w.policies.harvest !== 'high' ? 1 : 0;
    },
    make: (w) => {
      const pct = Math.round((100 * w.economy.harvestLastYear) / w.economy.millDemand);
      if (stockLimited(w)) {
        const cells = timberShortfallCells(w);
        return {
          title: 'Open more forest to the mill',
          text: `The mill cut only ${pct}% of its log demand last year: every stand in the Timber zone that is ready to cut has been cut, and a higher quota will not make trees grow faster. Add ${cells.length} ha of roaded forest to the Timber zone or the night shift goes.`,
          action: { type: 'zone', zone: ZONE.TIMBER, cells, label: 'Timber zone expansion' },
          acceptDelta: 12,
          declineDelta: -9,
          sideEffects: [['conservation', -4]],
        };
      }
      return {
        title: 'Keep the mill running',
        text: `The mill cut only ${pct}% of its log demand last year. Raise the harvest quota or the night shift goes.`,
        action: { type: 'policy', key: 'harvest', value: w.policies.harvest === 'low' ? 'medium' : 'high' },
        acceptDelta: 12,
        declineDelta: -9,
        sideEffects: [['conservation', -4]],
      };
    },
  },
  {
    key: 'salvage',
    faction: 'timber',
    when: (w) => (!w.policies.salvage && w.counters.yearBurnedHigh + (w.stats.burnedHigh.at(-1) ?? 0) > 300 ? 0.9 : 0),
    make: () => ({
      title: 'Salvage the burned timber',
      text: 'Thousands of dead trees are worth money for two years before they check and rot. Let crews salvage burned and beetle-killed stands in Timber zones.',
      action: { type: 'policy', key: 'salvage', value: true },
      acceptDelta: 10,
      declineDelta: -6,
      sideEffects: [['conservation', -6]],
    }),
  },
  {
    key: 'cull-wolves',
    faction: 'ranchers',
    when: (w) => ((w.memory.recentDepredations ?? 0) > 1.2 && w.policies.wolfPolicy !== 'bounty' ? 1 : 0),
    make: (w) => ({
      title: w.policies.wolfPolicy === 'protected' ? 'Let us defend our herds' : 'Put a bounty on wolves',
      text: `Wolves killed livestock ${w.counters.yearDepredations} times this year. ${w.policies.wolfPolicy === 'protected' ? 'Allow ranchers to shoot wolves caught in the act.' : 'Pay hunters to thin the packs.'}`,
      action: { type: 'policy', key: 'wolfPolicy', value: w.policies.wolfPolicy === 'protected' ? 'managed' : 'bounty' },
      acceptDelta: 12,
      declineDelta: -10,
      sideEffects: [
        ['conservation', w.policies.wolfPolicy === 'protected' ? -6 : -14],
        ['tourism', -3],
      ],
    }),
  },
  {
    key: 'more-grazing',
    faction: 'ranchers',
    when: (w) => (w.policies.grazing === 'light' && w.factions.ranchers.approval < 50 ? 0.6 : w.policies.grazing === 'none' ? 0.9 : 0),
    make: (w) => ({
      title: 'Open the allotments',
      text: 'Cattle need grass. Raise grazing permits on the Rangeland — it keeps the cheatgrass and fire fuel down, too.',
      action: { type: 'policy', key: 'grazing', value: w.policies.grazing === 'none' ? 'light' : 'heavy' },
      acceptDelta: 10,
      declineDelta: -6,
      sideEffects: [['conservation', -4]],
    }),
  },
  {
    key: 'wilderness',
    faction: 'conservation',
    when: (w) => {
      const c = econCache(w);
      return c.wildernessCells < w.N * 0.12 ? 0.8 : 0;
    },
    make: (w) => {
      const cells = remoteUnzoned(w);
      return {
        title: 'Protect the high country',
        text: `Designate ${cells.length} ha of roadless backcountry as Wilderness: no roads, no logging, and lightning fires left to do their work.`,
        action: { type: 'zone', zone: ZONE.WILDERNESS, cells, label: 'Wilderness designation' },
        acceptDelta: 12,
        declineDelta: -7,
        sideEffects: [
          ['timber', -4],
          ['tourism', 2],
        ],
      };
    },
  },
  {
    key: 'wolves-back',
    faction: 'conservation',
    when: (w) => (w.packs.length === 0 ? 1 : 0),
    make: () => ({
      title: 'Bring back the wolves',
      text: `The deer are eating every aspen sucker and willow shoot. Fund a wolf reintroduction ($${(COST.wolfReintro / 1000).toFixed(0)}k).`,
      action: { type: 'reintroduce-wolves' },
      acceptDelta: 14,
      declineDelta: -6,
      sideEffects: [['ranchers', -10]],
    }),
  },
  {
    key: 'end-clearcuts',
    faction: 'conservation',
    when: (w) => (w.policies.harvestMethod === 'clearcut' ? 0.9 : 0),
    make: () => ({
      title: 'End clearcutting',
      text: 'Clearcuts scar the view, bleed soil into the creeks, and grow back as dense, flammable thickets. Return to selective harvest.',
      action: { type: 'policy', key: 'harvestMethod', value: 'selective' },
      acceptDelta: 10,
      declineDelta: -8,
      sideEffects: [['timber', -6]],
    }),
  },
  {
    key: 'protect-homes',
    faction: 'residents',
    when: (w) => {
      const worst = w.towns.reduce((a, t) => Math.max(a, 1 - t.firewise), 0);
      return worst > 0.6 && (w.memory.nearTownFireDays > 0.5 || (w.memory.recentLoss ?? 0) > 0.5) ? 1 : worst > 0.75 ? 0.5 : 0;
    },
    make: (w) => {
      const t = [...w.towns].sort((a, b) => a.firewise - b.firewise)[0];
      const cells = townBufferCells(w, t.id);
      return {
        title: `Protect ${t.name}`,
        text: `${t.name} sits in dense, flammable forest. Fund thinning of the ${cells.length} most hazardous hectares around town (~$${Math.round((cells.length * COST.thin) / 1000)}k).`,
        action: { type: 'fund', amount: cells.length * COST.thin, label: `Community protection thinning: ${t.name}`, cells } as PetitionAction,
        acceptDelta: 10,
        declineDelta: -9,
        sideEffects: [['timber', 2]],
      };
    },
  },
  {
    key: 'smoke-rules',
    faction: 'residents',
    when: (w) => (!w.policies.smokeRules && (w.memory.rxSmokeDays ?? 0) >= 3 && (w.memory.lastYearSmoke ?? 0) > 6 ? 0.8 : 0),
    make: () => ({
      title: 'No more smoke in our lungs',
      text: 'Your prescribed burns filled the valley with smoke again. Only burn when the air can carry it away.',
      action: { type: 'policy', key: 'smokeRules', value: true },
      acceptDelta: 8,
      declineDelta: -7,
      sideEffects: [['conservation', -2]],
    }),
  },
  {
    key: 'water',
    faction: 'residents',
    when: (w) => (w.reservoirSilt > 0.2 || w.reservoirTurbidity > 0.3 || w.counters.yearWaterShortDays > 10 ? 0.9 : 0),
    make: (w) => ({
      title: 'Clean, reliable water',
      text: `The reservoir has lost ${Math.round(w.reservoirSilt * 100)}% of its capacity to sediment. Fund dredging ($250k).`,
      action: { type: 'fund', amount: 250_000, label: 'Reservoir dredging' },
      acceptDelta: 10,
      declineDelta: -8,
      sideEffects: [],
    }),
  },
  {
    key: 'lift-ban',
    faction: 'tourism',
    when: (w) => (w.policies.fireBan === 'summer' ? 0.9 : 0),
    make: () => ({
      title: 'Let people have their campfires',
      text: 'A summer-long fire ban is emptying the campgrounds. Ban fires only when danger is very high.',
      action: { type: 'policy', key: 'fireBan', value: 'auto' },
      acceptDelta: 9,
      declineDelta: -6,
      sideEffects: [['residents', -2]],
    }),
  },
  {
    key: 'campground',
    faction: 'tourism',
    // only when the campgrounds really are full (v1.0 asked every three years while approval was
    // below 58, and granting it built nothing and cost nothing)
    when: (w) => {
      const share = w.memory.turnedAwayShare ?? 0;
      if (share < CAMP_PETITION_SHARE) return 0;
      return bestCampSite(w) >= 0 ? Math.min(0.9, 0.3 + 1.5 * share) : 0;
    },
    make: (w) => {
      const site = bestCampSite(w);
      const pct = Math.round(100 * (w.memory.turnedAwayShare ?? 0));
      return {
        title: 'More places to camp',
        text: `${pct}% of last year’s visitors found the campgrounds full and went elsewhere. Build a campground ${placeName(w, site)} ($${COST.camp / 1000}k, then $${COST.campUpkeep / 1000}k a year).`,
        action: { type: 'fund', amount: COST.camp, label: 'New campground', cells: [site] },
        acceptDelta: 9,
        declineDelta: -5,
        sideEffects: [['conservation', -2]],
      };
    },
  },
];

export function generatePetitions(w: World): Petition[] {
  const last = w.memory.lastPetitionYear;
  const opts = TEMPLATES.map((t) => ({ t, u: t.when(w) }))
    .filter((o) => o.u > 0 && w.year - (last[o.t.key] ?? -99) >= 3)
    .map((o) => ({ ...o, score: o.u * (1 + (60 - w.factions[o.t.faction].approval) / 40) }))
    .sort((a, b) => b.score - a.score);
  const out: Petition[] = [];
  const used = new Set<FactionId>();
  for (const o of opts) {
    if (out.length >= 3) break;
    if (used.has(o.t.faction)) continue;
    used.add(o.t.faction);
    const p = o.t.make(w);
    out.push({ id: w.nextId(), faction: o.t.faction, ...p, key: o.t.key } as Petition & { key: string });
  }
  return out;
}

// ------------------------------------------------------------ annual review
export function budgetFor(w: World): number {
  const diff = w.config.difficulty === 'gentle' ? 1.15 : w.config.difficulty === 'harsh' ? 0.85 : 1;
  const trust = w.trust;
  const pop = w.population;
  return Math.round(1_020_000 * diff * (0.55 + 0.9 * (trust / 100)) * (0.85 + 0.15 * (pop / 3400)));
}

/**
 * Open the annual review of the year that just ended. `closed` is that year's ledger as
 * archived by closeEconomyYear, which runs first and leaves e.ledger empty for the new year
 * (v1.0 totalled the fresh ledger and reported $0k / $0k every year).
 */
export function beginReview(w: World, closed: LedgerYear = w.economy.history.at(-1) ?? w.economy.ledger): void {
  const r = w.review;
  const e = w.economy;
  const tot = ledgerTotals(closed);
  const yr = w.year - 1;
  const trust = w.trust;
  r.pending = true;
  r.year = yr;
  r.petitions = generatePetitions(w);
  r.budgetNext = budgetFor(w);
  const burned = w.stats.burned.at(-1) ?? 0;
  const high = w.stats.burnedHigh.at(-1) ?? 0;
  r.report = [
    ['Council trust', `${Math.round(trust)} / 100`],
    ['Area burned', `${burned.toLocaleString()} ha (${high.toLocaleString()} ha severe)`],
    ['Homes lost', `${w.stats.structuresLost.at(-1) ?? 0}`],
    ['Income / spending', `$${Math.round(tot.income / 1000)}k / $${Math.round(tot.expense / 1000)}k`],
    ['Balance', `$${Math.round(e.funds / 1000)}k`],
    ['Next year’s allocation', `$${Math.round(r.budgetNext / 1000)}k`],
  ];
  // verdict
  let verdict = '';
  if (trust < 30) {
    r.lowTrustYears++;
    verdict = r.lowTrustYears >= 2 ? 'dismissed' : 'warning';
  } else r.lowTrustYears = 0;
  if (trust < 18) verdict = 'dismissed';
  if (e.funds < -600_000) verdict = 'bankrupt';
  const tenureOver = yr >= w.config.tenureYears;
  if (!verdict && tenureOver) verdict = 'tenure';
  r.verdict = verdict || (trust > 70 ? 'praise' : 'ok');
  for (const p of r.petitions) w.memory.lastPetitionYear[(p as Petition & { key: string }).key] = w.year;
}

function applyPetition(w: World, p: Petition): void {
  const a = p.action;
  if (a.type === 'policy') (w.policies as unknown as Record<string, unknown>)[a.key] = a.value;
  else if (a.type === 'zone') {
    for (const c of a.cells) if (w.L.zone[c] === ZONE.NONE) w.L.zone[c] = a.zone;
    w.dirty.zone++;
  } else if (a.type === 'reintroduce-wolves') {
    // release in the most remote dry ground
    const far = distanceField(w, (i) => w.L.town[i] !== 0, 80);
    let best = -1,
      bd = -1;
    for (let i = 0; i < w.N; i += 3) if (!w.L.water[i] && far[i] > bd && w.L.elev[i] < 2600) {
      bd = far[i];
      best = i;
    }
    if (best >= 0) {
      const x = (best % w.W) + 0.5,
        y = ((best / w.W) | 0) + 0.5;
      const names = new NameBank(w.rng.misc.fork('reintro' + w.year));
      w.packs.push({ id: w.nextId(), name: names.packName(), x, y, px: x, py: y, n: 5, tx: x, ty: y, hunger: 0.4, targetHerd: -1, kills: 0, founded: w.day });
      w.spend('Wildlife', COST.wolfReintro);
      w.memory.wolfReintroYear = w.year;
    }
  } else if (a.type === 'fund') {
    const label = a.label;
    if (label.startsWith('Community protection') && (a as PetitionAction & { cells?: number[] }).cells) {
      createProject(w, 'thin', (a as PetitionAction & { cells: number[] }).cells);
    } else if (label === 'Reservoir dredging') {
      w.spend('Infrastructure', a.amount);
      dredge(w, 0.3);
    } else if (label === 'New campground') {
      // build on the site the petition named, or the next best if that one is no longer possible
      let site = a.cells?.[0] ?? -1;
      if (!campSiteValid(w, site)) site = bestCampSite(w);
      if (site < 0) {
        // nowhere left to build: nothing is built, nothing is paid, and nobody is pleased
        p.acceptDelta = 0;
        p.sideEffects = [];
        w.record('people', 'No site could be found for the new campground; nothing was built.', 1);
        return;
      }
      buildCampground(w, site);
      w.notify(`New campground built ${placeName(w, site)}.`, 'good', site % w.W, (site / w.W) | 0);
    }
  }
}

/** Handles 'petition' and 'closeReview' commands. */
export function handleReviewCommand(w: World, cmd: Command): CommandResult {
  const r = w.review;
  if (!r.pending) return { ok: false, msg: 'The council is not in session.' };
  if (cmd.t === 'petition') {
    const p = r.petitions.find((x) => x.id === cmd.id);
    if (!p || (p as Petition & { resolved?: boolean }).resolved) return { ok: false, msg: 'Already answered.' };
    (p as Petition & { resolved?: boolean; accepted?: boolean }).resolved = true;
    (p as Petition & { accepted?: boolean }).accepted = cmd.accept;
    if (cmd.accept) {
      applyPetition(w, p);
      shock(w, p.faction, p.acceptDelta, `Petition granted: ${p.title}`);
      for (const [f, d] of p.sideEffects) shock(w, f, d, `${FACTION_NAMES[p.faction]} petition granted`);
      w.memory.acceptedPetitions++;
      w.record('petition', `The council granted the ${FACTION_NAMES[p.faction].toLowerCase()} petition: “${p.title}”.`, 1);
    } else {
      shock(w, p.faction, p.declineDelta, `Petition refused: ${p.title}`);
      w.memory.declinedPetitions++;
      w.record('petition', `The warden refused the ${FACTION_NAMES[p.faction].toLowerCase()} petition: “${p.title}”.`, 1);
    }
    return { ok: true, msg: cmd.accept ? 'Petition granted.' : 'Petition refused.' };
  }
  if (cmd.t === 'closeReview') {
    for (const p of r.petitions) {
      const pp = p as Petition & { resolved?: boolean };
      if (!pp.resolved) {
        pp.resolved = true;
        shock(w, p.faction, Math.round(p.declineDelta * 0.6), `Petition ignored: ${p.title}`);
      }
    }
    const v = r.verdict;
    if (v === 'dismissed' || v === 'bankrupt' || v === 'tenure') {
      w.outcome = evaluateLegacy(w, v === 'tenure' ? 'tenure' : v === 'bankrupt' ? 'bankrupt' : 'dismissed');
      r.pending = false;
      return { ok: true, msg: 'Your tenure has ended.' };
    }
    const returned = applyAllocation(w);
    r.pending = false;
    const back = returned > 0 ? ` $${Math.round(returned / 1000)}k of unspent funds returned to the county.` : '';
    return { ok: true, msg: `The council allocates $${Math.round(r.budgetNext / 1000)}k for the coming year.${back}` };
  }
  return { ok: false, msg: 'Unknown council action.' };
}

/**
 * New fiscal year: unspent money beyond a reserve of 35% of the new allocation
 * returns to the county ("use it or lose it"); debt carries over in full.
 * Returns the amount returned.
 */
export function applyAllocation(w: World): number {
  const e = w.economy;
  const r = w.review;
  const reserve = 0.35 * r.budgetNext;
  let returned = 0;
  if (e.funds > reserve) {
    returned = e.funds - reserve;
    e.funds = reserve;
  }
  w.memory.lastReturned = returned;
  w.memory.returnedTotal = (w.memory.returnedTotal ?? 0) + returned;
  w.memory.allocTotal = (w.memory.allocTotal ?? 0) + r.budgetNext;
  w.earn('Council allocation', r.budgetNext);
  e.annualBudget = r.budgetNext;
  return returned;
}

export function trustOf(w: World): number {
  return clamp01(w.trust / 100) * 100;
}
