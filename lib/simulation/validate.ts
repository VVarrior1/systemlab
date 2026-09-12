import type { Architecture, NodeKind, SystemNode, Workload } from "../types";
import { normalizeNode, normalizeWorkload } from "../templates";

const kinds: NodeKind[] = ["traffic", "server", "load-balancer", "database", "cache", "queue", "cdn", "rate-limiter"];
const patterns = ["steady", "spike", "ramp", "flash"];
const legacyFailures = ["none", "server", "database"];
const failureKinds = ["server", "database", "cache-flush", "slow-database", "slow-server", "region", "flapping", "error-burst"];

/** What traffic, a CDN or a rate limiter may hand a request to. */
const entryTargets: NodeKind[] = ["server", "load-balancer", "cdn", "rate-limiter"];
/** What an application server may call. */
const dependencyTargets: NodeKind[] = ["cache", "database", "queue", "server", "rate-limiter"];

export const LIMITS = {
  nodes: 48,
  edges: 96,
  requestRate: 3000,
  duration: 60,
  failureEvents: 6,
  poolSize: 1000,
  maxDeliveries: 10,
  keySpace: 100000,
  shards: 16,
  replicas: 16,
  capacity: 100000,
  latency: 10000,
  dependencies: 4,
};

const isApplicationServer = (node: SystemNode) => node.kind === "server" && node.role !== "worker";

