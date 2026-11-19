/**
 * The guided first season promises the new warden a fire to learn on. It is lit
 * through a logged command ('tutorialIgnition') so that replays reproduce it, on the
 * ground where today's fire weather would actually carry a fire, and announced for
 * what it is: the cause and the notice follow the real season and weather.
 */
import { SEASON_NAMES } from './types.ts';
import type { FireEvent } from './types.ts';
import { cellFuel } from './systems/fuels.ts';
import { isBurnable, moistureDamping, startFire, surfaceHeadRate } from './systems/fire.ts';
import { DANGER_NAMES } from './systems/climate.ts';
import type { World } from './world.ts';

/**
 * Fire weather of one cell today: how fast a surface fire would spread through it before
 * wind and slope (cells/hour). Fine fuel and its dryness, with green growth damping the
 * fire, on the same footing as the fire model's spread rate (systems/fire.ts spreadRate):
 * cured grass carries fire; damp spring litter under green shoots does not.
 */
export function cellFireWeather(w: World, i: number): number {
  const L = w.L;
  if (L.water[i] || L.town[i] !== 0 || L.snow[i] > 5 || L.pond[i] > 0.35) return 0;
  const f = cellFuel(w, i);
  if (f.fine < 0.5) return 0;
  const fm = Math.max(0.02, L.fm[i] + f.green * (0.06 + 0.06 * f.grassShare));
  const damp = moistureDamping(fm / (0.15 + 0.13 * (1 - f.grassShare)));
  // the fire model's own head-fire rate for today's wind (cells/hour), so the lesson site follows it
  return (surfaceHeadRate(w, i, f, w.weather.windSpeed) / 100) * damp;
}

/** Mean fire weather of a cell's neighbourhood (a fire needs more than one dry cell to run). */
function neighbourhoodFireWeather(w: World, x: number, y: number, r = 2): number {
  let s = 0,
    n = 0;
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx,
        yy = y + dy;
      if (!w.inside(xx, yy)) continue;
      s += cellFireWeather(w, yy * w.W + xx);
      n++;
    }
  return n ? s / n : 0;
}

/** Spread potential (cells/hour, i.e. 20 m/h) below which a fire would barely creep: no lesson there. */
export const TUTORIAL_FIRE_MIN = 0.2;

/**
 * Where the tutorial fire starts: the spot 1.2–2.6 km from the first town whose
 * neighbourhood would carry fire best today, with a slight preference for high
 * ground (where lightning strikes) and for the middle of the ring. Deterministic;
 * returns -1 when nothing nearby can burn (deep snow, a wet spell).
 */
export function tutorialFireCell(w: World): number {
  const t = w.towns[0];
  if (!t) return -1;
  const cands: Array<[number, number, number]> = [];
  const wdx = Math.cos(w.weather.windDir),
    wdy = Math.sin(w.weather.windDir);
  let lo = Infinity,
    hi = -Infinity;
  for (let k = 0; k < 420; k++) {
    const a = (k * 2.399963) % (Math.PI * 2),
      d = 12 + (k % 15);
    const x = Math.round(t.x + Math.cos(a) * d),
      y = Math.round(t.y + Math.sin(a) * d);
    if (!w.inside(x, y)) continue;
    const i = y * w.W + x;
    if (!isBurnable(w, i) || w.L.town[i] !== 0 || w.L.water[i]) continue;
    const own = cellFireWeather(w, i);
    if (own < TUTORIAL_FIRE_MIN) continue;
    // a fire runs with the wind: score the ground around the origin and the ground downwind of it
    const fw = 0.5 * neighbourhoodFireWeather(w, x, y) + 0.5 * neighbourhoodFireWeather(w, Math.round(x + 2.5 * wdx), Math.round(y + 2.5 * wdy));
    if (fw < TUTORIAL_FIRE_MIN) continue;
    cands.push([i, fw, d]);
    lo = Math.min(lo, w.L.elev[i]);
    hi = Math.max(hi, w.L.elev[i]);
  }
  let best = -1,
    bs = -Infinity;
  for (const [i, fw, d] of cands) {
    const rel = hi > lo ? (w.L.elev[i] - lo) / (hi - lo) : 0.5;
    const sc = fw * (0.85 + 0.3 * rel) * (1 - 0.02 * Math.abs(d - 18));
    if (sc > bs || (sc === bs && i < best)) {
      bs = sc;
      best = i;
    }
  }
  return best;
}

