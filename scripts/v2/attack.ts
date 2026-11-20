/**
 * Why does initial attack succeed or fail? For every wildfire: how long before it was reported, how
 * big it was by then, how long until a crew was working it and how big it was by then, how much of
 * its edge a hand crew could face, and what became of it.
 *
 *   node scripts/v2/attack.ts <scenario> <seed> <years> [--all]
 */
import { loadSim } from './lib.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const scen = args[0] ?? 'tinderbox';
const seed = args[1] ?? 'cal-a';
const years = Number(args[2] ?? 10);
const S = await loadSim();
const FIRE = S.types.FIRE;
const w = S.generateWorld(S.makeConfig(scen, seed));
w.config.tenureYears = Math.max(w.config.tenureYears, years + 1);
const sim = new S.Simulation(w, {}, { autoReview: true });

interface Rec {
  id: number;
  cause: string;
  start: number; // tick
  doy: number;
  sub0: number;
  wind0: number;
  danger0: number;
  under0: number;
  canopy0: number;
  detect: number; // tick (-1: never)
  areaDetect: number;
  assign: number; // tick a crew was first sent
  freeAtReport: number;
  arrive: number; // tick a crew first worked it
  areaArrive: number;
  hotShare: number; // share of burning edge above the hand-crew flame limit at arrival
  crewsAt: number;
  area24: number; // area a day after the report
  final: number;
  days: number;
  stationDist: number;
}
const recs = new Map<number, Rec>();
let tick = 0;
const total = years * 360 * 8;
for (; tick < total; tick++) {
  if (w.review.pending) S.autoCloseReview(w, false);
  if (w.outcome.ended) break;
  sim.tick();
  for (const fe of w.fires) {
    if (fe.cause === 'prescribed') continue;
    let r = recs.get(fe.id);
    if (!r) {
      if (!fe.active) continue;
      const c = fe.originY * w.W + fe.originX;
      const f = S.fuels.cellFuel(w, c);
      let sd = Infinity;
      for (const t of w.towns) sd = Math.min(sd, Math.hypot((t.station % w.W) - fe.originX, ((t.station / w.W) | 0) - fe.originY));
      for (const cr of w.crews) sd = Math.min(sd, Math.hypot((cr.home % w.W) - fe.originX, ((cr.home / w.W) | 0) - fe.originY));
      r = { id: fe.id, cause: fe.cause, start: tick, doy: w.day % 360, sub0: w.sub, wind0: w.weather.windSpeed, danger0: w.weather.dangerClass, under0: w.L.under ? w.L.under[c] : 0, canopy0: f.canopy, detect: -1, areaDetect: 0, assign: -1, freeAtReport: -1, arrive: -1, areaArrive: 0, hotShare: 0, crewsAt: 0, area24: -1, final: 0, days: 0, stationDist: sd };
      recs.set(fe.id, r);
    }
    if (r.detect < 0 && fe.detected) {
      r.detect = tick;
      r.areaDetect = fe.area;
      r.freeAtReport = w.crews.filter((c: any) => c.kind === 'hand' && (c.state === 'idle' || c.task?.kind === 'project' || c.task?.fireId === fe.id)).length;
    }
    if (r.assign < 0 && w.crews.some((c: any) => c.task?.fireId === fe.id && c.kind === 'hand')) r.assign = tick;
    if (r.detect >= 0 && r.area24 < 0 && tick - r.detect >= 8) r.area24 = fe.area;
    if (r.arrive < 0 && fe.active) {
      const on = w.crews.filter((c: any) => c.task?.fireId === fe.id && c.state === 'working' && c.kind !== 'engine');
      if (on.length) {
        r.arrive = tick;
        r.areaArrive = fe.area;
        r.crewsAt = on.length;
        let edge = 0,
          hot = 0;
        for (const b of w.burning) {
          if (w.L.fid[b] !== fe.id) continue;
          edge++;
          if (w.L.crown[b] === 1 || w.L.fint[b] > S.fire.FLAME_LIMIT.hand) hot++;
        }
        r.hotShare = edge ? hot / edge : 0;
      }
    }
    if (!fe.active && r.final === 0) {
      r.final = fe.area;
      r.days = fe.outDay - fe.startDay;
      if (r.area24 < 0) r.area24 = fe.area;
    }
  }
}
void FIRE;
const all = [...recs.values()].filter((r) => r.final > 0);
const h = (t: number) => (t * 3).toFixed(0).padStart(4);
const med = (a: number[]) => (a.length ? a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);
const caught = all.filter((r) => r.final < 10),
  escaped = all.filter((r) => r.final >= 10);