export function validateSimulation(architecture: Architecture, workload: Workload): void {
  const { nodes, edges } = architecture;
  if (!Array.isArray(nodes) || !Array.isArray(edges) || nodes.length > LIMITS.nodes || edges.length > LIMITS.edges) {
    throw new Error(`Use at most ${LIMITS.nodes} components and ${LIMITS.edges} connections.`);
  }
  const ids = new Set(nodes.map((node) => node.id));
  if (ids.size !== nodes.length) throw new Error("Component identifiers must be unique.");
  const traffic = nodes.filter((node) => node.kind === "traffic");
  if (traffic.length !== 1) throw new Error("Add exactly one traffic source.");
  if (!traffic[0].enabled) throw new Error("Enable the traffic source before running.");

  for (const node of nodes) {
    if (!kinds.includes(node.kind)) throw new Error("The design contains an unsupported component.");
    if (!Number.isFinite(node.capacity) || node.capacity <= 0 || node.capacity > LIMITS.capacity) {
      throw new Error(`${node.label}: capacity must be between 1 and ${LIMITS.capacity.toLocaleString("en-US")} requests/s.`);
    }
    if (!Number.isInteger(node.replicas) || node.replicas < 1 || node.replicas > LIMITS.replicas) {
      throw new Error(`${node.label}: use between 1 and ${LIMITS.replicas} replicas.`);
    }
    if (!Number.isFinite(node.latency) || node.latency < 0 || node.latency > LIMITS.latency) {
      throw new Error(`${node.label}: latency must be between 0 and ${LIMITS.latency.toLocaleString("en-US")} ms.`);
    }
    if (!Number.isFinite(node.cacheHitRate) || node.cacheHitRate < 0 || node.cacheHitRate > 1) {
      throw new Error(`${node.label}: cache hit rate must be between 0 and 100%.`);
    }
    if (!Number.isFinite(node.cost) || node.cost < 0) throw new Error(`${node.label}: cost must be positive.`);
    const settings = normalizeNode(node);
    if (!Number.isFinite(settings.timeoutMs) || settings.timeoutMs < 0 || settings.timeoutMs > 60000) {
      throw new Error(`${node.label}: the dependency timeout must be between 0 and 60,000 ms.`);
    }
    if (!Number.isInteger(settings.retries) || settings.retries < 0 || settings.retries > 3) {
      throw new Error(`${node.label}: use between 0 and 3 retries.`);
    }
    if (!Number.isFinite(settings.retryBackoffMs) || settings.retryBackoffMs < 0 || settings.retryBackoffMs > 10000) {
      throw new Error(`${node.label}: the retry backoff must be between 0 and 10,000 ms.`);
    }
    if (!Number.isFinite(settings.maxQueue) || settings.maxQueue < 0 || settings.maxQueue > 100000) {
      throw new Error(`${node.label}: the queue bound must be between 0 (unbounded) and 100,000 requests.`);
    }
    if (!Number.isFinite(settings.healthCheckMs) || settings.healthCheckMs < 0 || settings.healthCheckMs > 60000) {
      throw new Error(`${node.label}: the health-check interval must be between 0 and 60,000 ms.`);
    }
    if (!["low", "medium", "high"].includes(settings.variance)) throw new Error(`${node.label}: choose a supported service-time variance.`);
    if (node.kind === "server") {
      if (!Number.isInteger(settings.poolSize) || settings.poolSize < 0 || settings.poolSize > LIMITS.poolSize) {
        throw new Error(`${node.label}: the connection pool must hold between 0 (unlimited) and ${LIMITS.poolSize.toLocaleString("en-US")} concurrent dependency calls.`);
      }
      if (!Number.isFinite(settings.breakerWindowMs) || settings.breakerWindowMs < 100 || settings.breakerWindowMs > 60000) {
        throw new Error(`${node.label}: the circuit-breaker window must be between 100 and 60,000 ms.`);
      }
      if (!Number.isInteger(settings.breakerMinCalls) || settings.breakerMinCalls < 1 || settings.breakerMinCalls > 10000) {
        throw new Error(`${node.label}: the circuit breaker needs between 1 and 10,000 calls in its window before it may open.`);
      }
      if (!Number.isFinite(settings.breakerFailureRatio) || settings.breakerFailureRatio <= 0 || settings.breakerFailureRatio > 1) {
        throw new Error(`${node.label}: the circuit-breaker failure ratio must be above 0% and at most 100%.`);
      }
      if (!Number.isFinite(settings.breakerOpenMs) || settings.breakerOpenMs < 0 || settings.breakerOpenMs > 60000) {
        throw new Error(`${node.label}: the circuit breaker may stay open between 0 and 60,000 ms.`);
      }
    }
    if (node.kind === "database") {
      if (!["single", "leader-follower", "sharded", "quorum"].includes(settings.dbMode)) throw new Error(`${node.label}: choose a supported database mode.`);
      if (!Number.isInteger(settings.shards) || settings.shards < 1 || settings.shards > LIMITS.shards) {
        throw new Error(`${node.label}: use between 1 and ${LIMITS.shards} shards.`);
      }
      if (!["hash", "range"].includes(settings.shardStrategy)) throw new Error(`${node.label}: choose a hash or range shard strategy.`);
      if (!Number.isFinite(settings.replicationLagMs) || settings.replicationLagMs < 0 || settings.replicationLagMs > 60000) {
        throw new Error(`${node.label}: replication lag must be between 0 and 60,000 ms.`);
      }
      if (!Number.isFinite(settings.failoverMs) || settings.failoverMs < 0 || settings.failoverMs > 60000) {
        throw new Error(`${node.label}: failover time must be between 0 and 60,000 ms.`);
      }
      if (!["eventual", "read-your-writes"].includes(settings.consistency)) throw new Error(`${node.label}: choose a supported consistency setting.`);
      if (settings.dbMode === "sharded" && settings.shards * node.replicas > 64) {
        throw new Error(`${node.label}: shards times replicas must stay at or below 64 lanes.`);
      }
      if (settings.dbMode === "quorum") {
        for (const [name, value] of [["write quorum W", settings.quorumWrite], ["read quorum R", settings.quorumRead]] as const) {
          if (!Number.isInteger(value) || value < 1 || value > node.replicas) {
            throw new Error(`${node.label}: the ${name} must be a whole number between 1 and the ${node.replicas} replica${node.replicas === 1 ? "" : "s"} (N).`);
          }
        }
      }
    }
    if (node.kind === "cache") {
      if (!["probabilistic", "keyed"].includes(settings.cacheModel)) throw new Error(`${node.label}: choose a probabilistic or keyed cache model.`);
      if (!Number.isInteger(settings.cacheEntries) || settings.cacheEntries < 1 || settings.cacheEntries > LIMITS.keySpace) {
        throw new Error(`${node.label}: the cache must hold between 1 and ${LIMITS.keySpace.toLocaleString("en-US")} keys.`);
      }
      if (!Number.isFinite(settings.ttlMs) || settings.ttlMs < 0 || settings.ttlMs > 600000) {
        throw new Error(`${node.label}: the cache TTL must be between 0 (no expiry) and 600,000 ms.`);
      }
      if (!Number.isFinite(settings.warmupSeconds) || settings.warmupSeconds < 0 || settings.warmupSeconds > 60) {
        throw new Error(`${node.label}: the warm-up must be between 0 and 60 seconds.`);
      }
    }
    if (node.kind === "queue") {
      if (!["at-most-once", "at-least-once"].includes(settings.ackMode)) {
        throw new Error(`${node.label}: choose at-most-once or at-least-once delivery.`);
      }
      if (!Number.isFinite(settings.visibilityTimeoutMs) || settings.visibilityTimeoutMs < 0 || settings.visibilityTimeoutMs > 60000) {
        throw new Error(`${node.label}: the visibility timeout must be between 0 (never redeliver on time) and 60,000 ms.`);
      }
      if (!Number.isInteger(settings.maxDeliveries) || settings.maxDeliveries < 1 || settings.maxDeliveries > LIMITS.maxDeliveries) {
        throw new Error(`${node.label}: deliver a message between 1 and ${LIMITS.maxDeliveries} times before dead-lettering it.`);
      }
    }
    if (node.kind === "rate-limiter") {
      if (!Number.isFinite(settings.limit) || settings.limit < 1 || settings.limit > LIMITS.capacity) {
        throw new Error(`${node.label}: the rate limit must be between 1 and ${LIMITS.capacity.toLocaleString("en-US")} requests/s.`);
      }
      if (!Number.isFinite(settings.burst) || settings.burst < 1 || settings.burst > LIMITS.capacity) {
        throw new Error(`${node.label}: the burst allowance must be between 1 and ${LIMITS.capacity.toLocaleString("en-US")} requests.`);
      }
    }
  }

  const seenEdges = new Set<string>();
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) throw new Error("A connection references a missing component.");
    if (edge.source === edge.target) throw new Error("Remove the connection loop. Request routes must not contain cycles.");
    const key = `${edge.source}:${edge.target}`;
    if (seenEdges.has(key)) throw new Error("Remove duplicate connections between the same components.");
    seenEdges.add(key);
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, SystemNode[]>();
  const incoming = new Map<string, SystemNode[]>();
  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of edges) {
    outgoing.get(edge.source)!.push(byId.get(edge.target)!);
    incoming.get(edge.target)!.push(byId.get(edge.source)!);
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error("Remove the connection loop. Request routes must not contain cycles.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const child of outgoing.get(id)!) visit(child.id);
    visiting.delete(id);
    visited.add(id);
  }
  visit(traffic[0].id);
  const disconnected = nodes.filter((node) => !visited.has(node.id));
  if (disconnected.length) throw new Error(`Connect every component to traffic: ${disconnected.map((node) => node.label).join(", ")}.`);

  for (const node of nodes) {
    const next = outgoing.get(node.id)!;
    const parents = incoming.get(node.id)!;
    if (node.kind === "traffic") {
      if (parents.length) throw new Error("Nothing may point at the traffic source.");
      if (!next.length || next.some((child) => !entryTargets.includes(child.kind) || child.role === "worker")) {
        throw new Error("Connect traffic to one or more application servers, load balancers, CDNs or rate limiters.");
      }
    } else if (node.kind === "cdn" || node.kind === "rate-limiter") {
      if (next.length !== 1 || !entryTargets.includes(next[0].kind) || next[0].role === "worker") {
        throw new Error(`${node.label}: connect it to exactly one application server, load balancer, CDN or rate limiter.`);
      }
    } else if (node.kind === "load-balancer") {
      if (!next.length || next.some((child) => !isApplicationServer(child))) {
        throw new Error(`${node.label}: connect the load balancer to one or more application servers.`);
      }
    } else if (node.kind === "database") {
      if (next.length) throw new Error(`${node.label}: databases are the end of a request route.`);
    } else if (node.kind === "cache") {
      if (next.length !== 1 || next[0].kind !== "database") {
        throw new Error(`${node.label}: connect the cache to exactly one database for misses and writes.`);
      }
    } else if (node.kind === "queue") {
      if (next.length !== 1 || next[0].kind !== "server" || next[0].role !== "worker") {
        throw new Error(`${node.label}: connect the queue to one server with the Worker role.`);
      }
    } else if (node.kind === "server") {
      if (next.length > LIMITS.dependencies) {
        throw new Error(`${node.label}: call at most ${LIMITS.dependencies} dependencies from one server.`);
      }
      if (next.some((child) => !dependencyTargets.includes(child.kind) || (child.kind === "server" && child.role === "worker"))) {
        throw new Error(`${node.label}: a server may call caches, databases, queues, rate limiters or other application servers.`);
      }
      if (node.role === "worker" && parents.some((parent) => parent.kind !== "queue")) {
        throw new Error(`${node.label}: a worker must receive jobs from a queue.`);
      }
      if (node.role !== "worker" && parents.some((parent) => parent.kind === "queue")) {
        throw new Error(`${node.label}: give a server fed by a queue the Worker role.`);
      }
    }
  }

  if (!Number.isFinite(workload.requestRate) || workload.requestRate < 1 || workload.requestRate > LIMITS.requestRate) {
    throw new Error(`Choose traffic between 1 and ${LIMITS.requestRate.toLocaleString("en-US")} requests/s.`);
  }
  if (!Number.isInteger(workload.duration) || workload.duration < 1 || workload.duration > LIMITS.duration) {
    throw new Error(`Choose a whole-number duration between 1 and ${LIMITS.duration} seconds.`);
  }
  if (!Number.isFinite(workload.readRatio) || workload.readRatio < 0 || workload.readRatio > 1) {
    throw new Error("Read traffic must be between 0 and 100%.");
  }
  if (!Number.isFinite(workload.seed)) throw new Error("The simulation seed must be a finite number.");
  if (!patterns.includes(workload.pattern) || !legacyFailures.includes(workload.failure)) {
    throw new Error("Choose a supported traffic pattern and failure scenario.");
  }
  const settings = normalizeWorkload(workload);
  if (!Number.isInteger(settings.keySpace) || settings.keySpace < 1 || settings.keySpace > LIMITS.keySpace) {
    throw new Error(`The key space must be a whole number between 1 and ${LIMITS.keySpace.toLocaleString("en-US")}.`);
  }
  if (!Number.isFinite(settings.keySkew) || settings.keySkew < 0 || settings.keySkew > 0.95) {
    throw new Error("Key skew must be between 0 (uniform) and 0.95 (extreme).");
  }
  if (!Number.isFinite(settings.crossRegionLatencyMs) || settings.crossRegionLatencyMs < 0 || settings.crossRegionLatencyMs > 5000) {
    throw new Error("Cross-region latency must be between 0 and 5,000 ms.");
  }
  if (!Number.isFinite(settings.deadlineMs) || settings.deadlineMs < 100 || settings.deadlineMs > 60000) {
    throw new Error("The request deadline must be between 100 and 60,000 ms.");
  }
  if (!Array.isArray(settings.regions) || !settings.regions.length) throw new Error("Give the traffic at least one origin region.");
  if (settings.regions.some((region) => !region.name || !Number.isFinite(region.share) || region.share <= 0)) {
    throw new Error("Every traffic region needs a name and a share above zero.");
  }
  if (!Array.isArray(settings.failures) || settings.failures.length > LIMITS.failureEvents) {
    throw new Error(`Schedule at most ${LIMITS.failureEvents} failure events.`);
  }
  for (const failure of settings.failures) {
    if (!failureKinds.includes(failure.kind)) throw new Error("Choose a supported failure kind.");
    if (!Number.isFinite(failure.at) || failure.at < 0 || failure.at > 1) {
      throw new Error("A failure must start between 0% and 100% of the run.");
    }
    if (failure.duration !== undefined && (!Number.isFinite(failure.duration) || failure.duration < 0 || failure.duration > LIMITS.duration)) {
      throw new Error(`A failure may last between 0 and ${LIMITS.duration} seconds.`);
    }
    if (failure.factor !== undefined && (!Number.isFinite(failure.factor) || failure.factor < 1 || failure.factor > 100)) {
      throw new Error("A slow-database or slow-server factor must be between 1 and 100.");
    }
    if (failure.intervalMs !== undefined && (!Number.isFinite(failure.intervalMs) || failure.intervalMs < 50 || failure.intervalMs > 60000)) {
      throw new Error("A flapping replica must change state every 50 to 60,000 ms.");
    }
    if (failure.ratio !== undefined && (!Number.isFinite(failure.ratio) || failure.ratio <= 0 || failure.ratio > 1)) {
      throw new Error("An error burst must fail between 0% (exclusive) and 100% of the replica's requests.");
    }
    if (failure.target !== undefined && !ids.has(failure.target)) {
      throw new Error("A failure event targets a component that is not in the design.");
    }
    if (failure.kind === "region" && !failure.region) {
      throw new Error("A region outage needs the name of the region to take down.");
    }
  }
}
