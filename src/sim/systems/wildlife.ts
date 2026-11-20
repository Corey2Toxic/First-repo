/**
 * Wildlife: deer herds, wolf packs and beaver colonies, linked by two fields.
 *
 *  - `browse`: where deer have been eating. Heavy browse kills aspen suckers
 *    and willow (shrub) shoots, so groves cannot regenerate.
 *  - `fear`: where wolves have been. Deer avoid it — "the landscape of fear" —
 *    so aspen and willow recover there even before wolves kill many deer.
 *
 * Beavers dam gentle streams where willow and aspen grow; their ponds raise
 * the water table, store water through summer, trap sediment, refill
 * helicopter buckets, and stop fire. Fewer deer → more willow → more beavers.
 */
import { boxBlur, clamp01, smoothstep } from '../grid.ts';
import { FIRE, INFRA, ZONE } from '../types.ts';
import type { Colony, Herd, Pack } from '../types.ts';
import { REVENUE } from '../economyParams.ts';
import { greenness } from '../derived.ts';
import { beaverSiteScore } from '../gen/wildlife.ts';
import { NameBank } from '../gen/names.ts';
import type { World } from '../world.ts';

export interface WildlifeHooks {
  onDepredation?: (p: Pack) => void;
  onWolvesKilled?: (p: Pack, n: number) => void;
  onPackFormed?: (p: Pack, parent: Pack) => void;
  onPackLost?: (p: Pack) => void;
  onColonyFounded?: (c: Colony) => void;
  onColonyAbandoned?: (c: Colony) => void;
  onDamBuilt?: (c: Colony) => void;
}

// ------------------------------------------------------------ forage
/*
 * Forage is measured in "forage units" of accessible dry matter (1 unit ≈ 1 t/ha). A herd eats from
 * the patch it stands on, so how well each deer feeds depends on how many deer share that patch and
 * how much they have already eaten there: density dependence is emergent. v1.0 fed every herd the
 * mean forage of its patch whatever its size and held the population near a carrying capacity
 * computed from total forage (audit: herds of 5 and 300 reached the same condition; without the
 * global K deer overshot 1.6–2.5×). The binding constraint is, as for real mule deer, the winter
 * range: grass under snow, shrubs and aspen suckers browsed down as the winter wears on.
 */
/** Daily intake per deer, forage units (≈ 2.5 kg dry matter). */
export const DEER_INTAKE = 0.0025;
/** Largest share of a patch's accessible forage a herd can crop in a day (selective foraging). */
export const DEER_CROP_SHARE = 0.03;
/** Ground a deer covers foraging in a day, ha: a herd ranges over (2R+1)² cells with (2R+1)² ≈ n × this. */
const HA_PER_DEER_DAY = 1.0;

function forageGrass(w: World, i: number): number {
  const L = w.L;
  // regrowth on a recent burn is more nutritious for a few years (higher protein and digestibility)
  const flush = w.yearF - L.lastBurn[i] < 4 ? 1.4 : 1;
  return L.grass[i] * (0.35 + 0.65 * greenness(w, i)) * (1 - 0.5 * L.graze[i]) * flush;
}
/** Browse: shrub twigs (~450 kg/ha at full shrub cover; winter browse ranges run ~100–400) and suckers. */
function forageWoody(w: World, i: number): number {
  const L = w.L;
  const youngAspen = L.ageA[i] < 12 ? L.aspen[i] * 1.6 : L.aspen[i] * 0.25;
  return L.shrub[i] * 0.45 + youngAspen;
}
function forage(w: World, i: number): number {
  return forageGrass(w, i) + forageWoody(w, i);
}

function preferredElev(doy: number): number {
  const m = Math.floor(doy / 30);
  return [1700, 1900, 2150, 2350, 2450, 2400, 2150, 1850, 1650, 1450, 1400, 1500][m];
}

function humanPressure(w: World, i: number): number {
  const L = w.L;
  let p = 0;
  if (L.town[i]) p += 3;
  if (L.infra[i] & INFRA.ROAD) p += 0.15;
  if (L.zone[i] === ZONE.RECREATION) p += 0.1;
  return p;
}

/** Unbiased stochastic rounding: E[result] = x. */
export function stochasticRound(x: number, u: number): number {
  return Math.floor(x + u);
}

