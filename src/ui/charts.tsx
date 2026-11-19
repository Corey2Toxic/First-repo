/**
 * Small canvas charts: multi-series lines and stacked bars.
 */
import { useEffect, useRef } from 'preact/hooks';

export interface Series {
  label: string;
  color: string;
  data: number[];
  dashed?: boolean;
}

export function LineChart(props: { series: Series[]; height?: number; min?: number; max?: number; xLabel?: (i: number) => string; yFmt?: (v: number) => string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth,
      H = props.height ?? 150;
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const n = Math.max(...props.series.map((s) => s.data.length), 2);
    let lo = props.min ?? Infinity,
      hi = props.max ?? -Infinity;
    if (props.min === undefined || props.max === undefined)
      for (const s of props.series)
        for (const v of s.data) {
          if (props.min === undefined) lo = Math.min(lo, v);
          if (props.max === undefined) hi = Math.max(hi, v);
        }
    if (!isFinite(lo) || !isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    if (hi - lo < 1e-9) hi = lo + 1;
    const pad = { l: 44, r: 8, t: 8, b: 18 };
    const x = (i: number) => pad.l + (i / (n - 1)) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
    ctx.strokeStyle = 'rgba(255,244,220,0.08)';
    ctx.fillStyle = 'rgba(239,232,214,0.55)';
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.lineWidth = 1;
    for (let k = 0; k <= 3; k++) {
      const v = lo + ((hi - lo) * k) / 3;
      const yy = y(v);
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(W - pad.r, yy);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(props.yFmt ? props.yFmt(v) : formatShort(v), pad.l - 6, yy + 3.5);
    }
    if (props.xLabel) {
      ctx.textAlign = 'center';
      const steps = Math.min(6, n - 1);
      for (let k = 0; k <= steps; k++) {
        const i = Math.round(((n - 1) * k) / steps);
        ctx.fillText(props.xLabel(i), x(i), H - 4);
      }
    }
    for (const s of props.series) {
      if (s.data.length < 2) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.8;
      ctx.setLineDash(s.dashed ? [4, 3] : []);
      ctx.beginPath();
      s.data.forEach((v, i) => {
        const xx = x(i + (n - s.data.length)),
          yy = y(v);
        if (i === 0) ctx.moveTo(xx, yy);
        else ctx.lineTo(xx, yy);
      });
      ctx.stroke();
    }
    ctx.setLineDash([]);
  });
  return (
    <div>
      <canvas ref={ref} class="chart" style={{ height: `${props.height ?? 150}px` }} />
      <div class="row" style={{ flexWrap: 'wrap', gap: '10px', marginTop: '4px' }}>
        {props.series.map((s) => (
          <span class="row" style={{ gap: '5px', fontSize: '11.5px' }} key={s.label}>
            <i class="swatch" style={{ background: s.color, width: '10px', height: '3px', border: 0 }} /> <span class="dim">{s.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function BarChart(props: { stacks: Array<{ label: string; color: string; data: number[] }>; height?: number; xLabel?: (i: number) => string; yFmt?: (v: number) => string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth,
      H = props.height ?? 140;
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const n = Math.max(...props.stacks.map((s) => s.data.length), 1);
    let hi = 1;
    for (let i = 0; i < n; i++) {
      let t = 0;
      for (const s of props.stacks) t += s.data[i] ?? 0;
      hi = Math.max(hi, t);
    }
    const pad = { l: 44, r: 8, t: 8, b: 18 };
    const bw = (W - pad.l - pad.r) / n;
    ctx.fillStyle = 'rgba(239,232,214,0.55)';
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (let k = 0; k <= 2; k++) {
      const v = (hi * k) / 2;
      const yy = pad.t + (1 - v / hi) * (H - pad.t - pad.b);
      ctx.fillText(props.yFmt ? props.yFmt(v) : formatShort(v), pad.l - 6, yy + 3.5);
      ctx.strokeStyle = 'rgba(255,244,220,0.08)';
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(W - pad.r, yy);
      ctx.stroke();
    }
    for (let i = 0; i < n; i++) {
      let acc = 0;
      for (const s of props.stacks) {
        const v = s.data[i] ?? 0;
        if (v <= 0) continue;
        const y0 = pad.t + (1 - (acc + v) / hi) * (H - pad.t - pad.b);
        const y1 = pad.t + (1 - acc / hi) * (H - pad.t - pad.b);
        ctx.fillStyle = s.color;
        ctx.fillRect(pad.l + i * bw + bw * 0.12, y0, Math.max(1, bw * 0.76), y1 - y0);
        acc += v;
      }
    }
    if (props.xLabel) {
      ctx.fillStyle = 'rgba(239,232,214,0.55)';
      ctx.textAlign = 'center';
      const step = Math.max(1, Math.ceil(n / 8));
      for (let i = 0; i < n; i += step) ctx.fillText(props.xLabel(i), pad.l + i * bw + bw / 2, H - 4);
    }
  });
  return (
    <div>
      <canvas ref={ref} class="chart" style={{ height: `${props.height ?? 140}px` }} />
      <div class="row" style={{ flexWrap: 'wrap', gap: '10px', marginTop: '4px' }}>
        {props.stacks.map((s) => (
          <span class="row" style={{ gap: '5px', fontSize: '11.5px' }} key={s.label}>
            <i class="swatch" style={{ background: s.color }} /> <span class="dim">{s.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function formatShort(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return Math.round(v / 1e3) + 'k';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  if (a >= 10) return Math.round(v).toString();
  return v.toFixed(a < 1 ? 2 : 1);
}
