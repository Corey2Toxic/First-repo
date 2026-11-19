/**
 * Save storage in the browser: gzip (CompressionStream) + IndexedDB, with a
 * localStorage fallback for the slot index, and file export/import.
 */
import { decodeWorld, describeSave, encodeWorld } from '../sim/save.ts';
import type { World } from '../sim/world.ts';

const DB = 'fireweed-saves';
const STORE = 'saves';

export interface SlotInfo {
  slot: string;
  valley: string;
  year: number;
  scenario: string;
  savedAt: string;
  bytes: number;
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return data;
  const cs = new CompressionStream('gzip');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  // raw (uncompressed) saves start with the FWD1 magic
  if (data[0] === 0x46 && data[1] === 0x57) return data;
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read compressed saves.');
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('No IndexedDB'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  const v = await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return v;
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function saveToSlot(w: World, slot: string): Promise<SlotInfo> {
  const raw = encodeWorld(w);
  const gz = await gzip(raw);
  const d = describeSave(raw);
  const info: SlotInfo = { slot, valley: d.valley, year: d.year, scenario: d.scenario, savedAt: d.savedAt, bytes: gz.length };
  await idbPut('slot:' + slot, gz);
  const index = await listSlots();
  const next = [info, ...index.filter((s) => s.slot !== slot)];
  await idbPut('index', next);
  return info;
}

export async function listSlots(): Promise<SlotInfo[]> {
  try {
    return (await idbGet<SlotInfo[]>('index')) ?? [];
  } catch {
    return [];
  }
}

export async function loadSlot(slot: string): Promise<World> {
  const gz = await idbGet<Uint8Array>('slot:' + slot);
  if (!gz) throw new Error('Save not found.');
  return decodeWorld(await gunzip(new Uint8Array(gz)));
}

export async function deleteSlot(slot: string): Promise<void> {
  await idbDelete('slot:' + slot);
  const index = await listSlots();
  await idbPut(
    'index',
    index.filter((s) => s.slot !== slot),
  );
}

export async function exportFile(w: World): Promise<void> {
  const gz = await gzip(encodeWorld(w));
  const blob = new Blob([gz as BlobPart], { type: 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${w.valleyName.replace(/\s+/g, '-').toLowerCase()}-year-${w.year}.fireweed`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export async function importFile(file: File): Promise<World> {
  const buf = new Uint8Array(await file.arrayBuffer());
  return decodeWorld(await gunzip(buf));
}

export function hasStorage(): boolean {
  return typeof indexedDB !== 'undefined';
}

/**
 * False when the page is embedded in a host that blocks script-started
 * downloads (the hosted single-file build sets this flag); saves still go to
 * the browser's own storage there.
 */
export function canDownload(): boolean {
  return !(globalThis as { FIREWEED_NO_DOWNLOADS?: boolean }).FIREWEED_NO_DOWNLOADS;
}