// ------------------------------------------------------------ herds
function updateHerd(w: World, h: Herd): void {
  const L = w.L;
  const r = w.rng.wildlife;
  h.px = h.x;
  h.py = h.y;
  const target = preferredElev(w.doy);
  // in winter herds come down onto the low, snow-free winter range and crowd it (as migratory mule
  // deer do), so that is where forage runs short; in summer they spread out over the high country
  const winterRange = w.month >= 9 || w.month === 0;
  const elevW = winterRange ? 1 / 250 : 1 / 700;
  const snowW = winterRange ? 1 / 60 : 1 / 120;
  const hx = Math.floor(h.x),
    hy = Math.floor(h.y);
  let best = hy * w.W + hx,
    bestS = -Infinity;
  const evalCell = (i: number) => {
    if (L.water[i] >= 2 || L.pond[i] > 0.4) return -Infinity;
    if (L.fire[i] === FIRE.BURNING) return -20;
    return (
      forage(w, i) * 1.3 -
      Math.min(2, L.snow[i] * snowW) -
      L.fear[i] * 1.4 -
      humanPressure(w, i) -
      L.slope[i] * 0.6 -
      Math.abs(L.elev[i] - target) * elevW +
      r.next() * 0.15
    );
  };
  bestS = evalCell(best);
  for (let k = 0; k < 10; k++) {
    const ang = r.range(0, Math.PI * 2),
      d = r.range(1, 6);
    const x = Math.round(h.x + Math.cos(ang) * d),
      y = Math.round(h.y + Math.sin(ang) * d);
    if (!w.inside(x, y)) continue;
    const i = y * w.W + x;
    const s = evalCell(i);
    if (s > bestS) {
      bestS = s;
      best = i;
    }
  }
  // move up to ~2.5 cells/day toward the best spot
  const tx = (best % w.W) + 0.5,
    ty = ((best / w.W) | 0) + 0.5;
  const dx = tx - h.x,
    dy = ty - h.y;
  const dist = Math.hypot(dx, dy);
  const step = Math.min(dist, 2.5);
  if (dist > 0.01) {
    h.x += (dx / dist) * step;
    h.y += (dy / dist) * step;
  }
  // eat: per-capita intake from the ground the herd covers in a day (5×5 cells, 25 ha); deep snow
  // buries grass and costs energy
  const cx = Math.floor(h.x),
    cy = Math.floor(h.y);
  const snow = L.snow[cy * w.W + cx];
  // bigger herds cover more ground, so at low landscape density every deer eats its fill whatever the
  // herd size, and shortage comes from herds depleting and sharing the same range
  const FORAGE_R = Math.max(1, Math.min(5, Math.round((Math.sqrt(h.n * HA_PER_DEER_DAY) - 1) / 2)));
  // winter: grass under snow is hard to reach, and cured grass is poor food for a browser like a mule
  // deer (low digestibility), so the winter diet is mostly browse
  const winter = w.season === 3 || (w.season === 2 && snow > 30);
  const grassAccess = (1 - 0.85 * Math.min(1, snow / 120)) * (winter ? 0.5 : 1);
  const woodyAccess = 1 - 0.3 * Math.min(1, snow / 250);
  let avail = 0;
  for (let oy = -FORAGE_R; oy <= FORAGE_R; oy++)
    for (let ox = -FORAGE_R; ox <= FORAGE_R; ox++) {
      const x = cx + ox,
        y = cy + oy;
      if (!w.inside(x, y)) continue;
      const i = y * w.W + x;
      if (L.water[i] >= 2) continue;
      avail += forageGrass(w, i) * grassAccess + forageWoody(w, i) * woodyAccess;
    }
  const demand = h.n * DEER_INTAKE * (1 + 0.5 * Math.min(1, snow / 200));
  const eaten = Math.min(demand, avail * DEER_CROP_SHARE);
  const ratio = demand > 0 ? eaten / demand : 1;
  // what was eaten comes off the patch; woody browse leaves the browse field that kills suckers
  const frac = avail > 0 ? eaten / avail : 0;
  if (frac > 0)
    for (let oy = -FORAGE_R; oy <= FORAGE_R; oy++)
      for (let ox = -FORAGE_R; ox <= FORAGE_R; ox++) {
        const x = cx + ox,
          y = cy + oy;
        if (!w.inside(x, y)) continue;
        const i = y * w.W + x;
        if (L.water[i] >= 2) continue;
        // What is eaten leaves the range. (v1.x counted the accessible forage in full but took only
        // half of the grass and a quarter of the browse eaten off the ground, and those again scaled
        // by access: measured, 6-19 % of a winter's intake left the stock, so no herd ever ran its
        // range down and deer had no carrying capacity below ~80 per km².)
        L.grass[i] = Math.max(0, L.grass[i] * (1 - frac * grassAccess));
        L.shrub[i] = Math.max(0, L.shrub[i] * (1 - frac * woodyAccess * 0.8));
        // the browse field is feeding pressure: it kills suckers and shoots and, when deer crowd a
        // range, holds back grass and shrub regrowth (range damage), so irruptions undercut themselves
        L.browse[i] = clamp01(L.browse[i] + frac * (0.9 * woodyAccess + 0.3 * grassAccess));
      }
  h.fed = ratio;
  if (winter) {
    // winter: living off autumn fat; deep snow costs more; going hungry costs most
    h.cond = clamp01(h.cond - (0.0014 + 0.0016 * Math.min(1, snow / 150) + 0.004 * (1 - ratio)));
    h.low = Math.min(h.low ?? 1, h.cond);
  } else {
    // growing season: condition tracks forage per animal
    const target = 0.3 + 0.62 * ratio;
    h.cond += (target - h.cond) * 0.03;
  }
}

