/**
 * Student's t quantile, from scratch.
 *
 * The forecast needs `T.INV(1 - alpha/2, df)` and there is no such thing in the
 * standard library. Pulling in a stats package for one number would put a
 * dependency into a package whose whole point is not having any, so it is built
 * here out of the regularized incomplete beta function: ~60 lines, exact to
 * float precision, and property-testable against published table values.
 */

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** Lanczos approximation, reflection formula below 0.5. */
function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i]! / (z + i + 1);
  const t = z + LANCZOS.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta, by the modified Lentz method. */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAX_ITERATIONS = 300;
  const EPSILON = 3e-16;
  const TINY = 1e-300;

  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= MAX_ITERATIONS; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPSILON) break;
  }
  return h;
}

/** Regularized incomplete beta, I_x(a, b). */
export function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** P(T <= t) for `df` degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  if (df <= 0) return Number.NaN;
  const tail = 0.5 * incompleteBeta(df / 2, 0.5, df / (df + t * t));
  return t > 0 ? 1 - tail : tail;
}

/**
 * The inverse: the `p`-quantile of Student's t.
 *
 * Bisection rather than a closed form -- the CDF is monotone and this runs once
 * per category, so the ~60 iterations cost nothing and the code stays readable.
 */
export function studentTQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1) || df <= 0) return Number.NaN;
  if (p === 0.5) return 0;

  let low = -1e4;
  let high = 1e4;
  for (let i = 0; i < 200; i++) {
    const mid = (low + high) / 2;
    if (studentTCdf(mid, df) < p) low = mid;
    else high = mid;
    if (high - low < 1e-13 * Math.max(1, Math.abs(mid))) break;
  }
  return (low + high) / 2;
}

