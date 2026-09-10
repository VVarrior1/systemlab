import type { FailureEvent, NodeKind, NodeMetric, SimulationEvent, SimulationResult, Workload } from "../types";

export interface NodeTelemetry {
  id: string;
  label: string;
  kind: NodeKind;
  enabled: boolean;
  replicas: number;
  isApplication: boolean;
  hasBalancerParent: boolean;
  routed: number[];
  metric: NodeMetric;
  callsReceived: number;
  callersProcessed: number;
  cacheReads: number;
  cacheHits: number;
  cacheCoalesced: number;
  cacheModel: "probabilistic" | "keyed";
  dbMode: "single" | "leader-follower" | "sharded";
  staleServed: number;
  detectionFailures: number;
  healthCheckMs: number;
  breakerOpens: number;
  retries: number;
  timeoutMs: number;
  maxQueue: number;
  shardUtilization?: number[];
}

export interface Telemetry {
  workload: Required<Workload>;
  duration: number;
  requestCount: number;
  completed: number;
  failed: number;
  rejected: number;
  deadlineTimeouts: number;
  errorRate: number;
  rejectedRate: number;
  successRate: number;
  p50: number;
  p95: number;
  p99: number;
  maxQueueDepth: number;
  readRequests: number;
  staleReads: number;
  staleReadRate: number;
  retriesIssued: number;
  abandonedCalls: number;
  zombieReturns: number;
  amplification: number;
  amplifiedNodeId?: string;
  amplifiedNodeLabel?: string;
  cacheReads: number;
  cacheHits: number;
  crossRegionRequests: number;
  crossRegionP95: number;
  localP95: number;
  postFlushDbRate: number;
  steadyDbRate: number;
  hasCacheFlush: boolean;
  hasQueue: boolean;
  events: SimulationEvent[];
  nodes: NodeTelemetry[];
  failures: FailureEvent[];
  legacyFailure: Workload["failure"];
}

type Insight = SimulationResult["insights"][number];

const round = (value: number) => Math.round(value * 100) / 100;
const percent = (value: number) => `${round(value * 100)}%`;
const count = (value: number) => value.toLocaleString("en-US");

function pressureOf(node: NodeTelemetry): number {
  if (!node.isApplication) return node.metric.utilization;
  const replicas = node.metric.replicas ?? [];
  return Math.max(node.metric.utilization, ...replicas.map((replica) => replica.utilization));
}

/**
 * Every rule states the mechanism and the measurement behind it. A learner should be able to check
 * each number against the metrics panel, and none of them may say "add capacity" without saying why.
 */