function herdsMonthly(w: World): void {
  const r = w.rng.wildlife;
  const month = w.month;
  // tags the valley sells at full price in a year: 0.6 per km²
  const tagsAtFullPrice = Math.round((w.N / 100) * 0.6);
  for (const h of w.herds) {
    // fawns: a doe that came through winter in good condition raises one or two; a thin one may
    // raise none (late-winter condition, not the spring flush, sets the fawn crop)
    // (surviving fawns per head of the herd: ~0.3 after an average winter, up to 0.4 — ~0.8 per doe —
    // after a mild one; typical mule deer fawn:doe ratios run 0.5–0.7)
    if (month === 2) {
      h.n += stochasticRound(h.n * 0.4 * smoothstep(0.35, 0.7, Math.min(h.cond, h.low ?? h.cond)), r.next());
      h.low = undefined;
    }
    let deaths = h.n * 0.006;
    if (h.cond < 0.2) deaths += h.n * 0.08 * (1 - h.cond / 0.2);
    // late winter and thaw: thin animals (fawns first) die as the winter range runs out
    if ((month >= 9 || month === 0) && h.cond < 0.5) deaths += h.n * 0.1 * (1 - h.cond / 0.5);
    // (v1.0 rounded deaths as round(x + 0.5u), which doubles mortality whenever x < 0.5: small herds,
    // exactly those trying to recover, died at twice the intended rate)
    h.n = Math.max(0, h.n - stochasticRound(deaths, r.next()));
    if (month === 8) {
      const rate = w.policies.hunting === 'heavy' ? 0.2 : w.policies.hunting === 'moderate' ? 0.09 : 0;
      const taken = Math.min(h.n, stochasticRound(h.n * rate, r.next()));
      if (taken > 0) {
        h.n -= taken;
        // the valley can host only so many hunters: past the tags it can sell at full price, the
        // rest go cheap (v1.x paid $320 for every deer shot, so an irruption paid a million a year)
        const full = Math.max(0, Math.min(taken, tagsAtFullPrice - w.counters.yearHunted));
        w.counters.yearHunted += taken;
        w.earn('Hunting licenses', full * REVENUE.huntLicense + (taken - full) * REVENUE.huntLicense * 0.2);
      }
    }
  }
  // split large herds, merge tiny ones
  const out: Herd[] = [];
  for (const h of w.herds) {
    if (h.n <= 0) continue;
    if (h.n > 70) {
      const half = Math.floor(h.n / 2);
      h.n -= half;
      out.push({ id: w.nextId(), x: h.x + r.range(-2, 2), y: h.y + r.range(-2, 2), px: h.x, py: h.y, n: half, cond: h.cond, fed: h.fed });
    }
    out.push(h);
  }
  for (const h of out) {
    if (h.n >= 6 || h.n <= 0) continue;
    const other = out.find((o) => o !== h && o.n > 0 && Math.hypot(o.x - h.x, o.y - h.y) < 8);
    if (other) {
      other.n += h.n;
      h.n = 0;
    }
  }
  w.herds = out.filter((h) => h.n > 0);
}

// ------------------------------------------------------------ wolves
/*
 * Wolves (v1.1). v1.0 packs walked 350–600 m a day, held ~20 km² territories founded 4.8 km apart,
 * raised 1–4 pups a year whatever the prey, and fed by a global prey/K ratio; populations boomed to
 * 15 wolves per 100 km², crashed their prey and went extinct (18 of 20 audit runs), surviving only
 * through a 6 %/yr recolonisation roll. Now:
 *  - territories are ~130 km² (radius 6.5 km) and new packs need a vacant one, so wolf density is
 *    bounded by space, as in real populations (Mech & Boitani 2003: 1–5 wolves/100 km² typical);
 *  - a pack travels 15–25 km a day across its territory and hunts when hungry; each wolf needs
 *    about one deer every 18 days (~20 per year), so kill rates are set by satiation, not chance;
 *  - pups survive in proportion to the deer in the territory per wolf; hungry packs raise none;
 *  - most dispersers leave the valley; a disperser pair settles only in a vacant territory;
 *  - dispersing pairs from outside settle in vacant territory now and then (~25 %/yr while there is
 *    room and prey), not only after extinction; since 2.0 not in a valley set up without wolves
 *    until some have been released.
 */
