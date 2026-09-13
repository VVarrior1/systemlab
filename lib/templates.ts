import type { Architecture, NodeKind, SystemNode, Workload } from "./types";
import { componentCost } from "./cost";

export const nodeDefaults: Record<NodeKind, Omit<SystemNode, "id" | "position">> = {
  traffic: { kind: "traffic", label: "Incoming traffic", capacity: 10000, latency: 0, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0 },
  server: { kind: "server", label: "Application server", capacity: 200, latency: 15, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0, role: "application" },
  "load-balancer": { kind: "load-balancer", label: "Load balancer", capacity: 5000, latency: 2, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0 },
  database: { kind: "database", label: "Database", capacity: 150, latency: 25, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0 },
  cache: { kind: "cache", label: "Cache", capacity: 2500, latency: 2, replicas: 1, cacheHitRate: 0.8, enabled: true, cost: 0 },
  queue: { kind: "queue", label: "Message queue", capacity: 10000, latency: 1, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0 },
  cdn: { kind: "cdn", label: "CDN edge", capacity: 5000, latency: 3, replicas: 1, cacheHitRate: 0.7, enabled: true, cost: 0 },
  "rate-limiter": { kind: "rate-limiter", label: "Rate limiter", capacity: 5000, latency: 1, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0, limit: 500, burst: 500 },
  "object-store": { kind: "object-store", label: "Object store", capacity: 3000, latency: 40, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0, storedGb: 100 },
  stream: { kind: "stream", label: "Event stream", capacity: 20000, latency: 2, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0, partitions: 6, consumerGroups: 1, retentionSeconds: 86400 },
};
for (const kind of Object.keys(nodeDefaults) as NodeKind[]) nodeDefaults[kind].cost = componentCost(nodeDefaults[kind]);

/** Defaults for the optional v2 fields. The engine reads through these; the editor shows them. */
export const nodeFieldDefaults = {
  region: "primary",
  variance: "medium" as const,
  timeoutMs: 0,
  retries: 0,
  retryBackoffMs: 50,
  circuitBreaker: false,
  maxQueue: 0,
  fanout: "parallel" as const,
  algorithm: "round-robin" as const,
  healthCheckMs: 0,
  dbMode: "single" as const,
  shards: 4,
  shardStrategy: "hash" as const,
  replicationLagMs: 200,
  failoverMs: 3000,
  consistency: "eventual" as const,
  cacheModel: "probabilistic" as const,
  cacheEntries: 1000,
  ttlMs: 0,
  coalesce: false,
  warmupSeconds: 0,
  limit: 500,
  ackMode: "at-most-once" as const,
  visibilityTimeoutMs: 2000,
  maxDeliveries: 3,
  idempotent: false,
  poolSize: 0,
  breakerWindowMs: 1000,
  breakerMinCalls: 20,
  breakerFailureRatio: 0.5,
  breakerOpenMs: 5000,
  quorumWrite: 2,
  quorumRead: 2,
  election: "heartbeat" as const,
  electionMs: 2000,
  storedGb: 100,
  partitions: 6,
  consumerGroups: 1,
  retentionSeconds: 86400,
};

export const workloadFieldDefaults = {
  keySpace: 10000,
  keySkew: 0.6,
  crossRegionLatencyMs: 80,
  deadlineMs: 5000,
  payloadKb: 512,
  objectShare: 0,
};

/** Fills every optional field so the engine and the inspector never branch on undefined. */
export function normalizeNode(node: SystemNode): Required<Omit<SystemNode, "role">> & Pick<SystemNode, "role"> {
  const limit = node.limit ?? nodeFieldDefaults.limit;
  return {
    ...nodeFieldDefaults,
    burst: limit,
    ...Object.fromEntries(Object.entries(node).filter(([, value]) => value !== undefined)),
    limit,
    cost: node.cost,
  } as Required<Omit<SystemNode, "role">> & Pick<SystemNode, "role">;
}

export function normalizeWorkload(workload: Workload): Required<Workload> {
  const failures = workload.failures ?? (workload.failure === "none" ? [] : [{ kind: workload.failure, at: 0.5 }]);
  return {
    ...workloadFieldDefaults,
    regions: [{ name: "primary", share: 1 }],
    ...Object.fromEntries(Object.entries(workload).filter(([, value]) => value !== undefined)),
    failures,
  } as Required<Workload>;
}

