import { lzo1xCompress } from './lzo.js';

// Talking to the printer.
// The Phomemo PM-241-BT speaks TSPL. Over Bluetooth it uses Bluetooth Classic (a serial port, SPP),
// which Chrome on Android reaches through the Web Serial API. BLE and USB are offered as fallbacks.

export const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';
export const SPP_INSECURE = 'fa87c0d0-afac-11de-8a39-0800200c9a66';

const BLE_SERVICES = [
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '0000ae3a-0000-1000-8000-00805f9b34fb',
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
];

export const support = {
  serial: typeof navigator !== 'undefined' && 'serial' in navigator,
  ble: typeof navigator !== 'undefined' && 'bluetooth' in navigator,
  usb: typeof navigator !== 'undefined' && 'usb' in navigator,
};

// A short record of what happened over Bluetooth, shown in Settings so it can be copied and sent for help.
export const btLog = [];
const t0 = Date.now();
export function logBt(msg) {
  const at = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  // The same message again (like the printer's "ready" replies) adds a count instead of a new line.
  const last = btLog[btLog.length - 1];
  const m = last && /^(\S+) (.*?)(?: ×(\d+))?$/.exec(last);
  if (m && m[2] === msg) btLog[btLog.length - 1] = `${m[1]} ${msg} ×${(+m[3] || 1) + 1}`;
  else btLog.push(`${at} ${msg}`);
  if (btLog.length > 400) btLog.splice(0, btLog.length - 400);
  try { window.dispatchEvent(new Event('asbb-btlog')); } catch { /* not in a page */ }
}
const errText = (e) => (e && (e.name ? `${e.name}: ${e.message}` : e.message)) || String(e);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(what)), ms))]);

// The printer last chosen in the picker, so reopening the app goes back to that one printer and no other.
const REMEMBER = 'asbb-print-printer';
function remembered() {
  try { return JSON.parse(localStorage.getItem(REMEMBER) || 'null'); } catch { return null; }
}
function remember(t) {
  try { localStorage.setItem(REMEMBER, JSON.stringify({ kind: t.kind, id: t.device?.id || '', name: t.name })); } catch { /* not kept */ }
}

// ---------- transports ----------
class SerialTransport {
  constructor(port, label) { this.port = port; this.kind = 'serial'; this.name = label || 'Bluetooth printer'; this.writer = null; }
  static async request() {
    const port = await navigator.serial.requestPort({
      filters: [{ bluetoothServiceClassId: SPP_UUID }, { bluetoothServiceClassId: SPP_INSECURE }],
      allowedBluetoothServiceClassIds: [SPP_UUID, SPP_INSECURE],
    }).catch(async (e) => {
      // Older Chrome builds may not accept the Bluetooth filter; fall back to any port.
      if (e && e.name === 'TypeError') return navigator.serial.requestPort({ allowedBluetoothServiceClassIds: [SPP_UUID, SPP_INSECURE] });
      throw e;
    });
    const t = new SerialTransport(port, portName(port));
    await t.open();
    return t;
  }
  static async restore(want) {
    if (!support.serial || want?.kind !== 'serial') return null;
    const ports = await navigator.serial.getPorts();
    if (!ports.length) return null;
    const port = ports.find((p) => (p.getInfo().bluetoothServiceClassId || '').toLowerCase() === SPP_UUID) || ports[0];
    return new SerialTransport(port, portName(port));
  }
  async open() {
    if (this.port.writable) return;
    try {
      logBt('opening Bluetooth Classic');
      await this.port.open({ baudRate: 115200, bufferSize: 65536 });
      logBt('Bluetooth Classic open');
      this.listen();
    } catch (e) {
      logBt(`Bluetooth Classic wouldn't open: ${errText(e)}`);
      throw new Error('it wouldn’t connect over Bluetooth Classic. Tap the printer at the top, Disconnect, then Connect Bluetooth printer (Bluetooth LE) and pick it');
    }
  }
  // Log whatever the printer sends back (Labelife's printers answer 7E 01 7E for "got it", 7E 00 7E for "send again").
  async listen() {
    if (this.listening || !this.port.readable) return;
    this.listening = true;
    try {
      const reader = this.port.readable.getReader();
      this.reader = reader;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) logBt(`printer says: ${Array.from(value.slice(0, 40), (b) => b.toString(16).padStart(2, '0')).join(' ')}`);
      }
    } catch (e) {
      logBt(`stopped listening: ${errText(e)}`);
    } finally {
      this.listening = false;
    }
  }
  async write(data) {
    await this.open();
    logBt(`sending ${data.length} bytes over Bluetooth Classic`);
    const writer = this.port.writable.getWriter();
    try {
      const chunk = 8192;
      for (let i = 0; i < data.length; i += chunk) {
        await writer.ready;
        await writer.write(data.subarray(i, i + chunk));
      }
      await writer.ready;
      logBt(`all ${data.length} bytes sent over Bluetooth Classic`);
    } catch (e) {
      logBt(`Bluetooth Classic send failed: ${errText(e)}`);
      throw e;
    } finally {
      writer.releaseLock();
    }
  }
  async close() {
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { await this.port.close(); } catch { /* already closed */ }
    logBt('Bluetooth Classic closed');
  }
}

