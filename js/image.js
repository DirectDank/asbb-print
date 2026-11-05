// Turning PDFs and pictures into crisp 1-bit labels: loading, auto-crop, fitting and black & white conversion.
import * as pdfjsLib from '../vendor/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;

export const DPI = 203;
export const mmToDots = (mm) => Math.round((mm / 25.4) * DPI);

export const SIZES = [
  { id: '4x6', name: '4 × 6 in (shipping)', w: 101.6, h: 152.4 },
  { id: '100x150', name: '100 × 150 mm', w: 100, h: 150 },
  { id: '4x4', name: '4 × 4 in', w: 101.6, h: 101.6 },
  { id: '4x3', name: '4 × 3 in', w: 101.6, h: 76.2 },
  { id: '3x2', name: '3 × 2 in', w: 76.2, h: 50.8 },
  { id: '2x1', name: '2 × 1 in', w: 50.8, h: 25.4 },
  { id: '60x40', name: '60 × 40 mm', w: 60, h: 40 },
  { id: '50x30', name: '50 × 30 mm', w: 50, h: 30 },
  { id: '50x25', name: '50 × 25 mm', w: 50, h: 25 },
  { id: '40x30', name: '40 × 30 mm', w: 40, h: 30 },
];

export function sizeById(id, custom = []) {
  return SIZES.find((s) => s.id === id) || custom.find((s) => s.id === id) || SIZES[0];
}

export function labelDots(size) {
  return { w: mmToDots(size.w), h: mmToDots(size.h) };
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// ---------- loading ----------
// Returns { count, page(i) -> Promise<canvas> } so long PDFs are rendered one page at a time.
export async function openSource(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
  if (isPdf) {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const cache = new Map();
    return {
      kind: 'pdf',
      count: Math.min(pdf.numPages, 300),
      async page(i) {
        if (cache.has(i)) return cache.get(i);
        const p = await pdf.getPage(i + 1);
        const vp1 = p.getViewport({ scale: 1 });
        const scale = Math.min(5, 2600 / Math.max(vp1.width, vp1.height));
        const vp = p.getViewport({ scale });
        const c = makeCanvas(vp.width, vp.height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        await p.render({ canvasContext: ctx, viewport: vp }).promise;
        if (cache.size > 3) cache.delete(cache.keys().next().value);
        cache.set(i, c);
        return c;
      },
    };
  }
  const img = await loadImage(file);
  const c = makeCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0);
  return { kind: 'image', count: 1, page: async () => c };
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const url = src instanceof Blob ? URL.createObjectURL(src) : src;
    const img = new Image();
    img.onload = () => { resolve(img); if (src instanceof Blob) setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = () => reject(new Error('Couldn’t open that picture.'));
    img.src = url;
  });
}

// ---------- auto-crop ----------
// Finds candidate label areas on a page. Uses recursive whitespace cuts, then ranks blocks by size
// and by how close their shape is to the label (either way round, since we can rotate).
export function findCropAreas(src, labelAspect) {
  const maxSide = 700;
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * k));
  const h = Math.max(1, Math.round(src.height * k));
  const sc = makeCanvas(w, h);
  const sctx = sc.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(src, 0, 0, w, h);
  const px = sctx.getImageData(0, 0, w, h).data;
  const dark = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < dark.length; i++, j += 4) {
    const a = px[j + 3];
    const lum = (px[j] * 0.299 + px[j + 1] * 0.587 + px[j + 2] * 0.114) * (a / 255) + 255 * (1 - a / 255);
    dark[i] = lum < 170 ? 1 : 0;
  }
  const blocks = cropBlocksFromMask(dark, w, h, labelAspect);
  return blocks.map((b) => ({ x: b.x / k, y: b.y / k, w: b.w / k, h: b.h / k, score: b.score }));
}

