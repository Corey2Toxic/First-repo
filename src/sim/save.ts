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
import { POLICY_VALUES } from './commands.ts';
import { initStandAge } from './systems/vegetation.ts';
import { seedBeetles } from './systems/beetles.ts';
import type { LayerName, LayerType } from './world.ts';

/**
 * 4 (v1.1): command log saved; nested state merged over defaults on load, so fields added in later
 * versions get their defaults instead of `undefined`; invalid policies reset; orphaned fire cells
 * released. Version 3 (v1.0) saves load unchanged otherwise.
 */
export const SAVE_VERSION = 4;

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
  'commandLog',
] as const;

/** Object-valued state merged over the defaults of a fresh World on load. */
const MERGED_KEYS = new Set(['weather', 'climate', 'economy', 'policies', 'counters', 'memory', 'review', 'outcome']);

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
  // a save is a pure serialisation: the fire list is kept bounded by the simulation itself
  // (fire.ts pruneFires), so a reloaded world is identical to the live one (v1.0 trimmed here)
  const state: Record<string, unknown> = {};
  for (const k of STATE_KEYS) state[k] = (w as unknown as Record<string, unknown>)[k];
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
  for (const k of STATE_KEYS) {
    if (!(k in header.state)) continue;
    const v = header.state[k];
    // v1.0 replaced nested objects wholesale, so any field added later loaded as undefined (and ++ on
    // it gave NaN); merge saved values over the defaults instead
    if (MERGED_KEYS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) ww[k] = { ...(ww[k] as object), ...(v as object) };
    else ww[k] = v;
  }
  // imported files are not trusted: a policy value the game does not offer is reset to its default
  const defaults = new World(header.config).policies as unknown as Record<string, unknown>;
  const pol = w.policies as unknown as Record<string, unknown>;
  for (const key of Object.keys(pol)) {
    const allowed = (POLICY_VALUES as Record<string, ReadonlyArray<unknown>>)[key];
    if (!allowed) delete pol[key];
    else if (!allowed.includes(pol[key])) pol[key] = defaults[key];
  }
  for (const [k, s] of Object.entries(header.rng)) (w.rng as unknown as Record<string, Rng>)[k] = Rng.fromState(s);
  // bump dirty counters so renderers re-upload everything
  for (const k of Object.keys(w.dirty) as Array<keyof World['dirty']>) w.dirty[k] = 1000 + w.dirty[k];
  // v1.0 saves have no stand-age layer: derive it from the cohort ages, as generation does
  if (!header.layers.some((l) => l.name === 'standAge')) {
    initStandAge(w);
    seedBeetles(w); // and no endemic beetle population
  }
  // v1.0 saves can hold burned houses that were never released (fireproof forever): repair them
  releaseOrphanFireCells(w);
  // v1.0 did not count homes buried by debris flows in the valley total; every lost home is in
  // some town's lostStructures, so the total can be restored exactly
  const townLost = w.towns.reduce((a, t) => a + t.lostStructures, 0);
  if (townLost > w.counters.totalStructuresLost) w.counters.totalStructuresLost = townLost;
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
  // everything persisted that can steer the simulation (v1.0 hashed only part of it)
  const json = JSON.stringify({
    d: w.day,
    s: w.sub,
    h: w.herds,
    p: w.packs,
    c: w.crews,
    f: w.fires.map((f) => [f.id, f.area, f.active, f.response]),
    e: w.economy,
    fa: w.factions,
    t: w.towns,
    pr: w.projects,
    co: w.colonies,
    po: w.policies,
    cn: w.counters,
    r: Object.values(w.rng).map((x) => (x as Rng).getState()),
  });
  for (let i = 0; i < json.length; i++) mix(json.charCodeAt(i) & 255);
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).toUpperCase();
}
