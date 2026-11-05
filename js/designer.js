// Label designer: the design model, rendering to printer dots, and the on-screen editor.
import { makeCanvas, loadImage, ditherCanvas } from './image.js';

export const FONTS = [
  { id: 'Poppins', css: 'Poppins, Arial, sans-serif', name: 'Poppins' },
  { id: 'sans', css: 'Arial, Helvetica, sans-serif', name: 'Arial' },
  { id: 'condensed', css: '"Arial Narrow", "Roboto Condensed", sans-serif-condensed, Arial, sans-serif', name: 'Narrow' },
  { id: 'serif', css: 'Georgia, "Times New Roman", serif', name: 'Serif' },
  { id: 'mono', css: '"Courier New", ui-monospace, monospace', name: 'Typewriter' },
  { id: 'impact', css: 'Impact, "Arial Black", sans-serif', name: 'Impact' },
];
const fontCss = (id) => (FONTS.find((f) => f.id === id) || FONTS[0]).css;

let nextId = 1;
export const elId = () => 'e' + Date.now().toString(36) + (nextId++);

export function newElement(type, design) {
  const W = design.w, H = design.h;
  const base = { id: elId(), type, rot: 0 };
  switch (type) {
    case 'text': return { ...base, x: W * 0.08, y: H * 0.4, w: W * 0.84, h: H * 0.12, text: 'Your text', size: Math.round(H * 0.06), bold: true, italic: false, font: 'Poppins', align: 'center', valign: 'middle', fit: true, invert: false };
    case 'qr': { const s = Math.min(W, H) * 0.4; return { ...base, x: (W - s) / 2, y: (H - s) / 2, w: s, h: s, value: 'https://allsortsbyben.co.uk' }; }
    case 'barcode': return { ...base, x: W * 0.1, y: H * 0.4, w: W * 0.8, h: H * 0.18, value: '123456789012', format: 'CODE128', showText: true };
    case 'rect': return { ...base, x: W * 0.05, y: H * 0.05, w: W * 0.9, h: H * 0.9, fill: false, thick: 6 };
    case 'line': return { ...base, x: W * 0.08, y: H * 0.5, w: W * 0.84, h: 6, thick: 6 };
    case 'image': return { ...base, x: W * 0.1, y: H * 0.1, w: W * 0.8, h: H * 0.35, src: '', dither: true };
    default: return base;
  }
}

export function merge(str, row, n) {
  return String(str ?? '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, key) => {
    if (key.toLowerCase() === 'n') return String(n ?? 1);
    if (row && Object.prototype.hasOwnProperty.call(row, key)) return row[key];
    if (row) {
      const k = Object.keys(row).find((x) => x.toLowerCase() === key.toLowerCase());
      if (k) return row[k];
    }
    return m;
  });
}

const imgCache = new Map();
async function getImg(src) {
  if (!src) return null;
  if (!imgCache.has(src)) imgCache.set(src, loadImage(src).catch(() => null));
  return imgCache.get(src);
}

export async function preloadFonts(design) {
  if (!document.fonts) return;
  const loads = [];
  for (const el of design.elements) {
    if (el.type === 'text') loads.push(document.fonts.load(`${el.italic ? 'italic ' : ''}${el.bold ? 700 : 400} 40px ${fontCss(el.font)}`).catch(() => {}));
  }
  await Promise.all(loads);
}

