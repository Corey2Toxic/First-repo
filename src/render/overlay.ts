/**
 * Canvas2D overlay: place names, fire tags, crews, wildlife, infrastructure,
 * project outlines, tool previews and selection. Drawn every frame on top of
 * the WebGL map, with simple label collision avoidance.
 */
import type { Camera } from './camera.ts';
import type { World } from '../sim/world.ts';
import { INFRA } from '../sim/types.ts';
import { TERRITORY_RADIUS } from '../sim/systems/wildlife.ts';
import type { Crew, Project } from '../sim/types.ts';

export type Selection =
  | { type: 'cell'; cell: number }
  | { type: 'fire'; id: number }
  | { type: 'crew'; id: number }
  | { type: 'town'; id: number }
  | { type: 'project'; id: number }
  | { type: 'herd'; id: number }
  | { type: 'pack'; id: number }
  | { type: 'colony'; id: number };

export interface OverlayState {
  selection: Selection | null;
  hoverCell: number;
  brushRadius: number;
  brushActive: boolean; // tool uses a brush
  brushColor: string;
  painted: Set<number>;
  path: number[]; // line tool preview
  pathColor: string;
  pathLabel: string;
  showLabels: boolean;
  showWildlife: boolean;
  revealFires: boolean;
  tickAlpha: number; // 0..1 progress through the current 3-hour tick
  dayAlpha: number; // 0..1 progress through the current day
  time: number;
  towerRadius: boolean;
  /** where fire is expected to spread, one pixel per cell (drawn under everything else) */
  projection?: CanvasImageSource | null;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const PROJECT_COLOR: Record<string, string> = {
  thin: '#7fd18b',
  burn: '#ff9a3d',
  plant: '#b6e36b',
  fuelbreak: '#e9d27a',
};

export class OverlayRenderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  private placed: Rect[] = [];
  private outlineCache = new Map<number, { ver: number; segs: Float32Array }>();
  private embers: Array<{ x: number; y: number; vx: number; vy: number; life: number }> = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  private free(r: Rect): boolean {
    for (const p of this.placed) if (r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0) return false;
    this.placed.push(r);
    return true;
  }

  private label(text: string, x: number, y: number, font: string, fill: string, opts: { halo?: string; align?: CanvasTextAlign; force?: boolean } = {}): boolean {
    const ctx = this.ctx;
    ctx.font = font;
    const m = ctx.measureText(text);
    const wdt = m.width;
    const h = parseInt(font.match(/(\d+)px/)?.[1] ?? '12', 10);
    const align = opts.align ?? 'center';
    const x0 = align === 'center' ? x - wdt / 2 : align === 'left' ? x : x - wdt;
    const rect = { x0: x0 - 3, y0: y - h, x1: x0 + wdt + 3, y1: y + 4 };
    if (!opts.force && !this.free(rect)) return false;
    if (opts.force) this.placed.push(rect);
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = opts.halo ?? 'rgba(10,12,10,0.75)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
    return true;
  }

