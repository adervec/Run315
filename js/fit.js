// A FIT decoder: the binary every Garmin watch writes, read in the browser with no library.
//
// Only the messages Run315 analyses are decoded (file_id, session, lap, record, activity,
// sport, hrv); every other message, every unknown field and every developer field is
// stepped over by its declared size, so a file from a newer firmware still reads. Values
// come back in profile units (scale and offset applied): metres, m/s, ms, mm, %, degrees.
//
// decodeFit(bytes) -> { file_type, sport, sub_sport, start, local_offset_s, time_created,
//                       records: [...], laps: [...], session, sessions, rr_ms: [...] }
// `start` is the session's UTC start as ISO; timestamps are unix seconds.
// Pure. See test/fit.test.mjs (which carries a minimal encoder to build fixtures).

export const FIT_EPOCH = 631065600;   // 1989-12-31T00:00:00Z in unix seconds

// Base types by their number (the low five bits): [bytes, getter, invalid value or null]
const BASE = {
  0x00: [1, 'u8', 0xFF], 0x01: [1, 's8', 0x7F], 0x02: [1, 'u8', 0xFF],
  0x03: [2, 's16', 0x7FFF], 0x04: [2, 'u16', 0xFFFF], 0x05: [4, 's32', 0x7FFFFFFF],
  0x06: [4, 'u32', 0xFFFFFFFF], 0x07: [1, 'str', null], 0x08: [4, 'f32', null],
  0x09: [8, 'f64', null], 0x0A: [1, 'u8', 0x00], 0x0B: [2, 'u16', 0x0000],
  0x0C: [4, 'u32', 0x00000000], 0x0D: [1, 'u8', 0xFF], 0x0E: [8, 's64', null],
  0x0F: [8, 'u64', null], 0x10: [8, 'u64', null],
};

const SEMI = 180 / 2 ** 31;
// Field tables: field number -> [name, scale, offset]. Scale 'semi' turns semicircles to degrees.
const F_RECORD = {
  253: ['timestamp'], 0: ['position_lat', 'semi'], 1: ['position_long', 'semi'],
  2: ['altitude', 5, 500], 3: ['heart_rate'], 4: ['cadence'], 5: ['distance', 100],
  6: ['speed', 1000], 7: ['power'], 13: ['temperature'], 39: ['vertical_oscillation', 10],
  40: ['stance_time_percent', 100], 41: ['stance_time', 10], 53: ['fractional_cadence', 128],
  73: ['enhanced_speed', 1000], 78: ['enhanced_altitude', 5, 500], 83: ['vertical_ratio', 100],
  84: ['stance_time_balance', 100], 85: ['step_length', 10], 108: ['respiration_rate', 100],
};
const F_LAP = {
  253: ['timestamp'], 254: ['message_index'], 2: ['start_time'], 7: ['total_elapsed_time', 1000],
  8: ['total_timer_time', 1000], 9: ['total_distance', 100], 11: ['total_calories'],
  13: ['avg_speed', 1000], 14: ['max_speed', 1000], 15: ['avg_heart_rate'], 16: ['max_heart_rate'],
  17: ['avg_cadence'], 19: ['avg_power'], 21: ['total_ascent'], 22: ['total_descent'],
  24: ['lap_trigger'], 25: ['sport'], 39: ['sub_sport'], 80: ['avg_fractional_cadence', 128],
  110: ['enhanced_avg_speed', 1000], 111: ['enhanced_max_speed', 1000],
};
const F_SESSION = {
  253: ['timestamp'], 2: ['start_time'], 3: ['start_position_lat', 'semi'], 4: ['start_position_long', 'semi'],
  5: ['sport'], 6: ['sub_sport'], 7: ['total_elapsed_time', 1000], 8: ['total_timer_time', 1000],
  9: ['total_distance', 100], 11: ['total_calories'], 14: ['avg_speed', 1000], 15: ['max_speed', 1000],
  16: ['avg_heart_rate'], 17: ['max_heart_rate'], 18: ['avg_cadence'], 20: ['avg_power'],
  21: ['max_power'], 22: ['total_ascent'], 23: ['total_descent'], 26: ['num_laps'],
  124: ['enhanced_avg_speed', 1000], 125: ['enhanced_max_speed', 1000],
};
const MESSAGES = {
  0: ['file_id', { 0: ['type'], 1: ['manufacturer'], 2: ['product'], 3: ['serial_number'], 4: ['time_created'] }],
  12: ['sport', { 0: ['sport'], 1: ['sub_sport'], 3: ['name'] }],
  18: ['session', F_SESSION],
  19: ['lap', F_LAP],
  20: ['record', F_RECORD],
  34: ['activity', { 253: ['timestamp'], 0: ['total_timer_time', 1000], 1: ['num_sessions'], 5: ['local_timestamp'] }],
  78: ['hrv', { 0: ['time', 1000] }],
};
const TIME_FIELDS = new Set(['timestamp', 'start_time', 'time_created', 'local_timestamp']);

