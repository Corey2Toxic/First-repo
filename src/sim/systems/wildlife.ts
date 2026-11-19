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

function forage(w: World, i: number): number {
  const L = w.L;
  const g = greenness(w, i);
  const youngAspen = L.ageA[i] < 12 ? L.aspen[i] * 1.6 : L.aspen[i] * 0.25;
  const postFire = w.yearF - L.lastBurn[i] < 4 ? 0.25 : 0;
  return L.grass[i] * (0.35 + 0.65 * g) * (1 - 0.5 * L.graze[i]) + L.shrub[i] * 0.8 + youngAspen + postFire;
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

// ------------------------------------------------------------ herds
function updateHerd(w: World, h: Herd): void {
  const L = w.L;
  const r = w.rng.wildlife;
  h.px = h.x;
  h.py = h.y;
  const target = preferredElev(w.doy);
  const hx = Math.floor(h.x),
    hy = Math.floor(h.y);
  let best = hy * w.W + hx,
    bestS = -Infinity;
  const evalCell = (i: number) => {
    if (L.water[i] >= 2 || L.pond[i] > 0.4) return -Infinity;
    if (L.fire[i] === FIRE.BURNING) return -20;
    return (
      forage(w, i) * 1.3 -
      Math.min(2, L.snow[i] / 120) -
      L.fear[i] * 1.4 -
      humanPressure(w, i) -
      L.slope[i] * 0.6 -
      Math.abs(L.elev[i] - target) / 700 +
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
  // eat: draw down forage, leave browse pressure
  const cx = Math.floor(h.x),
    cy = Math.floor(h.y);
  let intake = 0;
  const per = h.n * 0.00009;
  for (let oy = -1; oy <= 1; oy++)
    for (let ox = -1; ox <= 1; ox++) {
      const x = cx + ox,
        y = cy + oy;
      if (!w.inside(x, y)) continue;
      const i = y * w.W + x;
      const f = forage(w, i);
      intake += f;
      L.grass[i] = Math.max(0, L.grass[i] - per * 0.6);
      L.shrub[i] = Math.max(0, L.shrub[i] - per * 0.35);
      L.browse[i] = clamp01(L.browse[i] + h.n * 0.0011);
    }
  // deep snow buries grass and costs energy; deer live off autumn fat through winter
  const snow = L.snow[cy * w.W + cx];
  const need = 0.5 + Math.min(0.45, snow / 250);
  const avail = intake * (1 - 0.55 * Math.min(1, snow / 120));
  const ratio = avail / 9 / need;
  h.fed = ratio;
  if (w.season === 3 || (w.season === 2 && snow > 30)) {
    // winter: living off autumn fat; deep snow costs more, browse above the snow helps
    h.cond = clamp01(h.cond - (0.0022 + 0.0018 * Math.min(1, snow / 150) - 0.0012 * Math.min(1, ratio)));
  } else {
    // growing season: condition tracks forage per animal (density dependence)
    const target = clamp01(0.3 + 0.62 * Math.min(1.15, ratio));
    h.cond += (target - h.cond) * 0.03;
  }
}

/** Deer the valley can feed: forage summed over the land (sampled). */
export function deerCapacity(w: World): number {
  let f = 0;
  for (let i = 0; i < w.N; i += 3) if (!w.L.water[i] && !w.L.town[i]) f += forage(w, i);
  return Math.max(50, f * 3 * 0.19);
}

function herdsMonthly(w: World): void {
  const r = w.rng.wildlife;
  const month = w.month;
  // density dependence: crowded herds raise fewer fawns and starve more
  let total = 0;
  for (const h of w.herds) total += h.n;
  const K = w.month === 2 || w.month === 10 ? deerCapacity(w) : (w.memory.deerK ?? deerCapacity(w));
  w.memory.deerK = K;
  const crowd = total / K;
  for (const h of w.herds) {
    if (month === 2) h.n += Math.round(h.n * 0.5 * smoothstep(0.2, 0.7, h.cond) * Math.max(0, 1 - crowd * 0.85)); // fawning
    let deaths = h.n * 0.006 + h.n * 0.05 * Math.max(0, crowd - 0.95);
    if (h.cond < 0.2) deaths += h.n * 0.08 * (1 - h.cond / 0.2);
    h.n = Math.max(0, h.n - Math.round(deaths + r.next() * 0.5));
    if (month === 8) {
      const rate = w.policies.hunting === 'heavy' ? 0.2 : w.policies.hunting === 'moderate' ? 0.09 : 0;
      const taken = Math.round(h.n * rate);
      if (taken > 0) {
        h.n -= taken;
        w.counters.yearHunted += taken;
        w.earn('Hunting licenses', taken * REVENUE.huntLicense);
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
function updatePack(w: World, p: Pack, hooks: WildlifeHooks): void {
  const L = w.L;
  const r = w.rng.wildlife;
  p.px = p.x;
  p.py = p.y;
  // bigger packs need more food
  p.hunger = Math.min(2, p.hunger + 0.025 + 0.018 * p.n);
  let tx = p.tx + r.range(-14, 14),
    ty = p.ty + r.range(-14, 14);
  let speed = 3.5;
  if (p.hunger > 0.4) {
    let best: Herd | null = null,
      bs = -Infinity;
    for (const h of w.herds) {
      const dT = Math.hypot(h.x - p.tx, h.y - p.ty);
      const dP = Math.hypot(h.x - p.x, h.y - p.y);
      if (dT > 45 && dP > 14) continue;
      const vuln = (1.25 - h.cond) * (1 + Math.min(1, L.snow[Math.floor(h.y) * w.W + Math.floor(h.x)] / 120));
      const s = vuln * Math.sqrt(h.n) - dP * 0.08;
      if (s > bs) {
        bs = s;
        best = h;
      }
    }
    if (best) {
      p.targetHerd = best.id;
      tx = best.x;
      ty = best.y;
      speed = 6;
    }
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
    const s = Math.min(dist, speed);
    const nx = p.x + (dx / dist) * s,
      ny = p.y + (dy / dist) * s;
    if (w.inside(Math.floor(nx), Math.floor(ny)) && L.water[Math.floor(ny) * w.W + Math.floor(nx)] < 2) {
      p.x = nx;
      p.y = ny;
    }
  }
  // the hunt: once the pack has closed on its target herd (after both have moved today)
  if (p.targetHerd >= 0) {
    const best = w.herds.find((h) => h.id === p.targetHerd);
    if (best && Math.hypot(best.x - p.x, best.y - p.y) < 2.5) {
      const snow = L.snow[Math.floor(best.y) * w.W + Math.floor(best.x)];
      // type II functional response: scarce, wary prey is hard to find and corner
      const density = w.memory.deerK ? deerTotal(w) / w.memory.deerK : 0.5;
      const scarcity = smoothstep(0.02, 0.32, density);
      const pSuccess = 0.33 * Math.sqrt(p.n / 5) * (0.6 + 0.8 * (1 - best.cond)) * (snow > 60 ? 1.4 : 1) * (0.25 + 0.75 * scarcity);
      if (r.next() < pSuccess) {
        const k = p.n >= 8 && best.n > 3 ? 2 : 1;
        best.n = Math.max(0, best.n - k);
        p.hunger = Math.max(0, p.hunger - 0.9 * k);
        p.kills += k;
        // territories drift toward where the hunting is good
        p.tx += (best.x - p.tx) * 0.04;
        p.ty += (best.y - p.ty) * 0.04;
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
  if (p.hunger > 0.7 && w.month >= 1 && w.month <= 7 && w.policies.grazing !== 'none') {
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
      p.hunger = Math.max(0, p.hunger - 0.8);
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
  for (const p of w.packs) {
    const preyRatio = w.memory.deerK ? deerTotal(w) / w.memory.deerK : 0.5;
    const preyRich = preyRatio > 0.18;
    if (w.month === 2 && p.hunger < 0.9 && p.n < 12 && preyRich) p.n += r.intRange(1, 4);
    if (r.next() < 0.04 * (p.n / 5)) p.n -= 1; // natural mortality
    if (p.hunger > 1.8 && r.next() < 0.35) p.n -= 1; // starvation
    if (w.policies.wolfPolicy === 'bounty' && r.next() < 0.45) {
      p.n -= 1;
      w.counters.yearWolvesKilled++;
      if (hooks.onWolvesKilled) hooks.onWolvesKilled(p, 1);
    }
    // dispersal: young wolves found new packs where there is room
    if (p.n >= 9 && w.month >= 6 && w.month <= 9 && preyRatio > 0.3) {
      for (let k = 0; k < 40; k++) {
        const ang = r.range(0, Math.PI * 2),
          d = r.range(28, 60);
        const x = p.tx + Math.cos(ang) * d,
          y = p.ty + Math.sin(ang) * d;
        if (!w.inside(Math.floor(x), Math.floor(y))) continue;
        if (w.L.water[Math.floor(y) * w.W + Math.floor(x)] >= 2) continue;
        if ([...w.packs, ...born].some((o) => Math.hypot(o.tx - x, o.ty - y) < 48)) continue;
        if (w.towns.some((t) => Math.hypot(t.x - x, t.y - y) < 16)) continue;
        const np: Pack = { id: w.nextId(), name: names.packName(), x: p.x, y: p.y, px: p.x, py: p.y, n: 3, tx: x, ty: y, hunger: 0.5, targetHerd: -1, kills: 0, founded: w.day };
        p.n -= 3;
        born.push(np);
        if (hooks.onPackFormed) hooks.onPackFormed(np, p);
        break;
      }
    }
  }
  w.packs.push(...born);
  for (const p of w.packs) if (p.n < 2 && hooks.onPackLost) hooks.onPackLost(p);
  w.packs = w.packs.filter((p) => p.n >= 2);
  // wolves recolonise empty valleys on their own, now and then (not under a bounty)
  if (w.packs.length === 0 && w.month === 9 && w.policies.wolfPolicy !== 'bounty' && r.next() < 0.06) {
    const edge = r.int(4);
    const x = edge === 0 ? 3 : edge === 1 ? w.W - 4 : r.range(10, w.W - 10);
    const y = edge === 2 ? 3 : edge === 3 ? w.H - 4 : r.range(10, w.H - 10);
    if (w.L.water[Math.floor(y) * w.W + Math.floor(x)] < 2) {
      const np: Pack = { id: w.nextId(), name: names.packName(), x, y, px: x, py: y, n: 2, tx: w.W / 2 + (x - w.W / 2) * 0.5, ty: w.H / 2 + (y - w.H / 2) * 0.5, hunger: 0.6, targetHerd: -1, kills: 0, founded: w.day };
      w.packs.push(np);
      if (hooks.onPackFormed) hooks.onPackFormed(np, np);
    }
  }
}

function deerTotal(w: World): number {
  let n = 0;
  for (const h of w.herds) n += h.n;
  return n;
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
        if (growing) {
          L.aspen[j] = Math.max(0, L.aspen[j] - 0.0022 * c.n);
          L.shrub[j] = Math.max(0, L.shrub[j] - 0.0016 * c.n);
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
    // wolves take the odd beaver
    if (w.packs.some((p) => Math.hypot(p.x - x, p.y - y) < 4) && r.next() < 0.05) c.n--;
    // yearly dispersal of young
    if (w.month === 3 && c.active && food > 0.07 && c.n >= 3) {
      if (c.n < 7) c.n += 2;
      for (let k = 0; k < 30; k++) {
        const nx = x + r.intRange(-30, 30),
          ny = y + r.intRange(-30, 30);
        if (!w.inside(nx, ny)) continue;
        const i = ny * w.W + nx;
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
