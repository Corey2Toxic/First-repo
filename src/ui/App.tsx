/**
 * Root component: screens (title, new game, game) and the game HUD.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { GameSession } from '../app/session.ts';
import { MapRenderer } from '../render/mapRenderer.ts';
import { Camera } from '../render/camera.ts';
import { generateWorld } from '../sim/gen/index.ts';
import { makeConfig } from '../sim/scenarios.ts';
import type { MapSize } from '../sim/scenarios.ts';
import type { GameConfig, ScenarioId, World } from '../sim/world.ts';
import { importFile, loadSlot } from '../app/storage.ts';
import { AdvisorCardView, Dock, Feed, LensBar, Toasts, ToolBar, ToolFlyout, TopBar } from './hud.tsx';
import type { PanelId } from './hud.tsx';
import { Inspector } from './inspector.tsx';
import { Drawer } from './panels.tsx';
import { EndModal, ReviewModal } from './review.tsx';
import { AboutScreen, NewGameScreen, TitleScreen } from './screens.tsx';

let sharedRenderer: MapRenderer | null = null;
function renderer(): MapRenderer {
  if (!sharedRenderer) sharedRenderer = new MapRenderer(document.getElementById('map') as HTMLCanvasElement);
  return sharedRenderer;
}

/** A slowly drifting view of a generated valley behind the menus. */
class Backdrop {
  private raf = 0;
  private cam = new Camera();
  private world: World;
  private t0 = performance.now();
  constructor(world: World) {
    this.world = world;
    const r = renderer();
    r.setWorld(world);
    this.cam.setGrid(world.W, world.H);
    this.resize();
    this.cam.fit();
    const loop = (t: number) => {
      this.frame(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  setWorld(w: World): void {
    this.world = w;
    renderer().setWorld(w);
    this.cam.setGrid(w.W, w.H);
    this.resize();
    this.cam.fit();
  }
  private resize(): void {
    const c = document.getElementById('map') as HTMLCanvasElement;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
    this.cam.setViewport(c.clientWidth, c.clientHeight);
  }
  private frame(t: number): void {
    const c = document.getElementById('map') as HTMLCanvasElement;
    if (c.width !== Math.round(c.clientWidth * Math.min(2, window.devicePixelRatio || 1))) this.resize();
    const k = (t - this.t0) / 1000;
    const w = this.world;
    const base = Math.min(this.cam.viewW / w.W, this.cam.viewH / w.H);
    this.cam.scale = this.cam.tscale = base * (1.35 + 0.12 * Math.sin(k * 0.05));
    this.cam.cx = this.cam.tcx = w.W / 2 + Math.sin(k * 0.03) * w.W * 0.12;
    this.cam.cy = this.cam.tcy = w.H / 2 + Math.cos(k * 0.025) * w.H * 0.08;
    renderer().draw(this.cam, w, k, { overlayMix: 0, zoneMix: 0, contours: false, gridLines: false, revealFires: true }, c.width, c.height);
  }
  stop(): void {
    cancelAnimationFrame(this.raf);
  }
}

type Screen = 'title' | 'about' | 'new' | 'loading' | 'game' | 'error';

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [error, setError] = useState('');
  const [loadingMsg, setLoadingMsg] = useState('Surveying the valley…');
  const [session, setSession] = useState<GameSession | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const backdrop = useRef<Backdrop | null>(null);
  const preview = useRef<{ key: string; world: World } | null>(null);

  useEffect(() => {
    // first paint, then build the title backdrop
    setTimeout(() => {
      try {
        const w = generateWorld(makeConfig('firstseason', 'fireweed-title', 'small'));
        w.day = 200; // autumn colours on the title
        backdrop.current = new Backdrop(w);
        setScreen('title');
      } catch (e) {
        setError(String((e as Error).message ?? e));
        setScreen('error');
      }
    }, 30);
  }, []);

  const startWorld = (w: World) => {
    backdrop.current?.stop();
    backdrop.current = null;
    session?.dispose();
    const s = new GameSession(w, document.getElementById('map') as HTMLCanvasElement, document.getElementById('overlay') as HTMLCanvasElement, renderer());
    setSession(s);
    setScreen('game');
    s.start();
    (window as unknown as { fireweed: GameSession }).fireweed = s;
  };

  const generate = (scenario: ScenarioId, seed: string, size: MapSize, overrides: Partial<GameConfig>): World => {
    const key = JSON.stringify([scenario, seed, size, overrides]);
    if (preview.current?.key === key) {
      const w = preview.current.world;
      preview.current = null;
      return w;
    }
    return generateWorld(makeConfig(scenario, seed, size, overrides));
  };

  const toTitle = () => {
    session?.dispose();
    setSession(null);
    setScreen('loading');
    setLoadingMsg('…');
    setTimeout(() => {
      const w = generateWorld(makeConfig('firstseason', 'fireweed-title', 'small'));
      w.day = 200;
      backdrop.current = new Backdrop(w);
      setScreen('title');
    }, 20);
  };

  if (screen === 'error')
    return (
      <div class="screen">
        <div class="modal" style={{ maxWidth: '560px' }}>
          <h1>Fireweed cannot start</h1>
          <p class="dim">{error}</p>
          <p class="dim">Fireweed needs a browser with WebGL 2 (any recent Chrome, Edge, Firefox or Safari).</p>
        </div>
      </div>
    );
  if (screen === 'loading')
    return (
      <div class="screen">
        <div class="loading">{loadingMsg}</div>
      </div>
    );
  if (screen === 'title')
    return (
      <TitleScreen
        onNew={() => setScreen('new')}
        onHelp={() => setScreen('about')}
        onContinue={(slot) => {
          setLoadingMsg('Opening the archive…');
          setScreen('loading');
          loadSlot(slot)
            .then(startWorld)
            .catch((e) => {
              setError(String(e.message ?? e));
              setScreen('error');
            });
        }}
        onImport={(f) => {
          setScreen('loading');
          importFile(f)
            .then(startWorld)
            .catch((e) => {
              setError(String(e.message ?? e));
              setScreen('error');
            });
        }}
      />
    );
  if (screen === 'about') return <AboutScreen onBack={() => setScreen('title')} />;
  if (screen === 'new')
    return (
      <NewGameScreen
        previewing={previewing}
        onBack={() => setScreen('title')}
        onPreview={(scenario, seed, size, overrides) => {
          setPreviewing(true);
          setTimeout(() => {
            const w = generateWorld(makeConfig(scenario, seed, size, overrides));
            preview.current = { key: JSON.stringify([scenario, seed, size, overrides]), world: w };
            backdrop.current?.setWorld(w);
            setPreviewing(false);
          }, 30);
        }}
        onStart={(scenario, seed, size, overrides) => {
          setLoadingMsg('Growing forests, carving rivers, founding towns…');
          setScreen('loading');
          setTimeout(() => startWorld(generate(scenario, seed, size, overrides)), 40);
        }}
      />
    );
  if (!session) return null;
  return <GameScreen s={session} onLoad={startWorld} onQuit={toTitle} onNew={() => (session.dispose(), setSession(null), setScreen('loading'), setTimeout(() => {
    const w = generateWorld(makeConfig('firstseason', 'fireweed-title', 'small'));
    backdrop.current = new Backdrop(w);
    setScreen('new');
  }, 20))} />;
}

function GameScreen({ s, onLoad, onQuit, onNew }: { s: GameSession; onLoad: (w: World) => void; onQuit: () => void; onNew: () => void }) {
  const [, setTick] = useState(0);
  const [panel, setPanel] = useState<PanelId | null>(null);
  useEffect(() => s.subscribe(() => setTick((x) => x + 1)), [s]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && panel) setPanel(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel]);
  const w = s.world;
  const overlay = document.getElementById('overlay');
  if (overlay) overlay.className = s.tool.id === 'inspect' ? '' : 'tool';
  const ended = w.outcome.ended;
  return (
    <>
      <TopBar s={s} openPanel={(p) => setPanel(p)} />
      <ToolBar s={s} />
      <ToolFlyout s={s} />
      <LensBar s={s} />
      {!panel ? (
        <div class={'side panel' + (s.lens !== 'none' ? ' with-legend' : '')}>
          <Inspector s={s} />
        </div>
      ) : null}
      {panel ? <Drawer s={s} id={panel} close={() => setPanel(null)} onLoad={onLoad} onQuit={onQuit} /> : null}
      <Feed s={s} />
      <AdvisorCardView s={s} docked={!!panel} />
      <Dock s={s} panel={panel} openPanel={setPanel} />
      <Toasts s={s} />
      {w.review.pending ? <ReviewModal s={s} /> : null}
      {ended ? (
        <EndModal
          s={s}
          onNew={onNew}
          onTitle={onQuit}
          onContinue={() => {
            w.outcome.ended = false;
            w.config.tenureYears += 25;
            w.review.pending = false;
            w.economy.funds = Math.max(w.economy.funds, 0);
            s.toast('The council grants you another 25 years. The valley goes on.', 'good');
            s.emit();
          }}
        />
      ) : null}
    </>
  );
}
