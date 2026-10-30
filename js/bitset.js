// Compact bitsets for coverage masks: one bit per node, carried as base64 in the synced state.
//
// The trail and street engines think in byte-per-node masks (js/lib/trails.js markHits),
// which is the right shape for matching and the wrong one for sync: a '0'/'1' string per
// way costs a byte per node in JSON, so five trail areas came to 5.4 MB. A bit per node in
// base64 is 6 bits of text per 8 nodes -- about a sixth of that -- and still a plain string,
// so merge.js and Drive need to know nothing about it.
//
// Bit i lives in byte i >> 3 at position i & 7 (least significant first). Trailing zero bytes
// are trimmed on encode: most ways are covered from the start or not at all, and a mask that
// is all zeros after some node does not need to say so. Decoders therefore accept a bitset
// shorter than the node count and read the missing tail as zeros.

export const bytesFor = n => (n + 7) >> 3;
export const create = n => new Uint8Array(bytesFor(Math.max(0, n | 0)));
export const get = (bs, i) => (bs[i >> 3] >> (i & 7)) & 1;
export function set(bs, i) { bs[i >> 3] |= 1 << (i & 7); return bs; }

// a |= b, in place; grows nothing (bits past a's length are dropped). Returns a.
export function or(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) a[i] |= b[i];
  return a;
}

// Bits set. A 256-entry table: this runs over every way of a city on each summary.
const POP = new Uint8Array(256);
for (let i = 1; i < 256; i++) POP[i] = (i & 1) + POP[i >> 1];
export function count(bs) {
  let s = 0;
  for (let i = 0; i < bs.length; i++) s += POP[bs[i]];
  return s;
}

// Byte-per-node mask (markHits) <-> bitset.
export function fromMask(mask) {
  const bs = create(mask.length);
  for (let i = 0; i < mask.length; i++) if (mask[i]) bs[i >> 3] |= 1 << (i & 7);
  return bs;
}
export function toMask(bs, n) {
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = (bs[i >> 3] >> (i & 7)) & 1;
  return m;
}

// Uint8Array <-> base64. btoa/atob exist in browsers and in node >= 16. Chunked so a large
// mask never blows the argument limit of String.fromCharCode.
export function toB64(bs) {
  let end = bs.length;
  while (end > 0 && bs[end - 1] === 0) end--;
  let s = '';
  for (let i = 0; i < end; i += 0x8000) s += String.fromCharCode.apply(null, bs.subarray(i, Math.min(end, i + 0x8000)));
  return btoa(s);
}
// `n` (nodes), when given, sizes the result so a trimmed tail comes back as zeros.
export function fromB64(str, n = null) {
  let bin = '';
  try { bin = atob(String(str || '')); } catch { bin = ''; }
  const out = new Uint8Array(Math.max(bin.length, n == null ? 0 : bytesFor(n)));
  for (let i = 0; i < bin.length && i < out.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The old trails format: one '0'/'1' character per node. A legacy string is exactly as long
// as the way has nodes and holds only 0s and 1s; a base64 bitset for the same way is about a
// sixth as long, and one short enough to be confused (8 nodes or fewer) always ends in '='.
export const isLegacy = (s, n) => typeof s === 'string' && s.length === n && n > 0 && /^[01]+$/.test(s);

// Either format -> bitset of n nodes. What a reader calls on a synced cover value.
export function decode(s, n) {
  if (s == null || s === '') return create(n);
  if (isLegacy(s, n)) {
    const bs = create(n);
    for (let i = 0; i < n; i++) if (s.charCodeAt(i) === 49) bs[i >> 3] |= 1 << (i & 7);
    return bs;
  }
  return fromB64(s, n);
}