// Render a design to a canvas the size of the label in printer dots.
export async function renderDesign(design, { row = null, n = 1, selected = null, guides = false } = {}) {
  await preloadFonts(design);
  const c = makeCanvas(design.w, design.h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  for (const el of design.elements) {
    ctx.save();
    const sideways = el.rot === 90 || el.rot === 270;
    const bw = sideways ? el.h : el.w;
    const bh = sideways ? el.w : el.h;
    ctx.translate(el.x + el.w / 2, el.y + el.h / 2);
    ctx.rotate(((el.rot || 0) * Math.PI) / 180);
    ctx.translate(-bw / 2, -bh / 2);
    try { await drawElement(ctx, el, bw, bh, row, n); } catch (e) { console.warn('draw failed', e); }
    ctx.restore();
  }
  if (guides && selected) {
    const el = design.elements.find((e) => e.id === selected);
    if (el) {
      ctx.save();
      ctx.strokeStyle = '#ff2bd6';
      ctx.lineWidth = Math.max(2, design.w / 300);
      ctx.setLineDash([10, 8]);
      ctx.strokeRect(el.x, el.y, el.w, el.h);
      ctx.restore();
    }
  }
  return c;
}

async function drawElement(ctx, el, w, h, row, n) {
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
  switch (el.type) {
    case 'text': return drawText(ctx, el, w, h, merge(el.text, row, n));
    case 'rect':
      if (el.fill) ctx.fillRect(0, 0, w, h);
      else { const t = el.thick || 4; ctx.lineWidth = t; ctx.strokeRect(t / 2, t / 2, w - t, h - t); }
      return;
    case 'line': {
      const t = el.thick || 4;
      if (w >= h) ctx.fillRect(0, h / 2 - t / 2, w, t);
      else ctx.fillRect(w / 2 - t / 2, 0, t, h);
      return;
    }
    case 'image': {
      const img = await getImg(el.src);
      if (!img) { ctx.strokeStyle = '#999'; ctx.setLineDash([8, 8]); ctx.strokeRect(0, 0, w, h); return; }
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      const s = Math.min(w / iw, h / ih);
      const dw = iw * s, dh = ih * s;
      const tmp = makeCanvas(dw, dh);
      const t = tmp.getContext('2d');
      t.fillStyle = '#fff';
      t.fillRect(0, 0, tmp.width, tmp.height);
      t.imageSmoothingQuality = 'high';
      t.drawImage(img, 0, 0, tmp.width, tmp.height);
      if (el.dither) ditherCanvas(tmp);
      ctx.drawImage(tmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
      return;
    }
    case 'qr': return drawQr(ctx, merge(el.value, row, n), w, h);
    case 'barcode': return drawBarcode(ctx, el, merge(el.value, row, n), w, h);
    default:
  }
}

function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const wd of words) {
      const test = line + wd;
      if (ctx.measureText(test).width > maxW && line.trim()) {
        out.push(line.trimEnd());
        line = wd.trimStart();
        // very long single word: break by characters
        while (ctx.measureText(line).width > maxW && line.length > 1) {
          let i = line.length;
          while (i > 1 && ctx.measureText(line.slice(0, i)).width > maxW) i--;
          out.push(line.slice(0, i));
          line = line.slice(i);
        }
      } else line = test;
    }
    out.push(line.trimEnd());
  }
  return out;
}