export const TERRITORY_RADIUS = 65; // cells (6.5 km), ~130 km²
const TERRITORY_SPACING = 100; // minimum distance between territory centres, cells
const WOLF_NEED = 1 / 18; // deer per wolf per day

/** Deer living within a territory (plus a margin the pack also ranges over). */
function preyInTerritory(w: World, tx: number, ty: number): number {
  let n = 0;
  const R = TERRITORY_RADIUS * 1.3;
  for (const h of w.herds) if (Math.hypot(h.x - tx, h.y - ty) < R) n += h.n;
  return n;
}

/** Is (x, y) a place a new pack could settle: on the map, dry, away from towns and other packs? */
export function vacantTerritory(w: World, x: number, y: number, others: Pack[] = w.packs): boolean {
  if (!w.inside(Math.floor(x), Math.floor(y))) return false;
  if (w.L.water[Math.floor(y) * w.W + Math.floor(x)] >= 2) return false;
  if (others.some((o) => Math.hypot(o.tx - x, o.ty - y) < TERRITORY_SPACING)) return false;
  if (w.towns.some((t) => Math.hypot(t.x - x, t.y - y) < 18)) return false;
  return true;
}

function updatePack(w: World, p: Pack, hooks: WildlifeHooks): void {
  const L = w.L;
  const r = w.rng.wildlife;
  p.px = p.x;
  p.py = p.y;
  // hunger: deer-equivalents of unmet need per wolf
  p.hunger = Math.min(2, p.hunger + WOLF_NEED);
  let tx = p.tx + r.range(-0.7, 0.7) * TERRITORY_RADIUS,
    ty = p.ty + r.range(-0.7, 0.7) * TERRITORY_RADIUS;
  let speed = 15;
  if (p.hunger > 0.15) {
    let best: Herd | null = null,
      bs = -Infinity;
    for (const h of w.herds) {
      // wolves keep clear of towns, so herds sheltering next to one are out of reach
      if (w.towns.some((t) => Math.hypot(t.x - h.x, t.y - h.y) < 11)) continue;
      const dT = Math.hypot(h.x - p.tx, h.y - p.ty);
      const dP = Math.hypot(h.x - p.x, h.y - p.y);
      // packs follow migrating deer to the edges of their range; hungry packs range further
      const reach = TERRITORY_RADIUS * (p.hunger > 0.6 ? 2 : 1.3);
      if (dT > reach && dP > 40) continue;
      const vuln = (1.25 - h.cond) * (1 + Math.min(1, L.snow[Math.floor(h.y) * w.W + Math.floor(h.x)] / 120));
      const s = vuln * Math.sqrt(h.n) - dP * 0.02;
      if (s > bs) {
        bs = s;
        best = h;
      }
    }
    if (best) {
      p.targetHerd = best.id;
      tx = best.x;
      ty = best.y;
      speed = 25;
    } else p.targetHerd = -1;
  } else p.targetHerd = -1;
  // avoid towns
  for (const t of w.towns) {
    const d = Math.hypot(t.x - tx, t.y - ty);
    if (d < 10) {
      tx += ((tx - t.x) / Math.max(1, d)) * 10;
      ty += ((ty - t.y) / Math.max(1, d)) * 10;
    }
  }
  const dx = tx - p.x,
    dy = ty - p.y;
  const dist = Math.hypot(dx, dy);
  if (dist > 0.01) {
    // head for the target, detouring around lakes (v1.0 packs simply stopped when a lake lay on the
    // straight line, and could stay stuck behind it for weeks)
    const s = Math.min(dist, speed);
    const base = Math.atan2(dy, dx);
    for (const turn of [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9]) {
      for (const f of [1, 0.5]) {
        const nx = p.x + Math.cos(base + turn) * s * f,
          ny = p.y + Math.sin(base + turn) * s * f;
        if (!w.inside(Math.floor(nx), Math.floor(ny)) || L.water[Math.floor(ny) * w.W + Math.floor(nx)] >= 2) continue;
        // the straight line must not cross a lake either
        let wet = false;
        for (let k = 1; k < 8 && !wet; k++) {
          const sx = Math.floor(p.x + ((nx - p.x) * k) / 8),
            sy = Math.floor(p.y + ((ny - p.y) * k) / 8);
          if (w.inside(sx, sy) && L.water[sy * w.W + sx] >= 2) wet = true;
        }
        if (wet) continue;
        p.x = nx;
        p.y = ny;
        break;
      }
      if (p.x !== p.px || p.y !== p.py) break;
    }
  }
  // the hunt: once the pack has closed on its target herd (after both have moved today)
  if (p.targetHerd >= 0) {
    const best = w.herds.find((h) => h.id === p.targetHerd);
    // type II functional response: where deer are scarce, finding and cornering them takes longer
    const dens = preyInTerritory(w, p.tx, p.ty) / (Math.PI * (TERRITORY_RADIUS * 1.3) ** 2 * 0.01); // deer/km²
    const engage = dens / (dens + 1.5);
    if (best && Math.hypot(best.x - p.x, best.y - p.y) < 3 && r.next() < engage) {
      const snow = L.snow[Math.floor(best.y) * w.W + Math.floor(best.x)];
      // success rises with pack size (to a point), prey weakness and deep snow
      const pSuccess = Math.min(0.95, 0.75 * Math.min(1.4, Math.sqrt(p.n / 4)) * (0.6 + 0.8 * (1 - best.cond)) * (snow > 60 ? 1.4 : 1));
      if (r.next() < pSuccess) {
        const k = p.n >= 8 && best.n > 3 ? 2 : 1;
        best.n = Math.max(0, best.n - k);
        // the kill is shared by the pack, and a carcass feeds it for days: what a small pack cannot
        // eat today is not thrown away (v1.x zeroed the surplus, so packs of 2-4 killed 25-45 deer a
        // wolf a year against the 20 the model intends, and ate themselves out of pups)
        p.hunger = Math.max(-0.6, p.hunger - k / Math.max(1, p.n));
        p.kills += k;
        // territories drift toward where the hunting is good (but keep their distance from neighbours)
        // (territories are stable for years: a slow drift, and the centre stays well inside the valley)
        const m = TERRITORY_RADIUS * 0.6;
        const nx = Math.max(m, Math.min(w.W - m, p.tx + (best.x - p.tx) * 0.01)),
          ny = Math.max(m, Math.min(w.H - m, p.ty + (best.y - p.ty) * 0.01));
        if (!w.packs.some((o) => o !== p && Math.hypot(o.tx - nx, o.ty - ny) < TERRITORY_SPACING * 0.8)) {
          p.tx = nx;
          p.ty = ny;
        }
      }
    }
  }
  // the landscape of fear
  const R = 6;
  const cx = Math.floor(p.x),
    cy = Math.floor(p.y);
  for (let oy = -R; oy <= R; oy++)
    for (let ox = -R; ox <= R; ox++) {
      const x = cx + ox,
        y = cy + oy;
      if (!w.inside(x, y)) continue;
      const d = Math.sqrt(ox * ox + oy * oy);
      if (d > R) continue;
      const i = y * w.W + x;
      L.fear[i] = Math.max(L.fear[i], 0.85 * (1 - d / (R + 1)) * Math.min(1, p.n / 4));
    }
  // conflict with livestock on rangeland in the grazing season
  if (p.hunger > 0.4 && w.month >= 1 && w.month <= 7 && w.policies.grazing !== 'none') {
    let nearRange = false;
    for (let oy = -3; oy <= 3 && !nearRange; oy++)
      for (let ox = -3; ox <= 3; ox++) {
        const x = cx + ox,
          y = cy + oy;
        if (w.inside(x, y) && L.zone[y * w.W + x] === ZONE.RANGE) {
          nearRange = true;
          break;
        }
      }
    const herdSize = w.policies.grazing === 'heavy' ? 1.6 : 1;
    if (nearRange && r.next() < 0.012 * herdSize) {
      w.counters.yearDepredations++;
      w.memory.lastDepredationDay = w.day;
      p.hunger = Math.max(0, p.hunger - 0.5);
      if (hooks.onDepredation) hooks.onDepredation(p);
      if (w.policies.wolfPolicy !== 'protected' && (w.policies.wolfPolicy === 'bounty' || r.next() < 0.3)) {
        const k = w.policies.wolfPolicy === 'bounty' ? 2 : 1;
        const killed = Math.min(p.n, k);
        p.n -= killed;
        w.counters.yearWolvesKilled += killed;
        if (hooks.onWolvesKilled) hooks.onWolvesKilled(p, killed);
      }
    }
  }
}