export function buildInsights(telemetry: Telemetry): Insight[] {
  const insights: Insight[] = [];
  const working = telemetry.nodes.filter((node) => node.kind !== "traffic");

  // ---- busiest stage -------------------------------------------------------
  const bottleneck = [...working].sort((a, b) => pressureOf(b) - pressureOf(a))[0];
  const bottleneckPressure = bottleneck ? pressureOf(bottleneck) : 0;
  if (bottleneck && bottleneckPressure >= 0.8) {
    insights.push({
      severity: bottleneckPressure >= 0.95 ? "critical" : "warning",
      title: `${bottleneck.label} is the busiest stage`,
      detail: `${percent(bottleneckPressure)} utilization at its busiest processing lane (${percent(bottleneck.metric.utilization)} across the component). Its peak waiting line reached ${count(bottleneck.metric.queueDepth)} requests and it processed ${count(bottleneck.metric.processed)}. Utilization above 80% means the queue grows faster than it drains whenever arrivals cluster, which is what turns a heavy service-time tail into a latency spike.`,
      nodeId: bottleneck.id,
    });
  }

  // ---- replica routing -----------------------------------------------------
  for (const node of working) {
    if (!node.isApplication || node.replicas < 2 || !node.enabled) continue;
    const idle = node.routed.flatMap((routed, lane) => (routed === 0 ? [lane + 1] : []));
    if (idle.length) {
      insights.push({
        severity: "warning",
        title: `${node.label} has idle replicas`,
        detail: `Replica${idle.length > 1 ? "s" : ""} ${idle.join(", ")} received no requests. ${
          node.hasBalancerParent
            ? "Check the load-balancer routes and which endpoints it believes are healthy for this workload."
            : "A direct connection to an application server reaches replica 1 only. Put a load balancer in front of it to use the other replicas."
        } You are paying for every enabled replica whether or not traffic reaches it.`,
        nodeId: node.id,
      });
    }
    const saturated = (node.metric.replicas ?? []).filter((replica) => replica.utilization >= 0.8);
    if (saturated.length) {
      insights.push({
        severity: saturated.some((replica) => replica.utilization >= 0.95) ? "critical" : "warning",
        title: `${node.label}: inspect individual replica load`,
        detail: `${saturated.map((replica) => `Replica ${replica.index}: ${percent(replica.utilization)}`).join("; ")}. The component average is ${percent(node.metric.utilization)}. Requests stay pinned to the replica they were routed to, so an idle replica cannot take work queued on a busy one.`,
        nodeId: node.id,
      });
    }
  }

  // ---- deliberate shedding -------------------------------------------------
  if (telemetry.rejected > 0) {
    const shedders = working.filter((node) => (node.metric.rejected ?? 0) > 0);
    insights.push({
      severity: telemetry.rejectedRate > 0.25 ? "warning" : "good",
      title: `${count(telemetry.rejected)} requests were shed on purpose (${percent(telemetry.rejectedRate)})`,
      detail: `${shedders.map((node) => `${node.label}: ${count(node.metric.rejected ?? 0)}`).join("; ") || "No single component dominates"}. Shed requests are rejected in a few milliseconds instead of queueing, so the ${count(telemetry.completed)} accepted requests kept a p95 of ${round(telemetry.p95)} ms and an unexpected-error rate of ${percent(telemetry.errorRate)}. Shedding trades availability for predictable latency; decide which one your users notice.`,
      ...(shedders.length === 1 ? { nodeId: shedders[0].id } : {}),
    });
  }

  // ---- retries and amplification ------------------------------------------
  if (telemetry.retriesIssued > 0 || telemetry.amplification >= 1.2) {
    const perRequest = round(telemetry.retriesIssued / (telemetry.requestCount || 1));
    insights.push({
      severity: telemetry.amplification >= 1.5 ? "critical" : "warning",
      title: `Dependency load was amplified ${round(telemetry.amplification)}x`,
      detail: `${telemetry.amplifiedNodeLabel ?? "The busiest dependency"} received ${round(telemetry.amplification)} calls for every request its callers processed, and ${count(telemetry.retriesIssued)} retries were issued (${perRequest} per request). A retry sends more load into a component that is already failing, so retries help only when the failure is independent and rare. Cap retries, add jitter (already applied here), and put a breaker in front of a dependency that is failing systematically.`,
      ...(telemetry.amplifiedNodeId ? { nodeId: telemetry.amplifiedNodeId } : {}),
    });
  }

  // ---- abandoned work ------------------------------------------------------
  if (telemetry.abandonedCalls > 0) {
    insights.push({
      severity: telemetry.zombieReturns > telemetry.requestCount * 0.05 ? "warning" : "good",
      title: `${count(telemetry.abandonedCalls)} dependency calls were abandoned at their timeout`,
      detail: `${count(telemetry.zombieReturns)} of them finished downstream anyway. A timeout frees the caller, not the callee: that work still occupies a lane, so a short timeout with retries can multiply the load on the very component you are trying to protect. Pick a timeout above the dependency's p99 and let the breaker handle systematic failure.`,
    });
  }

  // ---- circuit breakers ----------------------------------------------------
  const breakerOpens = telemetry.nodes.reduce((sum, node) => sum + node.breakerOpens, 0);
  if (breakerOpens > 0) {
    const owners = telemetry.nodes.filter((node) => node.breakerOpens > 0);
    insights.push({
      severity: "warning",
      title: `Circuit breakers opened ${count(breakerOpens)} time${breakerOpens === 1 ? "" : "s"}`,
      detail: `${owners.map((node) => `${node.label}: ${count(node.breakerOpens)}`).join("; ")}. A breaker opens after at least 20 dependency calls in one second with at least 50% failures, and then fails calls in microseconds for five seconds. Those fast failures are counted as rejected, not as errors: the breaker converts a slow, resource-consuming failure into a cheap one and gives the dependency room to recover.`,
      ...(owners.length === 1 ? { nodeId: owners[0].id } : {}),
    });
  }

  // ---- detection delay -----------------------------------------------------
  for (const node of telemetry.nodes) {
    if (node.detectionFailures <= 0) continue;
    insights.push({
      severity: "warning",
      title: `${node.label} kept routing to a dead endpoint for up to ${count(node.healthCheckMs)} ms`,
      detail: `${count(node.detectionFailures)} requests were sent to an endpoint that had already died but was still marked healthy in the last health check. Detection is not free: a balancer only learns about a death at its next check, so the expected number of doomed requests is roughly the traffic to that endpoint times the check interval. Shortening the interval costs check traffic; lengthening it costs availability.`,
      nodeId: node.id,
    });
  }

  // ---- deadline ------------------------------------------------------------
  if (telemetry.deadlineTimeouts > 0) {
    insights.push({
      severity: "critical",
      title: `${count(telemetry.deadlineTimeouts)} requests hit the 5,000 ms deadline`,
      detail: `These requests were still queued or waiting on a dependency after five seconds and were abandoned. They count as errors, not as rejections, and they are excluded from the latency percentiles, so a design that times out everything can still report a small p95 over the handful that made it. Compare successRate (${percent(telemetry.successRate)}) with p95 before believing a latency number.`,
    });
  }

  // ---- failures ------------------------------------------------------------
  if (telemetry.failures.length) {
    const summary = telemetry.failures
      .map((failure) => `${failure.kind} at ${round(failure.at * telemetry.duration)}s${failure.duration ? ` for ${failure.duration}s` : " with no recovery"}`)
      .join("; ");
    insights.push({
      severity: telemetry.failed > telemetry.rejected ? "warning" : "good",
      title: `${telemetry.failures.length} failure event${telemetry.failures.length === 1 ? "" : "s"} ran during this workload`,
      detail: `${summary}. The run ended with ${count(telemetry.failed)} failed requests, of which ${count(telemetry.rejected)} were deliberate rejections, leaving an unexpected-error rate of ${percent(telemetry.errorRate)}. Work already executing on a dead lane fails; work queued behind it fails only when its pool has no healthy lane left. Recovered replicas restart with an empty queue and no request is migrated.`,
    });
  } else if (telemetry.legacyFailure !== "none") {
    insights.push({
      severity: "warning",
      title: "No matching failure target",
      detail: `There is no enabled ${telemetry.legacyFailure} component to fail in this design, so the scenario had no effect.`,
    });
  }

  // ---- caching -------------------------------------------------------------
  if (telemetry.cacheReads > 0) {
    const hitRate = telemetry.cacheHits / telemetry.cacheReads;
    const coalesced = telemetry.nodes.reduce((sum, node) => sum + node.cacheCoalesced, 0);
    insights.push({
      severity: hitRate >= 0.5 ? "good" : "warning",
      title: `${percent(hitRate)} of cache reads were hits`,
      detail: `${count(telemetry.cacheHits)} reads avoided the origin${coalesced ? `, including ${count(coalesced)} that were coalesced onto another request's fetch` : ""}. Writes and misses still travel downstream, so the load your database sees is (writes + read misses), not (1 - hit rate) of everything. A keyed cache only reaches a high hit rate when the working set fits: entries below the hot-key set evict each other.`,
    });
  }
  if (telemetry.hasCacheFlush) {
    const multiple = telemetry.steadyDbRate > 0 ? telemetry.postFlushDbRate / telemetry.steadyDbRate : 0;
    insights.push({
      severity: multiple >= 1.5 ? "critical" : "good",
      title: `Origin load was ${round(multiple)}x higher in the 3 s after a cache flush`,
      detail: `${count(Math.round(telemetry.postFlushDbRate))} database calls/s just after the flush against ${count(Math.round(telemetry.steadyDbRate))}/s in steady state. A cold cache sends every read to the origin at once, and without request coalescing every concurrent miss on the same hot key becomes its own origin call. Size the origin for the cold-start burst, or coalesce and warm the cache.`,
    });
  }

  // ---- staleness -----------------------------------------------------------
  if (telemetry.staleReads > 0) {
    const owners = telemetry.nodes.filter((node) => node.staleServed > 0);
    insights.push({
      severity: telemetry.staleReadRate > 0.05 ? "warning" : "good",
      title: `${percent(telemetry.staleReadRate)} of reads returned stale data`,
      detail: `${count(telemetry.staleReads)} of ${count(telemetry.readRequests)} reads were served data older than the last write to that key${owners.length ? ` (${owners.map((node) => `${node.label}: ${count(node.staleServed)}`).join("; ")})` : ""}. Replication lag and cached entries are the price of read scale-out. Read-your-writes routing removes it for the writer at the cost of leader load; a shorter TTL removes it for cached keys at the cost of hit rate.`,
      ...(owners.length === 1 ? { nodeId: owners[0].id } : {}),
    });
  }

  // ---- partitioning --------------------------------------------------------
  for (const node of telemetry.nodes) {
    const shards = node.shardUtilization;
    if (!shards || shards.length < 2) continue;
    const max = Math.max(...shards);
    const mean = shards.reduce((sum, value) => sum + value, 0) / shards.length;
    if (mean <= 0) continue;
    const skew = max / mean;
    insights.push({
      severity: skew >= 2 ? "critical" : skew >= 1.3 ? "warning" : "good",
      title: `${node.label}: hottest shard runs ${round(skew)}x the average`,
      detail: `Shard utilization is ${shards.map((value) => percent(value)).join(", ")}. Adding shards only helps if the key distribution spreads across them: range partitioning over skewed keys piles the hot end onto one shard, while hashing spreads it but gives up range scans. The hottest shard, not the average, sets your write latency.`,
      nodeId: node.id,
    });
  }

  // ---- regions -------------------------------------------------------------
  if (telemetry.crossRegionRequests > 0) {
    const share = telemetry.crossRegionRequests / (telemetry.completed || 1);
    insights.push({
      severity: telemetry.crossRegionP95 > telemetry.localP95 * 1.5 ? "warning" : "good",
      title: `${percent(share)} of successful requests crossed a region`,
      detail: `Their p95 is ${round(telemetry.crossRegionP95)} ms against ${round(telemetry.localP95)} ms for requests served entirely in one region, at ${count(telemetry.workload.crossRegionLatencyMs)} ms per crossing. Every cross-region hop is added latency you cannot optimise away in software: move the data, move the read, or accept the round trip.`,
    });
  }

  // ---- queues --------------------------------------------------------------
  if (telemetry.hasQueue) {
    insights.push({
      severity: telemetry.maxQueueDepth > telemetry.workload.requestRate ? "warning" : "good",
      title: "Queued work is measured through completion",
      detail: `Peak backlog was ${count(telemetry.maxQueueDepth)} jobs against an arrival rate of ${count(telemetry.workload.requestRate)}/s. Accepting a job into a queue is not success: it still has to be processed inside the five-second deadline, and by Little's law the wait is backlog divided by drain rate. A queue absorbs a burst; it cannot raise the long-run drain rate.`,
    });
  }

  // ---- all clear -----------------------------------------------------------
  if (!telemetry.failed && bottleneckPressure < 0.8) {
    insights.push({
      severity: "good",
      title: "Every request completed inside the deadline",
      detail: `The busiest lane used ${percent(bottleneckPressure)} of its available capacity and p99 was ${round(telemetry.p99)} ms against a p50 of ${round(telemetry.p50)} ms. Headroom at a steady rate is not resilience: run the same design with a spike, a failure event or a cold cache before trusting it.`,
    });
  }

  return insights;
}