function readValue(dv, at, getter, le) {
  switch (getter) {
    case 'u8': return dv.getUint8(at);
    case 's8': return dv.getInt8(at);
    case 'u16': return dv.getUint16(at, le);
    case 's16': return dv.getInt16(at, le);
    case 'u32': return dv.getUint32(at, le);
    case 's32': return dv.getInt32(at, le);
    case 'f32': { const v = dv.getFloat32(at, le); return isFinite(v) ? v : null; }
    case 'f64': { const v = dv.getFloat64(at, le); return isFinite(v) ? v : null; }
    case 'u64': case 's64': {
      const lo = dv.getUint32(at + (le ? 0 : 4), le), hi = dv.getUint32(at + (le ? 4 : 0), le);
      if (hi === 0xFFFFFFFF && lo === 0xFFFFFFFF) return null;
      return hi * 2 ** 32 + lo;
    }
  }
  return null;
}

function readField(dv, u8, at, size, baseNum, le) {
  const b = BASE[baseNum & 0x1F];
  if (!b) return null;
  const [w, getter, invalid] = b;
  if (getter === 'str') {
    let end = at; while (end < at + size && u8[end] !== 0) end++;
    return new TextDecoder().decode(u8.subarray(at, end)) || null;
  }
  const n = Math.floor(size / w);
  if (n < 1) return null;
  const one = i => { const v = readValue(dv, at + i * w, getter, le); return v === invalid ? null : v; };
  if (n === 1) return one(0);
  const out = [];
  for (let i = 0; i < n; i++) { const v = one(i); if (v != null) out.push(v); }
  return out.length ? out : null;
}

const scaleValue = (v, spec) => {
  const [, scale, offset] = spec;
  const f = x => (scale === 'semi' ? x * SEMI : scale ? x / scale - (offset || 0) : x - (offset || 0));
  return Array.isArray(v) ? v.map(f) : f(v);
};
const iso = t => (t == null ? null : new Date(t * 1000).toISOString().slice(0, 19) + 'Z');

export function decodeFit(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = { file_type: null, sport: null, sub_sport: null, start: null, local_offset_s: null,
    time_created: null, records: [], laps: [], session: null, sessions: [], rr_ms: [] };
  let pos = 0, files = 0;
  // A FIT file may be several FIT files chained end to end; each restarts the definitions.
  while (pos + 12 <= u8.length && u8[pos + 8] === 0x2E && u8[pos + 9] === 0x46 && u8[pos + 10] === 0x49 && u8[pos + 11] === 0x54) {
    const hsize = u8[pos], dataSize = dv.getUint32(pos + 4, true);
    if (hsize < 12) break;
    const start = pos + hsize, end = Math.min(start + dataSize, u8.length);
    readRecords(u8, dv, start, end, out);
    pos = start + dataSize + 2;   // + the file CRC
    files++;
  }
  if (!files) throw new Error('not a FIT file');
  const s = out.sessions[0] || null;
  out.session = s;
  if (s) { out.sport = s.sport ?? out.sport; out.sub_sport = s.sub_sport ?? out.sub_sport; }
  const t0 = (s && s.start_time) ?? (out.records[0] && out.records[0].timestamp) ?? out.time_created;
  out.start = iso(t0);
  return out;
}

