// Dates, the one place they are decided. Python's naive datetimes become local-time
// JS Dates; Python `date` objects become 'YYYY-MM-DD' strings (sortable, comparable,
// JSON-safe). Tests run with TZ=UTC so local == UTC there.
const DAY_MS = 86400000;

export const pad = n => String(n).padStart(2, '0');
// Date (or ISO string) -> 'YYYY-MM-DD' in local time.
export function dayKey(d) {
  if (typeof d === 'string') return d.length === 10 ? d : dayKey(new Date(d));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
// 'YYYY-MM-DD' -> Date at local midnight.
export function fromDay(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
// Date + n days (keeps the wall-clock time across DST, like timedelta on naive datetimes).
export function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
// 'YYYY-MM-DD' + n days -> 'YYYY-MM-DD'.
export function addDayKey(s, n) { return dayKey(addDays(fromDay(s), n)); }
// Whole calendar days from a to b (b - a), on day keys or Dates.
export function daysBetween(a, b) {
  return Math.round((fromDay(dayKey(b)) - fromDay(dayKey(a))) / DAY_MS);
}
// Python's (a - b).total_seconds() / 86400 for Dates: fractional days.
export const fracDays = (a, b) => (a - b) / DAY_MS;
// Monday of the week containing d, as a day key (Python: d - timedelta(days=d.weekday())).
export function weekStart(d) { const x = fromDay(dayKey(d)); return dayKey(addDays(x, -((x.getDay() + 6) % 7))); }
// Python's date.weekday(): Monday 0 .. Sunday 6.
export const weekday = d => (fromDay(dayKey(d)).getDay() + 6) % 7;
// ISO string without zone, as Python's isoformat() writes naive datetimes.
export function isoLocal(d) {
  return dayKey(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}
