// A streaming zip reader over a File/Blob: nothing is loaded whole. The central directory
// is read from the end (ZIP64 too -- Garmin's export passes 4 GB), and an entry is a slice
// of the blob inflated on the fly by the browser's own DecompressionStream('deflate-raw').
// A zip inside a zip is just an entry turned back into a Blob (entryBlob), then read again.
//
// listEntries(blob) -> [{ name, method, csize, usize, offset, crc }]   (directories left out)
// streamEntry(blob, e) -> ReadableStream<Uint8Array>;  readEntry(blob, e) -> Uint8Array
// entryBlob(blob, e) -> Blob (a zero-copy slice when the entry is stored)
// No dependencies. See test/zipread.test.mjs.

const SIG_EOCD = 0x06054b50, SIG_Z64_LOC = 0x07064b50, SIG_Z64_EOCD = 0x06064b50,
  SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;
const MAX32 = 0xFFFFFFFF;

async function bytes(blob, from, to) {
  return new Uint8Array(await blob.slice(from, to).arrayBuffer());
}
const u64 = (dv, at) => dv.getUint32(at, true) + dv.getUint32(at + 4, true) * 2 ** 32;

export async function listEntries(blob) {
  const size = blob.size;
  const tailLen = Math.min(size, 22 + 0xFFFF + 20);           // EOCD + longest comment + ZIP64 locator
  const tail = await bytes(blob, size - tailLen, size);
  const tdv = new DataView(tail.buffer);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tdv.getUint32(i, true) === SIG_EOCD) { e = i; break; }
  if (e < 0) throw new Error('not a zip file (no end-of-directory record)');
  let count = tdv.getUint16(e + 10, true), cdSize = tdv.getUint32(e + 12, true), cdOff = tdv.getUint32(e + 16, true);
  if (count === 0xFFFF || cdSize === MAX32 || cdOff === MAX32) {
    const loc = e - 20;
    if (loc < 0 || tdv.getUint32(loc, true) !== SIG_Z64_LOC) throw new Error('ZIP64 locator missing');
    const z64at = u64(tdv, loc + 8);
    const z = await bytes(blob, z64at, z64at + 56), zdv = new DataView(z.buffer);
    if (zdv.getUint32(0, true) !== SIG_Z64_EOCD) throw new Error('ZIP64 end record missing');
    count = u64(zdv, 32); cdSize = u64(zdv, 40); cdOff = u64(zdv, 48);
  }
  const cd = await bytes(blob, cdOff, cdOff + cdSize), dv = new DataView(cd.buffer);
  const dec = new TextDecoder(), out = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (dv.getUint32(p, true) !== SIG_CEN) throw new Error('corrupt central directory');
    const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true);
    let csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    let offset = dv.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nl));
    // ZIP64 extra field: only the values that overflowed are present, in this order.
    for (let x = p + 46 + nl, xe = x + xl; x + 4 <= xe;) {
      const id = dv.getUint16(x, true), len = dv.getUint16(x + 2, true);
      if (id === 0x0001) {
        let q = x + 4;
        if (usize === MAX32) { usize = u64(dv, q); q += 8; }
        if (csize === MAX32) { csize = u64(dv, q); q += 8; }
        if (offset === MAX32) { offset = u64(dv, q); q += 8; }
      }
      x += 4 + len;
    }
    if (!name.endsWith('/')) out.push({ name, method, csize, usize, offset, crc });
    p += 46 + nl + xl + cl;
  }
  return out;
}

async function dataStart(blob, e) {
  const h = await bytes(blob, e.offset, e.offset + 30), dv = new DataView(h.buffer);
  if (dv.getUint32(0, true) !== SIG_LOC) throw new Error('bad local header for ' + e.name);
  return e.offset + 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
}

export async function streamEntry(blob, e) {
  const at = await dataStart(blob, e);
  const raw = blob.slice(at, at + e.csize).stream();
  if (e.method === 0) return raw;
  if (e.method === 8) return raw.pipeThrough(new DecompressionStream('deflate-raw'));
  throw new Error(`unsupported compression method ${e.method} for ${e.name}`);
}

export async function readEntry(blob, e) {
  const reader = (await streamEntry(blob, e)).getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); n += value.length;
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// An entry as a Blob of its own (to open a zip inside the zip). Stored: a slice, no copy.
// Deflated: inflated into a Blob, which the browser may keep on disk rather than in memory.
export async function entryBlob(blob, e) {
  if (e.method === 0) { const at = await dataStart(blob, e); return blob.slice(at, at + e.csize); }
  return new Response(await streamEntry(blob, e)).blob();
}
