/**
 * Cache models for Engine 2.0.
 *
 * `KeyedCache` is an LRU over a bounded number of keys with an optional TTL. Recency is kept in
 * `Map` insertion order, so every operation is O(1): a lookup deletes and re-inserts the key to
 * move it to the tail, and an overflowing insert evicts the head.
 *
 * Staleness is tracked per key. A write records the moment it was accepted at the cache; the
 * write-through `set` only happens when the database returns. A read that hits an entry which was
 * populated before the last accepted write to that key is serving data the database has already
 * superseded, which is what `stale` means here.
 */

export type CacheLookup = "hit" | "stale" | "miss";

export class KeyedCache {
  /** key -> time the entry was written into the cache. Insertion order is LRU order. */
  private readonly entries = new Map<number, number>();
  /** key -> time of the most recent write accepted for that key. */
  private readonly writes = new Map<number, number>();
  readonly capacity: number;
  readonly ttlMs: number;
  hits = 0;
  stale = 0;
  misses = 0;
  evictions = 0;
  expirations = 0;

  constructor(capacity: number, ttlMs: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.ttlMs = Math.max(0, ttlMs);
  }

  get size(): number {
    return this.entries.size;
  }

  lookup(key: number, now: number): CacheLookup {
    const setAt = this.entries.get(key);
    if (setAt === undefined) {
      this.misses++;
      return "miss";
    }
    if (this.ttlMs > 0 && now - setAt >= this.ttlMs) {
      this.entries.delete(key);
      this.expirations++;
      this.misses++;
      return "miss";
    }
    // Touch for recency.
    this.entries.delete(key);
    this.entries.set(key, setAt);
    const lastWrite = this.writes.get(key);
    if (lastWrite !== undefined && lastWrite > setAt) {
      this.stale++;
      return "stale";
    }
    this.hits++;
    return "hit";
  }

  /** Write-through population, on the way back from the database. */
  set(key: number, now: number): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, now);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions++;
    }
  }

  /** Records that a write for this key has been accepted but not yet reflected in the entry. */
  noteWrite(key: number, now: number): void {
    this.writes.set(key, now);
  }

  /** A cache-flush event drops the entries. The write history survives: the data still changed. */
  clear(): void {
    this.entries.clear();
  }
}

/** Joins concurrent misses for the same key into a single origin fetch. */
export class FetchCoalescer {
  private readonly waiters = new Map<number, ((ok: boolean) => void)[]>();
  joined = 0;

  /** True when a fetch for this key is already in flight and the caller was parked on it. */
  join(key: number, resume: (ok: boolean) => void): boolean {
    const waiting = this.waiters.get(key);
    if (!waiting) return false;
    waiting.push(resume);
    this.joined++;
    return true;
  }

  /** Marks this caller as the leader that will actually fetch the key. */
  lead(key: number): void {
    if (!this.waiters.has(key)) this.waiters.set(key, []);
  }

  /** Resolves everyone parked behind the leader. Returns how many were released. */
  settle(key: number, ok: boolean): number {
    const waiting = this.waiters.get(key);
    if (!waiting) return 0;
    this.waiters.delete(key);
    for (const resume of waiting) resume(ok);
    return waiting.length;
  }

  clear(): void {
    for (const [key] of this.waiters) this.settle(key, false);
    this.waiters.clear();
  }
}

/**
 * Probabilistic hit rate with a warm-up ramp: an empty cache starts at 0 and reaches the
 * configured rate after `warmupSeconds`. A cache flush restarts the ramp.
 */
export function probabilisticHitRate(baseRate: number, warmupSeconds: number, now: number, lastFlushAt: number): number {
  if (warmupSeconds <= 0) return baseRate;
  const elapsed = now - lastFlushAt;
  if (elapsed <= 0) return 0;
  const ramp = Math.min(1, elapsed / (warmupSeconds * 1000));
  return baseRate * ramp;
}
