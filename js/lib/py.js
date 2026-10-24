// The handful of Python semantics JS does not share. Ported modules lean on these
// instead of approximating, so a port gives the numbers its Python tests expect.

// round(): banker's rounding, half to even, to `n` decimals.
export function pyRound(x, n = 0) {
  if (x == null || !isFinite(x)) return x;
  const m = 10 ** n, v = x * m, f = Math.floor(v), diff = v - f;
  let r;
  if (Math.abs(diff - 0.5) < 1e-9) r = (f % 2 === 0) ? f : f + 1;
  else r = Math.round(v);
  return r / m;
}
// a % b and a // b with Python's sign rules (floor, not truncation).
export const pyMod = (a, b) => ((a % b) + b) % b;
export const floorDiv = (a, b) => Math.floor(a / b);
// divmod(a, b) -> [q, r]
export const divmod = (a, b) => [floorDiv(a, b), pyMod(a, b)];

export const sum = xs => xs.reduce((s, x) => s + x, 0);
export function mean(xs) { if (!xs.length) throw new Error('mean requires at least one data point'); return sum(xs) / xs.length; }
export function median(xs) {
  if (!xs.length) throw new Error('no median for empty data');
  const s = [...xs].sort((a, b) => a - b), n = s.length, h = n >> 1;
  return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
// statistics.stdev (sample) and pstdev (population).
export function stdev(xs) {
  if (xs.length < 2) throw new Error('stdev requires at least two data points');
  const m = mean(xs); return Math.sqrt(sum(xs.map(x => (x - m) ** 2)) / (xs.length - 1));
}
export function pstdev(xs) { const m = mean(xs); return Math.sqrt(sum(xs.map(x => (x - m) ** 2)) / xs.length); }

// statistics.NormalDist().cdf / .inv_cdf for the standard normal.
export function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function erf(x) {
  // Abramowitz-Stegun 7.1.26 is too coarse for p-values; use the series / continued fraction split.
  const s = Math.sign(x), a = Math.abs(x);
  if (a < 2.5) {
    let term = a, total = a, n = 0;
    while (Math.abs(term) > 1e-17 * Math.abs(total)) { n++; term *= -a * a / n; total += term / (2 * n + 1); }
    return s * 2 / Math.sqrt(Math.PI) * total;
  }
  // erfc continued fraction (Lentz), accurate in the tail
  let f = a, C = a, D = 0;
  for (let i = 1; i < 200; i++) {
    const an = i / 2;
    D = a + an * D; D = D === 0 ? 1e-300 : 1 / D;
    C = a + an / C; if (C === 0) C = 1e-300;
    const delta = C * D; f *= delta; if (Math.abs(delta - 1) < 1e-16) break;
  }
  return s * (1 - Math.exp(-a * a) / (f * Math.sqrt(Math.PI)));
}
// Acklam's inverse normal with one Newton step: matches NormalDist.inv_cdf to ~1e-15.
export function normInv(p) {
  if (p <= 0 || p >= 1) throw new Error('p must be in (0, 1)');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239],
    b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1],
    c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783],
    d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  let x;
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  else if (p > 1 - 0.02425) { const q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  else { const q = p - 0.5, r = q * q; x = (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1); }
  const e = normCdf(x) - p, u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}
