/**
 * Seeded randomness for Engine 2.0.
 *
 * Every draw comes from an explicit xorshift32 stream so that identical inputs reproduce
 * identical runs. The engine keeps separate streams for the workload (what arrives), the
 * service times (how long work takes) and the chaos decisions (jitter, routing rolls) so a
 * change to one part of the model does not silently reshuffle the others.
 */

export type Variance = "low" | "medium" | "high";

/** Lognormal sigma per variance setting. Higher sigma means a heavier right tail. */
export const VARIANCE_SIGMA: Record<Variance, number> = { low: 0.2, medium: 0.4, high: 0.8 };

export function sigmaFor(variance: Variance | undefined): number {
  return VARIANCE_SIGMA[variance ?? "medium"] ?? VARIANCE_SIGMA.medium;
}

/** xorshift32. Deterministic, fast, and adequate for a teaching simulator. */
export function createRandom(seed: number): () => number {
  let state = (Math.trunc(seed) >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/** Box-Muller. Two uniforms in, one standard normal out; the spare is deliberately discarded
 *  so the number of draws per call is constant and the stream stays easy to reason about. */
export function standardNormal(random: () => number): number {
  let u = random();
  if (u <= 1e-12) u = 1e-12;
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Lognormal service-time multiplier normalised to mean 1.
 * exp(sigma*Z) has mean exp(sigma^2/2), so the correction keeps average throughput equal to
 * `capacity` while the tail grows with sigma: p99/p50 = exp(2.326 * sigma).
 */
export function lognormalMultiplier(random: () => number, sigma: number): number {
  if (sigma <= 0) return 1;
  return Math.exp(sigma * standardNormal(random) - (sigma * sigma) / 2);
}

/**
 * Power-law key sampler: key = floor(keySpace * u^(1/(1-skew))).
 * skew 0 is uniform; 0.6 puts roughly half the traffic on the first ~13% of the key space;
 * 0.95 is a celebrity-key workload.
 */
export function powerLawKey(u: number, keySpace: number, skew: number): number {
  const space = Math.max(1, Math.floor(keySpace));
  const clamped = Math.min(0.95, Math.max(0, skew));
  const key = Math.floor(space * Math.pow(u, 1 / (1 - clamped)));
  return key < 0 ? 0 : key >= space ? space - 1 : key;
}

/** Exponential backoff with full jitter: uniform in [0, base * 2^attempt]. */
export function fullJitterBackoff(random: () => number, baseMs: number, attempt: number): number {
  const ceiling = Math.max(0, baseMs) * Math.pow(2, Math.max(0, attempt));
  return random() * ceiling;
}

/** Picks an index from cumulative shares. Shares need not be normalised. */
export function weightedIndex(u: number, weights: number[]): number {
  let total = 0;
  for (const weight of weights) total += Math.max(0, weight);
  if (total <= 0) return 0;
  let cursor = u * total;
  for (let index = 0; index < weights.length; index++) {
    cursor -= Math.max(0, weights[index]);
    if (cursor < 0) return index;
  }
  return weights.length - 1;
}
