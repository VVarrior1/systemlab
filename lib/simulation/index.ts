import type { Architecture, MetricSample, NodeMetric, RequestTrace, SimulationResult, SystemNode, TraceStep, Workload } from "../types";
import { componentCost } from "../cost";
import { createScheduler } from "./scheduler";
import { validateSimulation } from "./validate";

export { validateSimulation } from "./validate";
export const ENGINE_VERSION = "1.1.0";
export const REQUEST_DEADLINE_MS = 5000;

interface Request {
  id: number;
  enteredAt: number;
  read: boolean;
  cacheRoll: number;
  finished: boolean;
  steps: TraceStep[];
  active?: Job;
}
interface Job {
  request: Request;
  runtime: Runtime;
  enteredAt: number;
  step: TraceStep;
  queueOwner: Runtime;
  waiting: boolean;
  settled: boolean;
  lane?: number;
}
interface JobQueue { pending: Job[]; head: number }
interface Runtime {
  node: SystemNode;
  next: Runtime[];
  queues: JobQueue[];
  alive: boolean[];
  busy: boolean[];
  active: (Job | undefined)[];
  busyTime: number[];
  replicaProcessed: number[];
  replicaErrors: number[];
  routed: number[];
  waiting: number;
  peakQueue: number;
  processed: number;
  errors: number;
  elapsed: number;
  roundRobin: number;
}
interface Bucket { completed: number; failed: number; latencies: number[]; queueDepth: number }

