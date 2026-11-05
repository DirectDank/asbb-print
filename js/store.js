// Saved projects live in IndexedDB on this device. Settings live in localStorage.
const DB_NAME = 'asbb-print';
const STORE = 'projects';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const projects = {
  all: () => tx('readonly', (s) => reqP(s.getAll())).then((list) =>
    list.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updated || 0) - (a.updated || 0))),
  get: (id) => tx('readonly', (s) => reqP(s.get(id))),
  put: (p) => { p.updated = Date.now(); return tx('readwrite', (s) => reqP(s.put(p))).then(() => p); },
  remove: (id) => tx('readwrite', (s) => reqP(s.delete(id))),
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- settings ----
const SETTINGS_KEY = 'asbb-print-settings';
export const DEFAULT_SETTINGS = {
  sizeId: '4x6',
  gapType: 'gap', // gap | bline | continuous
  gapMm: 3,
  density: 8,
  speed: '', // '' = printer default
  offsetXmm: 0,
  offsetYmm: 0,
  flip: false,
  invert: false,
  transport: '',
  customSizes: [],
  lastBackup: 0,
  savesSinceBackup: 0,
};

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
}

// ---- backup ----
const blobToB64 = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
const b64ToBlob = (u) => fetch(u).then((r) => r.blob());

async function encode(v) {
  if (v instanceof Blob) return { __blob: await blobToB64(v) };
  if (v instanceof Uint8Array) return { __u8: await blobToB64(new Blob([v])) };
  if (Array.isArray(v)) return Promise.all(v.map(encode));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = await encode(x);
    return o;
  }
  return v;
}

async function decode(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (v.__blob) return b64ToBlob(v.__blob);
    if (v.__u8) return new Uint8Array(await (await b64ToBlob(v.__u8)).arrayBuffer());
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = await decode(x);
    return o;
  }
  if (Array.isArray(v)) return Promise.all(v.map(decode));
  return v;
}

export async function exportBackup() {
  const list = await projects.all();
  const data = { app: 'ASBB Print', version: 1, exported: new Date().toISOString(), projects: await encode(list) };
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

export async function importBackup(file) {
  const data = JSON.parse(await file.text());
  if (data.app !== 'ASBB Print' || !Array.isArray(data.projects)) throw new Error('That file isn’t an ASBB Print backup.');
  const list = await decode(data.projects);
  for (const p of list) await tx('readwrite', (s) => reqP(s.put(p)));
  return list.length;
}
