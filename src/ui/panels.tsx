/**
 * Drawer panels: fires, crews, projects, policies, council, budget, trends,
 * almanac, field notes, help and the game menu.
 */
import { useEffect, useState } from 'preact/hooks';
import type { GameSession } from '../app/session.ts';
import type { PanelId } from './hud.tsx';
import { CREW_LABEL } from './hud.tsx';
import { FACTIONS, FACTION_NAMES } from '../sim/types.ts';
import type { CrewKind, Policies } from '../sim/types.ts';
import { CREW_COST } from '../sim/economyParams.ts';
import { ledgerTotals } from '../sim/systems/economy.ts';
import { FIELD_NOTES } from '../sim/notes.ts';
import { approvalColor, dayToDate, ha, money, pct } from './format.ts';
import { BarChart, LineChart } from './charts.tsx';
import { canDownload, exportFile, importFile, listSlots, loadSlot, saveToSlot } from '../app/storage.ts';
import type { SlotInfo } from '../app/storage.ts';
import type { World } from '../sim/world.ts';

export function Drawer({ s, id, close, onLoad, onQuit }: { s: GameSession; id: PanelId; close: () => void; onLoad: (w: World) => void; onQuit: () => void }) {
  const titles: Record<PanelId, string> = {
    fires: 'Fires',
    crews: 'Crews',
    projects: 'Projects',
    policies: 'Policies',
    council: 'The council',
    ledger: 'Budget',
    charts: 'Trends',
    almanac: 'The almanac',
    notes: 'Field notes',
    help: 'How to play',
    menu: 'Menu',
  };
  return (
    <div class="drawer panel">
      <div class="head">
        <h2>{titles[id]}</h2>
        <button class="close" onClick={close} aria-label="Close panel">
          ×
        </button>
      </div>
      <div class="body">
        {id === 'fires' && <FiresPanel s={s} close={close} />}
        {id === 'crews' && <CrewsPanel s={s} />}
        {id === 'projects' && <ProjectsPanel s={s} close={close} />}
        {id === 'policies' && <PoliciesPanel s={s} />}
        {id === 'council' && <CouncilPanel s={s} />}
        {id === 'ledger' && <LedgerPanel s={s} />}
        {id === 'charts' && <ChartsPanel s={s} />}
        {id === 'almanac' && <AlmanacPanel s={s} close={close} />}
        {id === 'notes' && <NotesPanel s={s} />}
        {id === 'help' && <HelpPanel />}
        {id === 'menu' && <MenuPanel s={s} onLoad={onLoad} onQuit={onQuit} />}
      </div>
    </div>
  );
}

