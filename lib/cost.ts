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
};

const round = (value: number) => Math.round(value * 1000) / 1000;

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
