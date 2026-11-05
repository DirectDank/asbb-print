// Talking to the printer.
// The Phomemo PM-241-BT speaks TSPL. Over Bluetooth it uses Bluetooth Classic (a serial port, SPP),
// which Chrome on Android reaches through the Web Serial API. BLE and USB are offered as fallbacks.

export const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- transports ----------
class SerialTransport {
  constructor(port, label) { this.port = port; this.kind = 'serial'; this.name = label || 'Bluetooth printer'; this.writer = null; }
  static async request() {
    const port = await navigator.serial.requestPort({
      filters: [{ bluetoothServiceClassId: SPP_UUID }],
      allowedBluetoothServiceClassIds: [SPP_UUID],
    }).catch(async (e) => {
      // Older Chrome builds may not accept the Bluetooth filter; fall back to any port.
      if (e && e.name === 'TypeError') return navigator.serial.requestPort({ allowedBluetoothServiceClassIds: [SPP_UUID] });
      throw e;
    });
    const t = new SerialTransport(port, portName(port));
    await t.open();
    return t;
  }
  static async restore() {
    if (!support.serial) return null;
    const ports = await navigator.serial.getPorts();
    if (!ports.length) return null;
    const port = ports.find((p) => (p.getInfo().bluetoothServiceClassId || '').toLowerCase() === SPP_UUID) || ports[0];
    return new SerialTransport(port, portName(port));
  }
  async open() {
    if (this.port.writable) return;
    await this.port.open({ baudRate: 115200, bufferSize: 65536 });
  }
  async write(data) {
    await this.open();
    const writer = this.port.writable.getWriter();
    try {
      const chunk = 8192;
      for (let i = 0; i < data.length; i += chunk) {
        await writer.ready;
        await writer.write(data.subarray(i, i + chunk));
      }
      await writer.ready;
    } finally {
      writer.releaseLock();
    }
  }
  async close() { try { await this.port.close(); } catch { /* already closed */ } }
}

function portName(port) {
  try {
    const i = port.getInfo();
    if (i.bluetoothServiceClassId) return 'Bluetooth printer';
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
  static async restore() {
    if (!support.ble || !navigator.bluetooth.getDevices) return null;
    const list = await navigator.bluetooth.getDevices().catch(() => []);
    return list.length ? new BleTransport(list[0]) : null;
  }
  async open() {
    if (this.ch && this.device.gatt.connected) return;
    const server = await this.device.gatt.connect();
    const services = await server.getPrimaryServices();
    for (const s of services) {
      let chars = [];
      try { chars = await s.getCharacteristics(); } catch { continue; }
      const c = chars.find((x) => x.properties.writeWithoutResponse) || chars.find((x) => x.properties.write);
      if (c) { this.ch = c; return; }
    }
    throw new Error('Connected, but this printer has no Bluetooth LE print channel. Use “Bluetooth” instead.');
  }
  async write(data) {
    await this.open();
    const chunk = 180;
    const noResp = this.ch.properties.writeWithoutResponse;
    for (let i = 0; i < data.length; i += chunk) {
      const part = data.subarray(i, i + chunk);
      if (noResp) {
        await this.ch.writeValueWithoutResponse(part);
        if ((i / chunk) % 20 === 19) await sleep(15);
      } else {
        await this.ch.writeValueWithResponse(part);
      }
    }
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
    this.emit();
    return this.t;
  }
  // Re-use a printer chosen before, without the picker (best effort).
  async restore(kind) {
    const order = kind ? [kind, ...Object.keys(TRANSPORTS).filter((k) => k !== kind)] : Object.keys(TRANSPORTS);
    for (const k of order) {
      try {
        const t = await TRANSPORTS[k].restore();
        if (t) { this.t = t; this.emit(); return t; }
      } catch { /* try next */ }
    }
    return null;
  }
  async disconnect() { if (this.t) await this.t.close(); this.t = null; this.emit(); }
  async send(bytes) {
    if (!this.t) throw new Error('No printer connected');
    try {
      await this.t.write(bytes);
    } catch (e) {
      // One reconnect attempt (printer may have slept).
      try { await this.t.close(); } catch { /* ignore */ }
      await sleep(400);
      await this.t.write(bytes);
    }
  }
}

// ---------- TSPL ----------
// pages: array of { mono: {w,h,wb,bits}, copies? }  opts: printer settings + label size in mm
export function buildTspl(pages, opts) {
  const enc = new TextEncoder();
  const parts = [];
  const line = (s) => parts.push(enc.encode(s + '\r\n'));
  const fmt = (n) => (Math.round(n * 10) / 10).toString();
  line(`SIZE ${fmt(opts.wMm)} mm,${fmt(opts.hMm)} mm`);
  if (opts.gapType === 'continuous') line('GAP 0 mm,0 mm');
  else if (opts.gapType === 'bline') line(`BLINE ${fmt(opts.gapMm)} mm,0 mm`);
  else line(`GAP ${fmt(opts.gapMm)} mm,0 mm`);
  line(`DIRECTION ${opts.flip ? 1 : 0},0`);
  line('REFERENCE 0,0');
  if (opts.offsetYmm) line(`SHIFT ${Math.round((opts.offsetYmm / 25.4) * 203)}`);
  line(`DENSITY ${Math.max(0, Math.min(15, Math.round(opts.density ?? 8)))}`);
  if (opts.speed) line(`SPEED ${opts.speed}`);
  line('SET TEAR ON');
  const xOff = Math.max(0, Math.round(((opts.offsetXmm || 0) / 25.4) * 203));
  for (const p of pages) {
    const m = p.mono;
    line('CLS');
    // TSPL bitmaps: a 0 bit prints a black dot, a 1 bit stays white. Our packed data uses 1 = black, so invert
    // unless the "invert" setting says this printer works the other way.
    const data = new Uint8Array(m.bits.length);
    if (opts.invert) data.set(m.bits);
    else for (let i = 0; i < data.length; i++) data[i] = ~m.bits[i] & 0xff;
    // pad bits past the image width must be white
    const padBits = m.wb * 8 - m.w;
    if (padBits && !opts.invert) {
      const mask = (1 << padBits) - 1;
      for (let y = 0; y < m.h; y++) data[y * m.wb + m.wb - 1] |= mask;
    }
    parts.push(enc.encode(`BITMAP ${xOff},0,${m.wb},${m.h},0,`));
    parts.push(data);
    parts.push(enc.encode('\r\n'));
    line(`PRINT ${Math.max(1, p.copies || 1)},1`);
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// A feed-only command so the printer can find the next gap (handy after loading new labels).
export function buildFeed(opts) {
  const enc = new TextEncoder();
  const fmt = (n) => (Math.round(n * 10) / 10).toString();
  return enc.encode(`SIZE ${fmt(opts.wMm)} mm,${fmt(opts.hMm)} mm\r\nGAP ${fmt(opts.gapMm)} mm,0 mm\r\nFORMFEED\r\n`);
}