export function cropBlocksFromMask(dark, w, h, labelAspect) {
  const rowInk = (x0, x1, y) => { let n = 0; for (let x = x0; x < x1; x++) n += dark[y * w + x]; return n; };
  const colInk = (y0, y1, x) => { let n = 0; for (let y = y0; y < y1; y++) n += dark[y * w + x]; return n; };
  const noise = 1; // a row/column needs more than this many dark pixels to count as ink

  function bbox(x0, y0, x1, y1) {
    let top = -1, bottom = -1, left = -1, right = -1;
    for (let y = y0; y < y1; y++) if (rowInk(x0, x1, y) > noise) { top = y; break; }
    if (top < 0) return null;
    for (let y = y1 - 1; y >= top; y--) if (rowInk(x0, x1, y) > noise) { bottom = y + 1; break; }
    for (let x = x0; x < x1; x++) if (colInk(top, bottom, x) > noise) { left = x; break; }
    for (let x = x1 - 1; x >= left; x--) if (colInk(top, bottom, x) > noise) { right = x + 1; break; }
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  function splits(b, dir) {
    const len = dir === 'h' ? b.h : b.w;
    const minGap = Math.max(4, Math.round(0.025 * (dir === 'h' ? h : w)));
    const segs = [];
    let start = 0, gap = 0, inSeg = false;
    for (let i = 0; i < len; i++) {
      const ink = dir === 'h' ? rowInk(b.x, b.x + b.w, b.y + i) : colInk(b.y, b.y + b.h, b.x + i);
      if (ink > noise) {
        if (!inSeg) { start = i; inSeg = true; }
        gap = 0;
      } else if (inSeg) {
        gap++;
        if (gap >= minGap) { segs.push([start, i - gap + 1]); inSeg = false; gap = 0; }
      }
    }
    if (inSeg) segs.push([start, len - gap]);
    return segs.map(([a, z]) => (dir === 'h' ? { x: b.x, y: b.y + a, w: b.w, h: z - a } : { x: b.x + a, y: b.y, w: z - a, h: b.h }));
  }

  const out = [];
  function rec(x0, y0, x1, y1, depth, tried) {
    const b = bbox(x0, y0, x1, y1);
    if (!b || b.w < 3 || b.h < 3) return;
    out.push(b);
    if (depth >= 5) return;
    for (const dir of tried ? [tried === 'h' ? 'v' : 'h'] : ['h', 'v']) {
      const parts = splits(b, dir);
      if (parts.length > 1) {
        b.composite = true;
        for (const p of parts) rec(p.x, p.y, p.x + p.w, p.y + p.h, depth + 1, null);
        return;
      }
    }
  }
  rec(0, 0, w, h, 0, null);

  const pageArea = w * h;
  const r = labelAspect || 1.5;
  const scored = [];
  for (const b of out) {
    const area = b.w * b.h;
    if (area < pageArea * 0.03 && out.length > 1) continue;
    const a = b.h / b.w;
    const diff = Math.min(Math.abs(Math.log(a / r)), Math.abs(Math.log(a * r)));
    // blocks made of several separate pieces (e.g. label + instructions) are rarely the label itself
    const score = (area / pageArea) * Math.exp(-1.6 * diff) * (b.composite ? 0.35 : 1);
    // small padding so borders aren't clipped
    const pad = Math.round(Math.max(b.w, b.h) * 0.01) + 1;
    const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
    const box = { x, y, w: Math.min(w, b.x + b.w + pad) - x, h: Math.min(h, b.y + b.h + pad) - y, score };
    if (!scored.some((s) => Math.abs(s.x - box.x) < 4 && Math.abs(s.y - box.y) < 4 && Math.abs(s.w - box.w) < 6 && Math.abs(s.h - box.h) < 6)) scored.push(box);
  }
  scored.sort((p, q) => q.score - p.score);
  if (!scored.length) scored.push({ x: 0, y: 0, w, h, score: 0 });
  return scored.slice(0, 8);
}

// ---------- composing a label ----------
// crop: {x,y,w,h} in source pixels. opts: { rotate: 'auto'|0|90|180|270, fit: 'fit'|'fill'|'stretch', marginDots }
export function composeLabel(src, crop, dots, opts) {
  const out = makeCanvas(dots.w, dots.h);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  let rot = opts.rotate;
  if (rot === 'auto' || rot === undefined) {
    const srcPortrait = crop.h >= crop.w;
    const labelPortrait = dots.h >= dots.w;
    rot = srcPortrait === labelPortrait ? 0 : 90;
  }
  rot = Number(rot) % 360;
  const m = Math.max(0, opts.marginDots || 0);
  const availW = dots.w - 2 * m, availH = dots.h - 2 * m;
  const sideways = rot === 90 || rot === 270;
  const cw = sideways ? crop.h : crop.w;
  const ch = sideways ? crop.w : crop.h;
  let sx, sy;
  if (opts.fit === 'stretch') { sx = availW / cw; sy = availH / ch; }
  else {
    const s = opts.fit === 'fill' ? Math.max(availW / cw, availH / ch) : Math.min(availW / cw, availH / ch);
    sx = sy = s;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(m, m, availW, availH);
  ctx.clip();
  ctx.translate(dots.w / 2, dots.h / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const dw = (sideways ? sy : sx) * crop.w;
  const dh = (sideways ? sx : sy) * crop.h;
  ctx.drawImage(src, crop.x, crop.y, crop.w, crop.h, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
  return out;
}

// ---------- black & white ----------
// mode: 'sharp' (threshold, best for barcodes/text) or 'photo' (dithered)
export function toMono(canvas, mode = 'sharp', level = 160) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    const a = d[j + 3] / 255;
    g[i] = (d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114) * a + 255 * (1 - a);
  }
  const black = new Uint8Array(w * h);
  if (mode === 'photo') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const old = g[i];
        const nv = old < 128 ? 0 : 255;
        black[i] = nv === 0 ? 1 : 0;
        const err = old - nv;
        if (x + 1 < w) g[i + 1] += (err * 7) / 16;
        if (y + 1 < h) {
          if (x > 0) g[i + w - 1] += (err * 3) / 16;
          g[i + w] += (err * 5) / 16;
          if (x + 1 < w) g[i + w + 1] += err / 16;
        }
      }
    }
  } else {
    for (let i = 0; i < g.length; i++) black[i] = g[i] < level ? 1 : 0;
  }
  return packBits(black, w, h);
}