function packsMonthly(w: World, hooks: WildlifeHooks): void {
  const r = w.rng.wildlife;
  const names = new NameBank(w.rng.wildlife.fork('packnames' + w.day));
  const born: Pack[] = [];
  // deer per wolf, valley-wide: wolf density tracks prey biomass (Fuller 1989; Fuller, Mech &
  // Cochrane 2003: roughly one wolf per 200–300 deer where wolves are stable)
  let deerAll = 0,
    wolvesAll = 0;
  for (const h of w.herds) deerAll += h.n;
  for (const p of w.packs) wolvesAll += p.n;
  const valleyPPW = deerAll / Math.max(1, wolvesAll);
  for (const p of w.packs) {
    const preyPerWolf = Math.min(valleyPPW, preyInTerritory(w, p.tx, p.ty) / Math.max(1, p.n));
    // spring litter: pups survive in proportion to the prey per wolf; hungry packs raise none
    if (w.month === 2 && p.n >= 2 && p.n < 14) {
      const q = smoothstep(120, 320, preyPerWolf) * (1 - smoothstep(0.4, 1.0, p.hunger));
      p.n += Math.round(r.intRange(3, 6) * q);
    }
    // when prey runs short, young wolves leave before the pack starves
    if (preyPerWolf < 100 && p.n > 2) p.n -= Math.round((p.n - 2) * 0.15 * (1 - preyPerWolf / 100));
    // natural mortality ~12 %/yr per wolf (disease, injury, conflict between packs)
    let deaths = 0;
    for (let k = 0; k < p.n; k++) if (r.next() < 0.0106) deaths++;
    p.n -= deaths;
    // starvation after weeks of unmet need
    if (p.hunger > 1) p.n -= Math.max(1, Math.round(p.n * 0.2 * Math.min(1, p.hunger - 0.9)));
    if (w.policies.wolfPolicy === 'bounty' && r.next() < 0.45) {
      p.n -= 1;
      w.counters.yearWolvesKilled++;
      if (hooks.onWolvesKilled) hooks.onWolvesKilled(p, 1);
    }
    // autumn dispersal: young wolves leave large packs; a pair founds a pack only where a territory
    // is vacant, otherwise they leave the valley
    if (w.month >= 6 && w.month <= 9 && p.n >= 8) {
      const leaving = Math.min(4, p.n - 5);
      p.n -= leaving;
      if (leaving >= 2 && r.next() < 0.5 && deerAll / (wolvesAll + 2) > 250) {
        for (let k = 0; k < 30; k++) {
          const ang = r.range(0, Math.PI * 2),
            d = r.range(TERRITORY_SPACING, TERRITORY_SPACING * 1.8);
          const x = p.tx + Math.cos(ang) * d,
            y = p.ty + Math.sin(ang) * d;
          if (!vacantTerritory(w, x, y, [...w.packs, ...born])) continue;
          const np: Pack = { id: w.nextId(), name: names.packName(), x: p.x, y: p.y, px: p.x, py: p.y, n: 2, tx: x, ty: y, hunger: 0.3, targetHerd: -1, kills: 0, founded: w.day };
          born.push(np);
          if (hooks.onPackFormed) hooks.onPackFormed(np, p);
          break;
        }
      }
    }
  }
  w.packs.push(...born);
  // A pack reduced to one wolf holds its territory for a while: a disperser from beyond the valley
  // may pair with it in autumn. (v1.x deleted the pack the moment it had fewer than two wolves.)
  for (const p of w.packs) {
    if (p.n === 1) {
      if (p.lone === undefined) p.lone = w.day;
      else if (w.month === 9 && w.policies.wolfPolicy !== 'bounty' && r.next() < 0.5) {
        p.n = 2;
        p.lone = undefined;
      }
    } else p.lone = undefined;
  }
  const gone = (p: Pack) => p.n < 1 || (p.n === 1 && p.lone !== undefined && w.day - p.lone > 540);
  for (const p of w.packs) if (gone(p) && hooks.onPackLost) hooks.onPackLost(p);
  w.packs = w.packs.filter((p) => !gone(p));
  // dispersing pairs from beyond the valley settle in vacant territory now and then (not under a
  // bounty), and not in a valley set up without wolves until its warden has brought some back: the
  // same rule beavers have had since 1.1. (Without it wolves walked into Silent Woods, "no wolves
  // for eighty years", within about four years and stayed for 61–97 % of a passive tenure.)
  const wolfCountry = w.config.wolves > 0 || (w.memory.wolfReleases ?? 0) > 0;
  if (wolfCountry && w.month === 9 && w.policies.wolfPolicy !== 'bounty' && deerAll / (wolvesAll + 2) > 250) {
    for (let k = 0; k < 20; k++) {
      const x = r.range(TERRITORY_RADIUS * 0.4, w.W - TERRITORY_RADIUS * 0.4),
        y = r.range(TERRITORY_RADIUS * 0.4, w.H - TERRITORY_RADIUS * 0.4);
      if (!vacantTerritory(w, x, y)) continue;
      if (r.next() < 0.25) {
        const edge = r.int(4);
        const sx = edge === 0 ? 2 : edge === 1 ? w.W - 3 : x,
          sy = edge === 2 ? 2 : edge === 3 ? w.H - 3 : y;
        const np: Pack = { id: w.nextId(), name: names.packName(), x: sx, y: sy, px: sx, py: sy, n: 2, tx: x, ty: y, hunger: 0.3, targetHerd: -1, kills: 0, founded: w.day };
        w.packs.push(np);
        if (hooks.onPackFormed) hooks.onPackFormed(np, np);
      }
      break;
    }
  }
}

