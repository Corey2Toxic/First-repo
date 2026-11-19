import { DAYS_PER_YEAR, MONTH_NAMES, SEASON_NAMES } from '../sim/types.ts';
import type { World } from '../sim/world.ts';

/** The tenure year a day belongs to (as w.year counts them): files chronicle entries for the review and almanac. */
export function yearOfDay(w: World, day: number): number {
  return w.startYear + Math.floor(day / DAYS_PER_YEAR);
}

export function money(v: number): string {
  const s = v < 0 ? '−' : '';
  const a = Math.abs(v);
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${s}$${Math.round(a / 1e3)}k`;
  return `${s}$${Math.round(a)}`;
}

export function ha(v: number): string {
  if (v >= 10000) return `${(v / 1000).toFixed(1)}k ha`;
  return `${Math.round(v).toLocaleString()} ha`;
}

export function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function dateStr(w: World): string {
  const d = (w.doy % 30) + 1;
  return `${SEASON_NAMES[w.season]} · ${MONTH_NAMES[w.month]} ${d}`;
}

export function dayToDate(day: number): string {
  const y = Math.floor(day / 360) + 1;
  const doy = day % 360;
  return `Y${y} ${MONTH_NAMES[Math.floor(doy / 30)]}`;
}

export function hourStr(sub: number): string {
  const h = sub * 3;
  return `${String(h).padStart(2, '0')}:00`;
}

export const DANGER_COLORS = ['#4f9d55', '#b8b23d', '#e0a232', '#e5652f', '#c2263a'];

export function approvalColor(v: number): string {
  if (v >= 65) return '#6fbf73';
  if (v >= 45) return '#d8c24a';
  if (v >= 30) return '#e58a3a';
  return '#e2553f';
}

export function compass(rad: number): string {
  // windDir is the direction the wind blows TOWARD; report where it comes FROM
  const from = (rad + Math.PI) % (Math.PI * 2);
  const deg = ((from * 180) / Math.PI + 90 + 360) % 360; // map: +x east, +y south
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[Math.round(deg / 45) % 8];
}
