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

/**
 * The valley behind the title menus. The backdrop only draws it (nothing ticks it), so it is
 * generated once and reused: going back to the title costs a texture upload, not a new valley.
 */
let titleValley: World | null = null;
function titleWorld(): World {
  if (!titleValley) {
    const w = generateWorld(makeConfig('firstseason', 'fireweed-title', 'small'));
    w.day = 200; // autumn colours on the title
    titleValley = w;
  }
  return titleValley;
}

/** A slowly drifting view of a generated valley behind the menus. */
class Backdrop {
  private raf = 0;
  private stopped = false;
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
      if (this.stopped) return;
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
    // fill the screen in any orientation (portrait phones would otherwise letterbox)
    const sx = this.cam.viewW / w.W,
      sy = this.cam.viewH / w.H;
    const base = Math.max(Math.min(sx, sy), Math.max(sx, sy) / 1.35);
    this.cam.scale = this.cam.tscale = base * (1.35 + 0.12 * Math.sin(k * 0.05));
    this.cam.cx = this.cam.tcx = w.W / 2 + Math.sin(k * 0.03) * w.W * 0.12;
    this.cam.cy = this.cam.tcy = w.H / 2 + Math.cos(k * 0.025) * w.H * 0.08;
    renderer().draw(this.cam, w, k, { overlayMix: 0, zoneMix: 0, contours: false, gridLines: false, revealFires: true }, c.width, c.height);
  }
  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
  }
}

type Screen = 'title' | 'about' | 'new' | 'loading' | 'game' | 'error';

interface Failure {
  title: string;
  detail: string;
  /** Fireweed never got going (no WebGL 2, most likely). */
  startup: boolean;
  /** The title screen is still intact and can be shown again. */
  canReturn: boolean;
}

const canvas = (id: string) => document.getElementById(id) as HTMLCanvasElement;
const message = (e: unknown) => String((e as Error)?.message ?? e);

export function App() {
  const [screen, setScreen] = useState<Screen>('loading');
  const [failure, setFailure] = useState<Failure>({ title: '', detail: '', startup: true, canReturn: false });
  const [loadingMsg, setLoadingMsg] = useState('Surveying the valley…');
  const [session, setSession] = useState<GameSession | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const backdrop = useRef<Backdrop | null>(null);
  /** The running session. Transitions finish asynchronously, so they read it here, never from a stale render. */
  const current = useRef<GameSession | null>(null);
  const preview = useRef<{ key: string; world: World } | null>(null);

  /** Put the title valley behind the menus. Throws if it cannot be built. */
  const showBackdrop = () => {
    backdrop.current?.stop();
    backdrop.current = null;
    backdrop.current = new Backdrop(titleWorld());
  };

  /**
   * A transition failed. Unless the title is still intact (a save that would not open, a
   * valley that would not generate), stop everything that draws to the shared canvas and
   * offer a reload: v1.0 left a permanent loading screen instead.
   */
  const fail = (title: string, e: unknown, canReturn = false) => {
    console.error(e);
    if (!canReturn) {
      backdrop.current?.stop();
      backdrop.current = null;
      current.current?.dispose();
      current.current = null;
      setSession(null);
    }
    setFailure({ title, detail: message(e), startup: false, canReturn });
    setScreen('error');
  };

  useEffect(() => {
    // first paint, then build the title backdrop
    setTimeout(() => {
      try {
        showBackdrop();
        setScreen('title');
      } catch (e) {
        setFailure({ title: 'Fireweed cannot start', detail: message(e), startup: true, canReturn: false });
        setScreen('error');
      }
    }, 30);
  }, []);

  /** Open a world: the new session is built before the old one (or the backdrop) is let go. */
  const startWorld = (w: World) => {
    let s: GameSession;
    try {
      s = new GameSession(w, canvas('map'), canvas('overlay'), renderer());
    } catch (e) {
      // the shared renderer may already hold the new world: nothing else can go on drawing
      fail('This valley could not be opened', e);
      return;
    }
    backdrop.current?.stop();
    backdrop.current = null;
    current.current?.dispose();
    current.current = s;
    setSession(s);
    setScreen('game');
    s.start();
    (window as unknown as { fireweed: GameSession }).fireweed = s;
  };

  /** Leave the game for the title or the new-game screen (quit, or "New valley" after the legacy report). */
  const leaveGame = (next: 'title' | 'new') => {
    current.current?.dispose();
    current.current = null;
    setSession(null);
    setLoadingMsg(next === 'title' ? 'Returning to the title…' : 'Preparing a new valley…');
    setScreen('loading');
    setTimeout(() => {
      try {
        showBackdrop();
        setScreen(next);
      } catch (e) {
        fail('Fireweed could not return to the title', e);
      }
    }, 20);
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

  if (screen === 'error')
    return (
      <div class="screen">
        <div class="modal" style={{ maxWidth: '560px' }}>
          <h1>{failure.title}</h1>
          <p class="dim">{failure.detail}</p>
          {failure.startup ? (
            <p class="dim">Fireweed needs a browser with WebGL 2 (any recent Chrome, Edge, Firefox or Safari).</p>
          ) : (
            <p class="dim">Your saved games are safe: saves and autosaves are kept in this browser and nothing has been overwritten. Reload to carry on from your latest save.</p>
          )}
          <div class="row" style={{ marginTop: '16px', justifyContent: 'flex-end', gap: '8px' }}>
            {failure.canReturn ? (
              <button class="btn" onClick={() => setScreen('title')}>
                Back to title
              </button>
            ) : null}
            <button class="btn primary" onClick={() => location.reload()}>
              Reload Fireweed
            </button>
          </div>
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
            .catch((e) => fail('That save could not be opened', e, true));
        }}
        onImport={(f) => {
          setLoadingMsg('Reading the save file…');
          setScreen('loading');
          importFile(f)
            .then(startWorld)
            .catch((e) => fail('That file could not be opened', e, true));
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
            try {
              const w = generateWorld(makeConfig(scenario, seed, size, overrides));
              preview.current = { key: JSON.stringify([scenario, seed, size, overrides]), world: w };
              backdrop.current?.setWorld(w);
            } catch (e) {
              fail('The preview could not be drawn', e);
            } finally {
              setPreviewing(false);
            }
          }, 30);
        }}
        onStart={(scenario, seed, size, overrides) => {
          setLoadingMsg('Growing forests, carving rivers, founding towns…');
          setScreen('loading');
          setTimeout(() => {
            let w: World;
            try {
              w = generate(scenario, seed, size, overrides);
            } catch (e) {
              fail('The valley could not be generated', e, true);
              return;
            }
            startWorld(w);
          }, 40);
        }}
      />
    );
  if (!session) return null;
  return <GameScreen s={session} onLoad={startWorld} onQuit={() => leaveGame('title')} onNew={() => leaveGame('new')} />;
}

function GameScreen({ s, onLoad, onQuit, onNew }: { s: GameSession; onLoad: (w: World) => void; onQuit: () => void; onNew: () => void }) {
  const [, setTick] = useState(0);
  const [panel, setPanel] = useState<PanelId | null>(null);
  useEffect(() => s.subscribe(() => setTick((x) => x + 1)), [s]);
  // a valley loaded from the menu opens on the map, not behind the menu it was loaded from
  useEffect(() => setPanel(null), [s]);
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
          onContinue={() => s.command({ t: 'continueSandbox' })}
        />
      ) : null}
    </>
  );
}
