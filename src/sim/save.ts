/**
 * Save files: a JSON header (all non-layer state, RNG states included) plus
 * the raw bytes of every typed-array layer. Loading reproduces the exact
 * simulation state, so a loaded game continues identically to one that was
 * never saved (tested).
 *
 * Layout: "FWD1" | u32 headerLength | header UTF-8 JSON | padding to 4 | layer bytes...
 */
import { Rng } from './rng.ts';
import { LAYER_SPECS, World } from './world.ts';
import { releaseOrphanFireCells } from './systems/fire.ts';
import type { LayerName, LayerType } from './world.ts';

export const SAVE_VERSION = 3;

const STATE_KEYS = [
  'day',
  'sub',
  'startYear',
  'lastYearStarted',
  'valleyName',
  'landmarks',
  'towns',
  'crews',
  'projects',
  'fires',
  'herds',
  'packs',
  'colonies',
  'towers',
  'camps',
  'roads',
  'reservoirCells',
  'reservoirLevel',
  'reservoirSilt',
  'reservoirTurbidity',
  'outletCell',
  'damCell',
  'weather',
  'climate',
  'economy',
  'factions',
  'policies',
  'stats',
  'review',
  'outcome',
  'chronicle',
  'notifications',
  'discoveries',
  'counters',
  'memory',
  'burning',
  'smokePresent',
] as const;

interface Header {
  magic: 'fireweed';
  version: number;
  savedAt: string;
  config: World['config'];
  rng: Record<string, [number, number, number, number]>;
  state: Record<string, unknown>;
  layers: Array<{ name: string; type: LayerType; offset: number; length: number }>;
}

const BYTES: Record<LayerType, number> = { f32: 4, i32: 4, u8: 1, i8: 1, u16: 2 };

export function encodeWorld(w: World): Uint8Array {
  // keep the fire list bounded: all active fires + the 400 most recent
  const fires = w.fires.length > 400 ? [...w.fires.filter((f) => f.active), ...w.fires.filter((f) => !f.active).slice(-400)] : w.fires;
  const state: Record<string, unknown> = {};
  for (const k of STATE_KEYS) state[k] = k === 'fires' ? fires : (w as unknown as Record<string, unknown>)[k];
  const rng: Header['rng'] = {};
  for (const [k, r] of Object.entries(w.rng)) rng[k] = (r as Rng).getState();
  const layers: Header['layers'] = [];
  let offset = 0;
  for (const [name, type] of Object.entries(LAYER_SPECS)) {
    const length = w.N * BYTES[type as LayerType];
    layers.push({ name, type: type as LayerType, offset, length });
    offset += length;
    offset = (offset + 3) & ~3;
  }
  const header: Header = { magic: 'fireweed', version: SAVE_VERSION, savedAt: new Date().toISOString(), config: w.config, rng, state, layers };
  const hjson = new TextEncoder().encode(JSON.stringify(header));
  const headLen = 8 + hjson.length;
  const dataStart = (headLen + 3) & ~3;
  const out = new Uint8Array(dataStart + offset);
  out.set([0x46, 0x57, 0x44, 0x31], 0); // FWD1
  new DataView(out.buffer).setUint32(4, hjson.length, true);
  out.set(hjson, 8);
  for (const l of layers) {
    const arr = w.L[l.name as LayerName];
    out.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), dataStart + l.offset);
  }
  return out;
}

export function readHeader(bytes: Uint8Array): Header {
  if (bytes[0] !== 0x46 || bytes[1] !== 0x57 || bytes[2] !== 0x44 || bytes[3] !== 0x31) throw new Error('Not a Fireweed save file.');
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len))) as Header;
  if (header.magic !== 'fireweed') throw new Error('Not a Fireweed save file.');
  if (header.version > SAVE_VERSION) throw new Error('This save comes from a newer version of Fireweed.');
  return header;
}

export function decodeWorld(bytes: Uint8Array): World {
  const header = readHeader(bytes);
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  const dataStart = (8 + len + 3) & ~3;
  const w = new World(header.config);
  for (const l of header.layers) {
    const target = w.L[l.name as LayerName];
    if (!target) continue; // a layer this version no longer has
    const src = bytes.subarray(dataStart + l.offset, dataStart + l.offset + l.length);
    new Uint8Array(target.buffer, target.byteOffset, target.byteLength).set(src.subarray(0, target.byteLength));
  }
  const ww = w as unknown as Record<string, unknown>;
  for (const k of STATE_KEYS) if (k in header.state) ww[k] = header.state[k];
  for (const [k, s] of Object.entries(header.rng)) (w.rng as unknown as Record<string, Rng>)[k] = Rng.fromState(s);
  // bump dirty counters so renderers re-upload everything
  for (const k of Object.keys(w.dirty) as Array<keyof World['dirty']>) w.dirty[k] = 1000 + w.dirty[k];
  // forward-compatible defaults
  if (w.policies.smokeRules === undefined) w.policies.smokeRules = false;
  // v1.0 saves can hold burned houses that were never released (fireproof forever): repair them
  releaseOrphanFireCells(w);
  return w;
}

/** Quick summary for save-slot listings without decoding layers. */
export function describeSave(bytes: Uint8Array): { valley: string; year: number; scenario: string; savedAt: string; trust: number } {
  const h = readHeader(bytes);
  const s = h.state as Record<string, unknown>;
  const day = s.day as number;
  return {
    valley: (s.valleyName as string) ?? 'Valley',
    year: 1 + Math.floor(day / 360),
    scenario: h.config.scenario,
    savedAt: h.savedAt,
    trust: 0,
  };
}

/** Deterministic digest of the full state (tests: save/load and replay equality). */
export function stateHash(w: World): string {
  let h1 = 0x811c9dc5 >>> 0,
    h2 = 0x1b873593 >>> 0;
  const mix = (b: number) => {
    h1 = Math.imul(h1 ^ b, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ b, 2246822519) >>> 0;
  };
  for (const name of Object.keys(LAYER_SPECS) as LayerName[]) {
    const a = w.L[name];
    const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < u8.length; i += 1) mix(u8[i]);
  }
  const json = JSON.stringify({
    d: w.day,
    s: w.sub,
    h: w.herds,
    p: w.packs,
    c: w.crews,
    f: w.fires.map((f) => [f.id, f.area, f.active]),
    e: w.economy.funds,
    fa: w.factions,
  });
  for (let i = 0; i < json.length; i++) mix(json.charCodeAt(i) & 255);
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).toUpperCase();
}
