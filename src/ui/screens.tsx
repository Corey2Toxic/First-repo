/**
 * Title and new-game screens.
 */
import { useEffect, useState } from 'preact/hooks';
import { SCENARIOS, randomSeed } from '../sim/scenarios.ts';
import type { MapSize } from '../sim/scenarios.ts';
import type { GameConfig, ScenarioId } from '../sim/world.ts';
import { listSlots } from '../app/storage.ts';
import type { SlotInfo } from '../app/storage.ts';
import { money } from './format.ts';
import { GAME_VERSION } from '../version.ts';

export function TitleScreen(props: { onNew: () => void; onContinue: (slot: string) => void; onImport: (f: File) => void; onHelp: () => void }) {
  const [slots, setSlots] = useState<SlotInfo[]>([]);
  useEffect(() => {
    listSlots().then(setSlots);
  }, []);
  const latest = slots[0];
  return (
    <div class="screen">
      <div class="vignette" />
      <div class="title-wrap" style={{ position: 'relative' }}>
        <div class="logo">FIREWEED</div>
        <div class="subtitle">A century of fire, forest, wildlife — and the people in between.</div>
        <div style={{ fontSize: '12px', marginTop: '8px', letterSpacing: '0.12em', color: '#e8dcc0', opacity: 0.75, textShadow: '0 2px 8px rgba(0, 0, 0, 0.8)' }}>
          VERSION {GAME_VERSION}
        </div>
        <div class="menu" style={{ marginTop: '18px' }}>
          <button class="btn primary" onClick={props.onNew} autofocus>
            New valley
          </button>
          {latest ? (
            <button class="btn" onClick={() => props.onContinue(latest.slot)}>
              Continue · {latest.valley}, year {latest.year}
            </button>
          ) : null}
          <label class="btn" style={{ textAlign: 'center' }}>
            Load from file…
            <input
              type="file"
              accept=".fireweed"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (f) props.onImport(f);
              }}
            />
          </label>
          <button class="btn ghost" onClick={props.onHelp}>
            About the simulation
          </button>
        </div>
        <div class="faint" style={{ fontSize: '12px', marginTop: '22px', maxWidth: '520px', textShadow: '0 1px 4px #000' }}>
          Every forest, fire, herd and ember you will see is simulated: weather, fuels, succession, wildlife, water and politics interacting on a 24 × 17 km
          valley. No two valleys are the same.
        </div>
      </div>
    </div>
  );
}