function readRecords(u8, dv, pos, end, out) {
  const defs = [];
  let lastTs = null;
  while (pos < end) {
    const h = u8[pos++];
    let local, compressedTs = null;
    if (h & 0x80) {                                   // compressed timestamp header
      local = (h >> 5) & 0x03;
      const off = h & 0x1F;
      if (lastTs != null) { compressedTs = lastTs + ((off - (lastTs & 0x1F)) & 0x1F); lastTs = compressedTs; }
    } else if (h & 0x40) {                            // definition message
      local = h & 0x0F;
      if (pos + 5 > end) return;
      const le = u8[pos + 1] === 0, global = dv.getUint16(pos + 2, le), nf = u8[pos + 4];
      pos += 5;
      const fields = [];
      for (let i = 0; i < nf; i++, pos += 3) fields.push([u8[pos], u8[pos + 1], u8[pos + 2]]);
      let devSize = 0;
      if (h & 0x20) {                                 // developer fields: only their size matters here
        const nd = u8[pos++];
        for (let i = 0; i < nd; i++, pos += 3) devSize += u8[pos + 1];
      }
      const size = fields.reduce((a, f) => a + f[1], 0) + devSize;
      defs[local] = { le, global, fields, size };
      continue;
    } else local = h & 0x0F;
    const def = defs[local];
    if (!def || pos + def.size > end) return;         // undefined local type or truncated: stop cleanly
    const msg = MESSAGES[def.global];
    if (!msg) { pos += def.size; continue; }
    const [kind, table] = msg, m = {};
    let at = pos;
    for (const [num, size, base] of def.fields) {
      const spec = table[num];
      if (spec) {
        let v = readField(dv, u8, at, size, base, def.le);
        if (v != null) {
          v = scaleValue(v, spec);
          if (TIME_FIELDS.has(spec[0]) && typeof v === 'number') v += FIT_EPOCH;
          m[spec[0]] = v;
        }
      } else if (num === 253) {                       // a timestamp on a message we otherwise ignore
        const v = readField(dv, u8, at, size, base, def.le);
        if (v != null) lastTs = v + FIT_EPOCH;
      }
      at += size;
    }
    pos += def.size;
    if (m.timestamp != null) lastTs = m.timestamp;
    else if (compressedTs != null && kind !== 'hrv') m.timestamp = compressedTs;
    store(kind, m, out);
  }
}

function store(kind, m, out) {
  switch (kind) {
    case 'record': out.records.push(m); break;
    case 'lap': out.laps.push(m); break;
    case 'session': out.sessions.push(m); break;
    case 'hrv': if (m.time != null) for (const s of [].concat(m.time)) out.rr_ms.push(Math.round(s * 1000)); break;
    case 'file_id': if (out.file_type == null) { out.file_type = m.type ?? null; out.time_created = m.time_created ?? null; } break;
    case 'sport': if (out.sport == null) { out.sport = m.sport ?? null; out.sub_sport = m.sub_sport ?? null; } break;
    case 'activity': if (m.local_timestamp != null && m.timestamp != null) out.local_offset_s = m.local_timestamp - m.timestamp; break;
  }
}

// FIT sport / sub_sport -> the Garmin typeKey the analysis modules understand. Only a
// fallback: an export's activity summary carries Garmin's own type.
export function fitType(sport, sub) {
  if (sport === 1) return { 1: 'treadmill_running', 3: 'trail_running', 4: 'track_running', 45: 'virtual_run', 58: 'virtual_run' }[sub] || 'running';
  if (sport === 2) return { 6: 'indoor_cycling', 8: 'mountain_biking', 46: 'gravel_cycling', 58: 'virtual_ride', 7: 'road_biking' }[sub] || 'cycling';
  return { 5: sub === 18 ? 'open_water_swimming' : 'lap_swimming', 11: 'walking', 17: 'hiking', 15: 'rowing',
    4: sub === 15 ? 'elliptical' : sub === 14 ? 'indoor_rowing' : 'fitness_equipment',
    10: sub === 20 ? 'strength_training' : 'training', 13: 'resort_skiing_snowboarding_ws' }[sport] || 'other';
}
