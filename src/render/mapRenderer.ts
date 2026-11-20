/**
 * WebGL2 map renderer: packs simulation layers into small RGBA8 textures and
 * draws one full-screen quad with the procedural landscape shader.
 */
import { FRAG, VERT } from './shaders.ts';
import type { Camera } from './camera.ts';
import type { World } from '../sim/world.ts';
import { INFRA } from '../sim/types.ts';
import { bloomFactor, charFactor, greenness, snowCover } from '../sim/derived.ts';
import { DX8, DY8 } from '../sim/grid.ts';
import { LINE_SCALE, buildRiverTexture, buildRoadTexture } from './lines.ts';

type TexName = 'terrain' | 'veg' | 'veg2' | 'misc' | 'fire' | 'human' | 'overlay' | 'river' | 'road';
const TEX_ORDER: TexName[] = ['terrain', 'veg', 'veg2', 'misc', 'fire', 'human', 'overlay', 'river', 'road'];
const UNIFORM_SAMPLERS: Record<TexName, string> = {
  terrain: 'tTerrain',
  veg: 'tVeg',
  veg2: 'tVeg2',
  misc: 'tMisc',
  fire: 'tFire',
  human: 'tHuman',
  overlay: 'tOverlay',
  river: 'tRiver',
  road: 'tRoad',
};

export interface RenderOptions {
  overlayMix: number;
  zoneMix: number;
  contours: boolean;
  gridLines: boolean;
  /** Show fires the player has not detected yet (debug / spectator). */
  revealFires: boolean;
  /** 0 day .. 1 deep night (drawn only when time runs slowly enough to watch) */
  night?: number;
}

export class MapRenderer {
  readonly gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private tex = {} as Record<TexName, WebGLTexture>;
  private buf = {} as Record<TexName, Uint8Array>;
  private uni = new Map<string, WebGLUniformLocation | null>();
  private W = 0;
  private H = 0;
  private versions = { veg: -1, fire: -1, human: -1, misc: -1, overlay: -1 };
  private lastDay = -1;
  private elevMin = 0;
  private elevRange = 1;
  private shoreDist: Float32Array | null = null;
  overlayData: Uint8Array | null = null;
  overlayVersion = 0;
  private world: World | null = null;
  private roadVersion = -1;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.prog = this.link(VERT, FRAG);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const loc = gl.getAttribLocation(this.prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  }