function randomGenerator(seed: number) {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function percentile(values: number[], proportion: number): number {
  if (!values.length) return 0;
  return values[Math.max(0, Math.ceil(values.length * proportion) - 1)];
}
const round = (value: number) => Math.round(value * 100) / 100;
const ratio = (value: number) => Math.round(value * 1000000) / 1000000;
const isApplication = (node: SystemNode) => node.kind === "server" && node.role !== "worker";

export function runSimulation(architecture: Architecture, workload: Workload): SimulationResult {
  validateSimulation(architecture, workload);
  const scheduler = createScheduler();
  const random = randomGenerator(workload.seed);
  const serviceRandom = randomGenerator(workload.seed ^ 0x85ebca6b);
  const durationMs = workload.duration * 1000;
  const horizon = durationMs + REQUEST_DEADLINE_MS;
  const runtimes = architecture.nodes.map<Runtime>((node) => ({
    node, next: [], queues: Array.from({ length: isApplication(node) ? node.replicas : 1 }, () => ({ pending: [], head: 0 })),
    alive: Array.from({ length: node.replicas }, () => node.enabled),
    busy: Array.from({ length: node.replicas }, () => false),
    active: Array.from({ length: node.replicas }, () => undefined),
    busyTime: Array.from({ length: node.replicas }, () => 0),
    replicaProcessed: Array.from({ length: node.replicas }, () => 0),
    replicaErrors: Array.from({ length: node.replicas }, () => 0),
    routed: Array.from({ length: node.replicas }, () => 0),
    waiting: 0, peakQueue: 0, processed: 0, errors: 0, elapsed: 0, roundRobin: 0,
  }));
  const byId = new Map(runtimes.map((runtime) => [runtime.node.id, runtime]));
  for (const edge of architecture.edges) byId.get(edge.source)!.next.push(byId.get(edge.target)!);
  const source = runtimes.find((runtime) => runtime.node.kind === "traffic")!;
  const failureTarget = workload.failure === "none" ? undefined : runtimes.find((runtime) => runtime.node.kind === workload.failure && runtime.node.enabled);
  const buckets: Bucket[] = Array.from({ length: workload.duration + 5 }, () => ({ completed: 0, failed: 0, latencies: [], queueDepth: 0 }));
  const successfulLatencies: number[] = [];
  const traces: RequestTrace[] = [];
  const failedTraces: RequestTrace[] = [];
  const liveRequests = new Set<Request>();
  let requestCount = 0;
  let completed = 0;
  let failed = 0;
  let completedWithinWindow = 0;
  let globalQueueDepth = 0;
  let peakGlobalQueue = 0;
  let cacheReads = 0;
  let cacheHits = 0;
  let timeoutCount = 0;

  function changeQueue(runtime: Runtime, delta: number) {
    runtime.waiting += delta;
    runtime.peakQueue = Math.max(runtime.peakQueue, runtime.waiting);
    globalQueueDepth += delta;
    peakGlobalQueue = Math.max(peakGlobalQueue, globalQueueDepth);
  }

  function settle(job: Job, status: TraceStep["status"]) {
    if (job.settled) return;
    job.settled = true;
    job.step.duration = round(scheduler.now() - job.enteredAt);
    job.step.status = status;
    job.runtime.elapsed += scheduler.now() - job.enteredAt;
    if (status === "error") {
      job.runtime.errors++;
      if (job.lane !== undefined) job.runtime.replicaErrors[job.lane]++;
    } else {
      job.runtime.processed++;
      if (job.lane !== undefined) job.runtime.replicaProcessed[job.lane]++;
    }
  }

  function finish(request: Request, success: boolean, timeout = false) {
    if (request.finished) return;
    request.finished = true;
    liveRequests.delete(request);
    const latency = scheduler.now() - request.enteredAt;
    const bucket = buckets[Math.min(buckets.length - 1, Math.floor(scheduler.now() / 1000))];
    if (success) {
      completed++;
      if (scheduler.now() < durationMs) completedWithinWindow++;
      successfulLatencies.push(latency);
      bucket.completed++;
      bucket.latencies.push(latency);
    } else {
      failed++;
      bucket.failed++;
      if (timeout) timeoutCount++;
      if (request.active) {
        if (request.active.waiting) {
          request.active.waiting = false;
          changeQueue(request.active.queueOwner, -1);
        }
        settle(request.active, "error");
      }
    }
    const trace: RequestTrace = { id: request.id, latency: round(latency), success, steps: request.steps };
    // Keep a time-spread sample plus representative failures without retaining every request.
    if (request.id <= 4 || request.id % Math.max(1, Math.floor(workload.requestRate * 2)) === 0) {
      if (traces.length < 32) traces.push(trace);
    }
    if (!success && failedTraces.length < 4) failedTraces.push(trace);
  }

  function forward(job: Job) {
    const { runtime, request } = job;
    if (request.finished) return;
    let status: TraceStep["status"] = "ok";
    if (runtime.node.kind === "cache") {
      if (request.read) cacheReads++;
      if (request.read && request.cacheRoll < runtime.node.cacheHitRate) {
        cacheHits++;
        status = "hit";
      } else status = request.read ? "miss" : "bypass";
    }
    settle(job, status);
    request.active = undefined;
    if (status === "hit" || !runtime.next.length) {
      finish(request, true);
      return;
    }
    if (runtime.node.kind === "load-balancer") {
      const healthy = runtime.next.flatMap((target) => target.alive.flatMap((alive, lane) => alive ? [{ target, lane }] : []));
      if (!healthy.length) {
        // The balancer completed its own work, but cannot deliver a response upstream.
        enter(request, runtime.next[0], runtime, 0);
      } else {
        const endpoint = healthy[runtime.roundRobin++ % healthy.length];
        enter(request, endpoint.target, runtime, endpoint.lane);
      }
    } else enter(request, runtime.next[0], runtime);
  }

  function startJob(job: Job, lane: number) {
    const { runtime, request } = job;
    if (request.finished) return;
    if (job.waiting) {
      job.waiting = false;
      changeQueue(job.queueOwner, -1);
    }
    if (job.lane === undefined) runtime.routed[lane]++;
    job.lane = lane;
    job.step.replica = lane + 1;
    runtime.busy[lane] = true;
    runtime.active[lane] = job;
    const serviceDuration = (1000 / runtime.node.capacity) * (0.85 + serviceRandom() * 0.3);
    const startedAt = scheduler.now();
    const availableUntil = runtime === failureTarget && lane === 0 ? durationMs / 2 : durationMs;
    runtime.busyTime[lane] += Math.max(0, Math.min(serviceDuration, availableUntil - startedAt));
    scheduler.after(serviceDuration, () => {
      runtime.busy[lane] = false;
      runtime.active[lane] = undefined;
      if (!request.finished) {
        if (!runtime.alive[lane]) finish(request, false);
        else scheduler.after(runtime.node.latency, () => forward(job));
      }
      drain(runtime);
    });
  }

  function drain(runtime: Runtime) {
    for (let lane = 0; lane < runtime.busy.length; lane++) {
      if (!runtime.alive[lane] || runtime.busy[lane]) continue;
      const queue = runtime.queues[isApplication(runtime.node) ? lane : 0];
      while (queue.head < queue.pending.length && queue.pending[queue.head].request.finished) queue.head++;
      const next = queue.pending[queue.head];
      if (!next) continue;
      queue.head++;
      startJob(next, lane);
    }
    for (const queue of runtime.queues) {
      if (queue.head > 1024 && queue.head * 2 > queue.pending.length) {
        queue.pending = queue.pending.slice(queue.head);
        queue.head = 0;
      }
    }
  }

  function enter(request: Request, runtime: Runtime, previous?: Runtime, selectedLane?: number) {
    if (request.finished) return;
    const step: TraceStep = { nodeId: runtime.node.id, label: runtime.node.label, startedAt: round(scheduler.now() - request.enteredAt), duration: 0, status: "ok" };
    request.steps.push(step);
    const pinnedLane = isApplication(runtime.node) ? selectedLane ?? 0 : undefined;
    const job: Job = { request, runtime, enteredAt: scheduler.now(), step, queueOwner: previous?.node.kind === "queue" ? previous : runtime, waiting: false, settled: false, lane: pinnedLane };
    request.active = job;
    if (pinnedLane !== undefined) {
      step.replica = pinnedLane + 1;
      runtime.routed[pinnedLane]++;
    }
    if (pinnedLane !== undefined ? !runtime.alive[pinnedLane] : !runtime.alive.some(Boolean)) {
      scheduler.after(Math.min(10, runtime.node.latency), () => finish(request, false));
      return;
    }
    const lane = pinnedLane !== undefined ? runtime.busy[pinnedLane] ? -1 : pinnedLane : runtime.busy.findIndex((busy, index) => !busy && runtime.alive[index]);
    if (lane >= 0) startJob(job, lane);
    else {
      job.waiting = true;
      runtime.queues[pinnedLane ?? 0].pending.push(job);
      changeQueue(job.queueOwner, 1);
    }
  }

  if (failureTarget) {
    scheduler.after(durationMs / 2, () => {
      failureTarget.alive[0] = false;
      const active = failureTarget.active[0];
      if (active) finish(active.request, false);
      if (isApplication(failureTarget.node) || !failureTarget.alive.some(Boolean)) {
        const queue = failureTarget.queues[0];
        for (let i = queue.head; i < queue.pending.length; i++) finish(queue.pending[i].request, false);
        queue.pending = [];
        queue.head = 0;
      }
      drain(failureTarget);
    });
  }

  for (let second = 0; second < workload.duration; second++) {
    const progress = (second + 0.5) / workload.duration;
    const multiplier = workload.pattern === "spike" && progress >= 0.35 && progress < 0.65
      ? 2 : workload.pattern === "ramp" ? 0.3 + 1.4 * progress : 1;
    const arrivals = Math.round(workload.requestRate * multiplier);
    for (let index = 0; index < arrivals; index++) {
      const arrivalTime = second * 1000 + (index + 0.1 + random() * 0.8) / arrivals * 1000;
      const read = random() < workload.readRatio;
      const cacheRoll = random();
      scheduler.after(arrivalTime, () => {
        const request: Request = { id: ++requestCount, enteredAt: scheduler.now(), read, cacheRoll, finished: false, steps: [] };
        source.processed++;
        liveRequests.add(request);
        scheduler.after(REQUEST_DEADLINE_MS, () => finish(request, false, true));
        enter(request, source.next[0]);
      });
    }
  }
  for (let second = 0; second < buckets.length; second++) {
    scheduler.after((second + 1) * 1000 - 0.001, () => { buckets[second].queueDepth = globalQueueDepth; });
  }
  scheduler.run(horizon);
  for (const request of liveRequests) finish(request, false, true);

  successfulLatencies.sort((a, b) => a - b);
  const lastActiveBucket = buckets.reduce((last, bucket, index) => bucket.completed || bucket.failed || bucket.queueDepth ? index : last, workload.duration - 1);
  const samples: MetricSample[] = buckets.slice(0, lastActiveBucket + 1).map((bucket, index) => {
    bucket.latencies.sort((a, b) => a - b);
    return {
      time: index + 1,
      latency: round(bucket.latencies.reduce((sum, value) => sum + value, 0) / (bucket.latencies.length || 1)),
      p95: round(percentile(bucket.latencies, 0.95)),
      throughput: bucket.completed,
      errorRate: ratio(bucket.failed / (bucket.completed + bucket.failed || 1)),
      queueDepth: bucket.queueDepth,
    };
  });
  const nodes: NodeMetric[] = runtimes.map((runtime) => {
    const availableReplicaMs = runtime.node.enabled
      ? durationMs * runtime.node.replicas - (runtime === failureTarget ? durationMs / 2 : 0) : 0;
    return {
      nodeId: runtime.node.id,
      utilization: runtime.node.kind === "traffic" ? 0 : ratio(Math.min(1, runtime.busyTime.reduce((sum, value) => sum + value, 0) / (availableReplicaMs || 1))),
      queueDepth: runtime.peakQueue,
      processed: runtime.processed,
      errors: runtime.errors,
      avgLatency: round(runtime.elapsed / (runtime.processed + runtime.errors || 1)),
      healthyReplicas: runtime.alive.filter(Boolean).length,
      ...(runtime.node.kind !== "traffic" ? { replicas: runtime.busyTime.map((time, index) => ({
        index: index + 1,
        processed: runtime.replicaProcessed[index],
        errors: runtime.replicaErrors[index],
        utilization: runtime.node.enabled ? ratio(Math.min(1, time / (runtime === failureTarget && index === 0 ? durationMs / 2 : durationMs))) : 0,
      })) } : {}),
    };
  });
  const insights: SimulationResult["insights"] = [];
  const pressure = (metric: NodeMetric) => isApplication(byId.get(metric.nodeId)!.node)
    ? Math.max(metric.utilization, ...(metric.replicas ?? []).map((replica) => replica.utilization)) : metric.utilization;
  const bottleneck = [...nodes].filter((metric) => byId.get(metric.nodeId)!.node.kind !== "traffic").sort((a, b) => pressure(b) - pressure(a))[0];
  if (bottleneck && pressure(bottleneck) >= 0.8) {
    const runtime = byId.get(bottleneck.nodeId)!;
    insights.push({ severity: pressure(bottleneck) >= 0.95 ? "critical" : "warning", title: `${runtime.node.label} is the busiest stage`, detail: `${round(pressure(bottleneck) * 100)}% utilization at its busiest routed processing unit (${round(bottleneck.utilization * 100)}% across the component). Its peak waiting line reached ${bottleneck.queueDepth} requests; inspect routing and downstream dependencies before adding capacity.`, nodeId: bottleneck.nodeId });
  }
  for (const metric of nodes) {
    const runtime = byId.get(metric.nodeId)!;
    if (!isApplication(runtime.node) || runtime.node.replicas < 2 || !runtime.node.enabled) continue;
    const idle = runtime.routed.flatMap((count, index) => count === 0 ? [index + 1] : []);
    if (idle.length) {
      const hasBalancer = runtimes.some((parent) => parent.node.kind === "load-balancer" && parent.next.includes(runtime));
      insights.push({ severity: "warning", title: `${runtime.node.label} has idle replicas`, detail: `Replica${idle.length > 1 ? "s" : ""} ${idle.join(", ")} received no requests. ${hasBalancer ? "Inspect the load-balancer routes and healthy endpoints for this workload." : "Direct application connections reach replica 1 only. Connect a load balancer to distribute traffic to the additional replicas."}`, nodeId: runtime.node.id });
    }
    const saturated = (metric.replicas ?? []).filter((replica) => replica.utilization >= 0.8);
    if (saturated.length) insights.push({ severity: saturated.some((replica) => replica.utilization >= 0.95) ? "critical" : "warning", title: `${runtime.node.label}: inspect individual replica load`, detail: `${saturated.map((replica) => `Replica ${replica.index}: ${round(replica.utilization * 100)}%`).join("; ")}. The component average is ${round(metric.utilization * 100)}%; unused replicas cannot process requests pinned to a busy replica.`, nodeId: runtime.node.id });
  }
  if (timeoutCount) insights.push({ severity: "critical", title: `${timeoutCount.toLocaleString("en-US")} requests timed out`, detail: "These requests exceeded the 5,000 ms end-to-end deadline. Failed requests are included in the error rate and excluded from successful-response latency percentiles." });
  if (failureTarget) insights.push({ severity: failed ? "warning" : "good", title: `${failureTarget.node.label} replica 1 failed at ${workload.duration / 2}s`, detail: `${failureTarget.node.replicas - 1} replicas remained in that component. The run finished with ${failed.toLocaleString("en-US")} failed requests across all causes. ${isApplication(failureTarget.node) ? "Load balancers route new requests to healthy endpoints; direct connections keep targeting replica 1. Work pinned to the failed replica is not retried or moved." : "The managed pool or worker queue sends unassigned work to healthy replicas; work already executing on the failed replica fails."}`, nodeId: failureTarget.node.id });
  else if (workload.failure !== "none") insights.push({ severity: "warning", title: "No matching failure target", detail: `There is no enabled ${workload.failure} component to fail in this design.` });
  if (cacheReads) insights.push({ severity: cacheHits ? "good" : "warning", title: `${round(cacheHits / cacheReads * 100)}% of cache reads were hits`, detail: `${cacheHits.toLocaleString("en-US")} read requests avoided the database. Writes and cache misses continued downstream; cache freshness is not simulated.` });
  if (runtimes.some((runtime) => runtime.node.kind === "queue")) insights.push({ severity: peakGlobalQueue > workload.requestRate ? "warning" : "good", title: "Queued work is measured through completion", detail: "Queue acceptance does not count as a successful job. Waiting workers contribute to the upstream queue depth, and every job retains the same five-second completion deadline." });
  if (!failed && (!bottleneck || pressure(bottleneck) < 0.8)) insights.push({ severity: "good", title: "All requests completed within the deadline", detail: `The busiest routed processing unit used ${round((bottleneck ? pressure(bottleneck) : 0) * 100)}% of available capacity. Test a higher load or a failure before treating this headroom as sufficient.` });
  const traceMap = new Map([...traces, ...failedTraces].map((trace) => [trace.id, trace]));
  return {
    engineVersion: ENGINE_VERSION,
    seed: workload.seed,
    duration: workload.duration,
    requestCount,
    completed,
    failed,
    p50: round(percentile(successfulLatencies, 0.5)),
    p95: round(percentile(successfulLatencies, 0.95)),
    throughput: round(completedWithinWindow / workload.duration),
    errorRate: ratio(failed / (requestCount || 1)),
    cost: round(runtimes.reduce((sum, runtime) => sum + (runtime.node.kind !== "traffic" && runtime.node.enabled ? componentCost(runtime.node) * runtime.node.replicas : 0), 0)),
    maxQueueDepth: peakGlobalQueue,
    nodes,
    samples,
    traces: [...traceMap.values()].sort((a, b) => a.id - b.id),
    insights,
    assumptions: [
      `Engine ${ENGINE_VERSION}; discrete events scheduled by SIM.JS. Identical graph order, settings, seed and engine version reproduce identical results.`,
      "Each replica provides one processing lane. Application replicas have separate FIFO queues; workers and managed components share a FIFO queue. Processing averages 1,000 / capacity ms with seeded +/-15% variation; configured latency is added outside the occupied lane.",
      "Traffic arrives throughout each second with seeded timing variation. A spike doubles traffic during the middle 30% of the run; a ramp increases from 30% to 170% of the configured rate.",
      "All generated requests are simulated individually. Supported runs are 1-60 seconds at 1-2,000 base requests/s, with at most 48 components.",
      "All requests have a 5,000 ms end-to-end deadline. Arrivals stop at the configured duration; outstanding work is observed for up to five additional seconds.",
      "Throughput is successful completions during the configured traffic window divided by its duration. Latency percentiles include successful requests, including the drain period; error rate includes all generated requests. A zero latency percentile means no successful requests when completed is zero.",
      "Chart points are one-second completion buckets, including the drain period. Queue depth on components is the peak waiting line; utilization measures occupied processing time against available replica time during the traffic window.",
      "A direct traffic or dependency connection to an application server targets replica 1 only, without automatic distribution or failover. A load balancer routes round robin over all healthy (server, replica) endpoints; a server with two replicas receives twice the share of a server with one replica.",
      "Application requests stay pinned to the chosen replica, including while queued. An idle replica cannot take another replica's queued requests. Dependency calls are sequential; database and terminal server responses finish the request.",
      "Cache hit probability applies only to reads; read misses visit the database, while writes bypass lookup and continue to storage. Warm-up, key skew, eviction, invalidation and stale data are not modeled.",
      "Queues buffer FIFO jobs for a shared worker pull pool. Healthy workers take unassigned jobs as they become free. Reported latency includes full job completion, not acknowledgment; durability and duplicate delivery are not modeled.",
      "A configured failure removes replica 1 from the first enabled matching component halfway through the run. Active work on that replica fails. Application work queued there also fails; unassigned managed-pool and worker jobs remain available. There are no retries, recovery or request migration; load-balancer health detection is idealized and immediate.",
      "Database, cache, load-balancer and queue replicas are abstract managed pools with idealized distribution across healthy capacity. These pools do not teach deployment-level routing or real failover protocols. Database replication lag, write coordination, consistency and consensus are not simulated.",
      "Costs are teaching credits, calculated from canonical component-type capacity rates times replica count. Imported cost fields are ignored; this is not provider pricing. Enabled replicas are billed even if traffic never reaches them or they fail during the run.",
    ],
  };
}