// ------------------------------------------------------------ beavers
function upstreamPath(w: World, c: number, k: number): number[] {
  const L = w.L;
  const out: number[] = [];
  let cur = c;
  for (let s = 0; s < k; s++) {
    const x = cur % w.W,
      y = (cur / w.W) | 0;
    let best = -1,
      ba = 0;
    for (let oy = -1; oy <= 1; oy++)
      for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const nx = x + ox,
          ny = y + oy;
        if (!w.inside(nx, ny)) continue;
        const ni = ny * w.W + nx;
        if (L.flowTo[ni] === cur && L.flowAcc[ni] > ba) {
          ba = L.flowAcc[ni];
          best = ni;
        }
      }
    if (best < 0 || ba < 30) break;
    out.push(best);
    cur = best;
  }
  return out;
}

/** Stream cells beavers could use, from static terrain only (so a reloaded game rebuilds the same list). */
const habitatCache = new WeakMap<World, number[]>();
function beaverHabitat(w: World): number[] {
  let h = habitatCache.get(w);
  if (h) return h;
  const L = w.L;
  h = [];
  for (let i = 0; i < w.N; i++) {
    const acc = L.flowAcc[i];
    if (L.water[i] || acc < 70 || acc > 1300 || L.slope[i] > 0.07) continue;
    h.push(i);
  }
  habitatCache.set(w, h);
  return h;
}

