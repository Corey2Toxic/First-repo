/**
 * Save/reload fork check (a release gate). Plays one long game per scenario and seed; every ~200 days,
 * and at extra points while a reported fire burns, it saves and reloads the world into a fork, runs
 * the fork 360 days and compares it with the uninterrupted game at the same moment: every per-cell
 * layer, the random streams, herds, packs, colonies, crews, towns, economy, factions, active fires,
 * the entity counter and the state hash. Adapted from the independent verification's fork experiment
 * (`exp_i_saveload.ts`), which found verification finding R1.
 *
 *   node scripts/qa/forkcheck.ts [simRoot|-] [years] [scenario:seed ...]
 *
 * Defaults: this checkout, 26 years, tinderbox:audit-save-1 boomtown:audit-save-2 (the verification's
 * cases). Exits with status 1 if any fork diverges.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [rootArg, yearsArg, ...caseArgs] = process.argv.slice(2);
const root = resolve(rootArg && rootArg !== '-' ? rootArg : new URL('../../src/sim', import.meta.url).pathname);
const imp = (p: string) => import(pathToFileURL(`${root}/${p}`).href);
const { generateWorld } = await imp('gen/index.ts');
const { makeConfig } = await imp('scenarios.ts');
const { Simulation } = await imp('sim.ts');
const { applyAllocation } = await imp('systems/council.ts');
const { encodeWorld, decodeWorld, stateHash } = await imp('save.ts');
const { LAYER_SPECS } = await imp('world.ts');

const years = Number(yearsArg ?? 26);
const cases = (caseArgs.length ? caseArgs : ['tinderbox:audit-save-1', 'boomtown:audit-save-2']).map((c) => c.split(':') as [string, string]);
const K = 360;

// the council's review is answered the same way in both copies: every petition refused
const close = (w: any) => {
  for (const p of w.review.petitions) {
    p.resolved = true;
    p.accepted = false;
  }
  w.review.pending = false;
  applyAllocation(w);
};
function layerHash(w: any): number {
  let h = 2166136261 >>> 0;
  for (const name of Object.keys(LAYER_SPECS)) {
    if (name === 'fid') continue;
    const a = w.L[name];
    const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619) >>> 0;
  }
  return h;
}
function snapshot(w: any): Record<string, string | number> {
  return {
    layers: layerHash(w),
    rng: JSON.stringify(Object.fromEntries(Object.entries(w.rng).map(([k, r]: [string, any]) => [k, r.getState()]))),
    herds: JSON.stringify(w.herds.map((h: any) => [h.id, h.x, h.y, h.n, h.cond])),
    packs: JSON.stringify(w.packs.map((p: any) => [p.x, p.y, p.n, p.hunger, p.tx, p.ty])),
    colonies: JSON.stringify(w.colonies.map((c: any) => [c.cell, c.n, c.dam, c.active])),
    crews: JSON.stringify(w.crews.map((c: any) => [c.x, c.y, c.state, c.fatigue])),
    towns: JSON.stringify(w.towns.map((t: any) => [t.population, t.structures, t.firewise])),
    economy: JSON.stringify(w.economy.funds),
    factions: JSON.stringify(w.factions),
    activeFires: JSON.stringify(w.fires.filter((f: any) => f.active).map((f: any) => [f.id, f.area, f.cause])),
    fireCount: w.fires.length,
    nextId: w.counters.nextId,
    notifications: w.notifications.length,
    stateHash: stateHash(w),
  };
}

let trials = 0,
  diverged = 0,
  midFire = 0;
for (const [scen, seed] of cases) {
  const A = generateWorld(makeConfig(scen, seed, 'medium', { tenureYears: 999 }));
  const simA = new Simulation(A, {}, {});
  const pending = new Map<number, Array<{ tag: string; st: Record<string, string | number> }>>();
  let lastSave = -999,
    extraFire = 0;
  for (let t = 0; t < 8 * 360 * years; t++) {
    if (A.review.pending) close(A);
    simA.tick();
    const fireNow = A.fires.some((f: any) => f.active && f.detected && f.area > 30);
    if (A.sub === 3 && (A.day - lastSave >= 200 || (fireNow && extraFire < 25 && A.day - lastSave >= 20))) {
      if (fireNow) {
        extraFire++;
        midFire++;
      }
      lastSave = A.day;
      const B = decodeWorld(encodeWorld(A));
      const simB = new Simulation(B, {}, {});
      const target = A.day + K;
      while (B.day < target || B.sub !== A.sub) {
        if (B.review.pending) close(B);
        simB.tick();
      }
      const arr = pending.get(target) ?? [];
      arr.push({ tag: `${scen}:${seed} day ${A.day}${fireNow ? ' (mid-fire)' : ''}`, st: snapshot(B) });
      pending.set(target, arr);
    }
    if (A.sub === 3 && pending.has(A.day)) {
      const a = snapshot(A);
      for (const { tag, st } of pending.get(A.day)!) {
        trials++;
        const diff = Object.keys(a).filter((k) => a[k] !== st[k]);
        if (diff.length) {
          diverged++;
          console.log(`  DIVERGED ${tag}: after ${K} days differs in [${diff.join(', ')}]`);
        }
      }
      pending.delete(A.day);
    }
  }
  console.log(`${scen}:${seed}: ${years} years played; running total ${trials} reloads compared, ${diverged} diverged`);
}
console.log(`forkcheck: ${trials} reloads (${midFire} mid-fire) compared after ${K} days; ${diverged} diverged`);
process.exit(diverged ? 1 : 0);
