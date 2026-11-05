// LZO1X-1 compressor (port of the miniLZO algorithm by Markus F.X.J. Oberhumer).
// Phomemo / Labelife-family TSPL printers take their label bitmaps LZO-compressed (BITMAP mode 3),
// which also shrinks a mostly-white 4x6 label from ~124 KB to a few KB, so it sends fast over Bluetooth.

const M2_MAX_LEN = 8, M2_MAX_OFFSET = 0x0800;
const M3_MAX_LEN = 33, M3_MAX_OFFSET = 0x4000, M3_MARKER = 32;
const M4_MAX_LEN = 9, M4_MAX_OFFSET = 0xbfff, M4_MARKER = 16;
const D_BITS = 14, D_MASK = (1 << D_BITS) - 1;

function le32(a, i) { return (a[i] | (a[i + 1] << 8) | (a[i + 2] << 16) | (a[i + 3] << 24)) >>> 0; }

function emitLiterals(out, op, src, from, t, isFirst) {
  if (isFirst && t <= 238) out[op++] = 17 + t;
  else if (t <= 3) out[op - 2] |= t;
  else if (t <= 18) out[op++] = t - 3;
  else {
    let tt = t - 18;
    out[op++] = 0;
    while (tt > 255) { tt -= 255; out[op++] = 0; }
    out[op++] = tt;
  }
  for (let k = 0; k < t; k++) out[op++] = src[from + k];
  return op;
}

export function lzo1xCompress(src) {
  const n = src.length;
  const out = new Uint8Array(n + (n >> 4) + 64 + 3);
  let op = 0;
  let ii = 0; // start of pending literals
  if (n > 24) {
    const dict = new Int32Array(1 << D_BITS).fill(-1);
    const ipEnd = n - 20;
    let ip = 4;
    for (;;) {
      // find a match
      let mPos = -1;
      for (;;) {
        if (ip >= ipEnd) break;
        const dv = le32(src, ip);
        const di = (Math.imul(dv, 0x1824429d) >>> (32 - D_BITS)) & D_MASK;
        const cand = dict[di];
        dict[di] = ip;
        if (cand >= 0 && ip - cand <= M4_MAX_OFFSET && le32(src, cand) === dv) { mPos = cand; break; }
        ip += 1 + ((ip - ii) >> 5);
      }
      if (mPos < 0) break;
      // pending literals
      const t = ip - ii;
      if (t > 0) op = emitLiterals(out, op, src, ii, t, op === 0);
      // match length
      let mLen = 4;
      while (ip + mLen < ipEnd && src[ip + mLen] === src[mPos + mLen]) mLen++;
      let mOff = ip - mPos;
      ip += mLen;
      ii = ip;
      if (mLen <= M2_MAX_LEN && mOff <= M2_MAX_OFFSET) {
        mOff -= 1;
        out[op++] = ((mLen - 1) << 5) | ((mOff & 7) << 2);
        out[op++] = mOff >> 3;
      } else if (mOff <= M3_MAX_OFFSET) {
        mOff -= 1;
        if (mLen <= M3_MAX_LEN) out[op++] = M3_MARKER | (mLen - 2);
        else {
          let l = mLen - M3_MAX_LEN;
          out[op++] = M3_MARKER;
          while (l > 255) { l -= 255; out[op++] = 0; }
          out[op++] = l;
        }
        out[op++] = (mOff << 2) & 0xff;
        out[op++] = (mOff >> 6) & 0xff;
      } else {
        mOff -= 0x4000;
        if (mLen <= M4_MAX_LEN) out[op++] = M4_MARKER | ((mOff >> 11) & 8) | (mLen - 2);
        else {
          let l = mLen - M4_MAX_LEN;
          out[op++] = M4_MARKER | ((mOff >> 11) & 8);
          while (l > 255) { l -= 255; out[op++] = 0; }
          out[op++] = l;
        }
        out[op++] = (mOff << 2) & 0xff;
        out[op++] = (mOff >> 6) & 0xff;
      }
    }
  }
  const t = n - ii;
  if (t > 0) op = emitLiterals(out, op, src, ii, t, op === 0);
  out[op++] = M4_MARKER | 1;
  out[op++] = 0;
  out[op++] = 0;
  return out.slice(0, op);
}
