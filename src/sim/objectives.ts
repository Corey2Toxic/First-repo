/**
 * The council's charge: what each valley asks of its warden, in terms that can be read off the
 * valley at any moment. FIREWEED 1.x had one goal for every scenario (a 0–100 legacy score revealed
 * at the end), so the scenarios differed in their starting conditions but not in what the player was
 * trying to do, and nothing during play said how it was going.
 *
 * Objectives are pure readings of the world: nothing here is stored or steers the simulation.
 */
import type { World } from './world.ts';

export type ObjectiveState = 'met' | 'on-track' | 'behind' | 'failed';

export interface Objective {
  id: string;
  title: string;
  /** the charge, as the council words it */
  charge: string;
  /** where things stand now */
  reading: string;
  /** 0..1: toward the target, or (for a limit) the share of the allowance already used */
  progress: number;
  /** limit: stay under a ceiling for the whole tenure; reach: get there by the end; hold: keep an average */
  kind: 'limit' | 'reach' | 'hold';
  state: ObjectiveState;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const pct = (x: number) => Math.round(100 * x) + ' %';

function landCells(w: World): number {
  let land = 0;
  for (let i = 0; i < w.N; i += 5) if (w.L.water[i] < 2) land++;
  return land * 5;
}

/** Share of the tenure served so far (0..1). */
function served(w: World): number {
  return clamp01(w.yearsElapsed / Math.max(1, w.config.tenureYears));
}

function limit(id: string, title: string, charge: string, used: number, allowance: number, unit: string): Objective {
  const progress = allowance > 0 ? used / allowance : used > 0 ? 2 : 0;
  return {
    id,
    title,
    charge,
    reading: `${Math.round(used).toLocaleString('en-US')} of ${allowance.toLocaleString('en-US')} ${unit}`,
    progress: clamp01(progress),
    kind: 'limit',
    state: used > allowance ? 'failed' : used > allowance * 0.75 ? 'behind' : 'on-track',
  };
}

/** A target to be reached by the end of the tenure; `pace` is how far along it should be by now. */
function reach(id: string, title: string, charge: string, done: number, reading: string, pace: number): Objective {
  // nobody is behind in the first years: the pace is counted from 15 % of the way into the tenure
  return { id, title, charge, reading, progress: clamp01(done), kind: 'reach', state: done >= 1 ? 'met' : done >= Math.max(0, pace - 0.15) * 0.8 ? 'on-track' : 'behind' };
}

function hold(id: string, title: string, charge: string, ok: boolean, margin: number, reading: string): Objective {
  return { id, title, charge, reading, progress: clamp01(margin), kind: 'hold', state: ok ? 'on-track' : 'behind' };
}

// ---------------------------------------------------------------- the readings
function homesLost(w: World): number {
  return w.counters.totalStructuresLost;
}

function keepHomes(w: World, allowance: number): Objective {
  return limit('homes', 'Keep the homes', `Lose no more than ${allowance} homes to fire and flood while you are warden.`, homesLost(w), allowance, 'homes lost');
}

/** Cut the share of homes a design-day fire would take to `factor` of what it was when you arrived. */
function defensible(w: World, factor: number, title = 'Make the towns defensible'): Objective {
  const e = w.memory.exposure;
  const start = e?.start ?? 0,
    now = e?.now ?? start;
  const cut = Math.round((1 - factor) * 100);
  const charge =
    factor >= 1
      ? 'Do not let the towns become more exposed to fire than they were when you arrived.'
      : `Cut by ${cut} % the share of homes a bad fire day would take (thin and burn around the towns, harden the homes).`;
  const reading = `${pct(now)} of homes would burn on the design day (${pct(start)} when you arrived)`;
  if (factor >= 1) return hold('exposure', title, charge, now <= start * 1.02 + 0.005, start > 0 ? clamp01(1 - (now - start) / Math.max(0.05, start)) : 1, reading);
  const need = start * (1 - factor);
  const done = need > 0.005 ? (start - now) / need : 1;
  return reach('exposure', title, charge, done, reading, served(w));
}

/**
 * Fire the warden chose, as a share of the valley per year: prescribed burns, and wildfire that
 * burned at low or moderate severity while its response was Confine or Monitor. (Until the last
 * round of bots this counted every hectare that did not burn severely, so a passive warden met the
 * charge with the fires that got away from the crews: four of six First Season valleys.)
 */
function goodFire(w: World, sharePerYear: number): Objective {
  const land = landCells(w);
  const good = Math.max(0, w.counters.totalRx + (w.counters.totalManagedGood ?? 0));
  const target = sharePerYear * land * w.config.tenureYears;
  return reach(
    'goodfire',
    'Put fire back to work',
    `Put ${Math.round(target).toLocaleString('en-US')} ha under fire of your choosing during your tenure: prescribed burns, and wildfires you confine or monitor that stay on the ground.`,
    target > 0 ? good / target : 1,
    `${Math.round(good).toLocaleString('en-US')} ha so far`,
    served(w),
  );
}

function severity(w: World, ceiling: number): Objective {
  const burned = w.counters.totalBurned;
  const share = burned > 0 ? w.counters.totalHighSeverity / burned : 0;
  return hold(
    'severity',
    'Keep fire on the ground',
    `Keep severe fire under ${pct(ceiling)} of everything that burns.`,
    burned < 200 || share <= ceiling,
    burned < 200 ? 1 : 1 - share / Math.max(0.01, 2 * ceiling),
    burned > 0 ? `${pct(share)} of ${burned.toLocaleString('en-US')} ha burned severely` : 'nothing has burned yet',
  );
}

function trust(w: World, floor: number): Objective {
  const m = w.memory;
  const avg = m.trustYears ? (m.trustSum ?? 0) / m.trustYears : w.trust;
  return hold('trust', 'Keep the council with you', `Hold the council's trust at ${floor} or better on average.`, avg >= floor, avg / 100, `average trust ${Math.round(avg)} (now ${Math.round(w.trust)})`);
}

function reservoir(w: World, ceiling: number): Objective {
  const silt = w.reservoirSilt;
  return {
    ...limit('water', 'Keep the water clean', `Keep the reservoir less than ${pct(ceiling)} silted.`, Math.round(silt * 100), Math.round(ceiling * 100), '% silted'),
    reading: `${pct(silt)} of its capacity lost to silt`,
  };
}

function shareOf(xs: number[], ok: (x: number) => boolean): number {
  if (!xs.length) return 0;
  let k = 0;
  for (const x of xs) if (ok(x)) k++;
  return k / xs.length;
}

function wolvesBack(w: World, share: number): Objective {
  const s = shareOf(w.stats.wolves, (x) => x > 0);
  // months still to come can only add: is the target still within reach?
  return reach('wolves', 'Bring the wolves home', `Have wolves living in the valley for ${pct(share)} of your tenure.`, s / share, `${pct(s)} of the months so far (${w.packs.length} pack${w.packs.length === 1 ? '' : 's'} now)`, 0.6);
}

function beaversBack(w: World, colonies: number): Objective {
  const now = w.colonies.filter((c) => c.active).length;
  return reach('beavers', 'Slow the streams', `End your tenure with ${colonies} or more beaver colonies on the creeks.`, now / colonies, `${now} colon${now === 1 ? 'y' : 'ies'} now`, served(w));
}

function aspen(w: World, factor: number): Objective {
  const s = w.stats.forest;
  void s;
  let young = 0,
    n = 0;
  for (let i = 0; i < w.N; i += 3) {
    if (w.L.aspen[i] > 0.05) {
      n++;
      if (w.L.ageA[i] < 25) young++;
    }
  }
  const share = n ? young / n : 0;
  return reach('aspen', 'Let the aspen come back', `Have ${pct(factor)} of the aspen in stands younger than 25 years: groves that are replacing themselves.`, share / factor, `${pct(share)} of aspen stands are young`, served(w));
}

function growth(w: World, factor: number): Objective {
  const start = w.memory.startPopulation ?? w.population;
  const now = w.population;
  return reach('growth', 'Room to grow', `Let the valley grow to ${Math.round(start * factor).toLocaleString('en-US')} people.`, (now - start) / Math.max(1, start * (factor - 1)), `${now.toLocaleString('en-US')} people (${start.toLocaleString('en-US')} when you arrived)`, served(w));
}

// ---------------------------------------------------------------- per scenario
/** The three things this valley's council has charged its warden with. */
export function objectives(w: World): Objective[] {
  switch (w.config.scenario) {
    case 'firstseason':
      return [keepHomes(w, 8), defensible(w, 2 / 3), goodFire(w, 0.006)];
    case 'tinderbox':
      // (the ceiling was 30 % while a Tinderbox thicket torched in any wind; with the crown base at
      // 1.5 m a passive warden's fires average 20 % and a steward's 10 %)
      return [keepHomes(w, 15), defensible(w, 0.5), severity(w, 0.2)];
    case 'afterburn':
      return [reservoir(w, 0.25), keepHomes(w, 8), aspen(w, 0.3)];
    case 'boomtown':
      // (the second charge was "do not let the danger grow"; the fires a passive warden fails to
      // catch thin the fuel and met it on all four verification valleys)
      return [keepHomes(w, 20), defensible(w, 0.75, 'Grow safer, not only bigger'), growth(w, 1.25)];
    case 'silentwoods':
      return [wolvesBack(w, 0.5), beaversBack(w, 4), aspen(w, 0.3)];
    default:
      return [keepHomes(w, 12), defensible(w, 2 / 3), trust(w, 50)];
  }
}

/** How many of the charges stand met as things are (a limit or a hold counts while it has not been broken). */
export function objectivesMet(w: World): number {
  let k = 0;
  for (const o of objectives(w)) {
    if (o.kind === 'reach' ? o.progress >= 1 : o.state !== 'failed' && o.state !== 'behind') k++;
  }
  return k;
}
