/**
 * GameSession: owns the world, simulation, renderers, camera and the game
 * loop; translates pointer/keyboard input into tool actions and commands;
 * notifies the UI at a modest rate.
 */
import type { World } from '../sim/world.ts';
import { Simulation } from '../sim/sim.ts';
import { applyCommand, estimateCost } from '../sim/commands.ts';
import type { Command, CommandResult } from '../sim/commands.ts';
import { MapRenderer } from '../render/mapRenderer.ts';
import { Camera } from '../render/camera.ts';
import { OverlayRenderer } from '../render/overlay.ts';
import type { OverlayState, Selection } from '../render/overlay.ts';
import { computeLens, LENSES } from '../render/lenses.ts';
import type { LensId } from '../render/lenses.ts';
import { diskCells, lineCells, astar } from '../sim/grid.ts';
import { roadCost } from '../sim/gen/settle.ts';
import { FIRE, SP, SUBSTEPS_PER_DAY, ZONE } from '../sim/types.ts';
import { projectCostPerCell, validProjectCells } from '../sim/systems/projects.ts';
import { COST } from '../sim/economyParams.ts';
import { saveToSlot } from './storage.ts';
import { Advisor } from './advisor.ts';
import { FrameClock } from './frameClock.ts';
import { AudioEngine } from '../audio/audio.ts';
import { computeFireshed, projectSpread } from '../sim/projection.ts';
import type { Fireshed, SpreadProjection } from '../sim/projection.ts';
import { forecast } from '../sim/forecast.ts';
import type { DayForecast } from '../sim/forecast.ts';

export type ToolId =
  | 'inspect'
  | 'zone'
  | 'thin'
  | 'burn'
  | 'plant'
  | 'fuelbreak'
  | 'fireline'
  | 'airdrop'
  | 'road'
  | 'tower'
  | 'camp'
  | 'wolves'
  | 'beavers'
  | 'send';

export interface ToolState {
  id: ToolId;
  zone: number;
  species: number;
  brush: number;
  sendCrewId: number;
}

/**
 * Ticks (3 h) per real second. v2: fires last days and ask for decisions, so the slow end is slower
 * (Watch: a day in four seconds; v1.x: 3, 12, 48, 220) and the fast end is what it was.
 */
export const SPEEDS = [0, 2, 8, 40, 220];
export const SPEED_NAMES = ['Paused', 'Watch (6 h/s)', 'Day by day (1 day/s)', 'Fast (5 days/s)', 'Fastest (a month in a second)'];

export interface Toast {
  id: number;
  text: string;
  level: 'info' | 'good' | 'warn' | 'danger';
  at: number;
}

export interface Settings {
  autoSlow: boolean;
  /** pause for what needs a decision: an escaped fire, a town in a fire's path, a fire-weather watch with fire on the ground */
  autoPause: boolean;
  /** draw where reported fires are expected to spread */
  projection: boolean;
  /** darken the valley at night when time runs slowly */
  night: boolean;
  labels: boolean;
  contours: boolean;
  wildlife: boolean;
  audio: boolean;
  reveal: boolean;
  sharp: boolean;
}