export const componentCatalog: { kind: NodeKind; name: string; description: string }[] = [
  { kind: "server", name: "Server", description: "Application replicas need routed traffic; workers pull queued jobs. Can time out, retry, and break circuits." },
  { kind: "load-balancer", name: "Load balancer", description: "Routes across healthy application replicas; detects failures on a health-check interval." },
  { kind: "database", name: "Database", description: "Single pool, leader with followers (lag, failover), or shards (hash or range)." },
  { kind: "cache", name: "Cache", description: "Probabilistic hit rate, or a keyed LRU with TTL, hot keys, cold starts and coalescing." },
  { kind: "queue", name: "Queue", description: "Buffers jobs for worker replicas; can be bounded to shed overflow." },
  { kind: "cdn", name: "CDN edge", description: "Serves cacheable reads at the edge, in the user's region; misses go to the origin." },
  { kind: "rate-limiter", name: "Rate limiter", description: "Token bucket that rejects excess traffic fast so accepted requests stay healthy." },
  { kind: "object-store", name: "Object store", description: "Blob storage for large payloads; billed for bytes stored and bytes served (egress)." },
  { kind: "stream", name: "Event stream", description: "A partitioned, replayable log with consumer groups and per-partition ordering." },
];

export function createSystemNode(kind: NodeKind, id: string, position: { x: number; y: number }): SystemNode {
  return { ...nodeDefaults[kind], id, position: { ...position } };
}

export const defaultWorkload: Workload = {
  requestRate: 100,
  readRatio: 0.85,
  duration: 30,
  seed: 42,
  pattern: "steady",
  failure: "none",
};

export interface ArchitectureTemplate {
  id: string;
  name: string;
  description: string;
  architecture: Architecture;
  workload: Workload;
}

function node(kind: NodeKind, id: string, column: number, overrides: Partial<SystemNode> = {}, row = 0): SystemNode {
  const base = createSystemNode(kind, id, { x: 40 + column * 280, y: 140 + row * 170 });
  const merged = { ...base, ...overrides };
  return { ...merged, cost: componentCost(merged) };
}
function edges(pairs: [string, string][]): Architecture["edges"] {
  return pairs.map(([source, target]) => ({ id: `${source}-${target}`, source, target }));
}

export const sandboxArchitecture: Architecture = {
  nodes: [node("traffic", "traffic", 0), node("server", "server", 1), node("database", "database", 2)],
  edges: edges([["traffic", "server"], ["server", "database"]]),
};

