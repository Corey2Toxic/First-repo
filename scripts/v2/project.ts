/**
 * How good are the projections? Three checks on the projection engine (src/sim/projection.ts):
 *
 *   node scripts/v2/project.ts lab                       projected vs simulated spread on uniform fuel
 *   node scripts/v2/project.ts skill <scenario> <seed> [years]
 *                                                        project real fires 24 h ahead, then see what they did
 *   node scripts/v2/project.ts shed <scenario> <seed>    each town's fireshed and exposure, and what treatment does to them
 *   node scripts/v2/project.ts homes                     homes the simulation takes from a town a design-day fire reaches,
 *                                                        against the fireshed's `exposed` (treated or not, hardened or not)
 */
import { loadSim, flatValley, BEDS } from './lib.ts';

const mode = process.argv[2] ?? 'lab';
const S = await loadSim();
const P = await import('../../src/sim/projection.ts');
const projects = await import('../../src/sim/systems/projects.ts');
const FIRE = S.types.FIRE;

if (mode === 'lab') {
  console.log('Uniform fuel, real afternoon and evening (four 3-hour steps from 12:00), 10 m wind as given.');
  console.log('head = distance run downwind in 12 h (cells of 100 m); area in ha; simulated = mean of 8 runs');
  for (const bed of BEDS) {
    for (const wind of [3, 8]) {
      let simHead = 0,
        simArea = 0;
      const reps = 8;
      let w0: any = null;
      for (let k = 0; k < reps; k++) {
        const w = flatValley(S, bed, { w: 260, h: 121, wind, fm: 0.07, sub: 4 });
        w.rng.fire = w.rng.fire.fork('lab' + k);
        if (!w0) w0 = flatValley(S, bed, { w: 260, h: 121, wind, fm: 0.07, sub: 4 });
        const c = 60 * w.W + 40;
        S.fire.startFire(w, c, 'lightning');
        for (let s = 0; s < 4; s++) {
          w.sub = 4 + s;
          if (w.burning.length) S.fire.fireSubstep(w);
        }
        let maxX = 40,
          n = 0;
        for (let i = 0; i < w.N; i++)
          if (w.L.fire[i] !== FIRE.NONE || w.L.lastBurn[i] > 0) {
            n++;
            if (Math.floor(i / w.W) === 60) maxX = Math.max(maxX, i % w.W);
          }
        simHead += maxX - 40;
        simArea += n;
      }
      const t0 = performance.now();
      const pr = P.projectSpread(w0, { ignite: [60 * w0.W + 40], hours: 12 });
      const ms = performance.now() - t0;
      let pHead = 40,
        pArea = 0;
      for (let i = 0; i < w0.N; i++)
        if (pr.arrival[i] <= 12) {
          pArea++;
          if (Math.floor(i / w0.W) === 60) pHead = Math.max(pHead, i % w0.W);
        }
      console.log(
        `${bed.name.padEnd(26)} wind ${wind}: head simulated ${(simHead / reps).toFixed(1).padStart(6)} projected ${String(pHead - 40).padStart(4)} | area simulated ${(simArea / reps).toFixed(0).padStart(6)} projected ${String(pArea).padStart(6)} | ${ms.toFixed(0)} ms`,
      );
    }
  }
}

