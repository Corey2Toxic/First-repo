/**
 * Heads-up display: top bar, tool palette and flyouts, lenses and legend,
 * notification feed, toasts, panel dock and the advisor card.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { GameSession, ToolId } from '../app/session.ts';
import { SPEED_NAMES } from '../app/session.ts';
import { Icons } from './icons.tsx';
import { DANGER_COLORS, approvalColor, compass, dateStr, hourStr, money } from './format.ts';
import { DANGER_NAMES } from '../sim/systems/climate.ts';
import { LENSES } from '../render/lenses.ts';
import { SP, ZONE, ZONE_NAMES } from '../sim/types.ts';
import { COST, CREW_COST } from '../sim/economyParams.ts';
import { projectCostPerCell } from '../sim/systems/projects.ts';
import { objectives } from '../sim/objectives.ts';
import { ForecastStrip } from './incident.tsx';

export type PanelId = 'fires' | 'crews' | 'projects' | 'charge' | 'policies' | 'council' | 'ledger' | 'charts' | 'almanac' | 'notes' | 'help' | 'menu';

export function TopBar({ s, openPanel }: { s: GameSession; openPanel: (p: PanelId) => void }) {
  const w = s.world;
  const wx = w.weather;
  const trust = w.trust;
  const fires = w.fires.filter((f) => f.active && f.detected && f.cause !== 'prescribed').length;
  const arrowDeg = (wx.windDir * 180) / Math.PI;
  const charges = objectives(w);
  const bar = useRef<HTMLDivElement>(null);
  // The bar wraps onto several rows on narrow screens; publish where it ends so
  // the panels below it (tools, lenses, drawers, flyouts, toasts) start there.
  useEffect(() => {
    const el = bar.current;
    const host = el?.parentElement;
    if (!el || !host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => host.style.setProperty('--hud-top', `${el.offsetTop + el.offsetHeight + 12}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      host.style.removeProperty('--hud-top');
    };
  }, []);
  return (
    <div class="topbar panel" ref={bar}>
      <div style={{ minWidth: '150px' }}>
        <div class="valley">{w.valleyName}</div>
        <div class="date num">
          Year {w.year} of {w.config.tenureYears} · {dateStr(w)} · {hourStr(w.sub)}
        </div>
      </div>
      <div class="speeds" id="speed" title="Space: pause · 1–4: speed · N: run to the next thing that needs you">
        {[0, 1, 2, 3, 4].map((k) => (
          <button class={s.speed === k && !s.skipping ? 'on' : ''} onClick={() => s.setSpeed(k)} title={SPEED_NAMES[k]} aria-label={SPEED_NAMES[k]}>
            {k === 0 ? Icons.pause({ size: 14 }) : <span style={{ display: 'flex' }}>{Array.from({ length: k }, () => Icons.play({ size: 9 }))}</span>}
          </button>
        ))}
        <button class={'next' + (s.skipping ? ' on' : '')} id="next-event" onClick={() => s.advanceToEvent()} title="Run fast until something needs you: a fire, a fire-weather watch, a briefing, the turn of the season (N)" aria-label="Run to the next event">
          <span class="nword">Next </span>▸▸
        </button>
      </div>
      <div class="stat" title={`Annual allocation ${money(w.economy.annualBudget)}`}>
        <span class="k">Funds</span>
        <span class="v" style={{ color: w.economy.funds < 0 ? 'var(--red)' : undefined }}>
          {money(w.economy.funds)}
        </span>
      </div>
      <div class="stat p" style={{ cursor: 'pointer' }} onClick={() => openPanel('council')} title="Council trust — click for details" id="panel-council">
        <span class="k">Trust</span>
        <span class="v" style={{ color: approvalColor(trust) }}>
          {Math.round(trust)}
        </span>
        <div class="trustbar">
          <i style={{ width: `${trust}%`, background: approvalColor(trust) }} />
        </div>
      </div>
      <div class="stat p charge-chip" onClick={() => openPanel('charge')} title="The council's charge — click for details" id="panel-charge">
        <span class="k">Charge</span>
        <div class="pips">
          {charges.map((o) => (
            <i style={{ background: o.state === 'failed' ? 'var(--red)' : o.state === 'behind' ? 'var(--gold)' : o.kind === 'reach' && o.progress < 1 ? `linear-gradient(90deg, var(--green) ${o.progress * 100}%, rgba(255,255,255,0.14) ${o.progress * 100}%)` : 'var(--green)' }} title={`${o.title}: ${o.reading}`} key={o.id} />
          ))}
        </div>
      </div>
      <div class="danger-badge" style={{ background: DANGER_COLORS[wx.dangerClass] + '33', color: DANGER_COLORS[wx.dangerClass], border: `1px solid ${DANGER_COLORS[wx.dangerClass]}88` }} title="Valley fire danger today">
        {DANGER_NAMES[wx.dangerClass]}
        <span class="dword"> danger</span>
        {w.memory.fireBanActive ? ' · ban' : ''}
      </div>
      <ForecastStrip s={s} />
      <div class="wx">
        <span class="temp" title="Temperature (valley floor)">{Math.round(wx.tmax)}°C</span>
        <span title={`Wind from the ${compass(wx.windDir)}`}>
          <span class="wind-arrow" style={{ transform: `rotate(${arrowDeg}deg)` }}>
            ➜
          </span>{' '}
          {Math.round(wx.windSpeed * 3.6)} km/h {compass(wx.windDir)}
          {wx.windEvent ? <b style={{ color: 'var(--ember)' }}> · {w.climate.localWindName}</b> : null}
        </span>
        <span class="hum" title="Relative humidity">
          RH {Math.round(wx.rh * 100)}%
        </span>
        {wx.precip > 0.5 ? <span title="Precipitation today">{wx.temp < 0.5 ? '❄' : '☂'} {wx.precip.toFixed(0)} mm</span> : null}
        {wx.storm ? <span style={{ color: '#ffd27a' }} title="Thunderstorms">⚡{wx.dryLightning ? ' dry' : ''}</span> : null}
      </div>
      <div class="grow" />
      {fires > 0 ? (
        <button class="btn danger" onClick={() => openPanel('fires')}>
          {Icons.fire({ size: 14 })} {fires} active fire{fires > 1 ? 's' : ''}
        </button>
      ) : null}
      <button class="btn ghost" onClick={() => openPanel('menu')} title="Menu (save, load, settings)">
        {Icons.menu({ size: 16 })}
      </button>
    </div>
  );
}

interface ToolDef {
  id: ToolId;
  name: string;
  key?: string;
  icon: string;
}
const TOOLS: Array<ToolDef | null> = [
  { id: 'inspect', name: 'Inspect & pan', key: 'Q', icon: 'inspect' },
  null,
  { id: 'zone', name: 'Zones', key: 'Z', icon: 'zone' },
  { id: 'thin', name: 'Thinning', key: 'T', icon: 'thin' },
  { id: 'burn', name: 'Prescribed burn', key: 'B', icon: 'burn' },
  { id: 'plant', name: 'Plant trees', icon: 'plant' },
  { id: 'fuelbreak', name: 'Fuel break', icon: 'fuelbreak' },
  null,
  { id: 'fireline', name: 'Cut fireline', key: 'F', icon: 'fireline' },
  { id: 'airdrop', name: 'Air-tanker drop', key: 'X', icon: 'airdrop' },
  null,
  { id: 'road', name: 'Build road', icon: 'road' },
  { id: 'tower', name: 'Lookout tower', icon: 'tower' },
  { id: 'camp', name: 'Campground', icon: 'camp' },
  null,
  { id: 'wolves', name: 'Release wolves', icon: 'wolves' },
  { id: 'beavers', name: 'Relocate beavers', icon: 'beavers' },
];

export function ToolBar({ s }: { s: GameSession }) {
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div class="toolbar panel">
      {TOOLS.map((t, k) =>
        t ? (
          <button
            key={t.id}
            id={'tool-' + t.id}
            class={'toolbtn' + (s.tool.id === t.id ? ' on' : '') + (s.advisor.card?.highlight === 'tool-' + t.id ? ' pulse' : '')}
            onClick={() => s.setTool(s.tool.id === t.id && t.id !== 'inspect' ? 'inspect' : t.id)}
            onMouseEnter={() => setHover(t.id)}
            onMouseLeave={() => setHover(null)}
            aria-label={t.name}
          >
            {Icons[t.icon]()}
            {hover === t.id ? (
              <span class="tooltip">
                {t.name}
                {t.key ? <span class="kbd">{t.key}</span> : null}
              </span>
            ) : null}
          </button>
        ) : (
          <div class="toolgroup-sep" key={'sep' + k} />
        ),
      )}
    </div>
  );
}

const ZONE_DESC: Record<number, string> = {
  [ZONE.WILDERNESS]: 'No roads or logging. Lightning fires are monitored, not fought, unless they threaten values. Conservationists love it.',
  [ZONE.RECREATION]: 'Draws visitors and fees — and their campfires.',
  [ZONE.TIMBER]: 'The mill harvests mature stands here each autumn. Jobs and revenue; slash and young thickets follow.',
  [ZONE.RANGE]: 'Cattle graze the grass, reducing fine fuel. Wolves and cattle do not mix.',
  [ZONE.BUFFER]: 'Wildland–urban interface within 1 km of homes. Fires that reach it are always fought, and crews go there first. Thinned or burned buffer raises the town’s firewise rating and is kept treated each year ($45/ha). New homes are not built in it unless there is no other room.',
  [ZONE.NONE]: 'No special management. Fires are suppressed by default.',
};
export const ZONE_COLORS = ['#888', '#5abf73', '#59b3f2', '#f2a640', '#ebe066', '#f26666'];

export function ToolFlyout({ s }: { s: GameSession }) {
  const t = s.tool;
  if (t.id === 'inspect') return null;
  const brush = (
    <div class="col" style={{ marginTop: '10px' }}>
      <div class="row">
        <span class="dim" style={{ fontSize: '12px' }}>
          Brush radius
        </span>
        <span class="grow" />
        <span class="num">{t.brush * 100 + 50} m</span>
      </div>
      <input type="range" min={0} max={8} value={t.brush} onInput={(e) => s.setTool(t.id, { brush: Number((e.target as HTMLInputElement).value) })} />
      <div class="faint" style={{ fontSize: '11.5px' }}>
        Drag to paint · <span class="kbd">[</span>
        <span class="kbd">]</span> resize · right-click/Esc cancels
      </div>
    </div>
  );
  let body: preact.ComponentChildren = null;
  let title = '';
  switch (t.id) {
    case 'zone':
      title = 'Zones';
      body = (
        <div>
          {[ZONE.BUFFER, ZONE.WILDERNESS, ZONE.TIMBER, ZONE.RANGE, ZONE.RECREATION, ZONE.NONE].map((z) => (
            <div class={'opt' + (t.zone === z ? ' on' : '')} onClick={() => s.setTool('zone', { zone: z })} key={z}>
              <i class="swatch" style={{ background: ZONE_COLORS[z] }} />
              <div>
                <div style={{ fontWeight: 600 }}>{ZONE_NAMES[z]}</div>
                <div class="faint" style={{ fontSize: '11.5px' }}>
                  {ZONE_DESC[z]}
                </div>
              </div>
            </div>
          ))}
          <div class="faint" style={{ fontSize: '11.5px', marginTop: '6px' }}>
            Shift-drag to clear zoning.
          </div>
          {brush}
        </div>
      );
      break;
    case 'thin':
      title = 'Mechanical thinning';
      body = (
        <div>
          <p class="dim" style={{ margin: 0 }}>
            Crews cut shrubs and young fir and thin the canopy, removing the ladder that carries fire into crowns. Leaves slash on the ground unless the
            pile-and-burn policy is on.
          </p>
          <div class="kv" style={{ marginTop: '8px' }}>
            <span class="k">Cost</span>
            <span class="v">{money(projectCostPerCell('thin', s.world))}/ha</span>
            <span class="k">Pace</span>
            <span class="v">~5 ha/crew/day</span>
          </div>
          {brush}
        </div>
      );
      break;
    case 'burn':
      title = 'Prescribed burn';
      body = (
        <div>
          <p class="dim" style={{ margin: 0 }}>
            Crews ring the unit with control line and light it when the weather is mild, fuels are damp and wind is light — usually spring or autumn. Cheap and
            ecologically rich; produces smoke, and occasionally escapes. A unit beside houses can escape straight into town: thin the first few
            hundred metres around homes and burn beyond them.
          </p>
          <div class="kv" style={{ marginTop: '8px' }}>
            <span class="k">Cost</span>
            <span class="v">{money(COST.burn)}/ha</span>
          </div>
          {brush}
        </div>
      );
      break;
    case 'plant':
      title = 'Plant trees';
      body = (
        <div>
          <p class="dim" style={{ margin: 0 }}>
            Speeds recovery on open or burned ground.
          </p>
          <div class="seg" style={{ marginTop: '8px' }}>
            {[
              [SP.PINE, 'Pine'],
              [SP.FIR, 'Fir'],
              [SP.ASPEN, 'Aspen'],
            ].map(([sp, n]) => (
              <button class={t.species === sp ? 'on' : ''} onClick={() => s.setTool('plant', { species: sp as number })}>
                {n}
              </button>
            ))}
          </div>
          <div class="kv" style={{ marginTop: '8px' }}>
            <span class="k">Cost</span>
            <span class="v">{money(COST.plant)}/ha</span>
          </div>
          {brush}
        </div>
      );
      break;
    case 'fuelbreak':
      title = 'Shaded fuel break';
      body = (
        <div>
          <p class="dim" style={{ margin: 0 }}>
            A permanent strip of open, mowed forest where crews can make a stand. Expensive to cut and to maintain ({money(COST.fuelbreakUpkeep)}/ha/yr).
            Embers fly over it in strong wind.
          </p>
          <div class="kv" style={{ marginTop: '8px' }}>
            <span class="k">Cost</span>
            <span class="v">{money(COST.fuelbreak)}/ha</span>
          </div>
          {brush}
        </div>
      );
      break;
    case 'fireline':
      title = 'Cut fireline';
      body = (
        <p class="dim" style={{ margin: 0 }}>
          Drag along the ground where you want a line. The nearest free crew walks there and scrapes it to mineral soil. Lines stop surface fire — not crown
          fire, and not embers.
        </p>
      );
      break;
    case 'airdrop':
      title = 'Air-tanker retardant drop';
      body = (
        <p class="dim" style={{ margin: 0 }}>
          Drag a line ahead of a fire. Retardant slows fire for a few days. {money(COST.retardantDrop)} per drop (10 cells, 1 km).
        </p>
      );
      break;
    case 'road':
      title = 'Build road';
      body = (
        <p class="dim" style={{ margin: 0 }}>
          Click a start point on an existing road, then a destination. Roads speed crews and open timber to harvest — and bring people, sparks and erosion.
          {money(COST.road)} per 100 m. Not allowed in Wilderness.
        </p>
      );
      break;
    case 'tower':
      title = 'Lookout tower';
      body = (
        <p class="dim" style={{ margin: 0 }}>
          Click a summit. Spots smoke within ~3.4 km, so fires are found while they are small. {money(COST.tower)} + {money(COST.towerUpkeep)}/yr.
        </p>
      );
      break;
    case 'camp':
      title = 'Campground';
      body = (
        <p class="dim" style={{ margin: 0 }}>
          Click near a road. More visitors and fees; more campfires. {money(COST.camp)}.
        </p>
      );
      break;
    case 'wolves':
      title = 'Release wolves';
      body = (
        <p class="dim" style={{ margin: 0 }}>
          Click remote country at least 1.6 km from town. Five wolves from a neighbouring range. Conservationists cheer; ranchers do not. {money(COST.wolfReintro)}.
        </p>
      );
      break;
    case 'beavers':
      title = 'Relocate beavers';
      body = (
        <p class="dim" style={{ margin: 0 }}>
          Click a gentle stream with willow or aspen. Beavers need food within reach — check the Vegetation lens. {money(COST.beaverRelocation)}.
        </p>
      );
      break;
    case 'send':
      title = 'Send crew';
      body = (
        <p class="dim" style={{ margin: 0 }}>
          Click a fire, a project, or any spot on the map.
        </p>
      );
      break;
  }
  return (
    <div class="flyout panel">
      <div class="row">
        <h3>{title}</h3>
        <button class="close" onClick={() => s.setTool('inspect')} aria-label="Close tool">
          ×
        </button>
      </div>
      <div style={{ marginTop: '6px' }}>{body}</div>
      {s.pathLabel ? (
        <div class="tag" style={{ marginTop: '8px' }}>
          {s.pathLabel}
        </div>
      ) : null}
    </div>
  );
}

export function LensBar({ s }: { s: GameSession }) {
  const info = LENSES.find((l) => l.id === s.lens)!;
  return (
    <div class="lenswrap">
      <div class="lensbar panel">
        {LENSES.map((l) => (
          <button id={'lens-' + l.id} class={(s.lens === l.id ? 'on' : '') + (s.advisor.card?.highlight === 'lens-' + l.id ? ' pulse' : '')} onClick={() => s.setLens(l.id)} title={l.description}>
            {l.name}
          </button>
        ))}
      </div>
      {s.lens !== 'none' ? (
        <div class="legend panel">
          <div class="row">
            <h3>{info.name}</h3>
          </div>
          <div class="faint" style={{ fontSize: '12px', margin: '4px 0 6px' }}>
            {info.description}
          </div>
          {info.legend.map(([c, l]) => (
            <div class="item" key={l}>
              <i class="swatch" style={{ background: c }} /> {l}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Feed({ s }: { s: GameSession }) {
  const w = s.world;
  const items = w.notifications.filter((n) => w.day - n.day < 25).slice(-5);
  return (
    <div class="feed">
      {items.map((n) => (
        <div
          class={'item ' + n.level}
          key={n.id}
          onClick={() => {
            if (n.x !== undefined && n.y !== undefined) s.focus(n.x, n.y);
            if (n.fireId !== undefined) s.select({ type: 'fire', id: n.fireId });
          }}
        >
          <span class="when">{w.day === n.day ? 'today' : `${w.day - n.day}d ago`}</span>
          {n.text}
        </div>
      ))}
    </div>
  );
}

export function Toasts({ s }: { s: GameSession }) {
  return (
    <div class="toasts">
      {s.toasts.map((t) => (
        <div class={'toast ' + t.level} key={t.id}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Dock({ s, panel, openPanel }: { s: GameSession; panel: PanelId | null; openPanel: (p: PanelId | null) => void }) {
  const w = s.world;
  const fires = w.fires.filter((f) => f.active && f.detected).length;
  const notes = Object.keys(w.discoveries).length;
  const items: Array<[PanelId, string, string, number?]> = [
    ['fires', 'Fires', 'fire', fires],
    ['crews', 'Crews', 'crew'],
    ['projects', 'Projects', 'project'],
    ['charge', 'Charge', 'target'],
    ['policies', 'Policies', 'policy'],
    ['council', 'Council', 'council'],
    ['ledger', 'Budget', 'ledger'],
    ['charts', 'Trends', 'chart'],
    ['almanac', 'Almanac', 'book'],
    ['notes', `Field notes ${notes}`, 'leaf'],
    ['help', 'Help', 'help'],
  ];
  return (
    <div class="dock panel">
      {items.map(([id, label, icon, badge]) => (
        <button class={panel === id ? 'on' : ''} onClick={() => openPanel(panel === id ? null : id)} key={id}>
          {Icons[icon]({ size: 15 })} {label}
          {badge ? <span class="badge">{badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function AdvisorCardView({ s, docked }: { s: GameSession; docked?: boolean }) {
  const a = s.advisor;
  const card = a.card ?? a.tip;
  if (!card) return null;
  const isTip = !a.card;
  return (
    <div class={'advisor panel' + (isTip ? ' tip' : '') + (docked ? ' docked' : '')}>
      <div class="row">
        <span class="who">{isTip ? 'Deputy’s note' : 'Your deputy'}</span>
        <span class="grow" />
        {isTip ? (
          <button class="close" onClick={() => a.dismissTip()} aria-label="Dismiss">
            ×
          </button>
        ) : (
          <button class="btn ghost small" onClick={() => a.skipTutorial()}>
            Skip tutorial
          </button>
        )}
      </div>
      <h3 style={{ marginTop: '4px' }}>{card.title}</h3>
      <p class="dim" style={{ margin: '6px 0 0' }}>
        {card.body}
      </p>
      <div class="row" style={{ marginTop: '10px' }}>
        {card.focus ? (
          <button class="btn small" onClick={() => s.focus(card.focus![0], card.focus![1], 10)}>
            {Icons.target({ size: 13 })} Show me
          </button>
        ) : null}
        <span class="grow" />
        {card.action ? (
          <button class="btn primary small" onClick={() => a.ack()}>
            {card.action}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export const CREW_LABEL: Record<string, string> = { hand: 'Hand crew', engine: 'Engine', heli: 'Helicopter' };
export { CREW_COST };