const summary = (name: string, rs: Rec[]) => {
  const det = rs.filter((r) => r.detect >= 0);
  const arr = rs.filter((r) => r.arrive >= 0);
  console.log(
    `${name.padEnd(18)} n ${String(rs.length).padStart(3)} | report after ${med(det.map((r) => (r.detect - r.start) * 3)).toFixed(0)} h at ${med(det.map((r) => r.areaDetect)).toFixed(0)} ha | crew working ${med(arr.map((r) => (r.arrive - r.detect) * 3)).toFixed(0)} h later at ${med(arr.map((r) => r.areaArrive)).toFixed(0)} ha (never: ${rs.length - arr.length}) | edge too hot for hand crews ${Math.round(100 * (arr.reduce((a, r) => a + r.hotShare, 0) / Math.max(1, arr.length)))}% | start wind ${med(rs.map((r) => r.wind0)).toFixed(1)} danger ${med(rs.map((r) => r.danger0))} under ${med(rs.map((r) => r.under0)).toFixed(2)} station ${med(rs.map((r) => r.stationDist)).toFixed(0)} cells`,
  );
};
console.log(`${scen} ${seed}, ${years} years: ${all.length} wildfires, ${caught.length} under 10 ha (${Math.round((100 * caught.length) / Math.max(1, all.length))}%)`);
summary('caught (<10 ha)', caught);
summary('escaped (>=10 ha)', escaped);
summary('  of which >=1000', escaped.filter((r) => r.final >= 1000));
// did the first day decide it?
const by = (f: (r: Rec) => boolean) => {
  const g = all.filter(f);
  return `${g.filter((r) => r.final < 10).length}/${g.length}`;
};
console.log(`caught by size when a crew started work: <=2 ha ${by((r) => r.arrive >= 0 && r.areaArrive <= 2)}, 3-9 ha ${by((r) => r.arrive >= 0 && r.areaArrive > 2 && r.areaArrive < 10)}, >=10 ha ${by((r) => r.arrive >= 0 && r.areaArrive >= 10)}, no crew ever ${by((r) => r.arrive < 0)}`);
console.log(`caught by danger class at ignition: ${[0, 1, 2, 3, 4].map((d) => d + ': ' + by((r) => r.danger0 === d)).join(', ')}`);
console.log(`caught by cause: ${['lightning', 'human', 'escaped', 'ember'].map((c) => c + ' ' + by((r) => r.cause === c)).join(', ')}`);
console.log(`caught by hour of ignition: ${[0, 1, 2, 3, 4, 5, 6, 7].map((s) => s * 3 + 'h ' + by((r) => r.sub0 === s)).join(', ')}`);
if (flags.has('--all'))
  for (const r of all.sort((a, b) => b.final - a.final).slice(0, 60))
    console.log(
      `  y${Math.floor((r.start / 8) / 360) + 1} d${String(r.doy).padStart(3)} ${String(r.sub0 * 3).padStart(2)}h ${r.cause.padEnd(9)} wind ${r.wind0.toFixed(1).padStart(4)} dc ${r.danger0} under ${r.under0.toFixed(2)} can ${r.canopy0.toFixed(2)} stn ${r.stationDist.toFixed(0).padStart(3)} | report +${h(r.detect - r.start)}h ${String(r.areaDetect).padStart(4)} ha | free ${r.freeAtReport} sent +${r.assign < 0 ? '   -' : h(r.assign - r.detect)}h work +${r.arrive < 0 ? '   -' : h(r.arrive - r.detect)}h ${String(r.areaArrive).padStart(4)} ha x${r.crewsAt} hot ${Math.round(r.hotShare * 100)}% | +24h ${String(r.area24).padStart(5)} | final ${String(r.final).padStart(6)} ha ${r.days} d`,
    );