// Packed 1-bit image: MSB first, 1 = black dot.
export function packBits(black, w, h) {
  const wb = Math.ceil(w / 8);
  const bits = new Uint8Array(wb * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (black[y * w + x]) bits[y * wb + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { w, h, wb, bits };
}

export function monoToCanvas(mono, scale = 1) {
  const c = makeCanvas(mono.w, mono.h);
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(mono.w, mono.h);
  const d = id.data;
  for (let y = 0; y < mono.h; y++) {
    for (let x = 0; x < mono.w; x++) {
      const on = mono.bits[y * mono.wb + (x >> 3)] & (0x80 >> (x & 7));
      const j = (y * mono.w + x) * 4;
      const v = on ? 17 : 255;
      d[j] = d[j + 1] = d[j + 2] = v;
      d[j + 3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  if (scale === 1) return c;
  const s = makeCanvas(mono.w * scale, mono.h * scale);
  const sctx = s.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(c, 0, 0, s.width, s.height);
  return s;
}

export function canvasToBlob(c, type = 'image/png', q) {
  return new Promise((res) => c.toBlob(res, type, q));
}

export async function thumbFromMono(mono) {
  const c = monoToCanvas(mono);
  const k = 260 / Math.max(c.width, c.height);
  const t = makeCanvas(c.width * k, c.height * k);
  const ctx = t.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, 0, 0, t.width, t.height);
  return canvasToBlob(t, 'image/webp', 0.85);
}

// Simple Floyd–Steinberg dither in place on a canvas region (used for photos inside designs).
export function ditherCanvas(c) {
  const mono = toMono(c, 'photo');
  const m = monoToCanvas(mono);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(m, 0, 0);
  return c;
}