export const templates: ArchitectureTemplate[] = [
  {
    id: "web-app",
    name: "Web application",
    description: "Traffic addresses one application replica backed by a database.",
    architecture: sandboxArchitecture,
    workload: { ...defaultWorkload },
  },
  {
    id: "cached-service",
    name: "Cached service",
    description: "One application replica with a read cache in front of storage.",
    architecture: {
      nodes: [node("traffic", "traffic", 0), node("server", "server", 1, { capacity: 400 }), node("cache", "cache", 2), node("database", "database", 3)],
      edges: edges([["traffic", "server"], ["server", "cache"], ["cache", "database"]]),
    },
    workload: { ...defaultWorkload, requestRate: 300, readRatio: 0.95 },
  },
  {
    id: "background-jobs",
    name: "Background jobs",
    description: "An intake service and a shared queue supplying worker replicas.",
    architecture: {
      nodes: [node("traffic", "traffic", 0), node("server", "intake", 1, { label: "Job intake" }), node("queue", "queue", 2), node("server", "worker", 3, { label: "Job worker", role: "worker" }), node("database", "database", 4)],
      edges: edges([["traffic", "intake"], ["intake", "queue"], ["queue", "worker"], ["worker", "database"]]),
    },
    workload: { ...defaultWorkload, requestRate: 80, readRatio: 0 },
  },
  {
    id: "microservices",
    name: "Microservices fan-out",
    description: "An API gateway calls three services in parallel; the slowest reply sets the latency.",
    architecture: {
      nodes: [
        node("traffic", "traffic", 0), node("load-balancer", "balancer", 1), node("server", "gateway", 2, { label: "API gateway", capacity: 600, timeoutMs: 800, retries: 1 }),
        node("server", "users", 3, { label: "User service", capacity: 400 }, -1), node("server", "catalog", 3, { label: "Catalog service", capacity: 400 }), node("server", "pricing", 3, { label: "Pricing service", capacity: 400, variance: "high" }, 1),
        node("database", "users-db", 4, { label: "Users DB", capacity: 300 }, -1), node("cache", "catalog-cache", 4, { label: "Catalog cache", cacheHitRate: 0.9 }), node("database", "pricing-db", 4, { label: "Pricing DB", capacity: 300 }, 1), node("database", "catalog-db", 5, { label: "Catalog DB", capacity: 200 }),
      ],
      edges: edges([["traffic", "balancer"], ["balancer", "gateway"], ["gateway", "users"], ["gateway", "catalog"], ["gateway", "pricing"], ["users", "users-db"], ["catalog", "catalog-cache"], ["catalog-cache", "catalog-db"], ["pricing", "pricing-db"]]),
    },
    workload: { ...defaultWorkload, requestRate: 250, readRatio: 0.9 },
  },
  {
    id: "leader-follower",
    name: "Leader and read replicas",
    description: "Writes go to the leader; reads spread across followers with replication lag.",
    architecture: {
      nodes: [node("traffic", "traffic", 0), node("load-balancer", "balancer", 1), node("server", "server", 2, { capacity: 400, replicas: 2 }), node("database", "database", 3, { label: "Orders database", capacity: 200, replicas: 3, dbMode: "leader-follower", replicationLagMs: 300 })],
      edges: edges([["traffic", "balancer"], ["balancer", "server"], ["server", "database"]]),
    },
    workload: { ...defaultWorkload, requestRate: 400, readRatio: 0.9 },
  },
  {
    id: "sharded-writes",
    name: "Sharded writes",
    description: "A write-heavy workload spread across database shards; skewed keys can overload one shard.",
    architecture: {
      nodes: [node("traffic", "traffic", 0), node("load-balancer", "balancer", 1), node("server", "server", 2, { capacity: 500, replicas: 2 }), node("database", "database", 3, { label: "Events database", capacity: 150, dbMode: "sharded", shards: 4, shardStrategy: "range" })],
      edges: edges([["traffic", "balancer"], ["balancer", "server"], ["server", "database"]]),
    },
    workload: { ...defaultWorkload, requestRate: 450, readRatio: 0.2, keySkew: 0.8 },
  },
  {
    id: "rate-limited-api",
    name: "Rate-limited API",
    description: "A token bucket in front of the application sheds excess traffic during a flash crowd.",
    architecture: {
      nodes: [node("traffic", "traffic", 0), node("rate-limiter", "limiter", 1, { limit: 400, burst: 800 }), node("load-balancer", "balancer", 2), node("server", "server", 3, { capacity: 250, replicas: 2, maxQueue: 40 }), node("cache", "cache", 4), node("database", "database", 5, { capacity: 200 })],
      edges: edges([["traffic", "limiter"], ["limiter", "balancer"], ["balancer", "server"], ["server", "cache"], ["cache", "database"]]),
    },
    workload: { ...defaultWorkload, requestRate: 300, readRatio: 0.9, pattern: "flash" },
  },
  {
    id: "multi-region",
    name: "Multi-region",
    description: "Two regional stacks with geo routing; the leader database lives in one region.",
    architecture: {
      nodes: [
        node("traffic", "traffic", 0),
        node("cdn", "cdn-us", 1, { label: "US edge", region: "us-east" }, -1), node("cdn", "cdn-eu", 1, { label: "EU edge", region: "eu-west" }, 1),
        node("load-balancer", "lb-us", 2, { label: "US balancer", region: "us-east" }, -1), node("load-balancer", "lb-eu", 2, { label: "EU balancer", region: "eu-west" }, 1),
        node("server", "app-us", 3, { label: "US app", capacity: 300, replicas: 2, region: "us-east" }, -1), node("server", "app-eu", 3, { label: "EU app", capacity: 300, replicas: 2, region: "eu-west" }, 1),
        node("database", "database", 4, { label: "Primary database", capacity: 300, replicas: 2, dbMode: "leader-follower", region: "us-east" }),
      ],
      edges: edges([["traffic", "cdn-us"], ["traffic", "cdn-eu"], ["cdn-us", "lb-us"], ["cdn-eu", "lb-eu"], ["lb-us", "app-us"], ["lb-eu", "app-eu"], ["app-us", "database"], ["app-eu", "database"]]),
    },
    workload: { ...defaultWorkload, requestRate: 400, readRatio: 0.9, regions: [{ name: "us-east", share: 0.6 }, { name: "eu-west", share: 0.4 }] },
  },
];
