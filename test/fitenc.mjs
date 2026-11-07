// Test helpers, not a test: a minimal FIT encoder and zip writer, so fixtures are built in
// code and no binary files live in the repo. Used by fit/zipread/archive tests.
import { deflateRawSync } from 'node:zlib';

export const FIT_EPOCH = 631065600;
const W = { 0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 1, 8: 4, 9: 8, 10: 1, 11: 2, 12: 4, 13: 1 };
const BASE_BYTE = { 0: 0x00, 1: 0x01, 2: 0x02, 3: 0x83, 4: 0x84, 5: 0x85, 6: 0x86, 7: 0x07, 8: 0x88, 9: 0x89, 10: 0x0A, 11: 0x8B, 12: 0x8C, 13: 0x0D };
export const T = { enum: 0, sint8: 1, uint8: 2, sint16: 3, uint16: 4, sint32: 5, uint32: 6, string: 7, float32: 8, uint8z: 10 };

export class FitWriter {
  constructor() { this.parts = []; this.defs = []; }
  // fields: [[fieldNum, baseType (T.*), count=1]]; dev: [[fieldNum, size, devIndex]]
  def(local, global, fields, { be = false, dev = null } = {}) {
    const f = fields.map(([n, t, c = 1]) => [n, t, (t === T.string ? c : W[t] * c)]);
    const b = [0x40 | local | (dev ? 0x20 : 0), 0, be ? 1 : 0];
    b.push(...(be ? [global >> 8, global & 0xFF] : [global & 0xFF, global >> 8]), f.length);
    for (const [n, t, size] of f) b.push(n, size, BASE_BYTE[t]);
    if (dev) { b.push(dev.length); for (const d of dev) b.push(...d); }
    this.parts.push(Uint8Array.from(b));
    this.defs[local] = { f, be, devSize: dev ? dev.reduce((a, d) => a + d[1], 0) : 0 };
    return this;
  }
  // values in field order (raw integers, already scaled; null -> the invalid value; arrays for counts > 1)
  data(local, values, { compressed = null, devFill = 0 } = {}) {
    const d = this.defs[local];
    const size = 1 + d.f.reduce((a, x) => a + x[2], 0) + d.devSize;
    const buf = new Uint8Array(size), dv = new DataView(buf.buffer), le = !d.be;
    buf[0] = compressed == null ? local : 0x80 | ((local & 3) << 5) | (compressed & 0x1F);
    let at = 1;
    d.f.forEach(([, t, sz], i) => {
      const v = values[i], w = W[t];
      if (t === T.string) { buf.set(new TextEncoder().encode(String(v ?? '')).subarray(0, sz - 1), at); at += sz; return; }
      const list = Array.isArray(v) ? v : [v];
      for (let k = 0; k < sz / w; k++, at += w) {
        const x = list[k];
        const inv = { 0: 0xFF, 1: 0x7F, 2: 0xFF, 3: 0x7FFF, 4: 0xFFFF, 5: 0x7FFFFFFF, 6: 0xFFFFFFFF, 10: 0, 13: 0xFF }[t];
        const val = x == null ? inv : x;
        if (t === T.float32) dv.setFloat32(at, x ?? NaN, le);
        else if (w === 1) (t === T.sint8 ? dv.setInt8(at, val) : dv.setUint8(at, val));
        else if (w === 2) (t === T.sint16 ? dv.setInt16(at, val, le) : dv.setUint16(at, val, le));
        else (t === T.sint32 ? dv.setInt32(at, val, le) : dv.setUint32(at, val >>> 0, le));
      }
    });
    buf.fill(devFill, at);
    this.parts.push(buf);
    return this;
  }
  bytes() {
    const n = this.parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(14 + n + 2), dv = new DataView(out.buffer);
    out[0] = 14; out[1] = 0x20; dv.setUint16(2, 2132, true); dv.setUint32(4, n, true);
    out.set([0x2E, 0x46, 0x49, 0x54], 8);
    let at = 14;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}
export const fitTime = unix => unix - FIT_EPOCH;
export const semi = deg => Math.round(deg * 2 ** 31 / 180);

// A small activity: file_id, records every second, a lap, a session, an activity, hrv.
export function sampleActivity({ start = 1700000000, n = 20, sport = 1, rr = [812, 798, 805], localOffset = -18000 } = {}) {
  const w = new FitWriter();
  w.def(0, 0, [[0, T.enum], [1, T.uint16], [4, T.uint32]]).data(0, [4, 1, fitTime(start)]);
  w.def(1, 20, [[253, T.uint32], [0, T.sint32], [1, T.sint32], [5, T.uint32], [78, T.uint32], [3, T.uint8],
    [4, T.uint8], [53, T.uint8], [7, T.uint16], [73, T.uint32], [39, T.uint16], [41, T.uint16], [85, T.uint16], [83, T.uint16], [84, T.uint16], [13, T.sint8]]);
  for (let i = 0; i < n; i++)
    w.data(1, [fitTime(start + i), semi(43.65 + i * 1e-5), semi(-79.38), i * 300, (100 + i * 0.2 + 500) * 5, 140 + i,
      85, 64, 300 + i, 3000, 950, 2500, 12000, 790, 4950, 21]);
  w.def(2, 19, [[253, T.uint32], [254, T.uint16], [2, T.uint32], [7, T.uint32], [8, T.uint32], [9, T.uint32], [15, T.uint8], [16, T.uint8], [17, T.uint8], [19, T.uint16], [21, T.uint16]])
    .data(2, [fitTime(start + n), 0, fitTime(start), n * 1000, n * 1000, (n - 1) * 300, 150, 160, 85, 310, 4]);
  w.def(3, 18, [[253, T.uint32], [2, T.uint32], [5, T.enum], [6, T.enum], [7, T.uint32], [8, T.uint32], [9, T.uint32], [11, T.uint16], [16, T.uint8], [17, T.uint8]])
    .data(3, [fitTime(start + n), fitTime(start), sport, 0, n * 1000, n * 1000, (n - 1) * 300, 250, 150, 160]);
  if (rr && rr.length) w.def(4, 78, [[0, T.uint16, 5]]).data(4, [rr]);
  w.def(5, 34, [[253, T.uint32], [5, T.uint32]]).data(5, [fitTime(start + n), fitTime(start + n + localOffset)]);
  return w.bytes();
}

// ---- zip writer (stored or deflated; optional ZIP64 records) ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(u8) { let c = 0xFFFFFFFF; for (const b of u8) c = CRC[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

export function makeZip(files, { zip64 = false } = {}) {
  const enc = new TextEncoder(), chunks = [], cds = [];
  let off = 0;
  for (const f of files) {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const method = f.method ?? 8, body = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const name = enc.encode(f.name), crc = crc32(data);
    const lh = new Uint8Array(30 + name.length), l = new DataView(lh.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true); l.setUint16(8, method, true);
    l.setUint32(14, crc, true); l.setUint32(18, body.length, true); l.setUint32(22, data.length, true); l.setUint16(26, name.length, true);
    lh.set(name, 30);
    chunks.push(lh, body);
    const extra = zip64 ? 28 : 0;
    const ch = new Uint8Array(46 + name.length + extra), c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 45, true); c.setUint16(6, 45, true); c.setUint16(8, 0x800, true); c.setUint16(10, method, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, zip64 ? 0xFFFFFFFF : body.length, true); c.setUint32(24, zip64 ? 0xFFFFFFFF : data.length, true);
    c.setUint16(28, name.length, true); c.setUint16(30, extra, true); c.setUint32(42, zip64 ? 0xFFFFFFFF : off, true);
    ch.set(name, 46);
    if (zip64) {
      const x = 46 + name.length;
      c.setUint16(x, 1, true); c.setUint16(x + 2, 24, true);
      c.setBigUint64(x + 4, BigInt(data.length), true); c.setBigUint64(x + 12, BigInt(body.length), true); c.setBigUint64(x + 20, BigInt(off), true);
    }
    cds.push(ch);
    off += lh.length + body.length;
  }
  const cdSize = cds.reduce((a, x) => a + x.length, 0), cdOff = off;
  const tail = [];
  if (zip64) {
    const z = new Uint8Array(56), zd = new DataView(z.buffer);
    zd.setUint32(0, 0x06064b50, true); zd.setBigUint64(4, 44n, true); zd.setUint16(12, 45, true); zd.setUint16(14, 45, true);
    zd.setBigUint64(24, BigInt(files.length), true); zd.setBigUint64(32, BigInt(files.length), true);
    zd.setBigUint64(40, BigInt(cdSize), true); zd.setBigUint64(48, BigInt(cdOff), true);
    const loc = new Uint8Array(20), ld = new DataView(loc.buffer);
    ld.setUint32(0, 0x07064b50, true); ld.setBigUint64(8, BigInt(cdOff + cdSize), true); ld.setUint32(16, 1, true);
    tail.push(z, loc);
  }
  const e = new Uint8Array(22), ed = new DataView(e.buffer);
  ed.setUint32(0, 0x06054b50, true);
  ed.setUint16(8, zip64 ? 0xFFFF : files.length, true); ed.setUint16(10, zip64 ? 0xFFFF : files.length, true);
  ed.setUint32(12, zip64 ? 0xFFFFFFFF : cdSize, true); ed.setUint32(16, zip64 ? 0xFFFFFFFF : cdOff, true);
  tail.push(e);
  return new Blob([...chunks, ...cds, ...tail]);
}
export const blobBytes = async b => new Uint8Array(await b.arrayBuffer());
