/**
 * The life of every sizeable wildfire in a run, day by day: the weather it met, how fast it was
 * found, when crews reached it, how it grew, who worked it and what ended it. This is the tool for
 * answering "why did that fire get away?".
 *
 *   node scripts/v2/firetrace.ts <scenario> <seed> <years> [minHa=200] [default|nodispatch|noaid]
 *   add --steps to print the largest fire 3 hours at a time
 */
import { loadSim } from './lib.ts';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const scen = args[0] ?? 'tinderbox';
const seed = args[1] ?? 's1';
const years = Number(args[2] ?? 6);
const minHa = Number(args[3] ?? 200);
const mode = args[4] ?? 'default';

const S = await loadSim();
const w = S.generateWorld(S.makeConfig(scen, seed));
w.config.tenureYears = years + 1;
if (mode === 'nodispatch') w.policies.autoDispatch = false;
if (mode === 'noaid' && 'mutualAid' in w.policies) w.policies.mutualAid = 'manual';
const sim = new S.Simulation(w, {}, { autoReview: true });
const FIRE = S.types.FIRE;

interface Track {
  fe: any;
  startT: number;
  dc0: number;
  wind0: number;
  fm0: number;
  detT: number;
  crewT: number;
  areaAtCrew: number;
  days: string[];
  steps: string[];
  lastDay: number;
  dayStartArea: number;
  maxCrews: number;
  aidDay: number;
  rainOut: boolean;
}
const track = new Map<number, Track>();
const done: Track[] = [];

for (let t = 0; t < years * 360 * 8; t++) {
  if (w.review.pending) S.autoCloseReview(w, false);
  if (w.outcome.ended) break;
  sim.tick();
  if (w.burning.length === 0 && track.size === 0) continue;
  for (const fe of w.fires) {
    if (fe.cause === 'prescribed') continue;
    let tr = track.get(fe.id);
    if (!tr) {
      if (!fe.active) continue;
      tr = { fe, startT: t, dc0: w.weather.dangerClass, wind0: w.weather.windSpeed, fm0: S.moisture.medianFuelMoisture(w), detT: -1, crewT: -1, areaAtCrew: 0, days: [], steps: [], lastDay: w.day, dayStartArea: 0, maxCrews: 0, aidDay: -1, rainOut: false };
      track.set(fe.id, tr);
    }
    if (!fe.active) {
      tr.rainOut = w.weather.precip > 6;
      done.push(tr);
      track.delete(fe.id);
      continue;
    }
    if (tr.detT < 0 && fe.detected) tr.detT = t;
    const on = w.crews.filter((c: any) => c.task?.fireId === fe.id);
    const working = on.filter((c: any) => c.state === 'working').length;
    if (tr.crewT < 0 && working > 0) {
      tr.crewT = t;
      tr.areaAtCrew = fe.area;
    }
    tr.maxCrews = Math.max(tr.maxCrews, on.length);
    const team = (w.aid ?? []).find((a: any) => a.fireId === fe.id);
    if (team && team.arrived && tr.aidDay < 0) tr.aidDay = w.day - fe.startDay;
    let act = 0,
      hold = 0,
      maxF = 0,
      crown = 0;
    for (const b of w.burning)
      if (w.L.fid[b] === fe.id) {
        if (w.L.fphase[b] === 0) {
          act++;
          maxF = Math.max(maxF, w.L.fint[b]);
        } else hold++;
        if (w.L.crown[b] === 1) crown++;
      }
    if (flags.has('--steps'))
      tr.steps.push(
        `   d${String(w.day - fe.startDay).padStart(2)} ${String(((w.sub + 7) % 8) * 3).padStart(2)}h DC${w.weather.dangerClass} wind ${w.weather.windSpeed.toFixed(1)}${w.weather.windEvent ? '!' : ' '} rain ${w.weather.precip.toFixed(0)} | ${String(fe.area).padStart(6)} ha  front ${String(act).padStart(4)} holding ${String(hold).padStart(5)} crowning ${String(crown).padStart(4)} flames ${maxF.toFixed(1)} m | crews ${on.length} (${working} working)${team ? (team.arrived ? ' +team' : ' team called') : ''}`,
      );
    if (w.day !== tr.lastDay) {
      tr.days.push(`${fe.area - tr.dayStartArea}${w.weather.windEvent ? '!' : ''}${w.weather.precip > 6 ? 'r' : ''}`);
      tr.dayStartArea = fe.area;
      tr.lastDay = w.day;
    }
  }
}

const big = done.filter((tr) => tr.fe.area >= minHa).sort((a, b) => a.fe.startDay - b.fe.startDay);
console.log(`${scen} ${seed} ${mode}: ${done.length} wildfires in ${years} years, ${big.length} of ${minHa} ha or more.  Growth per day in ha; ! = wind event, r = rain`);
for (const tr of big) {
  const fe = tr.fe;
  const h = (t: number) => (t < 0 ? '  -' : String((t - tr.startT) * 3).padStart(3) + 'h');
  console.log(
    `y${Math.floor(fe.startDay / 360) + 1} d${String(fe.startDay % 360).padStart(3)} ${String(fe.cause).padEnd(9)} DC${tr.dc0} wind ${tr.wind0.toFixed(1)} fm ${tr.fm0.toFixed(2)} | found ${h(tr.detT)} crew ${h(tr.crewT)} at ${tr.areaAtCrew} ha, up to ${tr.maxCrews} crews${tr.aidDay >= 0 ? ', team day ' + tr.aidDay : ''} | ${String(fe.area).padStart(6)} ha in ${fe.outDay - fe.startDay} d, high ${Math.round((100 * fe.highSeverity) / Math.max(1, fe.area))}%, homes ${fe.structuresLost}, $${Math.round(fe.cost / 1000)}k, ${fe.response}${tr.rainOut ? ', rained out' : ''}`,
  );
  console.log(`      per day: ${tr.days.slice(0, 30).join(' ')}`);
}
if (flags.has('--steps') && big.length) {
  const top = big.slice().sort((a, b) => b.fe.area - a.fe.area)[0];
  console.log(`\n--- ${top.fe.name}, ${top.fe.area} ha ---`);
  console.log(top.steps.slice(0, 120).join('\n'));
}
void FIRE;