export function AboutScreen({ onBack }: { onBack: () => void }) {
  return (
    <div class="screen">
      <div class="vignette" />
      <div class="modal" style={{ position: 'relative' }}>
        <h1>About Fireweed</h1>
        <p class="dim">
          Fireweed is the first plant to bloom on a fresh burn. The game is about that cycle: a landscape that needs fire, communities that fear it, and a
          warden in between.
        </p>
        <div class="grid2">
          <div>
            <h3>What is simulated</h3>
            <ul class="dim" style={{ paddingLeft: '18px' }}>
              <li>Terrain grown by uplift and river erosion; snow, soil moisture and fuel moisture every day.</li>
              <li>Five plant types competing for light and water, aging, dying, seeding, resprouting.</li>
              <li>Fire spread from fuels, moisture, wind and slope; crowning, ember spotting, smouldering overnight.</li>
              <li>Deer herds, wolf packs and beaver colonies — and the cascade between them.</li>
              <li>Bark beetles, erosion, debris flows, a reservoir that silts up.</li>
              <li>Towns, a sawmill, ranches, tourism, five political constituencies and an annual council.</li>
            </ul>
          </div>
          <div>
            <h3>What is not scripted</h3>
            <p class="dim">
              Nothing. Fires start where lightning strikes dry fuel or people are careless. Petitions arise from real grievances. Your legacy is measured, not
              narrated. (The tutorial guarantees its first fire, and says so.)
            </p>
            <h3>Credits</h3>
            <p class="dim">Design, code and simulation: built from scratch for this project. All art is procedural.</p>
          </div>
        </div>
        <button class="btn primary" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}

export interface NewGameChoice {
  config: GameConfig;
}

export function NewGameScreen(props: { onBack: () => void; onStart: (scenario: ScenarioId, seed: string, size: MapSize, overrides: Partial<GameConfig>) => void; onPreview: (scenario: ScenarioId, seed: string, size: MapSize, overrides: Partial<GameConfig>) => void; previewing: boolean }) {
  const [scen, setScen] = useState<ScenarioId>('firstseason');
  const [seed, setSeed] = useState(randomSeed());
  const [size, setSize] = useState<MapSize>('medium');
  const s = SCENARIOS.find((x) => x.id === scen)!;
  const [custom, setCustom] = useState({ ...SCENARIOS.find((x) => x.id === 'custom')!.config });
  const overrides: Partial<GameConfig> = scen === 'custom' ? custom : {};
  const num = (k: keyof typeof custom, label: string, min: number, max: number, step: number, fmt: (v: number) => string) => (
    <label class="field">
      <span>
        {label}: <b style={{ color: 'var(--text)' }}>{fmt(custom[k] as number)}</b>
      </span>
      <input type="range" min={min} max={max} step={step} value={custom[k] as number} onInput={(e) => setCustom({ ...custom, [k]: Number((e.target as HTMLInputElement).value) })} />
    </label>
  );
  return (
    <div class="screen" style={{ alignItems: 'flex-start' }}>
      <div class="vignette" />
      <div class="modal" style={{ position: 'relative', marginTop: '30px' }}>
        <div class="row">
          <h1 class="grow">A new valley</h1>
          <button class="btn ghost" onClick={props.onBack}>
            ← Back
          </button>
        </div>
        <div class="scenarios" style={{ marginTop: '14px' }}>
          {SCENARIOS.map((x) => (
            <div class={'scenario' + (scen === x.id ? ' on' : '')} onClick={() => setScen(x.id)} key={x.id}>
              <div class="row">
                <h3 class="grow">{x.title}</h3>
                <span class="dots">{'●'.repeat(x.difficulty)}{'○'.repeat(4 - x.difficulty)}</span>
              </div>
              <div class="tagline">{x.tagline}</div>
            </div>
          ))}
        </div>
        <div class="card" style={{ marginTop: '14px' }}>
          <p class="dim" style={{ margin: 0 }}>
            {s.description}
          </p>
          <div class="row" style={{ flexWrap: 'wrap', gap: '6px', marginTop: '8px' }}>
            <span class="tag">{s.config.tenureYears}-year tenure</span>
            <span class="tag">start {money(s.config.startFunds)}</span>
            <span class="tag">{s.config.history === 'suppressed' ? 'a century of fire suppression' : s.config.history === 'burned' ? 'recent megafire' : 'natural fire history'}</span>
            <span class="tag">warming {s.config.climateTrend.toFixed(1)}°C/decade</span>
            <span class="tag">{s.config.wolves ? `${s.config.wolves} wolf pack${s.config.wolves > 1 ? 's' : ''}` : 'no wolves'}</span>
            <span class="tag">{s.config.beavers ? `${s.config.beavers} beaver colonies` : 'no beavers'}</span>
          </div>
        </div>
        {scen === 'custom' ? (
          <div class="grid3" style={{ marginTop: '12px' }}>
            {num('climateTrend', 'Warming', 0, 0.8, 0.05, (v) => `${v.toFixed(2)}°C/decade`)}
            {num('dryness', 'Precipitation', 0.7, 1.3, 0.05, (v) => `${Math.round(v * 100)}%`)}
            {num('tenureYears', 'Tenure', 15, 80, 5, (v) => `${v} years`)}
            {num('wolves', 'Wolf packs', 0, 4, 1, (v) => `${v}`)}
            {num('beavers', 'Beaver colonies', 0, 8, 1, (v) => `${v}`)}
            {num('herds', 'Deer herds', 6, 50, 2, (v) => `${v}`)}
            {num('townCount', 'Towns', 1, 4, 1, (v) => `${v}`)}
            {num('startFunds', 'Starting funds', 500000, 3000000, 100000, (v) => money(v))}
            <label class="field">
              <span>Fire history</span>
              <select value={custom.history} onChange={(e) => setCustom({ ...custom, history: (e.target as HTMLSelectElement).value as GameConfig['history'] })}>
                <option value="natural">Natural (patchy, frequent fire)</option>
                <option value="suppressed">A century of suppression</option>
                <option value="burned">A recent megafire</option>
              </select>
            </label>
            <label class="field">
              <span>Difficulty</span>
              <select value={custom.difficulty} onChange={(e) => setCustom({ ...custom, difficulty: (e.target as HTMLSelectElement).value as GameConfig['difficulty'] })}>
                <option value="gentle">Gentle</option>
                <option value="standard">Standard</option>
                <option value="harsh">Harsh</option>
              </select>
            </label>
          </div>
        ) : null}
        <div class="row" style={{ marginTop: '14px', flexWrap: 'wrap', gap: '10px' }}>
          <label class="field">
            <span>Seed</span>
            <div class="row" style={{ gap: '4px' }}>
              <input type="text" value={seed} onInput={(e) => setSeed((e.target as HTMLInputElement).value)} style={{ width: '170px' }} />
              <button class="btn small" onClick={() => setSeed(randomSeed())} title="Random seed">
                ⟳
              </button>
            </div>
          </label>
          <label class="field">
            <span>Valley size</span>
            <select value={size} onChange={(e) => setSize((e.target as HTMLSelectElement).value as MapSize)}>
              <option value="small">Small (18 × 12 km)</option>
              <option value="medium">Medium (24 × 17 km)</option>
              <option value="large">Large (30 × 21 km)</option>
            </select>
          </label>
          <span class="grow" />
          <button class="btn" disabled={props.previewing} onClick={() => props.onPreview(scen, seed, size, overrides)}>
            {props.previewing ? 'Surveying…' : 'Preview valley'}
          </button>
          <button class="btn primary" onClick={() => props.onStart(scen, seed, size, overrides)}>
            Begin tenure
          </button>
        </div>
      </div>
    </div>
  );
}