function coloniesMonthly(w: World, hooks: WildlifeHooks): void {
  const L = w.L;
  const r = w.rng.wildlife;
  const growing = w.season !== 3;
  // abandoned ponds slowly drain into rich meadows
  for (let i = 0; i < w.N; i++) {
    if (L.pond[i] > 0 && !w.colonies.some((c) => c.active && Math.abs((c.cell % w.W) - (i % w.W)) <= 8 && Math.abs(((c.cell / w.W) | 0) - ((i / w.W) | 0)) <= 8)) {
      L.pond[i] *= 0.9;
      if (L.pond[i] < 0.02) {
        L.pond[i] = 0;
        L.fert[i] = Math.max(L.fert[i], 0.4);
        L.grass[i] = Math.max(L.grass[i], 0.5);
      }
    }
  }
  const newCols: Colony[] = [];
  for (const c of w.colonies) {
    if (!c.active) continue;
    const x = c.cell % w.W,
      y = (c.cell / w.W) | 0;
    let food = 0;
    for (let oy = -3; oy <= 3; oy++)
      for (let ox = -3; ox <= 3; ox++) {
        if (!w.inside(x + ox, y + oy)) continue;
        const j = (y + oy) * w.W + x + ox;
        food += L.aspen[j] * 1.4 + L.shrub[j] * 0.8;
        // a colony cuts on the order of 1–2 ha of aspen and willow stems a year around its pond
        // (v1.0 cut ~12 %/yr of the whole 49-ha neighbourhood for a family of six, ~10x regrowth)
        if (growing) {
          L.aspen[j] = Math.max(0, L.aspen[j] - 0.0006 * c.n);
          L.shrub[j] = Math.max(0, L.shrub[j] - 0.0005 * c.n);
        }
      }
    food /= 49;
    c.food = food;
    const wasLow = c.dam < 0.3;
    c.dam = clamp01(c.dam + (food > 0.05 && growing ? 0.06 : -0.015));
    if (wasLow && c.dam >= 0.3 && hooks.onDamBuilt) hooks.onDamBuilt(c);
    // the pond backs up the stream channel
    const len = Math.round(2 + 6 * c.dam);
    const path = [c.cell, ...upstreamPath(w, c.cell, len)];
    path.forEach((p, j) => {
      const depth = c.dam * (1 - j / (len + 2));
      L.pond[p] = Math.max(L.pond[p], depth);
      // flood low neighbours of the channel
      const px = p % w.W,
        py = (p / w.W) | 0;
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          if (!w.inside(px + ox, py + oy)) continue;
          const q = (py + oy) * w.W + px + ox;
          if (L.water[q] || L.town[q]) continue;
          if (L.elev[q] < L.elev[c.cell] + c.dam * 4) L.pond[q] = Math.max(L.pond[q], depth * 0.6);
        }
    });
    c.years += 1 / 12;
    if (food < 0.025) {
      c.n -= r.next() < 0.3 ? 1 : 0;
      if (c.n <= 1 || (food < 0.02 && c.years > 3)) {
        c.active = false;
        c.abandonedDay = w.day;
        if (hooks.onColonyAbandoned) hooks.onColonyAbandoned(c);
      }
    }
    // wolves take the odd beaver; a colony reduced below a pair is gone (v1.0 let the count go
    // negative while the colony stayed 'active', and a negative family regrew the vegetation)
    if (w.packs.some((p) => Math.hypot(p.x - x, p.y - y) < 4) && r.next() < 0.05) c.n = Math.max(0, c.n - 1);
    if (c.active && c.n < 2) {
      c.active = false;
      c.abandonedDay = w.day;
      if (hooks.onColonyAbandoned) hooks.onColonyAbandoned(c);
      continue;
    }
    // spring kits: any breeding pair with food raises a litter (v1.0 only bred colonies of 3+, inside
    // the dispersal step, so every colony founded by a dispersing pair stayed at 2 forever — D5)
    if (w.month === 2 && c.active && c.n >= 2 && food > 0.05 && c.n < 8) c.n += Math.round(r.intRange(1, 4) * smoothstep(0.05, 0.12, food));
    // two-year-olds disperse from crowded colonies to found new ones
    if (w.month === 3 && c.active && food > 0.07 && c.n >= 5) {
      // search the stream habitat within 3 km (v1.0 tried random cells in a box, which almost never hit
      // one of the few hundred stream cells beavers can use)
      const near = beaverHabitat(w).filter((h) => Math.abs((h % w.W) - x) <= 30 && Math.abs(((h / w.W) | 0) - y) <= 30);
      for (let k = 0; k < Math.min(30, near.length); k++) {
        const i = near[r.int(near.length)];
        const nx = i % w.W,
          ny = (i / w.W) | 0;
        if (beaverSiteScore(w, i) < 0.11) continue;
        if ([...w.colonies, ...newCols].some((o) => o.active && Math.hypot((o.cell % w.W) - nx, ((o.cell / w.W) | 0) - ny) < 10)) continue;
        const nc: Colony = { id: w.nextId(), cell: i, n: 2, food: 0.5, dam: 0.05, years: 0, active: true, abandonedDay: -1 };
        newCols.push(nc);
        c.n -= 2;
        if (hooks.onColonyFounded) hooks.onColonyFounded(nc);
        break;
      }
    }
  }
  w.colonies.push(...newCols);
  // beavers from neighbouring drainages now and then settle a valley that has room for them (not in
  // a valley set up without beavers): v1.0 had no recolonisation, so local extinction was permanent
  const active = w.colonies.filter((c) => c.active).length;
  if (w.month === 3 && w.config.beavers > 0 && active < w.config.beavers && r.next() < 0.15) {
    let best = -1,
      bs = 0.15;
    for (const i of beaverHabitat(w)) {
      const s = beaverSiteScore(w, i);
      if (s <= bs) continue;
      const ix = i % w.W,
        iy = (i / w.W) | 0;
      if (w.colonies.some((o) => o.active && Math.hypot((o.cell % w.W) - ix, ((o.cell / w.W) | 0) - iy) < 14)) continue;
      bs = s;
      best = i;
    }
    if (best >= 0) {
      const nc: Colony = { id: w.nextId(), cell: best, n: 2, food: 0.5, dam: 0.05, years: 0, active: true, abandonedDay: -1 };
      w.colonies.push(nc);
      if (hooks.onColonyFounded) hooks.onColonyFounded(nc);
    }
  }
  // forget long-abandoned colonies
  w.colonies = w.colonies.filter((c) => c.active || w.day - c.abandonedDay < 360 * 6);
  w.dirty.water++;
}

