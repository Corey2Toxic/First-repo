/**
 * The weather forecast: it knows the true future (the weather has its own random stream), shows it
 * with skill that falls with lead time, and never changes the game.
 */
import { describe, expect, it } from 'vitest';
import { smallWorld } from '../helpers.ts';
import { Simulation, autoCloseReview } from '../../src/sim/sim.ts';
import { stateHash } from '../../src/sim/save.ts';
import { FORECAST_DAYS, SKILL, dangerClassFor, forecast, seasonOutlook, trueWeatherAhead } from '../../src/sim/forecast.ts';
import type { World } from '../../src/sim/world.ts';

function stepper(w: World) {
  const sim = new Simulation(w, {}, { autoReview: true, ignitions: false });
  return () => {
    if (w.review.pending) autoCloseReview(w, false);
    sim.tick();
  };
}

describe('weather forecast', () => {
  it('the future the forecaster sees is the future that happens, including across a year end', () => {
    const w = smallWorld('tinderbox', 'fc-truth');
    const step = stepper(w);
    let checks = 0;
    // before the first tick, mid-day, at midnight, just before and just after a year end
    for (const start of [0, 3, 8 * 100, 8 * 100 + 5, 8 * 357, 8 * 358 + 4, 8 * 365]) {
      while (w.day * 8 + w.sub < start) step();
      const h0 = stateHash(w);
      const truth = trueWeatherAhead(w, 5).map((t) => ({ day: t.day, wind: t.weather.windSpeed, rain: t.weather.precip, rh: t.weather.rh, event: t.weather.windEvent, storm: t.weather.storm, drought: t.droughtIndex }));
      forecast(w);
      seasonOutlook(w);
      // looking ahead changed nothing
      expect(stateHash(w)).toBe(h0);
      for (const t of truth) {
        while (w.day < t.day || w.sub === 0) step(); // until that day's weather has been drawn
        expect(w.weather.windSpeed).toBeCloseTo(t.wind, 9);
        expect(w.weather.precip).toBeCloseTo(t.rain, 9);
        expect(w.weather.rh).toBeCloseTo(t.rh, 9);
        expect(w.weather.windEvent).toBe(t.event);
        expect(w.weather.storm).toBe(t.storm);
        expect(w.climate.droughtIndex).toBeCloseTo(t.drought, 9);
        checks++;
      }
    }
    expect(checks).toBe(35);
  });

  it('is stable while the warden looks at it, and replays identically', () => {
    const a = smallWorld('firstseason', 'fc-stable');
    const b = smallWorld('firstseason', 'fc-stable');
    const sa = stepper(a),
      sb = stepper(b);
    for (let k = 0; k < 8 * 130 + 3; k++) {
      sa();
      sb();
    }
    const f1 = forecast(a),
      f2 = forecast(a),
      f3 = forecast(b);
    expect(f1.length).toBe(FORECAST_DAYS);
    expect(JSON.stringify(f2)).toBe(JSON.stringify(f1));
    expect(JSON.stringify(f3)).toBe(JSON.stringify(f1));
    expect(f1[0].day).toBe(a.day + 1);
    expect(f1.map((d) => d.lead)).toEqual([1, 2, 3, 4, 5]);
  });

  it('a wind-event warning verifies more often the nearer the day, and danger is forecast within a class', () => {
    const w = smallWorld('tinderbox', 'fc-skill');
    const sim = new Simulation(w, {}, { autoReview: true, ignitions: false });
    const hits = [0, 0, 0, 0, 0],
      warned = [0, 0, 0, 0, 0],
      missed = [0, 0, 0, 0, 0],
      events = [0, 0, 0, 0, 0],
      within = [0, 0, 0, 0, 0],
      n = [0, 0, 0, 0, 0];
    for (let d = 0; d < 12 * 360; d++) {
      sim.runDays(1);
      const month = Math.floor((w.day % 360) / 30);
      if (month < 3 || month > 8) continue;
      const fc = forecast(w);
      const tr = trueWeatherAhead(w, 5); // verified against what happens in the first test
      for (let k = 0; k < 5; k++) {
        n[k]++;
        if (Math.abs(fc[k].dangerClass - tr[k].dangerClass) <= 1) within[k]++;
        const said = fc[k].windEventChance >= 0.5;
        if (said) {
          warned[k]++;
          if (tr[k].weather.windEvent) hits[k]++;
        }
        if (tr[k].weather.windEvent) {
          events[k]++;
          if (!said) missed[k]++;
        }
      }
    }
    expect(events[0]).toBeGreaterThan(8);
    // tomorrow's warning is nearly always right and nearly never missed
    expect(hits[0] / warned[0]).toBeGreaterThan(0.9);
    expect(missed[0] / events[0]).toBeLessThan(0.15);
    // five days out the forecaster hedges: more false alarms, more misses
    expect(hits[4] / Math.max(1, warned[4])).toBeLessThan(hits[0] / warned[0]);
    expect(missed[4] / events[4]).toBeGreaterThan(missed[0] / events[0]);
    for (let k = 0; k < 5; k++) expect(within[k] / n[k]).toBeGreaterThan(0.9);
    expect(SKILL[0]).toBeGreaterThan(SKILL[4]);
  });

  it('the danger class follows the published rule and the seasonal outlook is one of three levels', () => {
    expect(dangerClassFor(0.3, 3, 0.1)).toBe(0);
    expect(dangerClassFor(0.05, 12, 0.5)).toBe(4);
    expect(dangerClassFor(0.12, 4, 0.2)).toBeGreaterThan(0);
    const w = smallWorld('tinderbox', 'fc-outlook');
    const step = stepper(w);
    for (let k = 0; k < 8 * 400; k++) step();
    const o = seasonOutlook(w);
    expect(['below', 'normal', 'above']).toContain(o.fireSeason);
    expect(o.text.length).toBeGreaterThan(20);
    expect(o.snowpack).toBeGreaterThan(0);
  });
});
