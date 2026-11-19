import { describe, expect, it } from 'vitest';
import { hydrologyDaily } from '../../src/sim/systems/hydrology.ts';
import { quickflowArray } from '../../src/sim/systems/moisture.ts';
import { smallWorld } from '../helpers.ts';

describe('watershed', () => {
  it('a full reservoir passes surplus water down the river below the dam (D18)', () => {
    const w = smallWorld('firstseason', 'd18-probe');
    const L = w.L;
    const inRes = new Set(w.reservoirCells);
    let outlet = w.damCell;
    while (outlet >= 0 && inRes.has(outlet)) outlet = L.flowTo[outlet];
    expect(outlet).toBeGreaterThanOrEqual(0);
    // cells draining into the reservoir
    let catchment = 0;
    for (let i = 0; i < w.N; i++) {
      let c = i;
      for (let k = 0; k < 4000 && c >= 0 && !inRes.has(c); k++) c = L.flowTo[c];
      if (c >= 0 && inRes.has(c)) catchment++;
    }
    expect(catchment).toBeGreaterThan(w.N * 0.2);
    w.reservoirLevel = 1;
    const runoff = new Float32Array(w.N).fill(10);
    hydrologyDaily(w, runoff);
    // v1.0 deleted everything the full reservoir could not hold: the river below the dam carried only
    // its own local runoff
    expect(L.stream[outlet]).toBeGreaterThan(0.8 * 10 * catchment);
    expect(w.reservoirLevel).toBeCloseTo(1, 5);
  });

  it('a minimum release never drains storage below what the inflow supplies', () => {
    const w = smallWorld('firstseason', 'd18-dry');
    w.reservoirLevel = 0.5;
    w.weather.temp = 0; // no evaporation
    const cap = Math.max(1, w.reservoirCells.length) * 5000 * (1 - w.reservoirSilt);
    const demand = w.population * 0.22 * (w.season === 1 ? 1.4 : 1);
    const runoff = new Float32Array(w.N); // a dry day
    for (let d = 0; d < 10; d++) hydrologyDaily(w, runoff);
    // only the town's own use is drawn from storage; no release is taken from a dry river
    expect(w.reservoirLevel * cap).toBeCloseTo(0.5 * cap - 10 * demand, 0);
  });

  it('sediment keeps arriving past 85 % silt and trapping falls as capacity shrinks', () => {
    const w = smallWorld('firstseason', 'silt-probe');
    const L = w.L;
    w.reservoirSilt = 0.86;
    // a storm on a bare, burned valley
    w.reservoirLevel = 1;
    const runoff = new Float32Array(w.N).fill(5);
    quickflowArray(w).fill(5);
    for (let i = 0; i < w.N; i++) L.grass[i] = L.shrub[i] = L.aspen[i] = L.pine[i] = L.fir[i] = L.litter[i] = 0;
    hydrologyDaily(w, runoff);
    expect(w.reservoirSilt).toBeGreaterThan(0.86); // v1.0 stopped at 0.85 and deleted the rest
  });
});