/** Keys that pan or zoom the camera (see keydown and panKeys). */
const CAMERA_KEYS = ['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'a', 'd', 'w', 's', '+', '=', '-', '_'];

const TOOL_COLORS: Partial<Record<ToolId, string>> = {
  zone: '#e8e2c0',
  thin: '#7fd18b',
  burn: '#ff9a3d',
  plant: '#b6e36b',
  fuelbreak: '#e9d27a',
  fireline: '#c98b52',
  airdrop: '#ff5a4a',
  road: '#e8d5a8',
};

export class GameSession {
  world: World;
  sim: Simulation;
  cam = new Camera();
  renderer: MapRenderer;
  overlay: OverlayRenderer;
  advisor: Advisor;
  audio: AudioEngine;
  speed = 0;
  private prevSpeed = 2;
  tool: ToolState = { id: 'inspect', zone: ZONE.BUFFER, species: SP.PINE, brush: 2, sendCrewId: -1 };
  lens: LensId = 'none';
  selection: Selection | null = null;
  hoverCell = -1;
  painted = new Set<number>();
  path: number[] = [];
  pathLabel = '';
  private roadStart = -1;
  settings: Settings = { autoSlow: true, autoPause: true, projection: true, night: true, labels: true, contours: false, wildlife: true, audio: false, reveal: false, sharp: false };
  /** Where fire is expected to spread: the selected fire, or every reported fire (refreshed as the clock moves). */
  projection: SpreadProjection | null = null;
  /** the fire the projection is for (-1: all reported fires) */
  projectionFire = -1;
  private projKey = '';
  private projAt = 0;
  private projImage: HTMLCanvasElement | null = null;
  /** The towns' firesheds on the design day (computed when a lens or a panel asks for it). */
  private shed: Fireshed | null = null;
  private shedKey = '';
  private fc: { day: number; list: DayForecast[] } | null = null;
  /** highest notification id already acted on (slow-downs and pauses) */
  private lastNote = 0;
  /** running fast until the next thing worth stopping for */
  skipping = false;
  toasts: Toast[] = [];
  private listeners = new Set<() => void>();
  private raf = 0;
  /** Frame timing, the simulation's time accrual and the fps / ticks-per-second counters. */
  readonly clock = new FrameClock();
  private lastUi = 0;
  private lastLens = 0;
  private lensBuf: Uint8Array;
  private dragging: { button: number; x: number; y: number; moved: boolean; painting: boolean } | null = null;
  /** Pointers currently down on the map (two fingers = pinch zoom). */
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; mx: number; my: number } | null = null;
  private keys = new Set<string>();
  private mapCanvas: HTMLCanvasElement;
  private overlayCanvas: HTMLCanvasElement;
  private disposers: Array<() => void> = [];
  private disposed = false;
  /**
   * Camera moves the player made (wheel, pinch, drag-pan, keyboard pan/zoom); programmatic
   * focus never counts. The tutorial's "Look around" step waits for real input.
   */
  camInputs = 0;
  lastSaved = '';
  onEnd: (() => void) | null = null;

  constructor(world: World, mapCanvas: HTMLCanvasElement, overlayCanvas: HTMLCanvasElement, renderer?: MapRenderer) {
    this.world = world;
    this.mapCanvas = mapCanvas;
    this.overlayCanvas = overlayCanvas;
    this.sim = new Simulation(world);
    this.renderer = renderer ?? new MapRenderer(mapCanvas);
    this.lensBuf = new Uint8Array(world.N * 4);
    try {
      this.renderer.setWorld(world);
      this.overlay = new OverlayRenderer(overlayCanvas);
      this.cam.setGrid(world.W, world.H);
      this.renderer.overlayData = this.lensBuf;
      this.advisor = new Advisor(this);
      this.audio = new AudioEngine();
      this.lastNote = world.notifications.length ? world.notifications[world.notifications.length - 1].id : 0;
      this.resize();
      this.cam.fit();
      this.bindInput();
    } catch (e) {
      // a half-built session must not leave listeners or a lens buffer behind on the shared canvases
      this.dispose();
      throw e;
    }
  }

  get fps(): number {
    return this.clock.fps;
  }

  get ticksPerSec(): number {
    return this.clock.ticksPerSec;
  }

  // ------------------------------------------------------------ lifecycle
  start(): void {
    if (this.disposed) return;
    this.clock.reset(performance.now());
    const loop = (t: number) => {
      if (this.disposed) return;
      this.frame(t);
      if (!this.disposed) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Stop the loop and release everything shared with the next screen. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    // the renderer is shared with the title backdrop and the next session: release our lens buffer
    if (this.renderer && this.renderer.overlayData === this.lensBuf) this.renderer.overlayData = null;
    for (const d of this.disposers) d();
    this.disposers = [];
    this.audio?.stop();
    this.listeners.clear();
    this.onEnd = null;
    const g = globalThis as unknown as { fireweed?: unknown };
    if (g.fireweed === this) delete g.fireweed;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const l of this.listeners) l();
  }

  toast(text: string, level: Toast['level'] = 'info'): void {
    const t: Toast = { id: Math.random(), text, level, at: performance.now() };
    this.toasts = [...this.toasts.slice(-3), t];
    this.emit();
  }

  resize(): void {
    const dpr = Math.min(this.settings.sharp ? 2 : 1.25, window.devicePixelRatio || 1);
    const w = this.mapCanvas.clientWidth || window.innerWidth;
    const h = this.mapCanvas.clientHeight || window.innerHeight;
    this.mapCanvas.width = Math.round(w * dpr);
    this.mapCanvas.height = Math.round(h * dpr);
    this.overlayCanvas.width = Math.round(w * dpr);
    this.overlayCanvas.height = Math.round(h * dpr);
    this.cam.setViewport(w, h);
  }

  // ------------------------------------------------------------ time
  setSpeed(s: number): void {
    if (s > 0) this.prevSpeed = s;
    this.speed = s;
    this.skipping = false;
    this.clock.capBacklog(SPEEDS[s] ?? 0);
    this.audio.resume();
    this.emit();
  }

  togglePause(): void {
    this.setSpeed(this.speed === 0 ? this.prevSpeed || 2 : 0);
  }

  /** Run fast until something asks for attention (a fire, a watch, a briefing, the turn of the season). */
  advanceToEvent(): void {
    if (this.sim.blocked) return;
    this.speed = 4;
    this.skipping = true;
    this.clock.capBacklog(SPEEDS[4]);
    this.audio.resume();
    this.emit();
  }

  private nightShown = 0;
  /**
   * How dark to draw the valley: night falls only when time is paused or running slowly enough to
   * watch (at speed the days would strobe), and it eases in and out.
   */
  private nightNow(dt: number): number {
    const w = this.world;
    let target = 0;
    if (this.settings.night && this.speed <= 1 && !this.skipping) {
      const hour = (w.sub + Math.min(1, this.clock.acc)) * 3;
      const sun = Math.sin(((hour - 6) / 12) * Math.PI);
      const t = Math.max(0, Math.min(1, (0.2 - sun) / 0.5));
      target = t * t * (3 - 2 * t);
    }
    const k = Math.min(1, dt * 2.5);
    this.nightShown += (target - this.nightShown) * k;
    return this.nightShown < 0.004 ? 0 : this.nightShown;
  }

  /** The published forecast for the coming days (one computation per game day). */
  getForecast(): DayForecast[] {
    const w = this.world;
    if (!this.fc || this.fc.day !== w.day) this.fc = { day: w.day, list: forecast(w) };
    return this.fc.list;
  }

  /** The towns' firesheds, recomputed when treatments, fire or the turn of a month have changed the ground. */
  getFireshed(): Fireshed {
    const w = this.world;
    const c = w.counters;
    // (burned area in steps of 200 ha: a fire in progress must not recompute the firesheds every few seconds)
    const key = `${w.year}:${Math.floor(w.doy / 30)}:${Math.floor(c.yearTreated / 20)}:${Math.floor(c.yearRxBurned / 50)}:${Math.floor(c.yearBurned / 200)}:${w.towns.map((t) => t.structures + ':' + Math.round(t.firewise * 50)).join(',')}`;
    if (!this.shed || this.shedKey !== key) {
      this.shed = computeFireshed(w);
      this.shedKey = key;
    }
    return this.shed;
  }

  /** Which fire the projection should be for: the selected one, else every reported wildfire (-1), else none (-2). */
  private projectionTarget(): number {
    const w = this.world;
    if (this.selection?.type === 'fire') {
      const id = this.selection.id;
      const fe = w.fires.find((f) => f.id === id);
      if (fe && fe.active && (fe.detected || this.settings.reveal)) return fe.id;
    }
    if (!this.settings.projection) return -2;
    return w.fires.some((f) => f.active && f.detected && f.cause !== 'prescribed') ? -1 : -2;
  }

  private refreshProjection(now: number): void {
    const w = this.world;
    const target = this.projectionTarget();
    if (target === -2) {
      if (this.projection) {
        this.projection = null;
        this.projImage = null;
        this.projKey = '';
      }
      return;
    }
    const key = `${target}:${w.day}:${w.sub}:${w.burning.length}`;
    if (key === this.projKey) return;
    // at speed the clock outruns the projection: draw at most a few a second
    if (this.projection && now - this.projAt < (this.speed >= 3 ? 900 : 300)) return;
    this.projKey = key;
    this.projAt = now;
    this.projectionFire = target;
    const pr = projectSpread(w, target >= 0 ? { fireId: target, hours: 48, includeUnreported: this.settings.reveal } : { hours: 48 });
    this.projection = pr;
    this.projImage = this.paintProjection(pr);
  }

  /** The projection as a picture, one pixel per hectare: where the fire is expected within 6, 12, 24 and 48 hours. */
  private paintProjection(pr: SpreadProjection): HTMLCanvasElement | null {
    if (typeof document === 'undefined') return null;
    const w = this.world;
    const c = this.projImage ?? document.createElement('canvas');
    c.width = w.W;
    c.height = w.H;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const img = ctx.createImageData(w.W, w.H);
    const d = img.data;
    const a = pr.arrival;
    for (let i = 0; i < w.N; i++) {
      const t = a[i];
      if (!(t > 0) || t > 48) continue;
      const o = i * 4;
      if (t <= 6) {
        d[o] = 255;
        d[o + 1] = 70;
        d[o + 2] = 50;
        d[o + 3] = 150;
      } else if (t <= 12) {
        d[o] = 255;
        d[o + 1] = 140;
        d[o + 2] = 50;
        d[o + 3] = 125;
      } else if (t <= 24) {
        d[o] = 255;
        d[o + 1] = 205;
        d[o + 2] = 80;
        d[o + 3] = 100;
      } else {
        d[o] = 255;
        d[o + 1] = 240;
        d[o + 2] = 180;
        d[o + 3] = 75;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  private frame(now: number): void {
    if (this.disposed) return;
    const clock = this.clock;
    // the camera animates with a capped step; the simulation and the counters use real time (D23)
    const dt = clock.beginFrame(now);
    this.panKeys(dt);
    this.cam.update(dt);
    const w = this.world;
    if (!this.sim.blocked && this.speed > 0 && !this.advisor.blockingStep) {
      clock.advance(SPEEDS[this.speed], () => {
        this.sim.tick();
        if (this.sim.blocked) {
          this.skipping = false;
          return false;
        }
        if (w.sub === 0 && w.doy % 90 === 0) {
          this.autosave();
          if (this.skipping) {
            // nothing asked for attention all season: stop at its turn
            this.skipping = false;
            this.speed = 0;
            this.toast('The season turns. Nothing needed you.', 'info');
            return false;
          }
        }
        return !this.checkStops();
      });
      // time may have been slowed for a new fire: owe no more than the new speed allows
      clock.capBacklog(SPEEDS[this.speed]);
    }
    clock.endFrame();
    if (w.outcome.ended && this.onEnd) {
      const f = this.onEnd;
      this.onEnd = null;
      f();
    }
    // lens refresh
    const lensInfo = LENSES.find((l) => l.id === this.lens)!;
    if (this.lens !== 'none' && this.lens !== 'zones' && (now - this.lastLens > (lensInfo.dynamic ? 700 : 3000) || this.lastLens === 0)) {
      computeLens(w, this.lens, this.lensBuf, lensInfo.fireshed ? this.getFireshed() : undefined);
      this.renderer.overlayVersion++;
      this.lastLens = now;
    }
    const dpr = this.mapCanvas.width / Math.max(1, this.cam.viewW);
    const zoneMix = this.lens === 'zones' || this.tool.id === 'zone' ? 1 : 0;
    this.renderer.draw(
      this.cam,
      w,
      now / 1000,
      {
        overlayMix: this.lens === 'none' || this.lens === 'zones' ? 0 : 1,
        zoneMix,
        contours: this.settings.contours,
        gridLines: this.tool.id !== 'inspect' && this.tool.id !== 'send',
        revealFires: this.settings.reveal,
        night: this.nightNow(dt),
      },
      this.mapCanvas.width,
      this.mapCanvas.height,
    );
    const st: OverlayState = {
      selection: this.selection,
      hoverCell: this.hoverCell,
      brushRadius: this.tool.brush,
      brushActive: ['zone', 'thin', 'burn', 'plant', 'fuelbreak'].includes(this.tool.id),
      brushColor: TOOL_COLORS[this.tool.id] ?? '#ffffff',
      painted: this.painted,
      path: this.path,
      pathColor: TOOL_COLORS[this.tool.id] ?? '#ffffff',
      pathLabel: this.pathLabel,
      showLabels: this.settings.labels,
      showWildlife: this.settings.wildlife || this.lens === 'wildlife',
      revealFires: this.settings.reveal,
      tickAlpha: Math.min(1, clock.acc),
      dayAlpha: Math.min(1, (w.sub + Math.min(1, clock.acc)) / SUBSTEPS_PER_DAY),
      time: now / 1000,
      towerRadius: this.tool.id === 'tower',
      projection: this.projImage,
    };
    this.overlay.draw(w, this.cam, st, dpr);
    this.audio.update(w, this.cam, this.speed, this.settings.audio);
    if (now - this.lastUi > 200) {
      this.lastUi = now;
      this.refreshProjection(now);
      this.advisor.update();
      this.toasts = this.toasts.filter((t) => now - t.at < 6000);
      this.emit();
    }
  }

  /**
   * Slow down or pause for what the simulation flags as needing attention (a notification's `stop`).
   * Returns true if the tick loop should stop. (v1.x slowed for a newly reported fire and nothing else.)
   */
  private checkStops(): boolean {
    const notes = this.world.notifications;
    let stop = 0,
      text = '';
    for (let k = notes.length - 1; k >= 0 && notes[k].id > this.lastNote; k--) {
      const st = notes[k].stop ?? 0;
      if (st > stop) {
        stop = st;
        text = notes[k].text;
      }
    }
    if (notes.length) this.lastNote = notes[notes.length - 1].id;
    if (!stop) return false;
    if (this.skipping) {
      // "next event": anything flagged ends the run
      this.skipping = false;
      this.speed = 0;
      this.prevSpeed = 1;
      this.toast(text.length > 110 ? text.slice(0, 107) + '…' : text, 'warn');
      return true;
    }
    if (stop === 2 && this.settings.autoPause && this.speed > 0) {
      this.prevSpeed = Math.min(this.speed, 2);
      this.speed = 0;
      this.toast('Paused: this needs a decision.', 'warn');
      return true;
    }
    if (this.settings.autoSlow && this.speed > 1) {
      this.speed = 1;
      this.toast(stop === 2 ? 'Time slowed: this needs a decision.' : 'Time slowed.', 'warn');
      return true;
    }
    return false;
  }

  private autosave(): void {
    saveToSlot(this.world, 'autosave')
      .then(() => {
        this.lastSaved = `Autosaved · Year ${this.world.year}`;
      })
      .catch(() => {});
  }

  // ------------------------------------------------------------ commands
  command(cmd: Command, quiet = false): CommandResult {
    const res = applyCommand(this.world, cmd);
    if (!quiet || !res.ok) this.toast(res.msg, res.ok ? 'good' : 'warn');
    this.renderer.markHumanDirty();
    this.lastLens = 0;
    this.advisor.onCommand(cmd, res);
    this.emit();
    return res;
  }

  focus(x: number, y: number, scale?: number): void {
    this.cam.centerOn(x + 0.5, y + 0.5, scale ?? Math.max(this.cam.tscale, 9));
  }

  setTool(id: ToolId, patch: Partial<ToolState> = {}): void {
    this.tool = { ...this.tool, ...patch, id };
    this.painted.clear();
    this.path = [];
    this.pathLabel = '';
    this.roadStart = -1;
    this.emit();
  }

  setLens(l: LensId): void {
    this.lens = l;
    this.lastLens = 0;
    this.emit();
  }

  select(s: Selection | null): void {
    this.selection = s;
    this.emit();
  }

  // ------------------------------------------------------------ input
  private cellAt(sx: number, sy: number): number {
    const [wx, wy] = this.cam.screenToWorld(sx, sy);
    const x = Math.floor(wx),
      y = Math.floor(wy);
    if (x < 0 || y < 0 || x >= this.world.W || y >= this.world.H) return -1;
    return y * this.world.W + x;
  }

  private bindInput(): void {
    const el = this.overlayCanvas;
    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, type: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => t.removeEventListener(type, fn as EventListener));
    };
    on(window, 'resize', () => this.resize());
    on(el, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      this.camInputs++;
      const r = el.getBoundingClientRect();
      this.cam.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016));
    }, { passive: false });
    on(el, 'contextmenu', (e: MouseEvent) => e.preventDefault());
    on(el, 'pointerdown', (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left,
        y = e.clientY - r.top;
      el.setPointerCapture(e.pointerId);
      this.audio.resume();
      if (e.isPrimary) this.pointers.clear(); // a new gesture; forget any lost pointer
      if (e.pointerType !== 'mouse') this.pointers.set(e.pointerId, { x, y });
      if (this.pointers.size >= 2) {
        // a second finger turns the gesture into a pinch; drop any stroke the first one began
        if (this.dragging?.painting) {
          this.painted.clear();
          this.path = [];
          this.pathLabel = '';
        }
        this.dragging = null;
        this.pinch = this.pinchState();
        this.camInputs++;
        return;
      }
      const painting = e.button === 0 && this.toolPaints();
      this.dragging = { button: e.button, x, y, moved: false, painting };
      if (painting) this.pointerPaint(x, y, e.shiftKey, true);
      if (e.button === 2 && (this.painted.size || this.path.length)) {
        this.painted.clear();
        this.path = [];
        this.pathLabel = '';
        this.roadStart = -1;
        this.dragging = null;
      }
    });
    on(el, 'pointermove', (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left,
        y = e.clientY - r.top;
      this.hoverCell = this.cellAt(x, y);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x, y });
      if (this.pinch && this.pointers.size >= 2) {
        const p = this.pinchState();
        this.cam.zoomAt(p.mx, p.my, p.dist / Math.max(1, this.pinch.dist));
        this.cam.panPixels(p.mx - this.pinch.mx, p.my - this.pinch.my);
        this.pinch = p;
        return;
      }
      const d = this.dragging;
      if (d) {
        const dx = x - d.x,
          dy = y - d.y;
        if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) {
          d.moved = true;
          if (!d.painting) this.camInputs++; // a drag-pan begins
        }
        if (d.painting) this.pointerPaint(x, y, e.shiftKey, false);
        else if (d.moved) {
          this.cam.panPixels(dx, dy);
          d.x = x;
          d.y = y;
        }
      } else if (this.tool.id === 'road' && this.roadStart >= 0 && this.hoverCell >= 0) {
        this.previewRoad(this.hoverCell);
      }
    });
    const endPinch = (e: PointerEvent): boolean => {
      this.pointers.delete(e.pointerId);
      if (!this.pinch) return false;
      if (this.pointers.size < 2) {
        this.pinch = null;
        // the finger still down keeps panning, and lifting it is not a click
        const rest = this.pointers.values().next().value;
        this.dragging = rest ? { button: 0, x: rest.x, y: rest.y, moved: true, painting: false } : null;
      }
      return true;
    };
    on(el, 'pointercancel', (e: PointerEvent) => {
      if (!endPinch(e)) this.dragging = null;
    });
    on(el, 'pointerup', (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left,
        y = e.clientY - r.top;
      if (endPinch(e)) return;
      const d = this.dragging;
      this.dragging = null;
      if (!d) return;
      if (d.painting) {
        this.finishPaint(e.shiftKey);
        return;
      }
      if (d.button === 0 && !d.moved) this.click(this.cellAt(x, y), x, y);
    });
    on(el, 'pointerleave', () => {
      this.hoverCell = -1;
    });
    on(window, 'keydown', (e: KeyboardEvent) => this.keydown(e));
    on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase()));
  }

  private pinchState(): { dist: number; mx: number; my: number } {
    const [a, b] = Array.from(this.pointers.values());
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  private toolPaints(): boolean {
    return ['zone', 'thin', 'burn', 'plant', 'fuelbreak', 'fireline', 'airdrop'].includes(this.tool.id);
  }

  private lastPaintCell = -1;
  private pointerPaint(x: number, y: number, erase: boolean, first: boolean): void {
    const c = this.cellAt(x, y);
    if (c < 0) return;
    const w = this.world;
    if (this.tool.id === 'fireline' || this.tool.id === 'airdrop') {
      if (first || this.lastPaintCell < 0) this.path = [c];
      else if (c !== this.lastPaintCell) {
        const seg = lineCells(w.W, this.lastPaintCell % w.W, (this.lastPaintCell / w.W) | 0, c % w.W, (c / w.W) | 0);
        for (const s of seg.slice(1)) if (!this.path.includes(s)) this.path.push(s);
        const max = this.tool.id === 'airdrop' ? 40 : 160;
        if (this.path.length > max) this.path.length = max;
      }
      this.lastPaintCell = c;
      if (this.tool.id === 'airdrop') {
        const drops = Math.ceil(this.path.length / 10);
        this.pathLabel = `${drops} drop${drops > 1 ? 's' : ''} · $${((drops * COST.retardantDrop) / 1000).toFixed(0)}k`;
      } else this.pathLabel = `${(this.path.length / 10).toFixed(1)} km of line`;
      return;
    }
    const cx = c % w.W,
      cy = (c / w.W) | 0;
    const cells = diskCells(w.W, w.H, cx, cy, this.tool.brush + 0.5);
    if (erase && this.tool.id !== 'zone') for (const k of cells) this.painted.delete(k);
    else for (const k of cells) this.painted.add(k);
    this.lastPaintCell = c;
    this.pathLabel = this.paintLabel();
  }

  paintLabel(): string {
    const id = this.tool.id;
    const n = this.painted.size;
    if (id === 'zone') return `${n} ha`;
    if (id === 'thin' || id === 'burn' || id === 'plant' || id === 'fuelbreak') {
      const valid = validProjectCells(this.world, id, Array.from(this.painted)).length;
      return `${valid} ha · $${Math.round((valid * projectCostPerCell(id, this.world)) / 1000)}k`;
    }
    return '';
  }

  private finishPaint(shift: boolean): void {
    const id = this.tool.id;
    this.lastPaintCell = -1;
    if (id === 'fireline') {
      if (this.path.length > 1) this.command({ t: 'fireline', cells: this.path.slice() });
      this.path = [];
      this.pathLabel = '';
      return;
    }
    if (id === 'airdrop') {
      if (this.path.length > 0) this.command({ t: 'airdrop', cells: this.path.slice() });
      this.path = [];
      this.pathLabel = '';
      return;
    }
    const cells = Array.from(this.painted);
    this.painted.clear();
    this.pathLabel = '';
    if (cells.length === 0) return;
    if (id === 'zone') this.command({ t: 'zone', cells, zone: shift ? ZONE.NONE : this.tool.zone }, true);
    else if (id === 'thin' || id === 'burn' || id === 'plant' || id === 'fuelbreak') this.command({ t: 'project', kind: id, cells, species: this.tool.species });
  }

  private previewRoad(goal: number): void {
    const w = this.world;
    const base = roadCost(w);
    const p = astar(w.W, w.H, this.roadStart, goal, (a, b, d) => (w.L.zone[b] === ZONE.WILDERNESS ? Infinity : base(a, b, d)), 1, 30000);
    this.path = p ? [this.roadStart, ...p] : [];
    const cost = estimateCost(w, { t: 'road', from: this.roadStart, to: goal });
    this.pathLabel = isFinite(cost) ? `$${Math.round(cost / 1000)}k` : 'no route';
  }

  private click(cell: number, sx: number, sy: number): void {
    if (cell < 0) return;
    const w = this.world;
    switch (this.tool.id) {
      case 'tower':
        this.command({ t: 'build', what: 'tower', cell });
        return;
      case 'camp':
        this.command({ t: 'build', what: 'camp', cell });
        return;
      case 'wolves':
        this.command({ t: 'reintroduceWolves', cell });
        return;
      case 'beavers':
        this.command({ t: 'relocateBeavers', cell });
        return;
      case 'road':
        if (this.roadStart < 0) {
          this.roadStart = cell;
          this.pathLabel = 'click destination';
        } else {
          this.command({ t: 'road', from: this.roadStart, to: cell });
          this.roadStart = -1;
          this.path = [];
          this.pathLabel = '';
        }
        return;
      case 'send': {
        const crewId = this.tool.sendCrewId;
        const fid = w.L.fid[cell];
        const fe = fid >= 0 ? w.fires.find((f) => f.id === fid && f.active) : undefined;
        if (fe && fe.detected) this.command({ t: 'sendCrew', crewId, fireId: fe.id });
        else {
          const pr = w.projects.find((p) => (p.status !== 'done' && p.status !== 'cancelled') && p.unit.includes(cell));
          if (pr) this.command({ t: 'sendCrew', crewId, projectId: pr.id });
          else this.command({ t: 'sendCrew', crewId, cell });
        }
        this.setTool('inspect');
        return;
      }
    }
    // inspect: pick the most specific thing under the cursor
    const [wx, wy] = this.cam.screenToWorld(sx, sy);
    const pickR = Math.max(0.8, 10 / this.cam.scale);
    const crew = w.crews.find((c) => Math.hypot(c.x - wx, c.y - wy) < pickR);
    if (crew) return this.select({ type: 'crew', id: crew.id });
    if (w.L.fire[cell] === FIRE.BURNING || w.L.fid[cell] >= 0) {
      const fe = w.fires.find((f) => f.id === w.L.fid[cell] && f.active && (f.detected || this.settings.reveal));
      if (fe) return this.select({ type: 'fire', id: fe.id });
    }
    if (this.settings.wildlife || this.lens === 'wildlife') {
      const pack = w.packs.find((p) => Math.hypot(p.x - wx, p.y - wy) < pickR * 1.2);
      if (pack) return this.select({ type: 'pack', id: pack.id });
      const col = w.colonies.find((c) => Math.hypot((c.cell % w.W) + 0.5 - wx, ((c.cell / w.W) | 0) + 0.5 - wy) < pickR);
      if (col) return this.select({ type: 'colony', id: col.id });
      const herd = w.herds.find((h) => Math.hypot(h.x - wx, h.y - wy) < pickR * 1.2);
      if (herd) return this.select({ type: 'herd', id: herd.id });
    }
    if (w.L.town[cell] !== 0) return this.select({ type: 'town', id: Math.abs(w.L.town[cell]) - 1 });
    const pr = w.projects.find((p) => p.status !== 'done' && p.status !== 'cancelled' && p.unit.includes(cell));
    if (pr) return this.select({ type: 'project', id: pr.id });
    this.select({ type: 'cell', cell });
  }

  private keydown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    const k = e.key.toLowerCase();
    this.keys.add(k);
    if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && CAMERA_KEYS.includes(k)) this.camInputs++;
    if (k === ' ') {
      e.preventDefault();
      this.togglePause();
      return;
    }
    if (k === 'escape') {
      if (this.painted.size || this.path.length) {
        this.painted.clear();
        this.path = [];
        this.pathLabel = '';
        this.roadStart = -1;
      } else if (this.tool.id !== 'inspect') this.setTool('inspect');
      else this.select(null);
      this.emit();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k >= '1' && k <= '4' && e.shiftKey === false && !this.lensKeyMode) {
      this.setSpeed(Number(k));
      return;
    }
    const lens = LENSES.find((l) => l.key === k);
    if (lens && (k === '`' || this.lensKeyMode)) {
      this.setLens(lens.id);
      return;
    }
    switch (k) {
      case 'n':
        this.advanceToEvent();
        break;
      case 'p':
        this.settings.projection = !this.settings.projection;
        this.projKey = '';
        this.emit();
        break;
      case 'q':
        this.setTool('inspect');
        break;
      case 'z':
        this.setTool('zone');
        break;
      case 't':
        this.setTool('thin');
        break;
      case 'b':
        this.setTool('burn');
        break;
      case 'f':
        this.setTool('fireline');
        break;
      case 'x':
        this.setTool('airdrop');
        break;
      case 'l':
        this.cycleLens();
        break;
      case '[':
        this.tool.brush = Math.max(0, this.tool.brush - 1);
        this.emit();
        break;
      case ']':
        this.tool.brush = Math.min(8, this.tool.brush + 1);
        this.emit();
        break;
      case '+':
      case '=':
        this.cam.zoomAt(this.cam.viewW / 2, this.cam.viewH / 2, 1.3);
        break;
      case '-':
      case '_':
        this.cam.zoomAt(this.cam.viewW / 2, this.cam.viewH / 2, 1 / 1.3);
        break;
    }
  }

  /** When true, number keys pick lenses instead of speeds (toggled by holding L in the UI). */
  lensKeyMode = false;

  cycleLens(): void {
    const ids = LENSES.map((l) => l.id);
    const k = ids.indexOf(this.lens);
    this.setLens(ids[(k + 1) % ids.length]);
  }

  private panKeys(dt: number): void {
    let dx = 0,
      dy = 0;
    if (this.keys.has('arrowleft') || this.keys.has('a')) dx += 1;
    if (this.keys.has('arrowright') || this.keys.has('d')) dx -= 1;
    if (this.keys.has('arrowup') || this.keys.has('w')) dy += 1;
    if (this.keys.has('arrowdown') || this.keys.has('s')) dy -= 1;
    if (dx || dy) this.cam.panPixels(dx * dt * 700, dy * dt * 700);
  }
}
