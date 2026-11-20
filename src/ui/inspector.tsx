/**
 * Inspector: details and actions for whatever is selected on the map.
 */
import type { GameSession } from '../app/session.ts';
import { FACTION_NAMES, FIRE, MONTH_NAMES, ZONE_NAMES } from '../sim/types.ts';
import { cellFuel, hazardIndex } from '../sim/systems/fuels.ts';
import { greenness } from '../sim/derived.ts';
import { deerCount, wolfCount } from '../sim/systems/wildlife.ts';
import { PROJECT_NAMES } from '../sim/systems/projects.ts';
import { DANGER_COLORS, dayToDate, ha, money, pct } from './format.ts';
import { CREW_LABEL } from './hud.tsx';
import { FireView } from './incident.tsx';
import { burnCrewsNeeded, burnOutlook } from '../sim/systems/projects.ts';

const SEV = ['—', 'low', 'moderate', 'high'];

function Bar({ v, color }: { v: number; color: string }) {
  return (
    <div class="bar">
      <i style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%`, background: color }} />
    </div>
  );
}

export function Inspector({ s }: { s: GameSession }) {
  const sel = s.selection;
  const w = s.world;
  if (!sel) return <Overview s={s} />;
  switch (sel.type) {
    case 'cell':
      return <CellView s={s} cell={sel.cell} />;
    case 'fire': {
      const fe = w.fires.find((f) => f.id === sel.id);
      return fe ? <FireView s={s} id={fe.id} /> : <Overview s={s} />;
    }
    case 'crew':
      return <CrewView s={s} id={sel.id} />;
    case 'town':
      return <TownView s={s} id={sel.id} />;
    case 'project':
      return <ProjectView s={s} id={sel.id} />;
    case 'herd':
    case 'pack':
    case 'colony':
      return <WildView s={s} />;
  }
}

function Header({ s, title, sub }: { s: GameSession; title: string; sub?: string }) {
  return (
    <div class="row" style={{ alignItems: 'flex-start' }}>
      <div class="grow">
        <h2>{title}</h2>
        {sub ? <div class="faint" style={{ fontSize: '12px' }}>{sub}</div> : null}
      </div>
      <button class="close" onClick={() => s.select(null)} aria-label="Close">
        ×
      </button>
    </div>
  );
}

function Overview({ s }: { s: GameSession }) {
  const w = s.world;
  const active = w.fires.filter((f) => f.active && f.detected);
  return (
    <div>
      <h3>The valley</h3>
      <div class="faint" style={{ fontSize: '12px', marginBottom: '8px' }}>
        Click anything on the map to inspect it.
      </div>
      {w.towns.map((t) => (
        <div class="row" style={{ padding: '4px 0', cursor: 'pointer' }} onClick={() => (s.select({ type: 'town', id: t.id }), s.focus(t.x, t.y))} key={t.id}>
          <b class="grow">{t.name}</b>
          <span class="dim num">{t.population.toLocaleString()}</span>
          {(() => {
            const te = w.memory.exposure?.towns.find((x) => x.id === t.id);
            const share = te && te.homes ? te.exposed / te.homes : null;
            return share === null ? (
              <span class="tag" title="Firewise rating">firewise {pct(t.firewise)}</span>
            ) : (
              <span class="tag" title="Share of this town's homes a bad fire day would take (surveyed each new year)" style={{ color: share > 0.4 ? 'var(--red)' : share > 0.15 ? 'var(--gold)' : 'var(--green)' }}>
                {pct(share)} at risk
              </span>
            );
          })()}
        </div>
      ))}
      <div class="sep" />
      <div class="kv">
        <span class="k">Active fires</span>
        <span class="v">{active.length ? active.map((f) => f.name).join(', ') : 'none'}</span>
        <span class="k">Reservoir</span>
        <span class="v">
          {pct(w.reservoirLevel)} full{w.reservoirSilt > 0.02 ? ` · ${pct(w.reservoirSilt)} silted` : ''}
        </span>
        <span class="k">Deer · wolves</span>
        <span class="v">
          {deerCount(w)} · {wolfCount(w)} in {w.packs.length} pack{w.packs.length === 1 ? '' : 's'}
        </span>
        <span class="k">Beaver colonies</span>
        <span class="v">{w.colonies.filter((c) => c.active).length}</span>
        <span class="k">Drought index</span>
        <span class="v">{pct(w.climate.droughtIndex)}</span>
        <span class="k">This year</span>
        <span class="v">
          {ha(w.counters.yearBurned)} burned · {w.counters.yearStructuresLost} homes lost
        </span>
      </div>
    </div>
  );
}

function CellView({ s, cell }: { s: GameSession; cell: number }) {
  const w = s.world;
  const L = w.L;
  const x = cell % w.W,
    y = (cell / w.W) | 0;
  const f = cellFuel(w, cell);
  const hz = hazardIndex(w, cell);
  const can = L.aspen[cell] + L.pine[cell] + L.fir[cell];
  const comp: Array<[string, number, string]> = [
    ['Grass', L.grass[cell], '#c8b46a'],
    ['Shrub', L.shrub[cell], '#8a8d45'],
    ['Aspen', L.aspen[cell], '#a6d65c'],
    ['Pine', L.pine[cell], '#3f7a44'],
    ['Fir', L.fir[cell], '#1f5f57'],
  ];
  const tot = comp.reduce((a, c) => a + c[1], 0) || 1;
  const yrs = w.yearF - L.lastBurn[cell];
  let nearest = '';
  let nd = Infinity;
  for (const m of w.landmarks) {
    const d = Math.hypot(m.x - x, m.y - y);
    if (d < nd) {
      nd = d;
      nearest = m.name;
    }
  }
  const water = L.water[cell];
  return (
    <div>
      <Header s={s} title={water >= 2 ? (water === 3 ? 'Reservoir' : 'Lake') : can > 0.3 ? 'Forest' : L.grass[cell] > 0.4 ? 'Meadow' : 'Open ground'} sub={`${(nd / 10).toFixed(1)} km from ${nearest} · ${Math.round(L.elev[cell])} m · slope ${Math.round(Math.atan(L.slope[cell]) * 57)}°`} />
      <div class="row" style={{ margin: '8px 0 4px' }}>
        <span class="tag">{ZONE_NAMES[L.zone[cell]]}</span>
        {L.fire[cell] === FIRE.BURNING ? <span class="tag" style={{ color: '#ffb08a' }}>burning</span> : null}
        {L.pond[cell] > 0.1 ? <span class="tag" style={{ color: '#9fe0ff' }}>beaver pond</span> : null}
      </div>
      <h4 style={{ marginTop: '10px' }}>Vegetation</h4>
      <div class="stack" style={{ marginTop: '6px' }}>
        {comp.map(([n, v, c]) => (
          <i key={n} title={`${n} ${pct(v)}`} style={{ width: `${(v / tot) * 100}%`, background: c }} />
        ))}
      </div>
      <div class="row" style={{ flexWrap: 'wrap', gap: '8px', marginTop: '5px', fontSize: '11.5px' }}>
        {comp
          .filter((c) => c[1] > 0.02)
          .map(([n, v, c]) => (
            <span class="row" style={{ gap: '4px' }} key={n}>
              <i class="swatch" style={{ background: c, width: '9px', height: '9px' }} />
              <span class="dim">
                {n} {pct(v)}
              </span>
            </span>
          ))}
      </div>
      <div class="kv" style={{ marginTop: '8px' }}>
        {L.pine[cell] > 0.03 ? (
          <>
            <span class="k">Pine age</span>
            <span class="v">{Math.round(L.ageP[cell])} yrs</span>
          </>
        ) : null}
        {L.fir[cell] > 0.03 ? (
          <>
            <span class="k">Fir age</span>
            <span class="v">{Math.round(L.ageF[cell])} yrs</span>
          </>
        ) : null}
        {L.aspen[cell] > 0.03 || L.aroot[cell] > 0.1 ? (
          <>
            <span class="k">Aspen age · roots</span>
            <span class="v">
              {Math.round(L.ageA[cell])} yrs · {pct(L.aroot[cell])}
            </span>
          </>
        ) : null}
        <span class="k">Greenness</span>
        <span class="v">{pct(greenness(w, cell))}</span>
      </div>
      <h4 style={{ marginTop: '12px' }}>Fuel & fire</h4>
      <div class="row" style={{ marginTop: '6px' }}>
        <span class="dim" style={{ width: '90px', fontSize: '12px' }}>
          Hazard
        </span>
        <div class="grow">
          <Bar v={hz} color={hz > 0.6 ? '#c2263a' : hz > 0.35 ? '#e0a232' : '#4f9d55'} />
        </div>
        <span class="num" style={{ width: '38px', textAlign: 'right' }}>
          {pct(hz)}
        </span>
      </div>
      <div class="kv" style={{ marginTop: '6px' }}>
        <span class="k">Fine fuel</span>
        <span class="v">{f.fine.toFixed(1)} t/ha</span>
        <span class="k">Ladder fuels</span>
        <span class="v">{pct(f.ladder)}</span>
        <span class="k">Crown fuel</span>
        <span class="v">{pct(f.canopy)}</span>
        <span class="k">Dead wood · snags</span>
        <span class="v">
          {Math.round(L.dead[cell])} · {Math.round(L.snag[cell])} t/ha
        </span>
        <span class="k">Fuel moisture</span>
        <span class="v">{(L.fm[cell] * 100).toFixed(0)}%</span>
        <span class="k">Soil moisture</span>
        <span class="v">{pct(L.sm[cell])}</span>
        {L.snow[cell] > 2 ? (
          <>
            <span class="k">Snowpack</span>
            <span class="v">{Math.round(L.snow[cell])} mm SWE</span>
          </>
        ) : null}
        <span class="k">Last fire</span>
        <span class="v">{L.lastBurn[cell] < -900 ? 'not in living memory' : `${Math.max(0, Math.round(yrs))} yrs ago (${SEV[L.burnSev[cell]]})`}</span>
        {L.lastTreat[cell] > -900 ? (
          <>
            <span class="k">Last treated</span>
            <span class="v">{Math.round(w.yearF - L.lastTreat[cell])} yrs ago</span>
          </>
        ) : null}
        {L.beetle[cell] > 0.05 ? (
          <>
            <span class="k">Bark beetles</span>
            <span class="v" style={{ color: 'var(--ember)' }}>
              {pct(L.beetle[cell])}
            </span>
          </>
        ) : null}
        {L.browse[cell] > 0.1 ? (
          <>
            <span class="k">Deer browse</span>
            <span class="v">{pct(L.browse[cell])}</span>
          </>
        ) : null}
        {L.fear[cell] > 0.1 ? (
          <>
            <span class="k">Wolf presence</span>
            <span class="v">{pct(L.fear[cell])}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function CrewView({ s, id }: { s: GameSession; id: number }) {
  const w = s.world;
  const c = w.crews.find((x) => x.id === id);
  if (!c) return <Overview s={s} />;
  const t = c.task;
  const fire = t?.fireId !== undefined ? w.fires.find((f) => f.id === t.fireId) : undefined;
  const pr = t?.projectId !== undefined ? w.projects.find((p) => p.id === t.projectId) : undefined;
  const town = w.towns.find((x) => x.station === c.home);
  return (
    <div>
      <Header s={s} title={c.name} sub={`${CREW_LABEL[c.kind]} · based at ${town?.name ?? 'station'}`} />
      <div class="kv" style={{ marginTop: '8px' }}>
        <span class="k">Status</span>
        <span class="v">{c.state}</span>
        <span class="k">Assignment</span>
        <span class="v">{fire ? fire.name : pr ? pr.label : t?.kind === 'line' ? 'cutting fireline' : t?.kind === 'move' ? 'moving' : 'none'}</span>
        <span class="k">Fatigue</span>
        <span class="v">{pct(c.fatigue)}</span>
        <span class="k">Hours on fires</span>
        <span class="v">{Math.round(c.hoursWorked)}</span>
      </div>
      <div class="row" style={{ marginTop: '10px', flexWrap: 'wrap', gap: '6px' }}>
        <button class="btn small primary" onClick={() => s.setTool('send', { sendCrewId: c.id })}>
          Send to…
        </button>
        <button class="btn small" onClick={() => s.command({ t: 'recallCrew', crewId: c.id })}>
          Recall
        </button>
        {c.state === 'idle' ? (
          <button class="btn small danger" onClick={() => s.command({ t: 'dismiss', crewId: c.id })}>
            Disband
          </button>
        ) : null}
      </div>
    </div>
  );
}

function TownView({ s, id }: { s: GameSession; id: number }) {
  const w = s.world;
  const t = w.towns[id];
  if (!t) return <Overview s={s} />;
  return (
    <div>
      <Header s={s} title={t.name} sub={`${t.population.toLocaleString()} people · ${t.structures} homes${t.mill ? ' · sawmill' : ''}`} />
      {(() => {
        const te = w.memory.exposure?.towns.find((x) => x.id === t.id);
        if (!te || !te.homes) return null;
        const share = te.exposed / te.homes;
        return (
          <div class="card" style={{ marginTop: '10px' }}>
            <div class="faint" style={{ fontSize: '11px' }}>
              ON A BAD FIRE DAY
            </div>
            <div style={{ fontSize: '18px', fontWeight: 700, color: share > 0.4 ? 'var(--red)' : share > 0.15 ? 'var(--gold)' : 'var(--green)' }}>
              {Math.round(te.exposed)} of {te.homes} homes would burn
            </div>
            <div class="faint" style={{ fontSize: '12px', marginTop: '3px' }}>
              {te.crownEdge > 0.3 ? `Crown fire would reach ${pct(te.crownEdge)} of the town's edge. ` : te.crownEdge > 0 ? `Crown fire would reach ${pct(te.crownEdge)} of its edge. ` : 'Fire would arrive on the ground. '}
              {te.area12.toLocaleString()} ha of country could deliver a fire here within one burning period. Surveyed each new year; the Fireshed lens shows it now.
            </div>
          </div>
        );
      })()}
      <h4 style={{ marginTop: '10px' }}>Firewise readiness</h4>
      <div class="row" style={{ marginTop: '6px' }}>
        <div class="grow">
          <Bar v={t.firewise} color={t.firewise > 0.5 ? 'var(--green)' : t.firewise > 0.3 ? 'var(--gold)' : 'var(--red)'} />
        </div>
        <span class="num">{pct(t.firewise)}</span>
      </div>
      <div class="faint" style={{ fontSize: '12px', marginTop: '4px' }}>
        Hardened homes: ember-proof roofs and vents, cleared yards. Rises with the firewise building code (a five-year programme) and with treated ground within ~400 m. A hardened home survives flames that take its neighbour.
      </div>
      <div class="kv" style={{ marginTop: '8px' }}>
        <span class="k">Fire threat now</span>
        <span class="v" style={{ color: t.threat > 0.5 ? 'var(--red)' : undefined }}>
          {t.threat > 0.5 ? 'HIGH' : t.threat > 0.1 ? 'moderate' : 'none'}
        </span>
        <span class="k">Smoke today</span>
        <span class="v">{t.smokeToday > 0.15 ? 'smoky' : 'clear'}</span>
        <span class="k">Smoky days this year</span>
        <span class="v">{t.smokeDays}</span>
        <span class="k">Homes ever lost</span>
        <span class="v">{t.lostStructures}</span>
        {id === 0 ? (
          <>
            <span class="k">Reservoir</span>
            <span class="v">
              {pct(w.reservoirLevel)} full · {pct(w.reservoirSilt)} silted
            </span>
          </>
        ) : null}
        {t.mill ? (
          <>
            <span class="k">Sawmill</span>
            <span class="v">{w.economy.millOpen ? `open · wants ${w.economy.millDemand.toLocaleString()} t/yr` : 'closed'}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ProjectView({ s, id }: { s: GameSession; id: number }) {
  const w = s.world;
  const pr = w.projects.find((p) => p.id === id);
  if (!pr) return <Overview s={s} />;
  const crews = w.crews.filter((c) => c.task?.projectId === pr.id);
  return (
    <div>
      <Header s={s} title={PROJECT_NAMES[pr.kind]} sub={pr.label} />
      <div class="kv" style={{ marginTop: '8px' }}>
        <span class="k">Status</span>
        <span class="v">{pr.status === 'waiting' && pr.kind === 'burn' ? 'awaiting burn window' : pr.status}</span>
        <span class="k">Progress</span>
        <span class="v">
          {pr.done} / {pr.unit.length} ha
        </span>
        <span class="k">Spent · est. total</span>
        <span class="v">
          {money(pr.spent)} · {money(pr.costPerCell * pr.unit.length)}
        </span>
        <span class="k">Queued</span>
        <span class="v">{dayToDate(pr.createdDay)}</span>
        {pr.kind === 'burn' ? (
          <>
            <span class="k">Days waiting</span>
            <span class="v">{pr.waitDays}</span>
          </>
        ) : null}
        <span class="k">Crews</span>
        <span class="v">{crews.map((c) => c.name).join(', ') || 'none yet'}</span>
      </div>
      {pr.kind === 'burn' && pr.status !== 'done' && pr.status !== 'cancelled' && pr.status !== 'burning'
        ? (() => {
            const o = burnOutlook(w, pr);
            const need = burnCrewsNeeded(pr);
            return (
              <div class="card" style={{ marginTop: '8px' }} id="burn-outlook">
                <div class="faint" style={{ fontSize: '11px' }}>
                  THE BURN BOSS, TODAY
                </div>
                <div style={{ fontWeight: 700, color: o.problem ? 'var(--gold)' : 'var(--green)' }}>{o.problem ? 'No go: ' + o.problem : 'Go: in prescription'}</div>
                <div class="faint" style={{ fontSize: '12px', marginTop: '3px' }}>
                  Fire would carry across {pct(o.carry)} of the unit this afternoon; {pct(o.hot)} of it would burn too hot to hold. Needs {need} free hand crew{need === 1 ? '' : 's'} to light and hold it.
                  {pr.note ? ' ' + pr.note : ''}
                </div>
              </div>
            );
          })()
        : null}
      {pr.kind === 'burn' ? (
        <div class="faint" style={{ fontSize: '12px', marginTop: '6px' }}>
          Lit only on a day when fire will carry but stay on the ground: low or moderate danger, wind under 23 km/h, no wind event in the forecast. You are charged for what burns.
        </div>
      ) : pr.note ? (
        <div class="faint" style={{ fontSize: '12px', marginTop: '6px' }}>
          {pr.note}
        </div>
      ) : null}
      {pr.status !== 'burning' && pr.status !== 'done' && pr.status !== 'cancelled' ? (
        <button class="btn small danger" style={{ marginTop: '10px' }} onClick={() => s.command({ t: 'cancelProject', id: pr.id })}>
          Cancel project
        </button>
      ) : null}
    </div>
  );
}

function WildView({ s }: { s: GameSession }) {
  const w = s.world;
  const sel = s.selection!;
  if (sel.type === 'herd') {
    const h = w.herds.find((x) => x.id === sel.id);
    if (!h) return <Overview s={s} />;
    return (
      <div>
        <Header s={s} title="Mule deer herd" sub={`${h.n} animals`} />
        <div class="kv" style={{ marginTop: '8px' }}>
          <span class="k">Body condition</span>
          <span class="v">{pct(h.cond)}</span>
          <span class="k">Foraging</span>
          <span class="v">{h.fed > 0.95 ? 'plenty' : h.fed > 0.6 ? 'adequate' : 'scarce'}</span>
        </div>
        <p class="faint" style={{ fontSize: '12px' }}>
          Herds summer high and winter low, follow fresh growth after fire, and avoid places where wolves have been. Each deer eats what its herd finds where it stands, so crowded winter range means thin deer by spring.
        </p>
      </div>
    );
  }
  if (sel.type === 'pack') {
    const p = w.packs.find((x) => x.id === sel.id);
    if (!p) return <Overview s={s} />;
    return (
      <div>
        <Header s={s} title={`The ${p.name}`} sub={`${p.n} wolves · since ${dayToDate(p.founded)}`} />
        <div class="kv" style={{ marginTop: '8px' }}>
          <span class="k">Kills</span>
          <span class="v">{p.kills} deer</span>
          <span class="k">Hunger</span>
          <span class="v">{p.hunger > 0.8 ? 'starving' : p.hunger > 0.3 ? 'hungry' : 'fed'}</span>
        </div>
        <p class="faint" style={{ fontSize: '12px' }}>
          The dashed circle is the pack’s territory. Deer avoid it, so browse there falls and young aspen and willow can grow.
        </p>
      </div>
    );
  }
  if (sel.type !== 'colony') return <Overview s={s} />;
  const c = w.colonies.find((x) => x.id === sel.id);
  if (!c) return <Overview s={s} />;
  return (
    <div>
      <Header s={s} title="Beaver colony" sub={c.active ? `${c.n} beavers · ${c.years.toFixed(1)} years here` : 'abandoned'} />
      <div class="kv" style={{ marginTop: '8px' }}>
        <span class="k">Dam</span>
        <span class="v">{pct(c.dam)}</span>
        <span class="k">Food nearby</span>
        <span class="v">{c.food > 0.12 ? 'good' : c.food > 0.05 ? 'thin' : 'exhausted'}</span>
      </div>
      <p class="faint" style={{ fontSize: '12px' }}>
        Ponds keep the valley floor green through drought, trap sediment before it reaches the reservoir, and give helicopters water close to fires.
      </p>
    </div>
  );
}

export function dangerColor(k: number): string {
  return DANGER_COLORS[k];
}
export { FACTION_NAMES, MONTH_NAMES };