function portName(port) {
  try {
    const i = port.getInfo();
    if (i.bluetoothServiceClassId) return 'Bluetooth Classic printer';
    if (i.usbVendorId) return 'USB serial printer';
  } catch { /* ignore */ }
  return 'Printer';
}

class BleTransport {
  constructor(device) { this.device = device; this.kind = 'ble'; this.name = device.name || 'Bluetooth LE printer'; this.ch = null; }
  static async request() {
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
    const t = new BleTransport(device);
    await t.open();
    return t;
  }
  static async restore(want) {
    if (!support.ble || !navigator.bluetooth.getDevices) return null;
    const list = await navigator.bluetooth.getDevices().catch(() => []);
    // Only the printer chosen before (by its id, or its name), never just the first device Chrome remembers.
    const d = list.find((x) => want?.id && x.id === want.id) || list.find((x) => want?.name && x.name === want.name);
    return d ? new BleTransport(d) : null;
  }
  async open() {
    if (this.ch && this.device.gatt.connected) return;
    if (!this.watching) {
      this.watching = true;
      this.device.addEventListener('gattserverdisconnected', () => logBt('printer dropped the Bluetooth link'));
    }
    logBt(`connecting to ${this.name}`);
    const server = await this.device.gatt.connect();
    logBt('connected; looking for print channels');
    const services = await server.getPrimaryServices();
    logBt(`services: ${services.map((s) => s.uuid.slice(4, 8)).join(', ') || 'none'}`);
    // Known print channels first (Phomemo/Aimo use ff00/ff02, others ffe0/ffe1, ae30/ae01, 18f0/2af1...).
    const preferred = ['ff02', 'ffe1', 'ae01', '2af1', 'fec7', 'ae3b', 'ff03', '49535343-8841', 'bef8d6c9'];
    const found = [];
    const notify = [];
    for (const sv of services) {
      let chars = [];
      try { chars = await sv.getCharacteristics(); } catch (e) { logBt(`${sv.uuid.slice(4, 8)}: ${errText(e)}`); continue; }
      for (const c of chars) {
        const p = c.properties;
        const has = ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'].filter((k) => p[k]).join('+');
        logBt(`  ${sv.uuid.slice(4, 8)}/${c.uuid.slice(4, 8)} ${has}`);
        if (p.writeWithoutResponse || p.write) found.push(c);
        if (p.notify || p.indicate) notify.push(c);
      }
    }
    this.channels = found.map((c) => `${c.service.uuid.slice(4, 8)}/${c.uuid.slice(4, 8)}`);
    if (!found.length) throw new Error('Connected, but this printer has no Bluetooth LE print channel. Use \u201cBluetooth Classic\u201d instead.');
    const rank = (c) => { const i = preferred.findIndex((p) => c.uuid.includes(p)); return i < 0 ? 99 : i; };
    found.sort((a, b) => rank(a) - rank(b));
    this.found = found;
    this.pick = Math.min(this.pick ?? 0, found.length - 1);
    this.ch = found[this.pick];
    this.channel = `${this.ch.service.uuid.slice(4, 8)}/${this.ch.uuid.slice(4, 8)}`;
    this.credits = 0;
    this.creditMode = false;
    this.replies = 0;
    // Labelife listens on the printer's reply channel (ff01) before sending; some printers won't take data until
    // someone is listening, so switch replies on for every channel in the print service that offers them.
    for (const c of notify.filter((c) => c.service.uuid === this.ch.service.uuid)) {
      try {
        if (!c.listening) {
          c.addEventListener('characteristicvaluechanged', (ev) => {
            const v = new Uint8Array(ev.target.value.buffer);
            const text = Array.from(v, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : `<${b.toString(16).padStart(2, '0')}>`)).join('');
            if (!(v[0] === 1 && v.length === 2 && this.sending)) logBt(`printer says (${c.uuid.slice(4, 8)}): ${text.slice(0, 80)}`);
            this.replies = (this.replies || 0) + 1;
            // The printer's Bluetooth chip runs credit flow control: 01 n = "n more pieces welcome",
            // 02 lo hi = the biggest piece it takes. Sending exactly as fast as it asks is the quickest safe speed.
            if (v[0] === 1 && v.length === 2) { this.credits = (this.credits || 0) + v[1]; this.creditMode = true; }
            else if (v[0] === 2 && v.length === 3) this.maxPiece = Math.max(20, Math.min(240, v[1] | (v[2] << 8)) - 4);
            if (this.onReply) this.onReply();
          });
          c.listening = true;
        }
        await c.startNotifications();
        logBt(`listening on ${c.uuid.slice(4, 8)}`);
      } catch (e) {
        logBt(`couldn't listen on ${c.uuid.slice(4, 8)}: ${errText(e)}`);
      }
    }
    await sleep(300); // give the printer a moment after connecting before sending
    logBt(`using ${this.channel} (${this.ch.properties.write ? 'with' : 'without'} response)`);
  }
  async write(data) {
    await this.open();
    if (this.creditMode) return this.writeCredits(data);
    logBt(`sending ${data.length} bytes on ${this.channel}`);
    const sizes = [240, 180, 100, 60, 20];
    let size = this.size ?? 0;
    let withResp = this.withResp ?? !!this.ch.properties.write;
    let fails = 0;
    const RATE = 4; // bytes per millisecond, for printers without credit flow control
    const started = Date.now();
    let sent = 0;
    for (let i = 0; i < data.length; ) {
      const part = data.subarray(i, i + sizes[size]);
      try {
        if (withResp) await this.ch.writeValueWithResponse(part);
        else await this.ch.writeValueWithoutResponse(part);
        sent += part.length;
        const ahead = sent / RATE - (Date.now() - started);
        if (ahead > 0) await sleep(ahead);
        i += part.length;
        fails = 0;
      } catch (e) {
        logBt(`  piece at ${i} (${part.length} bytes) failed: ${errText(e)}; link ${this.device.gatt.connected ? 'still up' : 'dropped'}`);
        if (++fails > 14) throw e;
        if (size < sizes.length - 1) size++;
        else if (withResp && this.ch.properties.writeWithoutResponse) { withResp = false; size = 0; }
        else if (fails > 3) throw e;
        await sleep(300);
        if (!this.device.gatt.connected) { this.ch = null; await this.open(); }
      }
    }
    logBt(`all ${data.length} bytes sent in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    this.size = size;
    this.withResp = withResp;
  }
  // Credit flow control: send a piece only while the printer has said it has room, as fast as it frees room.
  async writeCredits(data) {
    const piece = this.maxPiece || 240;
    const fast = !!this.ch.properties.writeWithoutResponse;
    logBt(`sending ${data.length} bytes on ${this.channel} (${piece}-byte pieces, as fast as the printer asks)`);
    const started = Date.now();
    let waits = 0;
    this.sending = true;
    try {
      for (let i = 0; i < data.length; ) {
        if (!this.device.gatt.connected) throw new Error('the printer dropped the Bluetooth link');
        if ((this.credits || 0) <= 0) {
          const got = await this.waitReply(3000);
          if (!got && (this.credits || 0) <= 0) { waits++; this.credits = 1; } // no word for 3 s: try one piece anyway
          continue;
        }
        const part = data.subarray(i, i + piece);
        this.credits--;
        if (fast) await this.ch.writeValueWithoutResponse(part);
        else await this.ch.writeValueWithResponse(part);
        i += part.length;
      }
    } catch (e) {
      logBt(`sending failed: ${errText(e)}`);
      throw e;
    } finally {
      this.sending = false;
    }
    logBt(`all ${data.length} bytes sent in ${((Date.now() - started) / 1000).toFixed(1)}s${waits ? ` (${waits} long waits)` : ''}`);
  }
  waitReply(ms) {
    return new Promise((resolve) => {
      const seen = this.replies || 0;
      const timer = setTimeout(() => { this.onReply = null; resolve(false); }, ms);
      this.onReply = () => { if (this.replies > seen) { clearTimeout(timer); this.onReply = null; resolve(true); } };
    });
  }
  async close() { try { this.device.gatt.disconnect(); } catch { /* ignore */ } }
}

class UsbTransport {
  constructor(device) { this.device = device; this.kind = 'usb'; this.name = device.productName || 'USB printer'; this.ep = null; this.iface = null; }
  static async request() {
    const device = await navigator.usb.requestDevice({ filters: [{ classCode: 7 }] });
    const t = new UsbTransport(device);
    await t.open();
    return t;
  }
  static async restore() {
    if (!support.usb) return null;
    const list = await navigator.usb.getDevices();
    return list.length ? new UsbTransport(list[0]) : null;
  }
  async open() {
    if (this.ep && this.device.opened) return;
    if (!this.device.opened) await this.device.open();
    if (this.device.configuration === null) await this.device.selectConfiguration(1);
    for (const iface of this.device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        const out = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
        if (out) {
          await this.device.claimInterface(iface.interfaceNumber);
          this.iface = iface.interfaceNumber;
          this.ep = out.endpointNumber;
          return;
        }
      }
    }
    throw new Error('No USB print channel found on this device.');
  }
  async write(data) {
    await this.open();
    const chunk = 16384;
    for (let i = 0; i < data.length; i += chunk) await this.device.transferOut(this.ep, data.subarray(i, i + chunk));
  }
  async close() { try { await this.device.close(); } catch { /* ignore */ } }
}

const TRANSPORTS = { serial: SerialTransport, ble: BleTransport, usb: UsbTransport };

export class Printer {
  constructor() { this.t = null; this.listeners = new Set(); }
  get connected() { return !!this.t; }
  get name() { return this.t ? this.t.name : ''; }
  get kind() { return this.t ? this.t.kind : ''; }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }
  async connect(kind) {
    const T = TRANSPORTS[kind];
    if (!T) throw new Error('Unknown connection type');
    if (this.t) await this.t.close();
    this.t = await T.request();
    remember(this.t);
    this.emit();
    return this.t;
  }
  // Re-use the printer chosen before, without the picker. It only counts as connected once it has actually
  // answered: a printer that is off or out of range shows as not connected, rather than "connected" with prints
  // going nowhere (as happened after the 1.2.0 update reloaded the app).
  async restore() {
    const want = remembered();
    if (!want || !TRANSPORTS[want.kind]) return null;
    try {
      const t = await TRANSPORTS[want.kind].restore(want);
      if (!t) return null;
      await withTimeout(t.open(), 10000, 'The printer didn’t answer');
      this.t = t;
      this.emit();
      return t;
    } catch {
      return null;
    }
  }
  async disconnect() { if (this.t) await this.t.close(); this.t = null; this.emit(); }
  async send(bytes) {
    if (!this.t) throw new Error('No printer connected');
    try {
      await this.t.write(bytes);
    } catch (e) {
      logBt(`print failed: ${errText(e)}; trying once more`);
      // One reconnect attempt (printer may have slept). If that fails too, it shows as not connected, so the next
      // press of Print asks for it to be connected again rather than trying a dead link.
      try { await this.t.close(); } catch { /* ignore */ }
      await sleep(400);
      try {
        await this.t.write(bytes);
      } catch (e2) {
        this.t = null;
        this.emit();
        throw new Error(`the printer didn’t answer (${(e2 && e2.message) || e2}). Tap Connect printer and choose it again`);
      }
    }
  }
}

// ---------- TSPL ----------
// Byte layout follows what Labelife sends to the PM-241 family ("tspl-c1"): a leading CRLF, then
// DENSITY / SPEED / REFERENCE / OFFSET / SIZE / GAP / DIRECTION / CLS, a BITMAP in mode 3
// (LZO-compressed, 1 = black dot), and PRINT 1,<copies>. One full job per page.
// pages: array of { mono: {w,h,wb,bits}, copies? }  opts: printer settings + label size in mm
export function buildTspl(pages, opts) {
  const enc = new TextEncoder();
  const parts = [];
  const txt = (s) => parts.push(enc.encode(s));
  const mm2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
  const plain = opts.format !== 'lzo';
  for (const p of pages) {
    const m = p.mono;
    txt('\r\n');
    txt(`DENSITY ${Math.max(0, Math.min(15, Math.round(opts.density ?? 8)))}\r\n`);
    if (opts.speed) txt(`SPEED ${opts.speed}\r\n`);
    txt('REFERENCE 0,0\r\n');
    txt('OFFSET 0 mm\r\n');
    if (opts.offsetYmm) txt(`SHIFT ${Math.round((opts.offsetYmm / 25.4) * 203)}\r\n`);
    txt(`SIZE ${Math.max(1, Math.round(opts.wMm))} mm,${Math.max(1, Math.round(opts.hMm))} mm\r\n`);
    if (opts.gapType === 'continuous') txt('GAP 0.00 mm,0.00 mm\r\n');
    else if (opts.gapType === 'bline') txt(`BLINE ${mm2(opts.gapMm)} mm,0.00 mm\r\n`);
    else txt(`GAP ${mm2(opts.gapMm)} mm,0.00 mm\r\n`);
    txt(`DIRECTION ${opts.flip ? 1 : 0},0\r\n`);
    txt('CLS\r\n');
    // Shift right by padding blank columns on the left.
    const xOff = Math.max(0, Math.round(((opts.offsetXmm || 0) / 25.4) * 203));
    const raster = shiftRaster(m, xOff);
    // Phomemo firmware: bit 1 = black. Standard TSPL: bit 0 = black. "invert" flips whichever is in use.
    const blackIsOne = plain ? !!opts.invert : !opts.invert;
    let data = raster.bits;
    if (!blackIsOne) {
      data = new Uint8Array(raster.bits.length);
      for (let i = 0; i < data.length; i++) data[i] = ~raster.bits[i] & 0xff;
      const padBits = raster.wb * 8 - raster.w;
      if (padBits) { const mask = (1 << padBits) - 1; for (let y = 0; y < raster.h; y++) data[y * raster.wb + raster.wb - 1] |= mask; }
    }
    if (plain) {
      txt(`BITMAP 0,0,${raster.wb},${raster.h},0,`);
      parts.push(data);
    } else {
      const z = lzo1xCompress(data);
      txt(`BITMAP 0,0,${raster.wb},${raster.h},3,${z.length},`);
      parts.push(z);
    }
    txt('\r\n');
    txt(`PRINT 1,${Math.max(1, p.copies || 1)}\r\n`);
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function shiftRaster(m, xOff) {
  if (!xOff) return m;
  const w = m.w + xOff, wb = Math.ceil(w / 8);
  const bits = new Uint8Array(wb * m.h);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
    if (m.bits[y * m.wb + (x >> 3)] & (0x80 >> (x & 7))) { const nx = x + xOff; bits[y * wb + (nx >> 3)] |= 0x80 >> (nx & 7); }
  }
  return { w, h: m.h, wb, bits };
}

// A feed-only command so the printer can find the next gap (handy after loading new labels).
export function buildFeed(opts) {
  const enc = new TextEncoder();
  const mm2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
  return enc.encode(`\r\nSIZE ${Math.round(opts.wMm)} mm,${Math.round(opts.hMm)} mm\r\nGAP ${mm2(opts.gapMm)} mm,0.00 mm\r\nFORMFEED\r\n`);
}