function FiresPanel({ s, close }: { s: GameSession; close: () => void }) {
  const w = s.world;
  const active = w.fires.filter((f) => f.active && (f.detected || s.settings.reveal));
  const recent = w.fires.filter((f) => !f.active && f.detected && w.day - f.outDay < 360).slice(-12).reverse();
  return (
    <div class="list">
      {active.length === 0 ? <p class="dim">No fires are burning that anyone knows about.</p> : null}
      {active.map((f) => (
        <div class="card" key={f.id} style={{ cursor: 'pointer' }} onClick={() => (s.select({ type: 'fire', id: f.id }), s.focus((f.minX + f.maxX) / 2, (f.minY + f.maxY) / 2), close())}>
          <div class="row">
            <b class="grow">{f.name}</b>
            <span class="tag">{f.response}</span>
          </div>
          <div class="dim" style={{ fontSize: '12px' }}>
            {ha(f.area)} · {pct(f.containment)} contained · {w.crews.filter((c) => c.task?.fireId === f.id).length} crews · started {dayToDate(f.startDay)}
            {f.crownArea ? ` · ${ha(f.crownArea)} crown` : ''}
          </div>
        </div>
      ))}
      {recent.length ? (
        <>
          <h4 style={{ margin: '16px 0 8px' }}>Recently out</h4>
          {recent.map((f) => (
            <div class="row" style={{ fontSize: '12.5px', padding: '3px 0' }} key={f.id}>
              <span class="grow">{f.name}</span>
              <span class="dim">
                {ha(f.area)} · {f.outDay - f.startDay} days{f.structuresLost ? ` · ${f.structuresLost} homes` : ''}
              </span>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

function CrewsPanel({ s }: { s: GameSession }) {
  const w = s.world;
  const kinds: CrewKind[] = ['hand', 'engine', 'heli'];
  const desc: Record<CrewKind, string> = {
    hand: 'Twenty people with tools. Cut fireline, mop up, carry out thinning and prescribed burns. Walk off-road.',
    engine: 'Fast on roads. Defends homes and attacks low-intensity fire near roads. Poor off-road.',
    heli: 'Flies anywhere and drops water — as long as there is a lake, river or beaver pond nearby.',
  };
  return (
    <div>
      <div class="row" style={{ marginBottom: '10px' }}>
        <label class="row" style={{ gap: '6px', cursor: 'pointer' }}>
          <input type="checkbox" checked={w.policies.autoDispatch} onChange={(e) => s.command({ t: 'policy', key: 'autoDispatch', value: (e.target as HTMLInputElement).checked }, true)} />
          Auto-dispatch crews to fires under suppression
        </label>
      </div>
      <div class="list">
        {w.crews.map((c) => (
          <div class="card" key={c.id} style={{ cursor: 'pointer' }} onClick={() => (s.select({ type: 'crew', id: c.id }), s.focus(c.x, c.y))}>
            <div class="row">
              <b class="grow">{c.name}</b>
              <span class="faint">{CREW_LABEL[c.kind]}</span>
              <span class="tag">{c.state}</span>
            </div>
          </div>
        ))}
      </div>
      <h4 style={{ margin: '16px 0 8px' }}>Hire</h4>
      {kinds.map((k) => (
        <div class="card" style={{ marginBottom: '8px' }} key={k}>
          <div class="row">
            <b class="grow">{CREW_LABEL[k]}</b>
            <span class="dim num">
              {money(CREW_COST[k].hire)} + {money(CREW_COST[k].yearly)}/yr
            </span>
            <button class="btn small" onClick={() => s.command({ t: 'hire', kind: k })}>
              Hire
            </button>
          </div>
          <div class="faint" style={{ fontSize: '12px', marginTop: '3px' }}>
            {desc[k]}
          </div>
        </div>
      ))}
    </div>
  );
}

function ProjectsPanel({ s, close }: { s: GameSession; close: () => void }) {
  const w = s.world;
  const live = w.projects.filter((p) => p.status !== 'done' && p.status !== 'cancelled');
  const done = w.projects.filter((p) => p.status === 'done').slice(-10).reverse();
  const committed = live.reduce((a, p) => a + p.costPerCell * p.todo.length, 0);
  return (
    <div>
      <p class="dim" style={{ marginTop: 0 }}>
        Paint treatments with the tools on the left. Hand crews work projects in order when no fire needs them; burns wait for their weather window. Still to
        spend on queued work: <b>{money(committed)}</b>.
      </p>
      <div class="list">
        {live.length === 0 ? <p class="faint">No projects queued.</p> : null}
        {live.map((p) => (
          <div class="card" key={p.id} style={{ cursor: 'pointer' }} onClick={() => (s.select({ type: 'project', id: p.id }), s.focus(p.cx, p.cy), close())}>
            <div class="row">
              <b class="grow">{p.label}</b>
              <span class="tag">{p.status === 'waiting' && p.kind === 'burn' ? 'awaiting window' : p.status}</span>
            </div>
            <div class="bar" style={{ marginTop: '6px' }}>
              <i style={{ width: `${(100 * p.done) / p.unit.length}%`, background: 'var(--green)' }} />
            </div>
          </div>
        ))}
      </div>
      {done.length ? (
        <>
          <h4 style={{ margin: '16px 0 8px' }}>Completed</h4>
          {done.map((p) => (
            <div class="row" style={{ fontSize: '12.5px', padding: '3px 0' }} key={p.id}>
              <span class="grow">{p.label}</span>
              <span class="dim">
                {p.done} ha · {money(p.spent)} · {dayToDate(p.doneDay)}
              </span>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

interface PolicyDef {
  key: keyof Policies;
  name: string;
  options: Array<[string | boolean, string]>;
  desc: string;
}
const POLICIES: PolicyDef[] = [
  { key: 'fireBan', name: 'Fire ban', options: [['never', 'Never'], ['auto', 'When danger is very high'], ['summer', 'All summer']], desc: 'Bans cut human ignitions by three-quarters. Outfitters and campers hate long bans.' },
  { key: 'buildingCode', name: 'Building code', options: [['standard', 'Standard'], ['firewise', 'Firewise']], desc: 'Ember-resistant roofs, vents and cleared yards. Residents grumble about the cost for a few years, then feel safer.' },
  { key: 'growthBoundary', name: 'Growth boundary', options: [[false, 'Off'], [true, 'On']], desc: 'Stops towns sprawling into the forest. Slows growth.' },
  { key: 'harvest', name: 'Harvest quota', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], desc: 'How much the mill may cut each autumn in Timber zones.' },
  { key: 'harvestMethod', name: 'Harvest method', options: [['selective', 'Selective'], ['clearcut', 'Clearcut']], desc: 'Clearcuts yield more per hectare, scar the view, bleed soil and regrow as dense, flammable thickets.' },
  { key: 'slash', name: 'Logging slash', options: [['leave', 'Leave on site'], ['pileburn', 'Pile & burn']], desc: 'Slash left behind is fuel. Piling and burning it costs $120/ha.' },
  { key: 'salvage', name: 'Salvage logging', options: [[false, 'Off'], [true, 'On']], desc: 'Harvest dead trees after fire or beetles in Timber zones. Money for the mill; damaged soils and angry conservationists.' },
  { key: 'grazing', name: 'Grazing permits', options: [['none', 'None'], ['light', 'Light'], ['heavy', 'Heavy']], desc: 'Cattle on Rangeland eat grass — fine fuel — but also pull wolves toward the herds.' },
  { key: 'wolfPolicy', name: 'Wolf management', options: [['protected', 'Protected'], ['managed', 'Lethal control'], ['bounty', 'Bounty']], desc: 'What happens to wolves that kill livestock — or simply exist.' },
  { key: 'hunting', name: 'Deer hunting', options: [['none', 'None'], ['moderate', 'Moderate'], ['heavy', 'Heavy']], desc: 'Autumn hunts bring license fees and fewer deer.' },
  { key: 'airPatrol', name: 'Air patrol', options: [[false, 'Off'], [true, 'On ($55k/yr)']], desc: 'Spotter flights find remote fires while they are small.' },
  { key: 'smokeRules', name: 'Smoke rules', options: [[false, 'Off'], [true, 'On']], desc: 'Burns only on days with good smoke dispersal. Fewer burn windows; less smoke.' },
];

function PoliciesPanel({ s }: { s: GameSession }) {
  const w = s.world;
  return (
    <div class="col" style={{ gap: '12px' }}>
      {POLICIES.map((p) => (
        <div key={p.key}>
          <div class="row">
            <b class="grow">{p.name}</b>
            <div class="seg">
              {p.options.map(([v, l]) => (
                <button class={w.policies[p.key] === v ? 'on' : ''} onClick={() => s.command({ t: 'policy', key: p.key, value: v }, true)} key={String(v)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div class="faint" style={{ fontSize: '12px', marginTop: '3px' }}>
            {p.desc}
          </div>
        </div>
      ))}
    </div>
  );
}

function CouncilPanel({ s }: { s: GameSession }) {
  const w = s.world;
  const weights = w.factionWeights();
  return (
    <div>
      <div class="row">
        <div class="grow">
          <div class="faint" style={{ fontSize: '11px' }}>
            COUNCIL TRUST
          </div>
          <div style={{ fontSize: '30px', fontWeight: 700, color: approvalColor(w.trust) }}>{Math.round(w.trust)}</div>
        </div>
        <div class="dim" style={{ fontSize: '12px', maxWidth: '300px', textAlign: 'right' }}>
          Trust is the weighted approval of five constituencies. Below 30 at two reviews running — or below 18 at any — and you are out.
        </div>
      </div>
      <div class="sep" />
      {FACTIONS.map((f) => {
        const st = w.factions[f];
        return (
          <div class="card" style={{ marginBottom: '8px' }} key={f}>
            <div class="row">
              <b class="grow">{FACTION_NAMES[f]}</b>
              <span class="faint" style={{ fontSize: '11.5px' }}>
                weight {pct(weights[f])}
              </span>
              <b class="num" style={{ color: approvalColor(st.approval), width: '34px', textAlign: 'right' }}>
                {Math.round(st.approval)}
              </b>
            </div>
            <div class="bar" style={{ marginTop: '5px' }}>
              <i style={{ width: `${st.approval}%`, background: approvalColor(st.approval) }} />
            </div>
            <div style={{ marginTop: '6px' }}>
              {st.factors.map(([k, v]) => (
                <div class="row" style={{ fontSize: '12px' }} key={k}>
                  <span class="grow dim">{k}</span>
                  <span class="num" style={{ color: v >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {v >= 0 ? '+' : ''}
                    {v.toFixed(0)}
                  </span>
                </div>
              ))}
              <div class="faint" style={{ fontSize: '11.5px', marginTop: '2px' }}>
                Drifting toward {Math.round(st.target)}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LedgerPanel({ s }: { s: GameSession }) {
  const w = s.world;
  const l = w.economy.ledger;
  const t = ledgerTotals(l);
  const prev = w.economy.history[w.economy.history.length - 1];
  const rows = (rec: Record<string, number>) =>
    Object.entries(rec)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => (
        <div class="row" style={{ fontSize: '12.5px', padding: '2px 0' }} key={k}>
          <span class="grow dim">{k}</span>
          <span class="num">{money(v)}</span>
        </div>
      ));
  return (
    <div>
      <div class="grid3">
        <div class="card">
          <div class="faint" style={{ fontSize: '11px' }}>
            BALANCE
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700, color: w.economy.funds < 0 ? 'var(--red)' : undefined }}>{money(w.economy.funds)}</div>
        </div>
        <div class="card">
          <div class="faint" style={{ fontSize: '11px' }}>
            INCOME THIS YEAR
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700 }}>{money(t.income)}</div>
        </div>
        <div class="card">
          <div class="faint" style={{ fontSize: '11px' }}>
            SPENT THIS YEAR
          </div>
          <div style={{ fontSize: '20px', fontWeight: 700 }}>{money(t.expense)}</div>
        </div>
      </div>
      <p class="faint" style={{ fontSize: '12px' }}>
        The council allocates money once a year at its review ({money(w.economy.annualBudget)} last time). Unspent funds above 35% of the new allocation go
        back to the county; debt carries over and costs you trust.
      </p>
      <div class="grid2">
        <div>
          <h4>Income</h4>
          {rows(l.income)}
        </div>
        <div>
          <h4>Spending</h4>
          {rows(l.expense)}
        </div>
      </div>
      {prev ? (
        <p class="faint" style={{ fontSize: '12px', marginTop: '12px' }}>
          Last year: income {money(ledgerTotals(prev).income)}, spending {money(ledgerTotals(prev).expense)}.
        </p>
      ) : null}
    </div>
  );
}

function ChartsPanel({ s }: { s: GameSession }) {
  const w = s.world;
  const st = w.stats;
  const [tab, setTab] = useState<'politics' | 'fire' | 'forest' | 'wildlife' | 'water' | 'money'>('politics');
  const mLabel = (i: number) => `Y${Math.floor(i / 12) + 1}`;
  const yLabel = (i: number) => `Y${st.year[i] ?? i + 1}`;
  const FC: Record<string, string> = { residents: '#e9c46a', timber: '#c98b52', ranchers: '#b7c96a', conservation: '#6fbf73', tourism: '#5aa9d6' };
  return (
    <div>
      <div class="seg" style={{ marginBottom: '12px' }}>
        {(['politics', 'fire', 'forest', 'wildlife', 'water', 'money'] as const).map((t) => (
          <button class={tab === t ? 'on' : ''} onClick={() => setTab(t)} key={t}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {st.month.length < 2 ? <p class="dim">Trends appear after the first couple of months.</p> : null}
      {tab === 'politics' && (
        <LineChart
          min={0}
          max={100}
          xLabel={mLabel}
          series={[{ label: 'Trust', color: '#ffffff', data: st.trust }, ...FACTIONS.map((f) => ({ label: FACTION_NAMES[f], color: FC[f], data: st.approvals[f], dashed: true }))]}
        />
      )}
      {tab === 'fire' && (
        <div class="col" style={{ gap: '16px' }}>
          <BarChart xLabel={yLabel} yFmt={(v) => `${Math.round(v)}`} stacks={[{ label: 'Severe (ha)', color: '#c2263a', data: st.burnedHigh }, { label: 'Low–moderate (ha)', color: '#e0a232', data: st.burned.map((b, i) => b - (st.burnedHigh[i] ?? 0)) }]} />
          <LineChart xLabel={mLabel} min={0} max={1} yFmt={(v) => pct(v)} series={[{ label: 'Mean fuel hazard', color: '#e0782f', data: st.fuel }]} />
          <BarChart xLabel={yLabel} stacks={[{ label: 'Homes lost', color: '#e2553f', data: st.structuresLost }, { label: 'Smoky days', color: '#9a9a9a', data: st.smokeDays }]} />
        </div>
      )}
      {tab === 'forest' && (
        <div class="col" style={{ gap: '16px' }}>
          <LineChart xLabel={mLabel} min={0} max={1} yFmt={(v) => pct(v)} series={[{ label: 'Forest cover', color: '#6fbf73', data: st.forest }]} />
          <LineChart xLabel={mLabel} series={[{ label: 'Old growth (ha)', color: '#9a86e8', data: st.oldGrowth }, { label: 'Beetle outbreak (ha)', color: '#e07030', data: st.beetle }]} />
        </div>
      )}
      {tab === 'wildlife' && (
        <div class="col" style={{ gap: '16px' }}>
          <LineChart xLabel={mLabel} series={[{ label: 'Deer', color: '#c98b52', data: st.deer }]} />
          <LineChart xLabel={mLabel} series={[{ label: 'Wolves', color: '#b4a8e8', data: st.wolves }, { label: 'Beaver colonies', color: '#5aa9d6', data: st.beavers }]} />
        </div>
      )}
      {tab === 'water' && (
        <div class="col" style={{ gap: '16px' }}>
          <LineChart xLabel={mLabel} min={0} max={1} yFmt={(v) => pct(v)} series={[{ label: 'Reservoir level', color: '#5aa9d6', data: st.reservoir }]} />
          <BarChart xLabel={yLabel} stacks={[{ label: 'Precipitation (mm)', color: '#5aa9d6', data: st.precip }]} />
          <BarChart xLabel={yLabel} stacks={[{ label: 'Peak snowpack (mm)', color: '#dfe8f2', data: st.snowPeak }]} />
        </div>
      )}
      {tab === 'money' && (
        <div class="col" style={{ gap: '16px' }}>
          <LineChart xLabel={mLabel} yFmt={(v) => money(v)} series={[{ label: 'Funds', color: '#e7b84b', data: st.funds }]} />
          <BarChart xLabel={yLabel} stacks={[{ label: 'Timber harvest (t)', color: '#c98b52', data: st.harvest }]} />
          <BarChart xLabel={yLabel} stacks={[{ label: 'Visitors', color: '#5aa9d6', data: st.visitors }]} />
        </div>
      )}
    </div>
  );
}

function AlmanacPanel({ s, close }: { s: GameSession; close: () => void }) {
  const w = s.world;
  const byYear = new Map<number, typeof w.chronicle>();
  for (const c of w.chronicle) {
    const y = Math.floor(c.day / 360) + 1;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(c);
  }
  const years = [...byYear.keys()].sort((a, b) => b - a);
  return (
    <div>
      <p class="dim" style={{ marginTop: 0 }}>
        The valley’s history as it happens: every notable fire, outbreak, flood, pack and petition.
      </p>
      {years.length === 0 ? <p class="faint">Nothing worth writing down yet.</p> : null}
      {years.map((y) => (
        <div key={y}>
          <div class="chron-year">Year {y}</div>
          {byYear
            .get(y)!
            .slice()
            .reverse()
            .map((c, k) => (
              <div class={'chron-item i' + c.importance} key={k}>
                <span>{c.text}</span>
                {c.x !== undefined ? (
                  <span class="go" onClick={() => (s.focus(c.x!, c.y!), close())} title="Show on map">
                    ◎
                  </span>
                ) : null}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

function NotesPanel({ s }: { s: GameSession }) {
  const w = s.world;
  const found = Object.keys(w.discoveries).length;
  return (
    <div>
      <p class="dim" style={{ marginTop: 0 }}>
        {found} of {FIELD_NOTES.length} discovered. Notes are written the first time you witness a process in your own valley.
      </p>
      <div class="notes-grid">
        {FIELD_NOTES.map((n) => {
          const d = w.discoveries[n.id];
          const open = d !== undefined;
          return (
            <div class={'note' + (open ? '' : ' locked')} key={n.id}>
              <div class="cat">{n.category}</div>
              <h3>{open ? n.title : '? ? ?'}</h3>
              {open ? (
                <>
                  <p>{n.body}</p>
                  <div class="tip">↳ {n.tip}</div>
                  <div class="faint" style={{ fontSize: '11px', marginTop: '6px' }}>
                    Observed {dayToDate(d)}
                  </div>
                </>
              ) : (
                <p>Not yet observed.</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HelpPanel() {
  return (
    <div class="col" style={{ gap: '12px', fontSize: '13px' }}>
      <div>
        <h3>The idea</h3>
        <p class="dim">
          You are warden of a mountain valley for decades. Forests grow, burn and regrow; deer, wolves and beavers reshape the streams; towns grow into the
          trees. Fire is inevitable. Suppress every fire and fuel piles up until one fire you cannot stop arrives. Let fire work — or bring it yourself in
          mild weather — and the forest stays open, patchy and resilient. Five constituencies judge every choice.
        </p>
      </div>
      <div>
        <h3>Controls</h3>
        <div class="kv" style={{ gridTemplateColumns: 'auto 1fr' }}>
          <span class="k">Pan / zoom</span>
          <span>drag, WASD/arrows · scroll wheel, + / −</span>
          <span class="k">Time</span>
          <span>Space pause · 1–4 speed</span>
          <span class="k">Tools</span>
          <span>Q inspect · Z zones · T thin · B burn · F fireline · X air tanker</span>
          <span class="k">Brush</span>
          <span>[ and ] · right-click or Esc to cancel · Shift-drag erases zones</span>
          <span class="k">Lenses</span>
          <span>L cycles; buttons top-right</span>
        </div>
      </div>
      <div>
        <h3>A first plan</h3>
        <ol class="dim" style={{ paddingLeft: '18px', margin: 0 }}>
          <li>Check the Fuel hazard lens around each town.</li>
          <li>Zone Community Buffers and queue thinning or prescribed burns there.</li>
          <li>Set remote high country to Wilderness — lightning fires there can be left to burn when it is safe.</li>
          <li>When fires start, decide: Suppress, Contain, or Monitor. Watch the wind.</li>
          <li>Keep an eye on the council. Spend your money before the review.</li>
        </ol>
      </div>
      <div>
        <h3>How fire behaves</h3>
        <p class="dim">
          Spread depends on fine-fuel load and moisture, wind along the direction of spread, and slope (uphill runs fast). Surface fire turns into crown fire
          where ladder fuels — shrubs and young fir — connect it to the canopy. Intense fires throw embers that cross rivers and lines. Fires lie down at night
          and smoulder; damp days put them out; dry winds wake them up.
        </p>
      </div>
    </div>
  );
}

function MenuPanel({ s, onLoad, onQuit }: { s: GameSession; onLoad: (w: World) => void; onQuit: () => void }) {
  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [msg, setMsg] = useState('');
  const refresh = () => listSlots().then(setSlots);
  useEffect(() => {
    refresh();
  }, []);
  const set = s.settings;
  const toggle = (k: keyof typeof set, label: string) => (
    <label class="row" style={{ gap: '8px', cursor: 'pointer', padding: '3px 0' }}>
      <input
        type="checkbox"
        checked={set[k]}
        onChange={(e) => {
          s.settings = { ...s.settings, [k]: (e.target as HTMLInputElement).checked };
          if (k === 'sharp') s.resize();
          s.emit();
        }}
      />
      {label}
    </label>
  );
  return (
    <div class="col" style={{ gap: '14px' }}>
      <div>
        <h3>Save</h3>
        <div class="row" style={{ marginTop: '6px', flexWrap: 'wrap', gap: '6px' }}>
          <button class="btn primary" onClick={() => saveToSlot(s.world, 'manual').then(() => (setMsg('Saved.'), refresh())).catch((e) => setMsg(String(e)))}>
            Save game
          </button>
          {canDownload() ? (
            <button class="btn" onClick={() => exportFile(s.world)}>
              Export file…
            </button>
          ) : null}
          <label class="btn">
            Import file…
            <input
              type="file"
              accept=".fireweed"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (f) importFile(f).then(onLoad).catch((err) => setMsg(String(err.message ?? err)));
              }}
            />
          </label>
        </div>
        {msg ? <div class="dim" style={{ marginTop: '6px' }}>{msg}</div> : null}
        {s.lastSaved ? <div class="faint" style={{ marginTop: '4px', fontSize: '12px' }}>{s.lastSaved}</div> : null}
      </div>
      <div>
        <h3>Load</h3>
        {slots.length === 0 ? <div class="faint">No saves yet.</div> : null}
        {slots.map((sl) => (
          <div class="row" style={{ padding: '4px 0' }} key={sl.slot}>
            <span class="grow">
              {sl.valley} · Year {sl.year} <span class="faint">({sl.slot}, {new Date(sl.savedAt).toLocaleString()})</span>
            </span>
            <button class="btn small" onClick={() => loadSlot(sl.slot).then(onLoad).catch((e) => setMsg(String(e)))}>
              Load
            </button>
          </div>
        ))}
      </div>
      <div>
        <h3>Settings</h3>
        {toggle('autoSlow', 'Slow time when a new fire is reported')}
        {toggle('labels', 'Place-name labels')}
        {toggle('wildlife', 'Show wildlife on the map')}
        {toggle('contours', 'Contour lines')}
        {toggle('audio', 'Ambient sound (wind, fire, birds)')}
        {toggle('sharp', 'Sharp rendering on high-DPI screens (more GPU work)')}
        {toggle('reveal', 'Reveal undetected fires (spoiler)')}
      </div>
      <div>
        <button class="btn danger" onClick={onQuit}>
          Quit to title
        </button>
      </div>
    </div>
  );
}