if (mode === 'skill') {
  const scen = process.argv[3] ?? 'tinderbox';
  const seed = process.argv[4] ?? 'cal-a';
  const years = Number(process.argv[5] ?? 8);
  const w = S.generateWorld(S.makeConfig(scen, seed));
  w.config.tenureYears = years + 1;
  const sim = new S.Simulation(w, {}, { autoReview: true });
  const rows: string[] = [];
  let pending: null | { fireId: number; day: number; area0: number; proj: any; burned0: Uint8Array; name: string; ms: number } = null;
  const ratios: number[] = [],
    recalls: number[] = [],
    precisions: number[] = [];
  for (let t = 0; t < years * 360 * 8; t++) {
    if (w.review.pending) S.autoCloseReview(w, false);
    if (w.outcome.ended) break;
    sim.tick();
    if (pending && (w.day - pending.day) * 8 + w.sub >= 8 + 3) {
      // 24 hours later (made at 09:00)
      const fe = w.fires.find((f: any) => f.id === pending!.fireId);
      let actual = 0,
        inside = 0,
        projN = 0;
      for (let i = 0; i < w.N; i++) {
        const burnedNow = (w.L.fid[i] === pending.fireId && w.L.fire[i] !== FIRE.NONE) || (w.L.lastBurn[i] > 0 && w.yearF - w.L.lastBurn[i] < 0.01);
        const isNew = burnedNow && !pending.burned0[i];
        const projected = pending.proj.arrival[i] <= 24 && pending.proj.arrival[i] > 0;
        if (projected) projN++;
        if (isNew) {
          actual++;
          if (projected) inside++;
        }
      }
      if (projN + actual >= 20) {
        const ratio = actual / Math.max(1, projN);
        ratios.push(ratio);
        if (actual > 0) recalls.push(inside / actual);
        if (projN > 0) precisions.push(inside / projN);
        rows.push(`  ${pending.name.padEnd(26)} at ${String(pending.area0).padStart(5)} ha: projected +${String(projN).padStart(5)} actual +${String(actual).padStart(5)}  ratio ${ratio.toFixed(2)}  of what burned ${Math.round((100 * inside) / Math.max(1, actual))}% was inside the projection  (${pending.ms.toFixed(0)} ms)${fe && !fe.active ? ' out' : ''}`);
      }
      pending = null;
    }
    // every morning at 09:00, project the largest reported fire that crews are NOT working (a fair test of the fire model)
    if (!pending && w.sub === 3) {
      const cands = w.fires.filter((f: any) => f.active && f.detected && f.cause !== 'prescribed' && f.area >= 30);
      if (cands.length) {
        const fe = cands.sort((a: any, b: any) => b.area - a.area)[0];
        const t0 = performance.now();
        const proj = P.projectSpread(w, { fireId: fe.id, hours: 24 });
        const ms = performance.now() - t0;
        const burned0 = new Uint8Array(w.N);
        for (let i = 0; i < w.N; i++) if (w.L.fire[i] !== FIRE.NONE || (w.L.lastBurn[i] > 0 && w.yearF - w.L.lastBurn[i] < 0.2)) burned0[i] = 1;
        pending = { fireId: fe.id, day: w.day, area0: fe.area, proj, burned0, name: fe.name, ms };
      }
    }
  }
  console.log(`${scen} ${seed}: ${rows.length} 24-hour projections of real fires (crews working as usual)`);
  console.log(rows.slice(0, 40).join('\n'));
  const q = (a: number[], p: number) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN);
  console.log(`actual/projected area: p10 ${q(ratios, 0.1).toFixed(2)} median ${q(ratios, 0.5).toFixed(2)} p90 ${q(ratios, 0.9).toFixed(2)}`);
  console.log(`share of what burned that the projection covered: p10 ${q(recalls, 0.1).toFixed(2)} median ${q(recalls, 0.5).toFixed(2)}`);
  console.log(`share of the projection that burned: median ${q(precisions, 0.5).toFixed(2)}`);
}

if (mode === 'shed') {
  const scen = process.argv[3] ?? 'tinderbox';
  const seed = process.argv[4] ?? 'cal-a';
  const w = S.generateWorld(S.makeConfig(scen, seed));
  const sim = new S.Simulation(w, {}, { autoReview: true, ignitions: false });
  sim.runDays(120);
  const show = (label: string) => {
    const t0 = performance.now();
    const fs = P.computeFireshed(w);
    const ms = performance.now() - t0;
    console.log(`${label}  (${ms.toFixed(0)} ms)`);
    for (const te of fs.towns) {
      const t = w.towns[te.id];
      console.log(`   ${String(t.name).padEnd(14)} homes ${String(te.homes).padStart(3)}  exposed ${te.exposed.toFixed(1).padStart(5)}  fireshed 6 h ${String(te.area6).padStart(5)} ha, 12 h ${String(te.area12).padStart(5)} ha  crown at the edge ${Math.round(te.crownEdge * 100)}%  firewise ${t.firewise.toFixed(2)}  RISK ${te.risk.toFixed(0)}`);
    }
    return fs;
  };
  const fs0 = show(`${scen} ${seed}: firesheds as generated`);
  const cls = [0, 0, 0, 0, 0];
  let land = 0;
  for (let i = 0; i < w.N; i++) if (w.L.water[i] < 2) { land++; cls[fs0.behaviour[i]]++; }
  console.log(`   design-day behaviour of the valley: no fire ${Math.round((100 * cls[0]) / land)}%, hand-workable ${Math.round((100 * cls[1]) / land)}%, too hot for hand crews ${Math.round((100 * cls[2]) / land)}%, too hot for engines ${Math.round((100 * cls[3]) / land)}%, torching ${Math.round((100 * cls[4]) / land)}%`);
  // thin the ground within 400 m of every home
  const near = new Uint8Array(w.N);
  for (let i = 0; i < w.N; i++) {
    if (w.L.town[i] <= 0) continue;
    const x = i % w.W,
      y = (i / w.W) | 0;
    for (let dy = -10; dy <= 10; dy++)
      for (let dx = -10; dx <= 10; dx++) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w.W || ny >= w.H) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const n = ny * w.W + nx;
        if (w.L.town[n] !== 0 || w.L.water[n]) continue;
        near[n] = Math.max(near[n], d <= 4 ? 2 : 1);
      }
  }
  let thinned = 0;
  for (let i = 0; i < w.N; i++) if (near[i] === 2) { projects.applyThinning(w, i); thinned++; }
  show(`after thinning ${thinned} ha within 400 m of homes`);
  let burned = 0;
  for (let i = 0; i < w.N; i++) if (near[i] >= 1) { S.fire.applyFireEffects(w, i, 1); burned++; }
  show(`after also underburning ${burned} ha within 1 km of homes`);
  for (const t of w.towns) t.firewise = Math.min(1, t.firewise + 0.32);
  show('after also completing the firewise programme');
}