// ------------------------------------------------------------ entry points
let fearScratch: Float32Array | null = null;

export function wildlifeDaily(w: World, hooks: WildlifeHooks = {}): void {
  const L = w.L;
  // fields decay
  for (let i = 0; i < w.N; i++) {
    L.fear[i] *= 0.95;
    L.browse[i] *= 0.988;
  }
  for (const h of w.herds) updateHerd(w, h);
  for (const p of w.packs) updatePack(w, p, hooks);
  if (w.doy % 30 === 0) {
    herdsMonthly(w);
    packsMonthly(w, hooks);
    coloniesMonthly(w, hooks);
    // soften the fear field slightly (scent spreads)
    if (!fearScratch || fearScratch.length !== w.N) fearScratch = new Float32Array(w.N);
    const tmp = new Float32Array(w.N);
    boxBlur(L.fear, fearScratch, tmp, w.W, w.H, 1);
    for (let i = 0; i < w.N; i++) L.fear[i] = Math.max(L.fear[i] * 0.7, fearScratch[i]);
  }
}

export function deerCount(w: World): number {
  let n = 0;
  for (const h of w.herds) n += h.n;
  return n;
}
export function wolfCount(w: World): number {
  let n = 0;
  for (const p of w.packs) n += p.n;
  return n;
}