function drawText(ctx, el, w, h, text) {
  const pad = el.invert ? Math.max(6, h * 0.08) : 0;
  const iw = w - 2 * pad, ih = h - 2 * pad;
  let size = Math.max(6, el.size || 40);
  const setFont = (s) => { ctx.font = `${el.italic ? 'italic ' : ''}${el.bold ? 700 : 400} ${s}px ${fontCss(el.font)}`; };
  let lines;
  const lh = 1.15;
  for (let guard = 0; guard < 80; guard++) {
    setFont(size);
    lines = wrapLines(ctx, text, iw);
    if (!el.fit || (lines.length * size * lh <= ih && lines.every((l) => ctx.measureText(l).width <= iw)) || size <= 6) break;
    size = Math.max(6, Math.floor(size * 0.92));
  }
  if (el.invert) { ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#fff'; }
  ctx.textBaseline = 'middle';
  ctx.textAlign = el.align === 'left' ? 'left' : el.align === 'right' ? 'right' : 'center';
  const total = lines.length * size * lh;
  let y = pad + (el.valign === 'top' ? 0 : el.valign === 'bottom' ? ih - total : (ih - total) / 2) + (size * lh) / 2;
  const x = el.align === 'left' ? pad : el.align === 'right' ? w - pad : w / 2;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
  for (const l of lines) { ctx.fillText(l, x, y); y += size * lh; }
  ctx.restore();
}

function drawQr(ctx, value, w, h) {
  const qrcode = window.qrcode;
  if (!qrcode || !value) return;
  const q = qrcode(0, 'M');
  q.addData(value);
  q.make();
  const count = q.getModuleCount();
  const side = Math.min(w, h);
  const cell = Math.max(1, Math.floor(side / count));
  const real = cell * count;
  const ox = Math.round((w - real) / 2), oy = Math.round((h - real) / 2);
  ctx.fillStyle = '#000';
  for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (q.isDark(r, c)) ctx.fillRect(ox + c * cell, oy + r * cell, cell, cell);
}

function drawBarcode(ctx, el, value, w, h) {
  if (!window.JsBarcode || !value) return;
  const tmp = document.createElement('canvas');
  try {
    window.JsBarcode(tmp, value, { format: el.format || 'CODE128', displayValue: !!el.showText, margin: 0, width: 4, height: 200, fontSize: 40, textMargin: 6, background: 'rgba(0,0,0,0)', lineColor: '#000000' });
  } catch {
    ctx.font = `bold ${Math.round(h * 0.18)}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Barcode value doesn’t suit this type', w / 2, h / 2, w);
    return;
  }
  // keep bars crisp: scale to an integer bar width where possible
  ctx.imageSmoothingEnabled = false;
  const unit = tmp.width / 4; // modules
  const bar = Math.max(1, Math.floor(w / unit));
  const dw = Math.min(w, unit * bar >= w * 0.6 ? unit * bar : w);
  ctx.drawImage(tmp, (w - dw) / 2, 0, dw, h);
  ctx.imageSmoothingEnabled = true;
}

// ---------- on-screen editor ----------
export class Editor {
  constructor(canvasEl, onChange) {
    this.cv = canvasEl;
    this.onChange = onChange;
    this.design = null;
    this.selected = null;
    this.drag = null;
    this.pending = false;
    canvasEl.addEventListener('pointerdown', (e) => this.down(e));
    canvasEl.addEventListener('pointermove', (e) => this.move(e));
    canvasEl.addEventListener('pointerup', (e) => this.up(e));
    canvasEl.addEventListener('pointercancel', (e) => this.up(e));
  }
  load(design) { this.design = design; this.selected = null; this.draw(); }
  scale() { return this.cv.width / this.design.w; }
  pt(e) {
    const r = this.cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * this.design.w, y: ((e.clientY - r.top) / r.height) * this.design.h };
  }
  hit(p) {
    const els = this.design.elements;
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i];
      const slop = this.design.w * 0.015;
      if (p.x >= el.x - slop && p.x <= el.x + el.w + slop && p.y >= el.y - slop && p.y <= el.y + el.h + slop) return el;
    }
    return null;
  }
  handleAt(p) {
    const el = this.sel();
    if (!el) return false;
    const r = this.design.w * 0.05;
    return Math.hypot(p.x - (el.x + el.w), p.y - (el.y + el.h)) < r;
  }
  sel() { return this.design && this.design.elements.find((e) => e.id === this.selected) || null; }
  select(id) { this.selected = id; this.draw(); this.onChange('select'); }
  down(e) {
    if (!this.design) return;
    const p = this.pt(e);
    if (this.handleAt(p)) {
      const el = this.sel();
      this.drag = { mode: 'resize', el, sx: p.x, sy: p.y, ow: el.w, oh: el.h };
    } else {
      const el = this.hit(p);
      if (el) {
        if (el.id !== this.selected) this.select(el.id);
        this.drag = { mode: 'move', el, sx: p.x, sy: p.y, ox: el.x, oy: el.y };
      } else { this.select(null); return; }
    }
    this.cv.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  move(e) {
    if (!this.drag) return;
    const p = this.pt(e);
    const d = this.drag, el = d.el, W = this.design.w, H = this.design.h;
    const snap = (v, targets) => { for (const t of targets) if (Math.abs(v - t) < W * 0.012) return t; return v; };
    if (d.mode === 'move') {
      let x = d.ox + (p.x - d.sx), y = d.oy + (p.y - d.sy);
      const cx = snap(x + el.w / 2, [W / 2]); x = cx - el.w / 2;
      const cy = snap(y + el.h / 2, [H / 2]); y = cy - el.h / 2;
      el.x = Math.round(Math.max(-el.w * 0.9, Math.min(W - el.w * 0.1, x)));
      el.y = Math.round(Math.max(-el.h * 0.9, Math.min(H - el.h * 0.1, y)));
    } else {
      let nw = Math.max(16, d.ow + (p.x - d.sx));
      let nh = Math.max(4, d.oh + (p.y - d.sy));
      if (el.type === 'qr') nw = nh = Math.max(nw, nh);
      if (el.type === 'line') { if (d.ow >= d.oh) nh = d.oh; else nw = d.ow; }
      el.w = Math.round(nw); el.h = Math.round(nh);
    }
    this.draw();
    e.preventDefault();
  }
  up() {
    if (this.drag) { this.drag = null; this.onChange('edit'); }
  }
  async draw() {
    if (!this.design) return;
    if (this.pending) { this.again = true; return; }
    this.pending = true;
    const c = await renderDesign(this.design, { selected: this.selected, guides: true, row: this.design.data?.rows?.[0] || null, n: this.design.data?.serialStart || 1 });
    const ctx = this.cv.getContext('2d');
    if (this.cv.width !== this.design.w || this.cv.height !== this.design.h) { this.cv.width = this.design.w; this.cv.height = this.design.h; }
    ctx.drawImage(c, 0, 0);
    const el = this.sel();
    if (el) {
      const r = this.design.w * 0.028;
      ctx.fillStyle = '#ff2bd6';
      ctx.beginPath(); ctx.arc(el.x + el.w, el.y + el.h, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(el.x + el.w, el.y + el.h, r * 0.4, 0, Math.PI * 2); ctx.fill();
    }
    this.pending = false;
    if (this.again) { this.again = false; this.draw(); }
  }
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);
  if (!rows.length) return { columns: [], rows: [] };
  const columns = rows[0].map((c, i) => c.trim() || `Column ${i + 1}`);
  return { columns, rows: rows.slice(1).map((r) => Object.fromEntries(columns.map((c, i) => [c, (r[i] ?? '').trim()]))) };
}

// The built-in packing slip, made to match the shop's order insert.
export function packingSlipDesign(dots, sizeId) {
  const W = dots.w, H = dots.h;
  const u = (f) => Math.round(f * H);
  return {
    sizeId, w: W, h: H,
    elements: [
      { id: elId(), type: 'image', rot: 0, x: Math.round(W * 0.14), y: u(0.045), w: Math.round(W * 0.72), h: u(0.19), src: 'img/asbb-logo-mono.png', dither: false },
      { id: elId(), type: 'text', rot: 0, x: Math.round(W * 0.06), y: u(0.27), w: Math.round(W * 0.88), h: u(0.09), text: 'Thank you for your order!', size: u(0.05), bold: true, italic: false, font: 'Poppins', align: 'center', valign: 'middle', fit: true, invert: false },
      { id: elId(), type: 'text', rot: 0, x: Math.round(W * 0.08), y: u(0.37), w: Math.round(W * 0.84), h: u(0.11), text: 'We hope you love it. If anything isn’t right, message us and we’ll sort it.', size: u(0.028), bold: false, italic: false, font: 'Poppins', align: 'center', valign: 'middle', fit: true, invert: false },
      { id: elId(), type: 'qr', rot: 0, x: Math.round((W - u(0.24)) / 2), y: u(0.51), w: u(0.24), h: u(0.24), value: 'https://allsortsbyben.co.uk' },
      { id: elId(), type: 'text', rot: 0, x: Math.round(W * 0.06), y: u(0.77), w: Math.round(W * 0.88), h: u(0.08), text: 'Scan for 10% off your next order\nallsortsbyben.co.uk', size: u(0.028), bold: false, italic: false, font: 'Poppins', align: 'center', valign: 'middle', fit: true, invert: false },
      { id: elId(), type: 'text', rot: 0, x: Math.round(W * 0.1), y: u(0.87), w: Math.round(W * 0.8), h: u(0.08), text: 'CODE: EDIT ME', size: u(0.04), bold: true, italic: false, font: 'Poppins', align: 'center', valign: 'middle', fit: true, invert: true },
    ],
    data: null,
  };
}