  draw(w: World, cam: Camera, st: OverlayState, dpr: number): void {
    const ctx = this.ctx;
    const cw = this.canvas.width,
      ch = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.placed = [];
    const s = cam.scale;
    const P = (wx: number, wy: number) => cam.worldToScreen(wx, wy);
    const vis = (x: number, y: number, m = 40) => x > -m && y > -m && x < cam.viewW + m && y < cam.viewH + m;

    // --- where fire is expected to go (session.paintProjection)
    if (st.projection) {
      const [px, py] = P(0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(st.projection, px, py, w.W * s, w.H * s);
      ctx.imageSmoothingEnabled = true;
    }

    // --- project outlines
    for (const pr of w.projects) {
      if (pr.status === 'done' || pr.status === 'cancelled') continue;
      this.drawProject(w, cam, pr, st.selection?.type === 'project' && st.selection.id === pr.id);
    }

    // --- painted selection and brush
    if (st.painted.size > 0) {
      ctx.fillStyle = st.brushColor + '55';
      for (const c of st.painted) {
        const [x, y] = P(c % w.W, (c / w.W) | 0);
        ctx.fillRect(x, y, s + 0.5, s + 0.5);
      }
    }
    if (st.path.length > 1) {
      ctx.strokeStyle = st.pathColor;
      ctx.lineWidth = Math.max(2, s * 0.25);
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      st.path.forEach((c, k) => {
        const [x, y] = P((c % w.W) + 0.5, ((c / w.W) | 0) + 0.5);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      const last = st.path[st.path.length - 1];
      const [lx, ly] = P((last % w.W) + 0.5, ((last / w.W) | 0) + 0.5);
      if (st.pathLabel) this.label(st.pathLabel, lx + 10, ly - 10, '600 12px system-ui, sans-serif', '#fff', { align: 'left', force: true });
    }
    if (st.hoverCell >= 0 && st.brushActive) {
      const hx = (st.hoverCell % w.W) + 0.5,
        hy = ((st.hoverCell / w.W) | 0) + 0.5;
      const [x, y] = P(hx, hy);
      ctx.strokeStyle = st.brushColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(3, (st.brushRadius + 0.5) * s), 0, Math.PI * 2);
      ctx.stroke();
    }

    // --- tower view radius
    if (st.towerRadius) {
      ctx.strokeStyle = 'rgba(255,230,150,0.55)';
      ctx.setLineDash([4, 6]);
      for (const t of w.towers) {
        const [x, y] = P((t % w.W) + 0.5, ((t / w.W) | 0) + 0.5);
        ctx.beginPath();
        ctx.arc(x, y, 34 * s, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // --- wildlife
    const dayA = st.dayAlpha;
    if (st.showWildlife && s > 1.4) {
      for (const h of w.herds) {
        const x0 = h.px + (h.x - h.px) * dayA,
          y0 = h.py + (h.y - h.py) * dayA;
        const [x, y] = P(x0, y0);
        if (!vis(x, y)) continue;
        const dots = Math.min(9, Math.max(1, Math.round(h.n / 7)));
        ctx.fillStyle = '#7a4e2b';
        for (let k = 0; k < dots; k++) {
          const a = k * 2.399 + h.id;
          const r = Math.sqrt(k) * Math.max(1.6, s * 0.28);
          ctx.beginPath();
          ctx.arc(x + Math.cos(a) * r, y + Math.sin(a) * r, Math.max(1.3, s * 0.13), 0, Math.PI * 2);
          ctx.fill();
        }
        if (st.selection?.type === 'herd' && st.selection.id === h.id) this.ring(x, y, 10, '#f5d0a0');
      }
      for (const p of w.packs) {
        const x0 = p.px + (p.x - p.px) * dayA,
          y0 = p.py + (p.y - p.py) * dayA;
        const [x, y] = P(x0, y0);
        if (st.selection?.type === 'pack' && st.selection.id === p.id) {
          const [tx, ty] = P(p.tx, p.ty);
          ctx.strokeStyle = 'rgba(170,150,255,0.6)';
          ctx.setLineDash([5, 5]);
          ctx.beginPath();
          ctx.arc(tx, ty, TERRITORY_RADIUS * s, 0, Math.PI * 2);
          ctx.stroke();
          ctx.setLineDash([]);
          this.ring(x, y, 12, '#c8b8ff');
        }
        if (!vis(x, y)) continue;
        this.wolfIcon(x, y, Math.max(5, Math.min(11, s * 0.9)));
        if (s > 4 && st.showLabels) this.label(`${p.name} (${p.n})`, x, y - 12, '600 11px system-ui, sans-serif', '#d9d2ff');
      }
      for (const c of w.colonies) {
        const [x, y] = P((c.cell % w.W) + 0.5, ((c.cell / w.W) | 0) + 0.5);
        if (!vis(x, y)) continue;
        this.lodgeIcon(x, y, Math.max(4, Math.min(9, s * 0.7)), c.active);
        if (st.selection?.type === 'colony' && st.selection.id === c.id) this.ring(x, y, 10, '#9fe0ff');
      }
    }

    // --- infrastructure icons
    const iconSize = Math.max(5, Math.min(12, s * 0.9));
    for (const t of w.towers) {
      const [x, y] = P((t % w.W) + 0.5, ((t / w.W) | 0) + 0.5);
      if (vis(x, y)) this.towerIcon(x, y, iconSize);
    }
    for (const c of w.camps) {
      const [x, y] = P((c % w.W) + 0.5, ((c / w.W) | 0) + 0.5);
      if (vis(x, y)) this.tentIcon(x, y, iconSize);
    }
    if (w.damCell >= 0 && s > 2) {
      const [x, y] = P((w.damCell % w.W) + 0.5, ((w.damCell / w.W) | 0) + 0.5);
      ctx.fillStyle = '#d8d2c4';
      ctx.fillRect(x - iconSize * 0.6, y - 2, iconSize * 1.2, 4);
    }
    for (const t of w.towns) {
      if (w.L.infra[t.station] & INFRA.MILL) {
        const [x, y] = P((t.station % w.W) + 0.5, ((t.station / w.W) | 0) + 0.5);
        if (s > 2.5) this.millIcon(x, y, iconSize, w.economy.millOpen);
      }
    }

    // --- embers over detected fires (zoomed in)
    this.drawEmbers(w, cam, st, dpr);

    // --- crews
    const ta = st.tickAlpha;
    for (const c of w.crews) {
      const x0 = c.px + (c.x - c.px) * ta,
        y0 = c.py + (c.y - c.py) * ta;
      const [x, y] = P(x0, y0);
      if (!vis(x, y)) continue;
      const sel = st.selection?.type === 'crew' && st.selection.id === c.id;
      this.crewBadge(c, x, y, Math.max(7, Math.min(13, s * 0.9)), sel, st.time);
      if ((sel || (s > 6 && c.state !== 'idle')) && st.showLabels)
        this.label(c.name, x, y - 14, '600 11px system-ui, sans-serif', sel ? '#fff' : '#e8e2d0');
    }

    // --- fire tags
    for (const fe of w.fires) {
      if (!fe.active || (!fe.detected && !st.revealFires)) continue;
      const cx = (fe.minX + fe.maxX + 1) / 2,
        cy = fe.minY - 0.5;
      const [x, y] = P(cx, cy);
      if (!vis(x, y, 120)) continue;
      const sel = st.selection?.type === 'fire' && st.selection.id === fe.id;
      const txt = `${fe.name} · ${fe.area.toLocaleString()} ha${fe.cause !== 'prescribed' ? ` · ${Math.round(fe.containment * 100)}%` : ''}`;
      const col = fe.cause === 'prescribed' ? '#ffd29a' : fe.response === 'monitor' ? '#ffe2a8' : '#ffb08a';
      this.label(txt, x, y - 6, `${sel ? '700' : '600'} ${sel ? 13 : 12}px system-ui, sans-serif`, col, { force: sel });
      if (sel) {
        const [ax, ay] = P(fe.minX, fe.minY),
          [bx, by] = P(fe.maxX + 1, fe.maxY + 1);
        ctx.strokeStyle = 'rgba(255,170,120,0.8)';
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(ax - 4, ay - 4, bx - ax + 8, by - ay + 8);
        ctx.setLineDash([]);
      }
      // new-fire pulse
      if (w.day - fe.detectedDay < 1 && fe.cause !== 'prescribed') {
        const [px, py] = P(fe.originX + 0.5, fe.originY + 0.5);
        const ph = (st.time * 1.4) % 1;
        ctx.strokeStyle = `rgba(255,120,60,${1 - ph})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 6 + ph * 28, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // --- towns
    for (const t of w.towns) {
      const [x, y] = P(t.x + 0.5, t.y + 0.5);
      if (!vis(x, y, 100)) continue;
      const sel = st.selection?.type === 'town' && st.selection.id === t.id;
      const size = s < 3 ? 13 : 15;
      const ok = this.label(t.name, x, y - Math.max(10, Math.sqrt(t.structures) * s * 0.35), `700 ${size}px Georgia, 'Iowan Old Style', serif`, sel ? '#fff7d6' : '#f6ecd0', { force: true });
      if (ok && s > 2.5) {
        const threat = t.threat > 0.5 ? ' · ⚠' : '';
        this.label(`${t.population.toLocaleString()} people${threat}`, x, y - Math.max(10, Math.sqrt(t.structures) * s * 0.35) + 14, '500 11px system-ui, sans-serif', t.threat > 0.5 ? '#ffb38a' : '#d8cfb6', { force: true });
      }
    }

    // --- landmarks
    if (st.showLabels) {
      const sorted = [...w.landmarks].sort((a, b) => b.importance - a.importance);
      for (const m of sorted) {
        if (m.kind === 'town') continue;
        const minScale = m.importance >= 3 ? 1.5 : m.importance === 2 ? 3 : 5.5;
        if (s < minScale) continue;
        const [x, y] = P(m.x + 0.5, m.y + 0.5);
        if (!vis(x, y)) continue;
        if (m.kind === 'peak') {
          ctx.fillStyle = '#efe6d2';
          ctx.beginPath();
          ctx.moveTo(x, y - 5);
          ctx.lineTo(x + 4.5, y + 3);
          ctx.lineTo(x - 4.5, y + 3);
          ctx.closePath();
          ctx.fill();
          const elev = m.elev ? ` ${Math.round(m.elev)} m` : '';
          this.label(m.name + (s > 6 ? elev : ''), x, y - 8, `600 11px Georgia, serif`, '#efe6d2');
        } else if (m.kind === 'lake') {
          this.label(m.name, x, y + 4, `italic 600 11px Georgia, serif`, '#bfe3f2', { halo: 'rgba(10,30,45,0.7)' });
        } else if (m.kind === 'creek') {
          this.label(m.name, x, y, `italic 500 ${m.importance >= 3 ? 12 : 10.5}px Georgia, serif`, '#a9d4ea', { halo: 'rgba(10,30,45,0.7)' });
        } else {
          this.label(m.name.toUpperCase(), x, y, `600 9.5px system-ui, sans-serif`, 'rgba(235,228,210,0.85)');
        }
      }
    }

    // --- cell selection box
    if (st.selection?.type === 'cell') {
      const c = st.selection.cell;
      const [x, y] = P(c % w.W, (c / w.W) | 0);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x, y, Math.max(4, s), Math.max(4, s));
    }
  }

  private drawEmbers(w: World, cam: Camera, st: OverlayState, dpr: number): void {
    const ctx = this.ctx;
    const s = cam.scale;
    if (s < 5 || w.burning.length === 0) {
      this.embers.length = 0;
      return;
    }
    const L = w.L;
    const hidden = new Set<number>();
    if (!st.revealFires) for (const f of w.fires) if (f.active && !f.detected) hidden.add(f.id);
    // spawn
    const n = Math.min(40, Math.ceil(w.burning.length * 0.05));
    for (let k = 0; k < n; k++) {
      const b = w.burning[(Math.random() * w.burning.length) | 0];
      if (hidden.has(L.fid[b]) || L.fint[b] < 0.8) continue;
      const wx = (b % w.W) + Math.random(),
        wy = ((b / w.W) | 0) + Math.random();
      const [x, y] = cam.worldToScreen(wx, wy);
      if (x < -20 || y < -20 || x > cam.viewW + 20 || y > cam.viewH + 20) continue;
      const wd = w.weather.windDir;
      this.embers.push({ x, y, vx: Math.cos(wd) * 18 + (Math.random() - 0.5) * 10, vy: Math.sin(wd) * 18 - 14 - Math.random() * 12, life: 1 });
    }
    if (this.embers.length > 400) this.embers.splice(0, this.embers.length - 400);
    ctx.globalCompositeOperation = 'lighter';
    for (const e of this.embers) {
      e.x += e.vx / 60;
      e.y += e.vy / 60;
      e.life -= 1 / 50;
      if (e.life <= 0) continue;
      ctx.fillStyle = `rgba(255,${150 + 80 * e.life | 0},60,${e.life * 0.9})`;
      ctx.fillRect(e.x, e.y, 1.6, 1.6);
    }
    ctx.globalCompositeOperation = 'source-over';
    this.embers = this.embers.filter((e) => e.life > 0);
    void dpr;
  }

  private drawProject(w: World, cam: Camera, pr: Project, selected: boolean): void {
    const ctx = this.ctx;
    let cache = this.outlineCache.get(pr.id);
    if (!cache || cache.ver !== pr.unit.length) {
      const set = new Set(pr.unit);
      const segs: number[] = [];
      for (const c of pr.unit) {
        const x = c % w.W,
          y = (c / w.W) | 0;
        if (!set.has(c - w.W)) segs.push(x, y, x + 1, y);
        if (!set.has(c + w.W)) segs.push(x, y + 1, x + 1, y + 1);
        if (x === 0 || !set.has(c - 1)) segs.push(x, y, x, y + 1);
        if (x === w.W - 1 || !set.has(c + 1)) segs.push(x + 1, y, x + 1, y + 1);
      }
      cache = { ver: pr.unit.length, segs: Float32Array.from(segs) };
      this.outlineCache.set(pr.id, cache);
    }
    const col = PROJECT_COLOR[pr.kind];
    ctx.strokeStyle = col;
    ctx.lineWidth = selected ? 2.5 : 1.5;
    ctx.setLineDash(pr.status === 'burning' ? [] : [5, 3]);
    ctx.beginPath();
    const sg = cache.segs;
    for (let k = 0; k < sg.length; k += 4) {
      const [ax, ay] = cam.worldToScreen(sg[k], sg[k + 1]);
      const [bx, by] = cam.worldToScreen(sg[k + 2], sg[k + 3]);
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // completed cells are shaded
    if (pr.kind !== 'burn' && pr.done > 0 && cam.scale > 2) {
      const todo = new Set(pr.todo);
      ctx.fillStyle = col + '40';
      for (const c of pr.unit) {
        if (todo.has(c)) continue;
        const [x, y] = cam.worldToScreen(c % w.W, (c / w.W) | 0);
        ctx.fillRect(x, y, cam.scale, cam.scale);
      }
    }
    if (cam.scale > 3) {
      const [x, y] = cam.worldToScreen(pr.cx + 0.5, pr.cy + 0.5);
      const pct = pr.kind === 'burn' ? (pr.status === 'burning' ? 'burning' : pr.status === 'waiting' ? 'awaiting burn window' : 'queued') : `${Math.round((100 * pr.done) / pr.unit.length)}%`;
      this.label(pct, x, y, '600 10.5px system-ui, sans-serif', col);
    }
  }

  private ring(x: number, y: number, r: number, color: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  private crewBadge(c: Crew, x: number, y: number, r: number, selected: boolean, time: number): void {
    const ctx = this.ctx;
    const col = c.state === 'working' ? '#ff9b45' : c.state === 'moving' || c.state === 'returning' ? '#6cb7ff' : '#c9c2b0';
    ctx.fillStyle = 'rgba(20,20,18,0.85)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = selected ? '#ffffff' : col;
    ctx.lineWidth = selected ? 2.5 : 1.8;
    ctx.stroke();
    ctx.fillStyle = col;
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.6;
    if (c.kind === 'heli') {
      // rotor
      const a = time * 18;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8);
      ctx.lineTo(x - Math.cos(a) * r * 0.8, y - Math.sin(a) * r * 0.8);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, r * 0.28, 0, Math.PI * 2);
      ctx.fill();
    } else if (c.kind === 'engine') {
      ctx.fillRect(x - r * 0.55, y - r * 0.3, r * 1.1, r * 0.55);
      ctx.beginPath();
      ctx.arc(x - r * 0.3, y + r * 0.35, r * 0.16, 0, Math.PI * 2);
      ctx.arc(x + r * 0.3, y + r * 0.35, r * 0.16, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // pulaski: axe head + handle
      ctx.beginPath();
      ctx.moveTo(x - r * 0.45, y + r * 0.45);
      ctx.lineTo(x + r * 0.35, y - r * 0.35);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + r * 0.05, y - r * 0.55);
      ctx.lineTo(x + r * 0.55, y - r * 0.05);
      ctx.stroke();
    }
  }

  private wolfIcon(x: number, y: number, r: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(25,25,30,0.8)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#c9c4dc';
    ctx.beginPath();
    ctx.moveTo(x - r * 0.55, y - r * 0.15);
    ctx.lineTo(x - r * 0.35, y - r * 0.7);
    ctx.lineTo(x - r * 0.1, y - r * 0.25);
    ctx.lineTo(x + r * 0.1, y - r * 0.25);
    ctx.lineTo(x + r * 0.35, y - r * 0.7);
    ctx.lineTo(x + r * 0.55, y - r * 0.15);
    ctx.lineTo(x, y + r * 0.6);
    ctx.closePath();
    ctx.fill();
  }

  private lodgeIcon(x: number, y: number, r: number, active: boolean): void {
    const ctx = this.ctx;
    ctx.fillStyle = active ? '#8a5a35' : 'rgba(138,90,53,0.45)';
    ctx.strokeStyle = active ? '#d9b68a' : 'rgba(217,182,138,0.4)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.65, 0, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  private towerIcon(x: number, y: number, r: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = '#f2e6c4';
    ctx.fillStyle = '#f2e6c4';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.5, y + r * 0.8);
    ctx.lineTo(x, y - r * 0.3);
    ctx.lineTo(x + r * 0.5, y + r * 0.8);
    ctx.stroke();
    ctx.fillRect(x - r * 0.45, y - r * 0.75, r * 0.9, r * 0.5);
  }

  private tentIcon(x: number, y: number, r: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#9fd3e8';
    ctx.strokeStyle = 'rgba(10,20,25,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - r * 0.7);
    ctx.lineTo(x + r * 0.7, y + r * 0.5);
    ctx.lineTo(x - r * 0.7, y + r * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  private millIcon(x: number, y: number, r: number, open: boolean): void {
    const ctx = this.ctx;
    ctx.fillStyle = open ? '#c79a5a' : 'rgba(150,130,110,0.6)';
    ctx.strokeStyle = 'rgba(15,12,10,0.8)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(x + r * 0.6, y - r * 0.4, r * 1.2, r * 0.8);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + r * 1.5, y - r * 0.4);
    ctx.lineTo(x + r * 1.5, y - r * 1.1);
    ctx.lineTo(x + r * 1.7, y - r * 1.1);
    ctx.lineTo(x + r * 1.7, y - r * 0.4);
    ctx.fill();
  }
}
