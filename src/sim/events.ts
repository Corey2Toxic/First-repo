/**
 * Event hooks: translate what happens in the simulation into notifications,
 * chronicle entries, field-note discoveries and political shocks.
 */
import { FIRE } from './types.ts';
import type { FireEvent } from './types.ts';
import type { World } from './world.ts';
import type { SimHooks } from './sim.ts';
import { discover } from './notes.ts';
import { shock } from './systems/council.ts';
import { bloomFactor } from './derived.ts';
import { deerCount } from './systems/wildlife.ts';
import { ESCAPED_AREA, STAGE_NAME, buildFireReport, fileFireReport } from './incident.ts';

function nearestName(w: World, x: number, y: number): string {
  let best = '',
    bd = Infinity;
  for (const m of w.landmarks) {
    const d = Math.hypot(m.x - x, m.y - y);
    if (d < bd) {
      bd = d;
      best = m.name;
    }
  }
  return best;
}

/** Fires this large (ha) get their account in the "is out" notice; smaller ones just the size. */
const ESCAPED_REPORT = 10;

const CAUSE_TEXT: Record<string, string> = {
  lightning: 'lightning',
  human: 'human-caused',
  prescribed: 'prescribed',
  escaped: 'escaped prescribed',
  spot: 'spot',
  pile: 'pile',
};