  private link(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        throw new Error('Shader compile failed: ' + log);
      }
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
    return p;
  }

  private u(name: string): WebGLUniformLocation | null {
    if (!this.uni.has(name)) this.uni.set(name, this.gl.getUniformLocation(this.prog, name));
    return this.uni.get(name)!;
  }

  /** Bind a world: allocate textures and upload the static terrain. */
  setWorld(w: World): void {
    const gl = this.gl;
    this.world = w;
    // a lens overlay belongs to the world it was computed for: drop it on rebinding (v1.0 kept the
    // previous session's buffer and copied a medium map's lens into a small backdrop → RangeError)
    this.overlayData = null;
    this.W = w.W;
    this.H = w.H;
    for (const t of Object.values(this.tex)) gl.deleteTexture(t);
    this.tex = {} as Record<TexName, WebGLTexture>;
    for (const name of TEX_ORDER) {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      const nearest = name === 'human';
      const mip = name === 'fire';
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, nearest ? gl.NEAREST : mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const S = name === 'river' || name === 'road' ? LINE_SCALE : 1;
      this.buf[name] =
        name === 'river'
          ? buildRiverTexture(w)
          : name === 'road'
            ? buildRoadTexture(w, (i) => (w.L.infra[i] & INFRA.ROAD) !== 0)
            : new Uint8Array(w.N * 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w.W * S, w.H * S, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.buf[name]);
      if (mip) gl.generateMipmap(gl.TEXTURE_2D);
      this.tex[name] = t;
    }
    this.versions = { veg: -1, fire: -1, human: -1, misc: -1, overlay: -1 };
    this.lastDay = -1;
    this.roadVersion = w.dirty.infra;
    this.computeShoreDist();
    this.buildTerrain();
    this.upload('terrain');
    this.refresh(w, true);
  }

  private computeShoreDist(): void {
    const w = this.world!;
    const { W, H, N } = w;
    const d = new Float32Array(N).fill(99);
    const q: number[] = [];
    for (let i = 0; i < N; i++)
      if (!w.isWater(i)) {
        d[i] = 0;
        q.push(i);
      }
    let h = 0;
    while (h < q.length) {
      const c = q[h++];
      const cx = c % W,
        cy = (c / W) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX8[k],
          ny = cy + DY8[k];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (d[ni] > d[c] + 1) {
          d[ni] = d[c] + 1;
          q.push(ni);
        }
      }
    }
    this.shoreDist = d;
  }

  private buildTerrain(): void {
    const w = this.world!;
    const L = w.L;
    const b = this.buf.terrain;
    const { W, H, N } = w;
    let lo = Infinity,
      hi = -Infinity,
      maxAcc = 1;
    for (let i = 0; i < N; i++) {
      lo = Math.min(lo, L.elev[i]);
      hi = Math.max(hi, L.elev[i]);
      maxAcc = Math.max(maxAcc, L.flowAcc[i]);
    }
    this.elevMin = lo;
    this.elevRange = Math.max(1, hi - lo);
    const ex = 2.4;
    const stream = new Float32Array(N);
    const T = 110;
    const logMax = Math.log(maxAcc / T);
    for (let i = 0; i < N; i++) {
      const a = L.flowAcc[i];
      if (a >= T) stream[i] = Math.max(stream[i], 0.52 + 0.48 * Math.min(1, Math.log(a / T) / logMax));
      else stream[i] = Math.max(stream[i], (a / T) * 0.38);
      // bridge diagonal flow steps so channels render continuously
      const t = L.flowTo[i];
      if (a >= T && t >= 0) {
        const dx = (t % W) - (i % W),
          dy = ((t / W) | 0) - ((i / W) | 0);
        if (dx !== 0 && dy !== 0) {
          const v = stream[i] * 0.97;
          const j1 = i + dx,
            j2 = i + dy * W;
          stream[j1] = Math.max(stream[j1], v);
          stream[j2] = Math.max(stream[j2], v);
        }
      }
    }
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const xl = Math.max(0, x - 1),
          xr = Math.min(W - 1, x + 1),
          yu = Math.max(0, y - 1),
          yd = Math.min(H - 1, y + 1);
        const dzdx = (L.elev[y * W + xr] - L.elev[y * W + xl]) / ((xr - xl) * 100);
        const dzdy = (L.elev[yd * W + x] - L.elev[yu * W + x]) / ((yd - yu) * 100);
        let nx = -dzdx * ex,
          ny = -dzdy * ex;
        const nl = Math.sqrt(nx * nx + ny * ny + 1);
        nx /= nl;
        ny /= nl;
        b[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
        b[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        b[i * 4 + 2] = Math.round(((L.elev[i] - lo) / this.elevRange) * 255);
        b[i * 4 + 3] = Math.round(Math.min(1, stream[i]) * 255);
      }
  }

  private upload(name: TexName): void {
    const gl = this.gl;
    const S = name === 'river' || name === 'road' ? LINE_SCALE : 1;
    gl.bindTexture(gl.TEXTURE_2D, this.tex[name]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.W * S, this.H * S, gl.RGBA, gl.UNSIGNED_BYTE, this.buf[name]);
    if (name === 'fire') gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Re-pack whichever layers changed since the last frame. */
  refresh(w: World, force = false, opts?: Partial<RenderOptions>): void {
    const L = w.L;
    const N = w.N;
    const newDay = w.day !== this.lastDay;
    if (force || w.dirty.veg !== this.versions.veg || newDay) {
      const v = this.buf.veg,
        v2 = this.buf.veg2,
        m = this.buf.misc;
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        v[o] = Math.min(255, L.grass[i] * 255);
        v[o + 1] = Math.min(255, L.shrub[i] * 255);
        v[o + 2] = Math.min(255, L.aspen[i] * 255);
        v[o + 3] = Math.min(255, L.pine[i] * 255);
        v2[o] = Math.min(255, L.fir[i] * 255);
        v2[o + 1] = Math.min(255, snowCover(L.snow[i]) * 255);
        v2[o + 2] = Math.min(255, charFactor(w, i) * 255);
        v2[o + 3] = Math.min(255, L.red[i] * 255);
        m[o] = Math.min(255, bloomFactor(w, i) * 255);
        m[o + 1] = Math.min(255, greenness(w, i) * 255);
        m[o + 3] = Math.min(255, Math.min(1, L.snag[i] / 120) * 255);
      }
      this.upload('veg');
      this.upload('veg2');
      this.upload('misc');
      this.versions.veg = w.dirty.veg;
      this.lastDay = w.day;
    }
    if (force || w.dirty.fire !== this.versions.fire || w.dirty.smoke !== this.versions.misc) {
      const f = this.buf.fire;
      const reveal = opts?.revealFires ?? false;
      const sd = this.shoreDist!;
      const hidden = new Set<number>();
      if (!reveal) for (const fe of w.fires) if (fe.active && !fe.detected) hidden.add(fe.id);
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        let fi = 0;
        if (L.fire[i] === 1 && !hidden.has(L.fid[i])) fi = Math.min(1, 0.22 + L.fint[i] * 0.2); // flame length (m) → glow
        f[o] = fi * 255;
        f[o + 1] = Math.min(255, Math.sqrt(Math.min(1, L.smoke[i])) * 255);
        f[o + 2] = Math.min(255, Math.max(L.fline[i], 0) * 255);
        const water = L.water[i] >= 2 ? 0.62 + 0.38 * Math.min(1, sd[i] / 4) : L.pond[i] > 0.05 ? 0.5 + 0.3 * L.pond[i] : 0;
        f[o + 3] = water * 255;
      }
      this.upload('fire');
      this.versions.fire = w.dirty.fire;
      this.versions.misc = w.dirty.smoke;
    }
    if (force || w.dirty.zone + w.dirty.infra * 7 !== this.versions.human) {
      const h = this.buf.human;
      for (let i = 0; i < N; i++) {
        const o = i * 4;
        h[o] = L.zone[i];
        h[o + 1] = L.infra[i];
        h[o + 2] = L.town[i] > 0 ? L.town[i] : L.town[i] < 0 ? 128 + -L.town[i] : 0;
        let flags = 0;
        if (L.retard[i] > 0.05) flags |= 16;
        if (L.wet[i] > 0.05) flags |= 32;
        h[o + 3] = flags;
      }
      this.upload('human');
      if (this.roadVersion !== w.dirty.infra) {
        buildRoadTexture(w, (i) => (L.infra[i] & INFRA.ROAD) !== 0, this.buf.road);
        this.upload('road');
        this.roadVersion = w.dirty.infra;
      }
      this.versions.human = w.dirty.zone + w.dirty.infra * 7;
    }
    if (this.overlayData && this.overlayVersion !== this.versions.overlay) {
      if (this.overlayData.length !== this.buf.overlay.length) {
        // stale buffer from another world size: never copy across sizes
        this.overlayData = null;
        return;
      }
      this.buf.overlay.set(this.overlayData);
      this.upload('overlay');
      this.versions.overlay = this.overlayVersion;
    }
  }

  markHumanDirty(): void {
    this.versions.human = -1;
  }

  draw(cam: Camera, w: World, time: number, opts: RenderOptions, canvasW: number, canvasH: number): void {
    // the renderer is shared by the title backdrop and every session: a loop still running for a
    // world it is no longer bound to must not write that world into these buffers
    if (w !== this.world) return;
    const gl = this.gl;
    this.refresh(w, false, opts);
    gl.viewport(0, 0, canvasW, canvasH);
    gl.useProgram(this.prog);
    TEX_ORDER.forEach((name, k) => {
      gl.activeTexture(gl.TEXTURE0 + k);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[name]);
      gl.uniform1i(this.u(UNIFORM_SAMPLERS[name]), k);
    });
    const dpr = canvasW / cam.viewW;
    gl.uniform2f(this.u('uGrid'), w.W, w.H);
    gl.uniform2f(this.u('uCenter'), cam.cx, cam.cy);
    gl.uniform1f(this.u('uScale'), cam.scale * dpr);
    gl.uniform2f(this.u('uRes'), canvasW, canvasH);
    gl.uniform1f(this.u('uTime'), time);
    gl.uniform1f(this.u('uDoy'), w.doy / 360 + w.sub / (8 * 360));
    const ws = Math.min(1.5, w.weather.windSpeed / 8);
    gl.uniform2f(this.u('uWind'), Math.cos(w.weather.windDir) * ws, Math.sin(w.weather.windDir) * ws);
    gl.uniform1f(this.u('uOverlayMix'), opts.overlayMix);
    gl.uniform1f(this.u('uZoneMix'), opts.zoneMix);
    gl.uniform1f(this.u('uContours'), opts.contours ? 1 : 0);
    gl.uniform1f(this.u('uGridLines'), opts.gridLines ? 1 : 0);
    gl.uniform1f(this.u('uElevRange'), this.elevRange);
    gl.uniform1f(this.u('uNight'), opts.night ?? 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  get elevationRange(): [number, number] {
    return [this.elevMin, this.elevMin + this.elevRange];
  }
}
