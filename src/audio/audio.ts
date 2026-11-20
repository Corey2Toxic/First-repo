/**
 * Procedural ambience with WebAudio: wind (filtered noise following wind
 * speed), the crackle and roar of fire near the camera, rain, and birdsong
 * on spring and summer mornings. Everything is synthesized — no assets.
 */
import type { Camera } from '../render/camera.ts';
import type { World } from '../sim/world.ts';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private fireGain: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private crackleTimer = 0;
  private birdTimer = 0;
  private enabled = false;

  private init(): void {
    if (this.ctx || typeof AudioContext === 'undefined') return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02; // brown noise
      d[i] = last * 3.5;
    }
    const mk = () => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      src.start();
      return src;
    };
    // wind
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 400;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    mk().connect(this.windFilter).connect(this.windGain).connect(this.master);
    // fire roar
    const fireF = ctx.createBiquadFilter();
    fireF.type = 'bandpass';
    fireF.frequency.value = 180;
    fireF.Q.value = 0.6;
    this.fireGain = ctx.createGain();
    this.fireGain.gain.value = 0;
    mk().connect(fireF).connect(this.fireGain).connect(this.master);
    // rain hiss
    const white = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const wd = white.getChannelData(0);
    for (let i = 0; i < wd.length; i++) wd[i] = Math.random() * 2 - 1;
    const rs = ctx.createBufferSource();
    rs.buffer = white;
    rs.loop = true;
    rs.start();
    const rf = ctx.createBiquadFilter();
    rf.type = 'highpass';
    rf.frequency.value = 2500;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rs.connect(rf).connect(this.rainGain).connect(this.master);
  }

  resume(): void {
    if (!this.enabled) return;
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  stop(): void {
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
  }

  update(w: World, cam: Camera, speed: number, enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      if (this.master) this.master.gain.value = 0;
      return;
    }
    this.init();
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    this.master.gain.setTargetAtTime(speed === 0 ? 0.35 : 0.6, t, 0.3);
    const wind = Math.min(1, w.weather.windSpeed / 14);
    this.windGain!.gain.setTargetAtTime(0.05 + 0.35 * wind * wind, t, 0.6);
    this.windFilter!.frequency.setTargetAtTime(250 + 900 * wind, t, 0.6);
    this.rainGain!.gain.setTargetAtTime(w.weather.precip > 1 ? Math.min(0.12, w.weather.precip / 120) : 0, t, 0.8);
    // fire loudness from visible detected burning cells near the camera centre
    let near = 0;
    const hidden = new Set(w.fires.filter((f) => f.active && !f.detected).map((f) => f.id));
    const r = Math.max(8, 320 / cam.scale);
    for (const b of w.burning) {
      if (hidden.has(w.L.fid[b])) continue;
      const dx = (b % w.W) - cam.cx,
        dy = ((b / w.W) | 0) - cam.cy;
      if (dx * dx + dy * dy < r * r) near += Math.min(2, w.L.fint[b] * 0.5);
    }
    const zoomBoost = Math.min(1, cam.scale / 14);
    const fl = Math.min(1, near / 25) * zoomBoost;
    this.fireGain!.gain.setTargetAtTime(fl * 0.5, t, 0.4);
    if (fl > 0.05 && t > this.crackleTimer) {
      this.crackleTimer = t + 0.03 + Math.random() * (0.25 - fl * 0.2);
      this.crackle(fl);
    }
    const morning = w.sub >= 2 && w.sub <= 3;
    if ((w.season === 0 || w.season === 1) && morning && speed > 0 && speed <= 2 && t > this.birdTimer && w.burning.length === 0) {
      this.birdTimer = t + 1.5 + Math.random() * 4;
      this.bird();
    }
  }

  private crackle(level: number): void {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * 0.012);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 0.15 + 0.4 * level * Math.random();
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 900 + Math.random() * 2500;
    src.connect(f).connect(g).connect(this.master!);
    src.start();
  }

  private bird(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const notes = 2 + Math.floor(Math.random() * 4);
    const base = 2600 + Math.random() * 1800;
    for (let k = 0; k < notes; k++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      const st = t + k * (0.09 + Math.random() * 0.06);
      o.frequency.setValueAtTime(base * (1 + 0.15 * Math.sin(k * 1.7)), st);
      o.frequency.exponentialRampToValueAtTime(base * (0.75 + Math.random() * 0.5), st + 0.07);
      g.gain.setValueAtTime(0, st);
      g.gain.linearRampToValueAtTime(0.03, st + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, st + 0.08);
      o.connect(g).connect(this.master!);
      o.start(st);
      o.stop(st + 0.1);
    }
  }
}