if (mode === 'homes') {
  const beds: Record<string, any> = {
    grass: { name: 'grass', grass: 0.85, litter: 0.4, dead: 5 },
    pine: { name: 'pine', grass: 0.05, pine: 0.55, litter: 6, dead: 8, ageP: 120 },
    thicket: { name: 'thicket', grass: 0.05, pine: 0.4, fir: 0.45, shrub: 0.3, litter: 16, dead: 30, under: 0.85, ageP: 120, ageF: 120 },
  };
  const valley = (bed: any, firewise: number, treat: boolean) => {
    const w = flatValley(S, bed, { w: 160, h: 81, wind: 7, fm: 0.06, drought: 0.6 });
    const homes: Array<[number, number]> = [];
    for (let y = 37; y <= 43; y += 2) for (let x = 100; x <= 104; x += 2) homes.push([x, y]);
    w.towns.push({ id: 0, name: 'T', x: 102, y: 40, population: 400, structures: homes.length, lostStructures: 0, mill: false, station: 40 * w.W + 102, firewise, smokeToday: 0, smokeDays: 0, threat: 0, evacuated: false, growthPressure: 0, happiness: 0.5 });
    for (const [hx, hy] of homes) w.L.town[hy * w.W + hx] = 1;
    if (treat)
      for (let y = 30; y <= 50; y++)
        for (let x = 93; x <= 111; x++) {
          const i = y * w.W + x;
          if (w.L.town[i] !== 0) continue;
          projects.applyThinning(w, i);
          S.fire.applyFireEffects(w, i, 1);
          w.L.fire[i] = FIRE.NONE;
          w.L.lastBurn[i] = w.yearF - 3;
          w.L.litter[i] = 5;
        }
    return w;
  };
  const design = { name: 'westerly', windSpeed: 7, windDir: 0, windEvent: false, fm: 0.06 };
  console.log('A town of 12 homes, a fire front 1.2 km upwind on the westerly design day; mean of 12 runs.');
  for (const [name, bed, fw, treat] of [
    ['grass', beds.grass, 0, false],
    ['open pine litter', beds.pine, 0, false],
    ['thicket', beds.thicket, 0, false],
    ['thicket, firewise 0.9', beds.thicket, 0.9, false],
    ['thicket, thinned and burned', beds.thicket, 0, true],
    ['thicket, treated and firewise', beds.thicket, 0.9, true],
  ] as Array<[string, any, number, boolean]>) {
    let lost = 0;
    const reps = 12;
    for (let k = 0; k < reps; k++) {
      const w = valley(bed, fw, treat);
      w.weather.rh = 0.15;
      w.rng.fire = w.rng.fire.fork('homes' + k);
      for (let y = 30; y <= 50; y += 2) S.fire.startFire(w, y * w.W + 86, 'lightning');
      w.sub = 4;
      for (let s = 0; s < 400 && w.burning.length; s++) {
        S.fire.fireSubstep(w);
        w.sub++;
        if (w.sub === 8) {
          w.sub = 0;
          w.day++;
        }
      }
      for (let i = 0; i < w.N; i++) if (w.L.town[i] < 0) lost++;
    }
    const te = P.computeFireshed(valley(bed, fw, treat), [design]).towns[0];
    console.log(`  ${name.padEnd(30)} simulation took ${(lost / reps).toFixed(1).padStart(4)} of 12 | fireshed says ${te.exposed.toFixed(1).padStart(4)} exposed, crown at the edge ${Math.round(te.crownEdge * 100)}%, risk ${te.risk.toFixed(0)}`);
  }
}