const COMPASS = ['east', 'south-east', 'south', 'south-west', 'west', 'north-west', 'north', 'north-east'];

function fuelWords(w: World, i: number): string {
  const L = w.L;
  const f = cellFuel(w, i);
  if (f.grassShare > 0.5) return 'cured grass';
  if (L.red[i] > 0.2) return 'beetle-killed pine';
  if (L.fir[i] > L.pine[i] && L.fir[i] > 0.2) return 'deadfall under the firs';
  if (L.pine[i] > 0.2) return 'pine litter';
  if (L.shrub[i] > 0.3) return 'dry brush';
  return 'dry litter';
}

/** Is lightning a believable cause today? */
export function stormToday(w: World): boolean {
  return w.weather.storm || w.weather.strikes > 0;
}

/**
 * Light the tutorial fire at `cell` (see the 'tutorialIgnition' command). The fire is
 * reported at once; lightning is blamed only when a storm is actually overhead.
 */
export function tutorialIgnition(w: World, cell: number): { fire: FireEvent | null; msg: string } {
  if (!w.config.tutorial) return { fire: null, msg: 'Only the guided first season lights a lesson fire.' };
  if (w.memory.tutorialFireId !== undefined) return { fire: null, msg: 'The lesson fire has already been lit.' };
  if (!isBurnable(w, cell) || w.L.town[cell] !== 0 || cellFireWeather(w, cell) <= 0) return { fire: null, msg: 'Nothing there would burn today.' };
  const lightning = stormToday(w);
  const fe = startFire(w, cell, lightning ? 'lightning' : 'human');
  if (!fe) return { fire: null, msg: 'Nothing there would burn today.' };
  const t = w.towns[0];
  fe.detected = true;
  fe.detectedDay = w.day;
  fe.detectedBy = lightning ? 'the lookout' : 'residents';
  w.memory.tutorialFireId = fe.id;
  const season = SEASON_NAMES[w.season].toLowerCase();
  const danger = DANGER_NAMES[w.weather.dangerClass].toLowerCase();
  const fuel = fuelWords(w, cell);
  let where = '';
  if (t) {
    const dx = fe.originX - t.x,
      dy = fe.originY - t.y;
    const km = (Math.hypot(dx, dy) / 10).toFixed(1);
    const dir = COMPASS[((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8];
    where = ` ${km} km ${dir} of ${t.name}`;
  }
  const humidity = Math.round(w.weather.rh * 100);
  const cause = lightning
    ? `${w.weather.dryLightning ? 'A dry' : 'A'} ${season} thunderstorm sent lightning into ${fuel}${where}`
    : `On a ${season} day of ${danger} fire danger (${humidity}% humidity), an unattended campfire crept into ${fuel}${where}`;
  const msg = `${cause}: the ${fe.name} has been reported by ${fe.detectedBy}.`;
  w.notify(msg, 'danger', fe.originX, fe.originY, fe.id);
  return { fire: fe, msg };
}

/**
 * Weather for the guided first season's lesson fire: a dry summer or autumn afternoon
 * (when fires start) of at least High danger. Spring fires die in the green-up, so the
 * lesson waits for the fire season instead of striking on a fixed date.
 */
export function lessonFireWeather(w: World): boolean {
  if (w.season !== 1 && w.season !== 2) return false;
  if (w.sub < 3 || w.sub > 5 || w.weather.precip > 2) return false;
  return w.weather.dangerClass >= 2;
}

/** Late in the summer the lesson goes ahead on any dry afternoon, whatever the danger rating. */
export function lessonFireFallback(w: World): boolean {
  return w.season <= 2 && w.doy >= 150 && w.sub >= 3 && w.sub <= 5 && w.weather.precip <= 2;
}
