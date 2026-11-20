/**
 * The fire as an incident: the forecast strip, the incident view (stage, what its edge is doing,
 * where it is expected to go, what can be done), after-action reports, and the council's charge.
 */
import type { GameSession } from '../app/session.ts';
import { FLAME_LIMIT } from '../sim/systems/fire.ts';
import { DANGER_NAMES } from '../sim/systems/climate.ts';
import { aidFor, aidProblem, fireThreat } from '../sim/systems/crews.ts';
import { STAGE_NAME, fireStage, stopText } from '../sim/incident.ts';
import { objectives } from '../sim/objectives.ts';
import type { Objective } from '../sim/objectives.ts';
import { COST } from '../sim/economyParams.ts';
import { FIRE } from '../sim/types.ts';
import type { FireEvent, FireReport, FireResponse } from '../sim/types.ts';
import type { World } from '../sim/world.ts';
import { DANGER_COLORS, compass, dayToDate, ha, money, pct } from './format.ts';
import { Icons } from './icons.tsx';

const STAGE_COLOR = ['var(--gold)', 'var(--ember)', 'var(--red)'];
const DAY_LETTER = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** The next five days, as the forecaster sees them (forecast.ts): colour is the expected danger class. */
export function ForecastStrip({ s }: { s: GameSession }) {
  const w = s.world;
  const fc = s.getForecast();
  return (
    <div class="forecast" id="forecast" title="Forecast for the next five days. It is good for tomorrow and less sure further out.">
      {fc.map((f) => {
        const icon = f.windEventChance >= 0.5 ? '≋' : f.stormChance >= 0.5 ? '⚡' : f.rainChance >= 0.5 ? '☂' : '';
        const tip = `${f.lead === 1 ? 'Tomorrow' : 'In ' + f.lead + ' days'}: ${DANGER_NAMES[f.dangerClass]} danger, ${Math.round(f.tmax)}°C, wind ${Math.round(f.windSpeed * 3.6)} km/h ${compass(f.windDir)}, RH ${Math.round(f.rh * 100)}%${
          f.windEventChance >= 0.3 ? `, ${Math.round(f.windEventChance * 100)}% chance of the ${w.climate.localWindName}` : ''
        }${f.rainChance >= 0.3 ? `, ${Math.round(f.rainChance * 100)}% chance of rain` : ''}${f.stormChance >= 0.3 ? `, ${Math.round(f.stormChance * 100)}% chance of ${f.dryStorm ? 'dry ' : ''}thunderstorms` : ''}`;
        return (
          <div class={'fday' + (f.redFlag ? ' flag' : '')} style={{ background: DANGER_COLORS[f.dangerClass] }} title={tip} key={f.day}>
            <span class="d">{DAY_LETTER[f.day % 7]}</span>
            <span class="i">{icon}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Share of a fire's burning edge by what could work it. */
function edgeProfile(w: World, fe: FireEvent): { hand: number; engine: number; air: number; beyond: number; crown: number; n: number } {
  const L = w.L;
  const out = { hand: 0, engine: 0, air: 0, beyond: 0, crown: 0, n: 0 };
  for (const b of w.burning) {
    if (L.fid[b] !== fe.id || L.town[b] > 0) continue;
    // only cells with unburned ground beside them are edge
    const x = b % w.W,
      y = (b / w.W) | 0;
    let open = false;
    for (let d = 0; d < 4 && !open; d++) {
      const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0),
        ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= w.W || ny >= w.H) continue;
      const n = ny * w.W + nx;
      if (L.fire[n] === FIRE.NONE && L.water[n] < 2) open = true;
    }
    if (!open) continue;
    out.n++;
    const f = L.fint[b];
    if (L.crown[b] === 1) out.crown++;
    else if (f <= FLAME_LIMIT.hand) out.hand++;
    else if (f <= FLAME_LIMIT.engine) out.engine++;
    else if (f <= FLAME_LIMIT.air) out.air++;
    else out.beyond++;
  }
  return out;
}

function eta(hours: number): string {
  if (hours < 1.5) return 'within the hour';
  if (hours < 24) return `in about ${Math.round(hours)} hours`;
  return `in about ${(hours / 24).toFixed(1)} days`;
}

export function ReportView({ r }: { r: FireReport }) {
  return (
    <div class="report">
      {r.text.map((t, k) => (
        <p key={k} style={{ margin: k ? '5px 0 0' : 0 }}>
          {t}
        </p>
      ))}
      {r.stopped.length > 0 && r.area >= 3 ? (
        <div class="stopbar" title="What holds its final edge">
          {r.stopped.map(([k, v]) => (
            <i class={'stop-' + k} style={{ width: `${v * 100}%` }} title={`${stopText(k)}: ${pct(v)}`} key={k} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function FireView({ s, id }: { s: GameSession; id: number }) {
  const w = s.world;
  const fe = w.fires.find((f) => f.id === id)!;
  const th = fireThreat(w, fe);
  const town = th.town >= 0 ? w.towns[th.town] : null;
  const crews = w.crews.filter((c) => c.task?.fireId === fe.id);
  const idle = w.crews.filter((c) => c.aid === undefined && (c.state === 'idle' || (c.task?.kind === 'project' && !c.manual && w.projects.find((p) => p.id === c.task!.projectId)?.status !== 'burning')));
  const days = (fe.active ? w.day : fe.outDay) - fe.startDay;
  const wild = fe.cause !== 'prescribed' && fe.cause !== 'pile';
  const stage = fe.active && wild ? fireStage(w, fe) : (fe.stage ?? 0);
  const report = w.reports.find((r) => r.fireId === fe.id);
  const resp: Array<[FireResponse, string, string]> = [
    ['suppress', 'Suppress', 'Every edge crews can safely work. The default, and the dearest.'],
    ['contain', 'Confine', 'Hold only the side toward homes and roads; the rest burns.'],
    ['monitor', 'Monitor', 'No crews unless you send them. For fire doing good work in the backcountry.'],
  ];
  const sub = `${fe.cause === 'prescribed' ? 'Prescribed burn' : fe.cause === 'escaped' ? 'Escaped prescribed burn' : fe.cause === 'human' ? 'Human-caused' : 'Lightning'} · started ${dayToDate(fe.startDay)} · day ${days + 1}`;
  const head = (
    <div class="row" style={{ alignItems: 'flex-start' }}>
      <div class="grow">
        <h2>{fe.name}</h2>
        <div class="faint" style={{ fontSize: '12px' }}>
          {sub}
        </div>
      </div>
      <button class="close" onClick={() => s.select(null)} aria-label="Close">
        ×
      </button>
    </div>
  );
  if (!fe.active) {
    return (
      <div>
        {head}
        <div class="kv" style={{ marginTop: '8px' }}>
          <span class="k">Burned</span>
          <span class="v">
            {ha(fe.area)} · {pct(fe.highSeverity / Math.max(1, fe.area))} severe
          </span>
          <span class="k">Homes lost</span>
          <span class="v">{fe.structuresLost}</span>
          <span class="k">Cost</span>
          <span class="v">{money(fe.cost)}</span>
        </div>
        {report ? <ReportView r={report} /> : null}
      </div>
    );
  }
  const e = edgeProfile(w, fe);
  const pr = s.projection && s.projectionFire === fe.id ? s.projection : null;
  const grew = fe.area - (fe.areaYesterday ?? fe.area);
  const aid = aidFor(w, fe.id);
  const aidWhy = aid ? '' : aidProblem(w, fe);
  const hits = pr ? pr.towns.filter((t) => t.homes > 0).sort((a, b) => a.hours - b.hours) : [];
  return (
    <div>
      {head}
      {wild ? (
        <div class="stage" style={{ borderColor: STAGE_COLOR[stage], color: STAGE_COLOR[stage] }}>
          {STAGE_NAME[stage]}
        </div>
      ) : null}
      <div class="grid2" style={{ marginTop: '8px', gap: '8px' }}>
        <div class="card">
          <div class="faint" style={{ fontSize: '11px' }}>
            AREA
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700 }}>{ha(fe.area)}</div>
          {grew > 0 && wild ? (
            <div class="faint" style={{ fontSize: '11.5px' }}>
              +{ha(grew)} since yesterday morning
            </div>
          ) : null}
        </div>
        <div class="card">
          <div class="faint" style={{ fontSize: '11px' }}>
            EDGE HELD
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700 }}>{pct(fe.containment)}</div>
          <div class="faint" style={{ fontSize: '11.5px' }}>{fe.burning} ha burning now</div>
        </div>
      </div>
      {e.n > 0 ? (
        <div style={{ marginTop: '10px' }} id="fire-edge">
          <div class="faint" style={{ fontSize: '11px' }}>
            ITS EDGE, BY WHAT CAN WORK IT
          </div>
          <div class="edgebar">
            <i class="e-hand" style={{ width: `${(100 * e.hand) / e.n}%` }} title={`Hand crews (flames under ${FLAME_LIMIT.hand} m): ${pct(e.hand / e.n)}`} />
            <i class="e-engine" style={{ width: `${(100 * e.engine) / e.n}%` }} title={`Engines only (under ${FLAME_LIMIT.engine} m): ${pct(e.engine / e.n)}`} />
            <i class="e-air" style={{ width: `${(100 * e.air) / e.n}%` }} title={`Aircraft only (under ${FLAME_LIMIT.air} m): ${pct(e.air / e.n)}`} />
            <i class="e-beyond" style={{ width: `${(100 * (e.beyond + e.crown)) / e.n}%` }} title={`Nothing direct works (longer flames or crown fire): ${pct((e.beyond + e.crown) / e.n)}`} />
          </div>
          <div class="faint" style={{ fontSize: '11.5px', marginTop: '3px' }}>
            {e.crown + e.beyond > e.n * 0.5
              ? 'Most of it is too hot to face. Work its flanks and heel, and wait for night.'
              : e.hand > e.n * 0.7
                ? 'Most of it is low enough for hand crews. This is the time to take it.'
                : 'Hand crews can work the green part, engines the yellow, aircraft the orange.'}
          </div>
        </div>
      ) : null}
      {wild ? (
        <div class="card" style={{ marginTop: '10px' }} id="fire-projection">
          <div class="faint" style={{ fontSize: '11px' }}>
            IF LEFT ALONE (today's weather, then the forecast)
          </div>
          {pr ? (
            <>
              <div class="projrow">
                {(['6 h', '12 h', '24 h', '48 h'] as const).map((l, k) => (
                  <div key={l}>
                    <b class="num">+{ha(pr.area[k])}</b>
                    <span class="faint">{l}</span>
                  </div>
                ))}
              </div>
              {hits.length ? (
                hits.map((t) => (
                  <div style={{ color: 'var(--red)', fontSize: '12.5px', marginTop: '4px' }} key={t.id}>
                    Could reach {w.towns[t.id]?.name ?? 'homes'} {eta(t.hours)}
                    {t.crown ? ', as crown fire' : ''} ({t.homes} homes in its path within two days).
                  </div>
                ))
              ) : (
                <div class="faint" style={{ fontSize: '12px', marginTop: '4px' }}>
                  No homes in its projected path for two days{town ? ` (nearest: ${town.name}, ${(th.dist / 10).toFixed(1)} km)` : ''}.
                </div>
              )}
              <div class="faint" style={{ fontSize: '11.5px', marginTop: '4px' }}>
                Shaded on the map: where it is expected within 6, 12, 24 and 48 hours. Spot fires, the luck of a road and your crews are not in it.
              </div>
            </>
          ) : (
            <div class="faint" style={{ fontSize: '12px', marginTop: '4px' }}>
              Working out where it is headed…
            </div>
          )}
        </div>
      ) : null}
      <div class="kv" style={{ marginTop: '8px' }}>
        <span class="k">Crown fire</span>
        <span class="v" style={{ color: fe.crownArea ? 'var(--red)' : undefined }}>
          {fe.crownArea ? `${ha(fe.crownArea)} (${pct(fe.crownArea / Math.max(1, fe.area))})` : 'none'}
        </span>
        <span class="k">Longest flames</span>
        <span class="v">{fe.maxIntensity.toFixed(1)} m</span>
        <span class="k">Homes lost</span>
        <span class="v" style={{ color: fe.structuresLost ? 'var(--red)' : undefined }}>
          {fe.structuresLost}
        </span>
        <span class="k">Cost so far</span>
        <span class="v">{money(fe.cost)}</span>
        <span class="k">Reported by</span>
        <span class="v">{fe.detectedBy || '—'}</span>
      </div>
      {wild ? (
        <>
          <h4 style={{ marginTop: '12px' }}>Response</h4>
          <div class="col" style={{ marginTop: '6px', gap: '4px' }}>
            {resp.map(([r, n, d]) => (
              <div
                class="opt card"
                style={{ cursor: 'pointer', borderColor: fe.response === r ? 'var(--ember)' : undefined, background: fe.response === r ? 'rgba(232,116,59,0.1)' : undefined, padding: '7px 10px' }}
                onClick={() => s.command({ t: 'fireResponse', fireId: fe.id, response: r })}
                key={r}
              >
                <b>{n}</b> <span class="faint" style={{ fontSize: '12px' }}>— {d}</span>
              </div>
            ))}
          </div>
          <h4 style={{ marginTop: '12px' }}>Outside help</h4>
          {aid ? (
            <div class="row" style={{ marginTop: '4px' }}>
              <span class="grow dim" style={{ fontSize: '12.5px' }}>
                {aid.arrived ? `An incident team is on this fire (${money(aid.cost)} so far).` : `An incident team reports ${aid.arriveDay - w.day <= 1 ? 'tomorrow morning' : 'in ' + (aid.arriveDay - w.day) + ' days'}.`}
              </span>
              <button class="btn small" onClick={() => s.command({ t: 'aid', fireId: fe.id, on: false })}>
                Send home
              </button>
            </div>
          ) : (
            <div class="row" style={{ marginTop: '4px' }}>
              <span class="grow faint" style={{ fontSize: '12px' }}>
                {aidWhy || `Four hand crews, two engines and a helicopter, here tomorrow morning: ${money(COST.aidMobilize)} and ${money(COST.aidPerDay)} a day.`}
              </span>
              <button class="btn small" disabled={!!aidWhy} onClick={() => s.command({ t: 'aid', fireId: fe.id, on: true })} id="call-aid">
                Call a team
              </button>
            </div>
          )}
        </>
      ) : null}
      <h4 style={{ marginTop: '12px' }}>Crews on this fire</h4>
      {crews.length === 0 ? (
        <div class="faint" style={{ fontSize: '12px', marginTop: '4px' }}>
          None.
        </div>
      ) : null}
      {crews.map((c) => (
        <div class="row" style={{ padding: '3px 0' }} key={c.id}>
          <span class="grow">
            {c.name} <span class="faint">· {c.state}{c.aid !== undefined ? ' · outside team' : ''}</span>
          </span>
          {c.aid === undefined ? (
            <button class="btn small" onClick={() => s.command({ t: 'recallCrew', crewId: c.id })}>
              Recall
            </button>
          ) : null}
        </div>
      ))}
      {idle.length > 0 && wild ? (
        <div class="row" style={{ flexWrap: 'wrap', marginTop: '6px', gap: '4px' }}>
          {idle.slice(0, 6).map((c) => (
            <button class="btn small" onClick={() => s.command({ t: 'sendCrew', crewId: c.id, fireId: fe.id })} key={c.id}>
              Send {c.name}
            </button>
          ))}
        </div>
      ) : null}
      <div class="row" style={{ marginTop: '10px', gap: '6px', flexWrap: 'wrap' }}>
        <button class="btn small" onClick={() => s.setTool('fireline')}>
          {Icons.fireline({ size: 14 })} Cut line
        </button>
        <button class="btn small" onClick={() => s.setTool('airdrop')}>
          {Icons.airdrop({ size: 14 })} Air tanker
        </button>
        <button class="btn small" onClick={() => s.focus((fe.minX + fe.maxX) / 2, (fe.minY + fe.maxY) / 2)}>
          {Icons.target({ size: 13 })} Focus
        </button>
      </div>
    </div>
  );
}

const OBJ_COLOR: Record<Objective['state'], string> = { met: 'var(--green)', 'on-track': 'var(--green)', behind: 'var(--gold)', failed: 'var(--red)' };
const OBJ_WORD: Record<Objective['state'], string> = { met: 'met', 'on-track': 'on track', behind: 'behind', failed: 'failed' };

export function ObjectiveList({ w }: { w: World }) {
  return (
    <div class="col" style={{ gap: '8px' }}>
      {objectives(w).map((o) => (
        <div class="card" key={o.id}>
          <div class="row">
            <b class="grow">{o.title}</b>
            <span class="tag" style={{ color: OBJ_COLOR[o.state] }}>
              {o.kind === 'limit' && o.state !== 'failed' ? 'holding' : OBJ_WORD[o.state]}
            </span>
          </div>
          <div class="dim" style={{ fontSize: '12.5px', marginTop: '2px' }}>
            {o.charge}
          </div>
          <div class="bar" style={{ marginTop: '6px' }}>
            <i style={{ width: `${o.progress * 100}%`, background: o.kind === 'limit' ? (o.state === 'failed' ? 'var(--red)' : o.progress > 0.75 ? 'var(--gold)' : 'var(--dim, #8a8f85)') : OBJ_COLOR[o.state] }} />
          </div>
          <div class="faint" style={{ fontSize: '12px', marginTop: '3px' }}>
            {o.reading}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The council's charge, and what a bad fire day would do to each town. */
export function ChargePanel({ s }: { s: GameSession }) {
  const w = s.world;
  const ex = w.memory.exposure;
  return (
    <div>
      <p class="dim" style={{ marginTop: 0 }}>
        What this valley's council asked of you when you took the job. Each is worth three points of the hundred your tenure is scored on; the rest is how the valley fares.
      </p>
      <ObjectiveList w={w} />
      {ex ? (
        <>
          <h4 style={{ margin: '16px 0 6px' }}>What a bad fire day would do</h4>
          <p class="faint" style={{ fontSize: '12px', margin: '0 0 8px' }}>
            Surveyed each new year: a late-summer day in drought with the valley's strong dry wind, and a fire arriving at every town. The Fireshed and Bad-day fire lenses show where the danger comes from.
          </p>
          {ex.towns.map((t) => {
            const town = w.towns[t.id];
            const share = t.homes ? t.exposed / t.homes : 0;
            return (
              <div class="row" style={{ padding: '4px 0', cursor: 'pointer' }} onClick={() => town && (s.select({ type: 'town', id: t.id }), s.focus(town.x, town.y))} key={t.id}>
                <b class="grow">{town?.name ?? 'Town'}</b>
                <span class="dim num" style={{ fontSize: '12.5px' }}>
                  {Math.round(t.exposed)} of {t.homes} homes
                </span>
                <span class="tag" style={{ color: share > 0.4 ? 'var(--red)' : share > 0.15 ? 'var(--gold)' : 'var(--green)' }}>{pct(share)}</span>
              </div>
            );
          })}
          <div class="faint" style={{ fontSize: '12px', marginTop: '6px' }}>
            All towns: {pct(ex.now)} of homes ({pct(ex.start)} when you arrived).
          </div>
        </>
      ) : null}
    </div>
  );
}
