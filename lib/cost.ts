import type { NodeKind, SystemNode } from "./types";

/**
 * Cost 2.0: per-kind nonlinear pricing in teaching credits.
 * componentCost = fixed + base * (capacity / cap) ^ exp, per replica.
 * Database write capacity is the most expensive thing to scale; caches, balancers and queues are cheap.
 */
export const costRates: Record<Exclude<NodeKind, "traffic">, { base: number; cap: number; exp: number; fixed: number }> = {
  server: { base: 3, cap: 200, exp: 1, fixed: 0.4 },
  database: { base: 4, cap: 150, exp: 1.35, fixed: 1 },
  cache: { base: 2, cap: 2500, exp: 0.6, fixed: 0.4 },
  "load-balancer": { base: 1, cap: 5000, exp: 0.3, fixed: 0.5 },
  queue: { base: 1, cap: 10000, exp: 0.4, fixed: 0.3 },
  cdn: { base: 2, cap: 5000, exp: 0.5, fixed: 0.6 },
  "rate-limiter": { base: 1, cap: 5000, exp: 0.3, fixed: 0.3 },
  "object-store": { base: 1, cap: 3000, exp: 0.3, fixed: 0.4 },
  stream: { base: 2, cap: 20000, exp: 0.5, fixed: 0.8 },
};

/** v2.3: storage is billed per GB kept (month-equivalent, scaled to the hour), egress per GB served. */
export const storageRates = { storageGbMonth: 0.02, egressGb: 0.09 };
/** A month of storage, priced for one hour of it. 730 = 365 x 24 / 12. */
export const HOURS_PER_MONTH = 730;

/**
 * Cost 2.1: usage on top of the provisioned bill, in credits per 1,000 operations per hour.
 * The engine measures operations over the run and extrapolates them to an hour
 * (count / duration * 3600), so a design pays for the traffic it actually serves as well as for
 * the capacity it keeps switched on. Database writes are billed at twice the read rate;
 * every hop that crosses a region is billed as a crossing.
 */
export const usageRates = {
  database: 0.004,
  cache: 0.0005,
  cdn: 0.001,
  queue: 0.0005,
  server: 0.0005,
  "rate-limiter": 0.0002,
  crossRegion: 0.002,
};

/** Measured operations, already extrapolated to an hour by the caller. */
export interface UsageCounts {
  /** Server calls handled. */
  server?: number;
  /** Every database operation, reads and writes. */
  database?: number;
  /** The write share of `database`. Writes are billed twice, so these count again. */
  databaseWrites?: number;
  /** Cache lookups and write-throughs. */
  cache?: number;
  /** Edge hits served by a CDN. Misses are billed by whatever serves them. */
  cdn?: number;
  /** Messages delivered to a consumer. A redelivery is another delivery. */
  queue?: number;
  /** Decisions a rate limiter made, accepted or shed. */
  "rate-limiter"?: number;
  /** Hops that crossed a region boundary. */
  crossRegion?: number;
  /** v2.3: GB an object store keeps. Billed as one hour of the monthly storage rate, not per operation. */
  storedGb?: number;
  /** v2.3: GB served to the outside world, already extrapolated to an hour. */
  egressGb?: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const per1000 = (operations: number | undefined, rate: number) => (Math.max(0, operations ?? 0) / 1000) * rate;

/** One hour of keeping `storedGb` GB. The monthly rate divided by the hours in a month. */
export function storageCostFor(storedGb: number | undefined): number {
  return round((Math.max(0, storedGb ?? 0) * storageRates.storageGbMonth) / HOURS_PER_MONTH);
}

/** One hour of serving `egressGb` GB out of the system. Bytes served are billed once, wherever they leave. */
export function egressCostFor(egressGb: number | undefined): number {
  return round(Math.max(0, egressGb ?? 0) * storageRates.egressGb);
}

/** Cost of one replica of a component. Traffic sources are free. */
export function componentCost(node: Pick<SystemNode, "kind" | "capacity">): number {
  if (node.kind === "traffic") return 0;
  const rate = costRates[node.kind];
  return round(rate.fixed + rate.base * Math.pow(Math.max(1, node.capacity) / rate.cap, rate.exp));
}

/** Total cost of a component including replicas, shards and the managed premium on followers. */
export function nodeCost(node: SystemNode): number {
  if (node.kind === "traffic" || !node.enabled) return 0;
  let total = componentCost(node) * node.replicas;
  if (node.kind === "database" && node.dbMode === "sharded") total *= Math.max(1, node.shards ?? 4);
  if (node.kind === "database" && node.dbMode === "leader-follower") total *= 1 + 0.15 * Math.max(0, node.replicas - 1);
  return round(total);
}

export function architectureCost(nodes: SystemNode[]): number {
  return round(nodes.reduce((sum, node) => sum + nodeCost(node), 0));
}

/**
 * The usage half of the bill. Counts are hourly operations; the rates are per 1,000 of them.
 * A cheap idle design can still be expensive once traffic arrives, which is the point.
 */
export function usageCost(counts: UsageCounts): number {
  const total =
    per1000(counts.server, usageRates.server) +
    per1000(counts.database, usageRates.database) +
    per1000(counts.databaseWrites, usageRates.database) +
    per1000(counts.cache, usageRates.cache) +
    per1000(counts.cdn, usageRates.cdn) +
    per1000(counts.queue, usageRates.queue) +
    per1000(counts["rate-limiter"], usageRates["rate-limiter"]) +
    per1000(counts.crossRegion, usageRates.crossRegion) +
    (Math.max(0, counts.storedGb ?? 0) * storageRates.storageGbMonth) / HOURS_PER_MONTH +
    Math.max(0, counts.egressGb ?? 0) * storageRates.egressGb;
  return round(total);
}