export function makeEventHooks(w: World): SimHooks {
  // once-only notices are remembered in the world (and so in saves): v1.0 kept them in this closure,
  // so a reloaded game repeated e.g. "…is crowning", consuming an entity id and changing the state
  // hash although the dynamics were identical (D11). Old keys are pruned to keep saves small.
  const once = (key: string) => {
    const told = (w.memory.told ??= {});
    if (told[key] !== undefined) return false;
    told[key] = w.day;
    const keys = Object.keys(told);
    if (keys.length > 300) for (const k of keys) if (w.day - told[k] > 360) delete told[k];
    return true;
  };
  return {
    onDetect(fe: FireEvent) {
      const where = nearestName(w, fe.originX, fe.originY);
      const resp = fe.response === 'monitor' ? ' Wilderness policy: monitoring.' : '';
      const size = fe.area >= 2 ? `, already ${fe.area} ha` : '';
      // found too late for initial attack: say so here, not in a second notice a moment later
      const late = fe.area >= ESCAPED_AREA && fe.cause !== 'prescribed' && fe.cause !== 'pile';
      if (late) {
        fe.stage = 1;
        discover(w, 'extended-attack');
      }
      w.notify(`New ${CAUSE_TEXT[fe.cause] ?? ''} fire: the ${fe.name}, near ${where}${size}, reported by ${fe.detectedBy}.${late ? ' It is past catching small.' : ''}${resp}`, 'danger', fe.originX, fe.originY, fe.id, late ? 2 : 1);
      if (w.weather.dryLightning && fe.cause === 'lightning') discover(w, 'dry-lightning');
    },
    onStage(fe: FireEvent, stage) {
      const x = Math.round((fe.minX + fe.maxX) / 2),
        y = Math.round((fe.minY + fe.maxY) / 2);
      if (stage === 1) {
        w.notify(`The ${fe.name} has escaped initial attack: ${fe.area} ha and still moving.`, 'warn', x, y, fe.id, 2);
        discover(w, 'extended-attack');
      } else if (stage === 2) {
        const why = fe.structuresLost > 0 ? 'homes are burning' : fe.inBuffer ? 'it is among the homes' : `${fe.area.toLocaleString('en-US')} ha`;
        w.notify(`${STAGE_NAME[2]}: the ${fe.name} (${why}).`, 'danger', x, y, fe.id, 2);
      }
    },
    onEnding(fe: FireEvent) {
      if (fe.cause === 'prescribed' || fe.cause === 'pile') return;
      if (!fe.detected && fe.area < 5) return;
      const rep = buildFireReport(w, fe);
      fileFireReport(w, rep);
      const untreated = rep.area - rep.treatedArea;
      if (rep.treatedArea >= 20 && untreated >= 20 && rep.untreatedHigh / untreated > 0.15 && rep.treatedHigh / rep.treatedArea < (0.5 * rep.untreatedHigh) / untreated) discover(w, 'treated-ground');
    },
    onCrown(fe: FireEvent, cell: number) {
      if (!fe.detected) return;
      if (once('crown' + fe.id)) {
        w.notify(`The ${fe.name} is crowning — crews cannot work the head of a crown fire.`, 'danger', cell % w.W, (cell / w.W) | 0, fe.id);
        discover(w, 'crown-fire');
      }
      if (w.yearF - w.L.lastBurn[cell] > 80) discover(w, 'fire-paradox');
      if (w.L.under[cell] > 0.5) discover(w, 'understory');
      if (w.weather.windEvent && once('wind' + w.day)) discover(w, 'downslope-wind');
    },
    onSpot(fe: FireEvent, cell: number, crossed: boolean) {
      if (!fe.detected) return;
      if (crossed && once('spot' + fe.id)) {
        w.notify(`Embers from the ${fe.name} started spot fires across a barrier.`, 'warn', cell % w.W, (cell / w.W) | 0, fe.id);
        discover(w, 'spotting');
      }
    },
    onStructureLost(townId: number, cell: number, fe: FireEvent) {
      const t = w.towns[townId];
      w.memory.recentLoss = (w.memory.recentLoss ?? 0) + 1;
      // each lost home hurts, with diminishing returns within one fire
      shock(w, 'residents', -2.4 / (1 + fe.structuresLost / 12), 'Homes lost to fire');
      shock(w, 'tourism', -0.4 / (1 + fe.structuresLost / 12));
      shock(w, 'conservation', -0.15);
      if (once(`loss${fe.id}:${w.day}`)) w.notify(`Homes are burning in ${t?.name ?? 'town'}! (${fe.name})`, 'danger', cell % w.W, (cell / w.W) | 0, fe.id);
      discover(w, 'wui');
    },
    onAidRequested(team, fe) {
      const wait = team.arriveDay - w.day;
      const when = wait <= 1 ? 'tomorrow morning' : 'in ' + wait + ' days';
      const who = team.auto ? 'Standing order: an' : 'An';
      w.notify(who + ' outside incident team has been called to the ' + fe.name + '. It reports ' + when + '.', 'warn', fe.originX, fe.originY, fe.id);
    },
    onAidArrived(_team, fe) {
      discover(w, 'mutual-aid');
      w.notify('The incident team has arrived for the ' + fe.name + ': four hand crews, two engines and a helicopter.', 'good', fe.originX, fe.originY, fe.id);
    },
    onAidReleased(team, fe, unpaid) {
      const days = Math.max(1, team.releasedDay - team.arriveDay);
      const name = fe ? fe.name : 'fire';
      const span = days + (days > 1 ? ' days' : ' day');
      const bill = '$' + Math.round(team.cost / 1000) + 'k';
      if (unpaid) w.notify('The county will not extend more emergency credit: the incident team has been sent home from the ' + name + ' after ' + span + ' (' + bill + ').', 'danger', fe?.originX, fe?.originY, fe?.id, 2);
      else w.notify('The incident team has left the ' + name + ' after ' + span + ': ' + bill + '.', 'info');
      if (fe) w.record('fire', 'An outside incident team worked the ' + name + ' for ' + span + ', at a cost of ' + bill + '.', 2, fe.originX, fe.originY);
    },
    onEscape(fe: FireEvent) {
      w.memory.recentEscapes = (w.memory.recentEscapes ?? 0) + 1;
      shock(w, 'residents', -7, 'Escaped prescribed burn');
      shock(w, 'conservation', -2);
      shock(w, 'tourism', -2);
      w.notify(`The burn has escaped its control line! It is now the ${fe.name}.`, 'danger', fe.originX, fe.originY, fe.id);
      w.record('fire', `A prescribed burn escaped its lines and became the ${fe.name}.`, 2, fe.originX, fe.originY);
      discover(w, 'escape');
    },
    onEnd(fe: FireEvent) {
      const yr = Math.floor(fe.startDay / 360) + 1;
      const days = Math.max(1, fe.outDay - fe.startDay);
      if (fe.cause === 'prescribed') {
        w.notify(`The ${fe.name} is out: ${fe.area} ha treated.`, 'good', fe.originX, fe.originY);
        if (fe.area >= 20) w.record('rx', `Crews completed the ${fe.name} (${fe.area} ha).`, 1, fe.originX, fe.originY);
        return;
      }
      if (!fe.detected && fe.area < 5) return;
      const sev = fe.area > 0 ? Math.round((100 * fe.highSeverity) / fe.area) : 0;
      if (fe.area >= 40 || fe.structuresLost > 0) {
        const imp = fe.area >= 4000 || fe.structuresLost >= 10 ? 3 : fe.area >= 600 || fe.structuresLost > 0 ? 2 : 1;
        const homes = fe.structuresLost ? `, destroying ${fe.structuresLost} homes` : '';
        w.record(
          'fire',
          `The ${fe.name} (${CAUSE_TEXT[fe.cause]}) burned ${fe.area.toLocaleString()} ha over ${days} days${homes}; ${sev}% burned severely.`,
          imp,
          fe.originX,
          fe.originY,
        );
        if (fe.area >= 4000) {
          w.counters.megafires++;
          w.counters.lastMegafireYear = yr;
          shock(w, 'residents', -5, 'A megafire');
          shock(w, 'tourism', -6, 'A megafire');
        }
      }
      // the after-action report (filed in onEnding) says what held it and whether prepared ground mattered
      const rep = w.reports.length && w.reports[w.reports.length - 1].fireId === fe.id ? w.reports[w.reports.length - 1] : null;
      if (fe.detected) {
        const account = rep && rep.area >= ESCAPED_REPORT ? ' ' + rep.text.slice(1, 3).join(' ') : '';
        w.notify(`The ${fe.name} is out after ${days} day${days === 1 ? '' : 's'}: ${fe.area.toLocaleString()} ha.${account}`, fe.structuresLost ? 'warn' : 'info', fe.originX, fe.originY, undefined, rep && rep.stage >= 1 ? 1 : undefined);
      }
      // gentle fires in fire-adapted forest teach something
      if (fe.lowSeverity >= 30 && fe.detected) discover(w, 'pine-survives');
      // what stopped it? moist meadows, aspen and beaver ponds on the final perimeter
      if (fe.area >= 25 && fe.detected) {
        const L = w.L;
        let edge = 0,
          green = 0;
        for (let y = Math.max(1, fe.minY - 1); y <= Math.min(w.H - 2, fe.maxY + 1); y++)
          for (let x = Math.max(1, fe.minX - 1); x <= Math.min(w.W - 2, fe.maxX + 1); x++) {
            const i = y * w.W + x;
            if (w.yearF - L.lastBurn[i] < 0.05 || L.fire[i] !== FIRE.NONE) continue;
            const adj = w.yearF - L.lastBurn[i - 1] < 0.05 || w.yearF - L.lastBurn[i + 1] < 0.05 || w.yearF - L.lastBurn[i - w.W] < 0.05 || w.yearF - L.lastBurn[i + w.W] < 0.05;
            if (!adj) continue;
            edge++;
            if (L.aspen[i] > 0.3 || L.pond[i] > 0.1 || L.sm[i] > 0.75) green++;
          }
        if (edge > 0 && green / edge > 0.22) discover(w, 'green-firebreak');
      }
    },
    onCrewRetreat(c, fe) {
      discover(w, 'flame-length');
      if (once('retreat' + fe.id)) w.notify(`${c.name} pulled back: the ${fe.name} is too hot to engage.`, 'warn', Math.floor(c.x), Math.floor(c.y), fe.id);
    },
    onBurnIgnited(pr, fe) {
      w.notify(`The burn window opened — crews lit the ${fe.name}.`, 'info', Math.round(pr.cx), Math.round(pr.cy), fe.id);
      discover(w, 'burn-window');
    },
    onDepredation(p) {
      w.memory.recentDepredations = (w.memory.recentDepredations ?? 0) + 1;
      shock(w, 'ranchers', -3, 'Wolves taking livestock');
      if (once('dep' + w.month + ':' + w.year)) w.notify(`The ${p.name} killed cattle on the range. Ranchers are furious.`, 'warn', Math.floor(p.x), Math.floor(p.y));
    },
    onWolvesKilled(p, n) {
      w.memory.recentWolfKills = (w.memory.recentWolfKills ?? 0) + n;
      shock(w, 'conservation', -1.5 * n, 'Wolves killed');
      if (once('wk' + w.month + ':' + w.year)) w.notify(`${n} wolf${n > 1 ? 'ves' : ''} of the ${p.name} shot under the current wolf policy.`, 'info', Math.floor(p.x), Math.floor(p.y));
    },
    onPackFormed(p, parent) {
      if (p === parent) {
        w.record('wildlife', `A pair of wolves wandered into the valley from the mountains beyond: the ${p.name}.`, 3, Math.floor(p.tx), Math.floor(p.ty));
        w.notify(`Wolves have returned to the valley on their own: the ${p.name}.`, 'good', Math.floor(p.x), Math.floor(p.y));
        return;
      }
      w.record('wildlife', `Young wolves from the ${parent.name} founded a new pack: the ${p.name}.`, 2, Math.floor(p.tx), Math.floor(p.ty));
      w.notify(`A new wolf pack, the ${p.name}, has formed.`, 'good', Math.floor(p.tx), Math.floor(p.ty));
    },
    onPackLost(p) {
      w.record('wildlife', `The ${p.name} has disappeared from the valley.`, 2, Math.floor(p.x), Math.floor(p.y));
      w.notify(`The ${p.name} is gone.`, 'warn', Math.floor(p.x), Math.floor(p.y));
    },
    onColonyFounded(c) {
      if (once('col' + w.year)) w.notify('Beavers have settled a new stretch of creek.', 'good', c.cell % w.W, (c.cell / w.W) | 0);
    },
    onColonyAbandoned(c) {
      if (once('colx' + w.year)) w.notify('A beaver colony has run out of food and moved on.', 'info', c.cell % w.W, (c.cell / w.W) | 0);
    },
    onDamBuilt(c) {
      if (discover(w, 'beaver-dam')) w.record('wildlife', 'Beavers dammed a creek, flooding a meadow into ponds.', 1, c.cell % w.W, (c.cell / w.W) | 0);
    },
    onOutbreak(cells, x, y) {
      if (w.memory.outbreakYear === w.year) return;
      w.memory.outbreakYear = w.year;
      w.record('beetle', `A bark beetle outbreak spread through ${cells.toLocaleString()} ha of pine.`, 2, Math.round(x), Math.round(y));
      w.notify(`Bark beetles are killing pines near ${nearestName(w, x, y)}.`, 'warn', Math.round(x), Math.round(y));
      discover(w, 'beetles');
    },
    onDebrisFlow(x, y, damaged) {
      w.record('water', `Heavy rain on a burn scar sent a debris flow down from ${nearestName(w, x, y)}${damaged ? `, burying ${damaged} homes` : ''}.`, damaged ? 3 : 2, x, y);
      w.notify(`Debris flow near ${nearestName(w, x, y)}!`, 'danger', x, y);
      if (damaged) shock(w, 'residents', -2 * damaged, 'Debris flow damage');
      discover(w, 'debris-flow');
    },
  };
}

/** Monthly checks for slower phenomena worth a field note. */
export function monthlyDiscoveries(w: World): void {
  const L = w.L;
  const m = w.month;
  let bloom = 0,
    resprout = 0,
    fearGrowth = 0,
    overbrowse = 0,
    succession = 0,
    red = 0;
  for (let i = 0; i < w.N; i += 2) {
    if (m >= 3 && m <= 5 && bloomFactor(w, i) > 0.3) bloom++;
    const ysf = w.yearF - L.lastBurn[i];
    if (ysf > 0.5 && ysf < 4 && L.aspen[i] > 0.05 && L.ageA[i] < 4) resprout++;
    if (L.fear[i] > 0.35 && L.aspen[i] > 0.06 && L.ageA[i] < 10) fearGrowth++;
    if (L.browse[i] > 0.45 && L.aspen[i] > 0.1 && L.ageA[i] > 40) overbrowse++;
    if (L.fir[i] > L.aspen[i] && L.aspen[i] > 0.05 && L.ageA[i] > 90) succession++;
    if (L.red[i] > 0.3) red++;
  }
  if (bloom >= 10) discover(w, 'fireweed');
  if (resprout >= 10) discover(w, 'aspen-resprout');
  if (w.packs.length && fearGrowth >= 12) discover(w, 'landscape-of-fear');
  if (overbrowse >= 30) discover(w, 'overbrowsing');
  if (succession >= 30) discover(w, 'succession');
  if (red >= 50) discover(w, 'red-phase');
  if (w.reservoirSilt > 0.06) discover(w, 'siltation');
  if (!w.economy.millOpen) discover(w, 'mill-closure');
  const startDeer = w.memory.startDeer ?? deerCount(w);
  if (w.packs.length && w.colonies.filter((c) => c.active).length >= 3 && deerCount(w) < startDeer * 0.9 && w.yearsElapsed > 3) discover(w, 'trophic-cascade');
}
