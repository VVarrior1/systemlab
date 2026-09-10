import type {
  Architecture,
  FailureEvent,
  MetricSample,
  NodeKind,
  NodeMetric,
  RequestTrace,
  SimulationEvent,
  SimulationResult,
  SystemNode,
  TraceStatus,
  TraceStep,
  Workload,
} from "../types";
import { architectureCost, nodeCost } from "../cost";
import { normalizeNode, normalizeWorkload } from "../templates";
import { FetchCoalescer, KeyedCache, probabilisticHitRate } from "./cache";
import { createRandom, fullJitterBackoff, lognormalMultiplier, powerLawKey, sigmaFor, weightedIndex } from "./distributions";
import { buildInsights, type NodeTelemetry, type Telemetry } from "./insights";
import { createScheduler } from "./scheduler";
import { validateSimulation } from "./validate";

export { validateSimulation } from "./validate";
export const ENGINE_VERSION = "2.0.0";
export const REQUEST_DEADLINE_MS = 5000;

/** Rolling window the circuit breaker judges dependency health over. */
const BREAKER_WINDOW_MS = 1000;
const BREAKER_MIN_CALLS = 20;
const BREAKER_FAILURE_RATIO = 0.5;
const BREAKER_OPEN_MS = 5000;
/** No unit of work is instantaneous, however much capacity it has. */
const MIN_SERVICE_MS = 0.02;
/** Roughly how many requests carry a full step trace. Sampling keeps big runs cheap. */
const TRACE_TARGET = 600;
const MAX_TRACES = 32;
const MAX_FAILED_TRACES = 4;

type NodeSettings = ReturnType<typeof normalizeNode>;
type Done = (ok: boolean) => void;

const FINISH_NORMAL = 0;
const FINISH_REJECTED = 1;
const FINISH_DEADLINE = 2;

interface Req {
  id: number;
  enteredAt: number;
  read: boolean;
  key: number;
  region: string;
  cacheRoll: number;
  edgeRoll: number;
  finished: boolean;
  traced: boolean;
  stale: boolean;
  crossRegionMs: number;
  steps: TraceStep[];
  pending: Job[];
}

interface Pool {
  lanes: number[];
  pending: Job[];
  head: number;
  waiting: number;
  roundRobin: number;
}

interface Job {
  request: Req;
  runtime: Runtime;
  pool: Pool;
  enteredAt: number;
  step: TraceStep | undefined;
  queueOwner: Runtime;
  waiting: boolean;
  settled: boolean;
  lane: number;
  stale: boolean;
  done: Done;
}

interface DeadInterval {
  from: number;
  to: number;
}

interface Runtime {
  node: SystemNode;
  settings: NodeSettings;
  kind: NodeKind;
  region: string;
  isApplication: boolean;
  isWorker: boolean;
  next: Runtime[];
  parents: Runtime[];
  lanes: number;
  pools: Pool[];
  poolOfLane: number[];
  alive: boolean[];
  busy: boolean[];
  active: (Job | undefined)[];
  busyTime: number[];
  laneProcessed: number[];
  laneErrors: number[];
  routed: number[];
  deadIntervals: DeadInterval[][];
  waiting: number;
  peakQueue: number;
  processed: number;
  errors: number;
  rejected: number;
  elapsed: number;
  callsReceived: number;
  sigma: number;
  serviceBase: number;
  slowUntil: number;
  slowFactor: number;
  // cache / cdn
  cache?: KeyedCache;
  coalescer?: FetchCoalescer;
  lastFlushAt: number;
  cacheReads: number;
  cacheHits: number;
  cacheCoalesced: number;
  cacheStale: number;
  flushes: number;
  // rate limiter
  tokens: number;
  lastRefill: number;
  // load balancer
  endpoints: { target: Runtime; lane: number }[];
  healthView: boolean[];
  nextHealthCheck: number;
  detectionFailures: number;
  roundRobin: number;
  // circuit breaker
  breakerEnabled: boolean;
  simpleCall: boolean;
  breakerState: "closed" | "open" | "half-open";
  breakerOpenUntil: number;
  breakerProbe: boolean;
  breakerTimes: number[];
  breakerBad: number[];
  breakerHead: number;
  breakerBadCount: number;
  breakerOpens: number;
  // database
  leaderLane: number;
  failoverUntil: number;
  committed?: Map<number, number>;
  followerCursor: number;
  staleServed: number;
  failoverRejects: number;
  shardOfLane: number[];
  shardCalls: number[];
}

interface Bucket {
  completed: number;
  failed: number;
  rejected: number;
  latencies: number[];
  queueDepth: number;
}

function percentile(values: number[], proportion: number): number {
  if (!values.length) return 0;
  return values[Math.max(0, Math.ceil(values.length * proportion) - 1)];
}
const round = (value: number) => Math.round(value * 100) / 100;
const ratio = (value: number) => Math.round(value * 1000000) / 1000000;
const isApplicationServer = (node: SystemNode) => node.kind === "server" && node.role !== "worker";

export function runSimulation(architecture: Architecture, workload: Workload): SimulationResult {
  validateSimulation(architecture, workload);
  const plan = normalizeWorkload(workload);
  const scheduler = createScheduler();
  const now = scheduler.now;
  const workloadRandom = createRandom(plan.seed);
  const serviceRandom = createRandom(plan.seed ^ 0x85ebca6b);
  const chaosRandom = createRandom(plan.seed ^ 0xc2b2ae35);
  const durationMs = plan.duration * 1000;
  const horizon = durationMs + REQUEST_DEADLINE_MS;
  const crossRegionLatencyMs = plan.crossRegionLatencyMs;

  // ---------------------------------------------------------------- runtimes

  const runtimes: Runtime[] = architecture.nodes.map((node, nodeIndex) => {
    const settings = normalizeNode(node);
    const isApplication = isApplicationServer(node);
    const sharded = node.kind === "database" && settings.dbMode === "sharded";
    const shards = sharded ? Math.max(1, settings.shards) : 1;
    const lanes = node.replicas * shards;
    const pools: Pool[] = [];
    const poolOfLane: number[] = new Array(lanes).fill(0);
    const shardOfLane: number[] = new Array(lanes).fill(0);
    const newPool = (poolLanes: number[]): Pool => ({ lanes: poolLanes, pending: [], head: 0, waiting: 0, roundRobin: 0 });
    if (isApplication || (node.kind === "database" && settings.dbMode === "leader-follower")) {
      // One lane per pool: application replicas are addressed directly, and a leader or a follower
      // is a distinct endpoint rather than an interchangeable member of a pool.
      for (let lane = 0; lane < lanes; lane++) {
        poolOfLane[lane] = pools.length;
        pools.push(newPool([lane]));
      }
    } else if (sharded) {
      for (let shard = 0; shard < shards; shard++) {
        const poolLanes: number[] = [];
        for (let replica = 0; replica < node.replicas; replica++) {
          const lane = shard * node.replicas + replica;
          poolLanes.push(lane);
          poolOfLane[lane] = shard;
          shardOfLane[lane] = shard;
        }
        pools.push(newPool(poolLanes));
      }
    } else {
      const poolLanes: number[] = [];
      for (let lane = 0; lane < lanes; lane++) poolLanes.push(lane);
      pools.push(newPool(poolLanes));
    }
    const breakerEnabled = node.kind === "server" && settings.circuitBreaker;
    return {
      node,
      settings,
      kind: node.kind,
      region: settings.region,
      isApplication,
      isWorker: node.kind === "server" && node.role === "worker",
      next: [],
      parents: [],
      lanes,
      pools,
      poolOfLane,
      alive: new Array(lanes).fill(node.enabled),
      busy: new Array(lanes).fill(false),
      active: new Array<Job | undefined>(lanes).fill(undefined),
      busyTime: new Array(lanes).fill(0),
      laneProcessed: new Array(lanes).fill(0),
      laneErrors: new Array(lanes).fill(0),
      routed: new Array(lanes).fill(0),
      deadIntervals: Array.from({ length: lanes }, () => [] as DeadInterval[]),
      waiting: 0,
      peakQueue: 0,
      processed: 0,
      errors: 0,
      rejected: 0,
      elapsed: 0,
      callsReceived: 0,
      sigma: sigmaFor(settings.variance),
      serviceBase: 1000 / Math.max(1, node.capacity),
      slowUntil: 0,
      slowFactor: 1,
      cache: node.kind === "cache" && settings.cacheModel === "keyed" ? new KeyedCache(settings.cacheEntries, settings.ttlMs) : undefined,
      coalescer: node.kind === "cache" && settings.cacheModel === "keyed" && settings.coalesce ? new FetchCoalescer() : undefined,
      lastFlushAt: 0,
      cacheReads: 0,
      cacheHits: 0,
      cacheCoalesced: 0,
      cacheStale: 0,
      flushes: 0,
      tokens: settings.burst,
      lastRefill: 0,
      endpoints: [],
      healthView: [],
      // Health checks run on their own clock, not the simulation's. The golden-ratio phase keeps a
      // balancer's checks from landing exactly on failure times or in lockstep with other balancers.
      nextHealthCheck: settings.healthCheckMs * ((nodeIndex + 1) * 0.6180339887498949 % 1),
      detectionFailures: 0,
      roundRobin: 0,
      breakerEnabled,
      simpleCall: !breakerEnabled && settings.retries === 0 && settings.timeoutMs === 0,
      breakerState: "closed",
      breakerOpenUntil: 0,
      breakerProbe: false,
      breakerTimes: [],
      breakerBad: [],
      breakerHead: 0,
      breakerBadCount: 0,
      breakerOpens: 0,
      leaderLane: 0,
      failoverUntil: 0,
      committed: node.kind === "database" && settings.dbMode !== "single" ? new Map<number, number>() : undefined,
      followerCursor: 0,
      staleServed: 0,
      failoverRejects: 0,
      shardOfLane,
      shardCalls: new Array(shards).fill(0),
    } satisfies Runtime;
  });

  const byId = new Map(runtimes.map((runtime) => [runtime.node.id, runtime]));
  for (const edge of architecture.edges) {
    const source = byId.get(edge.source)!;
    const target = byId.get(edge.target)!;
    source.next.push(target);
    target.parents.push(source);
  }
  for (const runtime of runtimes) {
    if (runtime.kind !== "load-balancer") continue;
    for (const target of runtime.next) {
      for (let lane = 0; lane < target.lanes; lane++) runtime.endpoints.push({ target, lane });
    }
    runtime.healthView = runtime.endpoints.map((endpoint) => endpoint.target.alive[endpoint.lane]);
  }
  const source = runtimes.find((runtime) => runtime.kind === "traffic")!;
  const databases = runtimes.filter((runtime) => runtime.kind === "database");
  const caches = runtimes.filter((runtime) => runtime.kind === "cache");

  // ---------------------------------------------------------------- counters

  const buckets: Bucket[] = Array.from({ length: plan.duration + 5 }, () => ({ completed: 0, failed: 0, rejected: 0, latencies: [], queueDepth: 0 }));
  const dbCallsPerSecond: number[] = new Array(buckets.length).fill(0);
  const successfulLatencies: number[] = [];
  const crossRegionLatencies: number[] = [];
  const localLatencies: number[] = [];
  const events: SimulationEvent[] = [];
  const traces: RequestTrace[] = [];
  const failedTraces: RequestTrace[] = [];
  const liveRequests = new Set<Req>();
  const traceStride = Math.max(1, Math.floor((plan.requestRate * plan.duration) / TRACE_TARGET));
  let requestCount = 0;
  let completed = 0;
  let failed = 0;
  let rejected = 0;
  let deadlineTimeouts = 0;
  let completedWithinWindow = 0;
  let globalQueueDepth = 0;
  let peakGlobalQueue = 0;
  let readRequests = 0;
  let staleReads = 0;
  let retriesIssued = 0;
  let abandonedCalls = 0;
  let zombieReturns = 0;
  let crossRegionRequests = 0;

  const bucketIndex = (time: number) => Math.min(buckets.length - 1, Math.max(0, Math.floor(time / 1000)));
  const emit = (title: string, detail: string, nodeId?: string) => {
    events.push({ time: round(now() / 1000), title, detail, ...(nodeId ? { nodeId } : {}) });
  };

  // ---------------------------------------------------------------- failures

  interface Planned {
    kind: FailureEvent["kind"];
    atMs: number;
    recoverMs: number;
    factor: number;
    target?: Runtime;
    region?: string;
  }
  const planned: Planned[] = [];
  const firstOfKind = (kind: NodeKind) => runtimes.find((runtime) => runtime.kind === kind && runtime.node.enabled);
  const explicitOfKind = (id: string | undefined, kind: NodeKind) => {
    const candidate = id ? byId.get(id) : undefined;
    return candidate && candidate.kind === kind ? candidate : undefined;
  };
  for (const failure of plan.failures) {
    const at = Math.min(durationMs, Math.max(0, failure.at * durationMs));
    let target: Runtime | undefined;
    if (failure.kind === "server") target = explicitOfKind(failure.target, "server") ?? firstOfKind("server");
    else if (failure.kind === "database" || failure.kind === "slow-database") target = explicitOfKind(failure.target, "database") ?? firstOfKind("database");
    else if (failure.kind === "cache-flush") target = explicitOfKind(failure.target, "cache") ?? firstOfKind("cache");
    const defaultDuration = failure.kind === "slow-database" ? 5 : 0;
    planned.push({
      kind: failure.kind,
      atMs: at,
      recoverMs: Math.max(0, failure.duration ?? defaultDuration) * 1000,
      factor: failure.factor ?? 5,
      target,
      region: failure.region,
    });
  }

  /** Lanes that a scheduled failure takes offline, so utilization can discount dead time. */
  function plannedDeadLanes(item: Planned): { runtime: Runtime; lane: number }[] {
    if (item.kind === "server" || item.kind === "database") {
      if (!item.target) return [];
      return [{ runtime: item.target, lane: 0 }];
    }
    if (item.kind === "region") {
      const victims: { runtime: Runtime; lane: number }[] = [];
      for (const runtime of runtimes) {
        if (runtime.kind === "traffic" || runtime.region !== item.region) continue;
        for (let lane = 0; lane < runtime.lanes; lane++) victims.push({ runtime, lane });
      }
      return victims;
    }
    return [];
  }
  for (const item of planned) {
    const to = item.recoverMs > 0 ? item.atMs + item.recoverMs : horizon;
    for (const victim of plannedDeadLanes(item)) victim.runtime.deadIntervals[victim.lane].push({ from: item.atMs, to });
  }

  /** Milliseconds a lane is both inside the traffic window and expected to be alive. */
  function activeMs(runtime: Runtime, lane: number, from: number, to: number): number {
    const start = Math.max(from, 0);
    const end = Math.min(to, durationMs);
    if (end <= start) return 0;
    const intervals = runtime.deadIntervals[lane];
    if (!intervals.length) return end - start;
    let span = end - start;
    for (const interval of intervals) {
      const overlap = Math.min(end, interval.to) - Math.max(start, interval.from);
      if (overlap > 0) span -= overlap;
    }
    return span > 0 ? span : 0;
  }

  // ---------------------------------------------------------------- plumbing

  function changeQueue(runtime: Runtime, delta: number) {
    runtime.waiting += delta;
    if (runtime.waiting > runtime.peakQueue) runtime.peakQueue = runtime.waiting;
    globalQueueDepth += delta;
    if (globalQueueDepth > peakGlobalQueue) peakGlobalQueue = globalQueueDepth;
  }

  function unpend(job: Job) {
    const list = job.request.pending;
    const index = list.indexOf(job);
    if (index >= 0) {
      list[index] = list[list.length - 1];
      list.pop();
    }
  }

  function dequeue(job: Job) {
    if (!job.waiting) return;
    job.waiting = false;
    job.pool.waiting--;
    changeQueue(job.queueOwner, -1);
  }

  function settle(job: Job, status: TraceStatus) {
    if (job.settled) return;
    job.settled = true;
    const elapsed = now() - job.enteredAt;
    const runtime = job.runtime;
    runtime.elapsed += elapsed;
    if (job.step) {
      job.step.duration = round(elapsed);
      job.step.status = status;
    }
    if (status === "error" || status === "timeout") {
      runtime.errors++;
      if (job.lane >= 0) runtime.laneErrors[job.lane]++;
    } else if (status === "rejected" || status === "open-circuit") {
      runtime.rejected++;
    } else {
      runtime.processed++;
      if (job.lane >= 0) runtime.laneProcessed[job.lane]++;
    }
    unpend(job);
  }

  function pushStep(request: Req, runtime: Runtime, status: TraceStatus) {
    if (!request.traced) return;
    request.steps.push({ nodeId: runtime.node.id, label: runtime.node.label, startedAt: round(now() - request.enteredAt), duration: 0, status });
  }

  function finish(request: Req, success: boolean, reason: number = FINISH_NORMAL) {
    if (request.finished) return;
    request.finished = true;
    liveRequests.delete(request);
    const latency = now() - request.enteredAt;
    const bucket = buckets[bucketIndex(now())];
    if (success) {
      completed++;
      if (now() < durationMs) completedWithinWindow++;
      successfulLatencies.push(latency);
      bucket.completed++;
      bucket.latencies.push(latency);
      if (request.stale) staleReads++;
      if (request.crossRegionMs > 0) crossRegionLatencies.push(latency);
      else localLatencies.push(latency);
    } else {
      failed++;
      bucket.failed++;
      if (reason === FINISH_REJECTED) {
        rejected++;
        bucket.rejected++;
      } else if (reason === FINISH_DEADLINE) deadlineTimeouts++;
      if (request.pending.length) {
        const stranded = request.pending.slice();
        request.pending.length = 0;
        for (const job of stranded) {
          dequeue(job);
          settle(job, "error");
          job.done(false);
        }
      }
    }
    if (request.traced) {
      const trace: RequestTrace = { id: request.id, latency: round(latency), success, steps: request.steps };
      if (traces.length < MAX_TRACES && (request.id <= 4 || request.id % traceStride === 0)) traces.push(trace);
      if (!success && failedTraces.length < MAX_FAILED_TRACES) failedTraces.push(trace);
    }
  }

  function rejectRequest(request: Req) {
    finish(request, false, FINISH_REJECTED);
  }

  // ---------------------------------------------------------------- routing

  function poolHasLane(runtime: Runtime, pool: Pool): boolean {
    for (const lane of pool.lanes) if (runtime.alive[lane]) return true;
    return false;
  }

  function freeLane(runtime: Runtime, pool: Pool): number {
    for (const lane of pool.lanes) if (runtime.alive[lane] && !runtime.busy[lane]) return lane;
    return -1;
  }

  function drain(runtime: Runtime) {
    for (const pool of runtime.pools) {
      for (;;) {
        const lane = freeLane(runtime, pool);
        if (lane < 0) break;
        while (pool.head < pool.pending.length && !pool.pending[pool.head].waiting) pool.head++;
        const next = pool.pending[pool.head];
        if (!next) break;
        pool.head++;
        startJob(next, lane);
      }
      if (pool.head > 1024 && pool.head * 2 > pool.pending.length) {
        pool.pending = pool.pending.slice(pool.head);
        pool.head = 0;
      }
    }
  }

  function startJob(job: Job, lane: number) {
    const { runtime, request } = job;
    if (request.finished || job.settled) return;
    dequeue(job);
    if (job.lane < 0) {
      runtime.routed[lane]++;
      if (job.step) job.step.replica = lane + 1;
    }
    job.lane = lane;
    runtime.busy[lane] = true;
    runtime.active[lane] = job;
    const startedAt = now();
    const slow = startedAt < runtime.slowUntil ? runtime.slowFactor : 1;
    const service = Math.max(MIN_SERVICE_MS, runtime.serviceBase * lognormalMultiplier(serviceRandom, runtime.sigma) * slow);
    runtime.busyTime[lane] += activeMs(runtime, lane, startedAt, startedAt + service);
    scheduler.after(service, () => {
      runtime.busy[lane] = false;
      runtime.active[lane] = undefined;
      if (!job.settled) {
        if (request.finished) settle(job, "ok");
        else if (!runtime.alive[lane]) failJob(job);
        else if (runtime.node.latency > 0) scheduler.after(runtime.node.latency, () => finishService(job));
        else finishService(job);
      }
      drain(runtime);
    });
  }

  function failJob(job: Job) {
    if (job.settled) return;
    dequeue(job);
    settle(job, "error");
    job.done(false);
  }

  function takeToken(runtime: Runtime): boolean {
    const at = now();
    const limit = runtime.settings.limit;
    const burst = Math.max(1, runtime.settings.burst);
    runtime.tokens = Math.min(burst, runtime.tokens + ((at - runtime.lastRefill) * limit) / 1000);
    runtime.lastRefill = at;
    if (runtime.tokens >= 1) {
      runtime.tokens -= 1;
      return true;
    }
    return false;
  }

  function shardOf(runtime: Runtime, key: number): number {
    const shards = Math.max(1, runtime.settings.shards);
    if (runtime.settings.shardStrategy === "range") {
      const width = Math.max(1, plan.keySpace / shards);
      return Math.min(shards - 1, Math.floor(key / width));
    }
    return ((key % shards) + shards) % shards;
  }

  /** Picks the pool a database request belongs in, and reports whether it will read stale data. */
  function databaseRoute(runtime: Runtime, request: Req): { pool: Pool; stale: boolean; failover: boolean } {
    const settings = runtime.settings;
    if (settings.dbMode === "sharded") {
      const shard = shardOf(runtime, request.key);
      runtime.shardCalls[shard]++;
      return { pool: runtime.pools[shard], stale: false, failover: false };
    }
    if (settings.dbMode !== "leader-follower") return { pool: runtime.pools[0], stale: false, failover: false };
    const committedAt = runtime.committed!.get(request.key);
    const recentlyWritten = committedAt !== undefined && now() - committedAt < settings.replicationLagMs;
    if (!request.read) {
      if (now() < runtime.failoverUntil) return { pool: runtime.pools[runtime.leaderLane], stale: false, failover: true };
      return { pool: runtime.pools[runtime.leaderLane], stale: false, failover: false };
    }
    if (recentlyWritten && settings.consistency === "read-your-writes") {
      return { pool: runtime.pools[runtime.leaderLane], stale: false, failover: false };
    }
    let chosen = -1;
    for (let attempt = 0; attempt < runtime.lanes; attempt++) {
      const lane = runtime.followerCursor++ % runtime.lanes;
      if (lane === runtime.leaderLane || !runtime.alive[lane]) continue;
      chosen = lane;
      break;
    }
    if (chosen < 0) return { pool: runtime.pools[runtime.leaderLane], stale: false, failover: false };
    if (recentlyWritten) runtime.staleServed++;
    return { pool: runtime.pools[chosen], stale: recentlyWritten, failover: false };
  }

  function refreshHealth(runtime: Runtime) {
    const interval = runtime.settings.healthCheckMs;
    const at = now();
    if (interval <= 0) {
      for (let index = 0; index < runtime.endpoints.length; index++) {
        const endpoint = runtime.endpoints[index];
        runtime.healthView[index] = endpoint.target.alive[endpoint.lane];
      }
      return;
    }
    if (at < runtime.nextHealthCheck) return;
    runtime.nextHealthCheck += (Math.floor((at - runtime.nextHealthCheck) / interval) + 1) * interval;
    for (let index = 0; index < runtime.endpoints.length; index++) {
      const endpoint = runtime.endpoints[index];
      runtime.healthView[index] = endpoint.target.alive[endpoint.lane];
    }
  }

  function routeBalanced(job: Job) {
    const runtime = job.runtime;
    const request = job.request;
    const endpoints = runtime.endpoints;
    if (!endpoints.length) {
      job.done(false);
      return;
    }
    refreshHealth(runtime);
    let chosen = -1;
    if (runtime.settings.algorithm === "least-connections") {
      let best = Infinity;
      for (let index = 0; index < endpoints.length; index++) {
        if (!runtime.healthView[index]) continue;
        const endpoint = endpoints[index];
        const target = endpoint.target;
        const pool = target.pools[target.poolOfLane[endpoint.lane]];
        const load = (target.busy[endpoint.lane] ? 1 : 0) + pool.waiting;
        if (load < best) {
          best = load;
          chosen = index;
        }
      }
    } else {
      let healthy = 0;
      for (let index = 0; index < endpoints.length; index++) if (runtime.healthView[index]) healthy++;
      if (healthy > 0) {
        let offset = runtime.roundRobin++ % healthy;
        for (let index = 0; index < endpoints.length; index++) {
          if (!runtime.healthView[index]) continue;
          if (offset === 0) {
            chosen = index;
            break;
          }
          offset--;
        }
      }
    }
    if (chosen < 0) chosen = 0;
    const endpoint = endpoints[chosen];
    if (!endpoint.target.alive[endpoint.lane]) runtime.detectionFailures++;
    enter(request, endpoint.target, runtime, job.done, endpoint.lane);
  }

  // ---------------------------------------------------------------- breaker

  function openBreaker(runtime: Runtime, at: number) {
    runtime.breakerState = "open";
    runtime.breakerOpenUntil = at + BREAKER_OPEN_MS;
    runtime.breakerOpens++;
    runtime.breakerTimes.length = 0;
    runtime.breakerBad.length = 0;
    runtime.breakerHead = 0;
    runtime.breakerBadCount = 0;
    emit(
      `${runtime.node.label} opened its circuit breaker`,
      `At least ${BREAKER_MIN_CALLS} dependency calls in the last second and at least ${BREAKER_FAILURE_RATIO * 100}% of them failed. Calls fail fast for ${BREAKER_OPEN_MS / 1000}s, then one probe decides whether to close.`,
      runtime.node.id,
    );
  }

  function breakerAllows(runtime: Runtime): boolean {
    const at = now();
    if (runtime.breakerState === "open") {
      if (at < runtime.breakerOpenUntil) return false;
      runtime.breakerState = "half-open";
      runtime.breakerProbe = false;
    }
    if (runtime.breakerState === "half-open") {
      if (runtime.breakerProbe) return false;
      runtime.breakerProbe = true;
      return true;
    }
    return true;
  }

  function recordBreaker(runtime: Runtime, ok: boolean) {
    const at = now();
    if (runtime.breakerState === "half-open") {
      runtime.breakerProbe = false;
      if (ok) {
        runtime.breakerState = "closed";
        runtime.breakerTimes.length = 0;
        runtime.breakerBad.length = 0;
        runtime.breakerHead = 0;
        runtime.breakerBadCount = 0;
        emit(`${runtime.node.label} closed its circuit breaker`, "A probe call succeeded, so normal dependency traffic resumed.", runtime.node.id);
      } else {
        openBreaker(runtime, at);
      }
      return;
    }
    if (runtime.breakerState === "open") return;
    runtime.breakerTimes.push(at);
    runtime.breakerBad.push(ok ? 0 : 1);
    if (!ok) runtime.breakerBadCount++;
    while (runtime.breakerHead < runtime.breakerTimes.length && runtime.breakerTimes[runtime.breakerHead] <= at - BREAKER_WINDOW_MS) {
      if (runtime.breakerBad[runtime.breakerHead]) runtime.breakerBadCount--;
      runtime.breakerHead++;
    }
    if (runtime.breakerHead > 1024) {
      runtime.breakerTimes = runtime.breakerTimes.slice(runtime.breakerHead);
      runtime.breakerBad = runtime.breakerBad.slice(runtime.breakerHead);
      runtime.breakerHead = 0;
    }
    const total = runtime.breakerTimes.length - runtime.breakerHead;
    if (total >= BREAKER_MIN_CALLS && runtime.breakerBadCount / total >= BREAKER_FAILURE_RATIO) openBreaker(runtime, at);
  }

  // ---------------------------------------------------------------- hops

  function regionOf(runtime: Runtime, request: Req): string {
    return runtime.kind === "traffic" || runtime.kind === "cdn" ? request.region : runtime.region;
  }

  function enter(request: Req, runtime: Runtime, from: Runtime, done: Done, laneHint = -1) {
    if (request.finished) return;
    runtime.callsReceived++;
    if (runtime.kind === "database") dbCallsPerSecond[bucketIndex(now())]++;
    if (crossRegionLatencyMs > 0 && regionOf(from, request) !== regionOf(runtime, request)) {
      request.crossRegionMs += crossRegionLatencyMs;
      scheduler.after(crossRegionLatencyMs, () => admit(request, runtime, from, done, laneHint));
      return;
    }
    admit(request, runtime, from, done, laneHint);
  }

  function admit(request: Req, runtime: Runtime, from: Runtime, done: Done, laneHint: number) {
    if (request.finished) return;
    const settings = runtime.settings;

    if (runtime.kind === "rate-limiter" && !takeToken(runtime)) {
      pushStep(request, runtime, "rejected");
      runtime.rejected++;
      rejectRequest(request);
      return;
    }

    let pool = runtime.pools[0];
    let stale = false;
    let failover = false;
    if (runtime.kind === "database") {
      const route = databaseRoute(runtime, request);
      pool = route.pool;
      stale = route.stale;
      failover = route.failover;
    } else if (runtime.isApplication) {
      pool = runtime.pools[laneHint >= 0 && laneHint < runtime.pools.length ? laneHint : 0];
    }

    if (settings.maxQueue > 0) {
      const bounded = runtime.kind === "queue" ? runtime.waiting >= settings.maxQueue : runtime.kind === "server" && pool.waiting >= settings.maxQueue;
      if (bounded) {
        pushStep(request, runtime, "rejected");
        runtime.rejected++;
        rejectRequest(request);
        return;
      }
    }

    let step: TraceStep | undefined;
    if (request.traced) {
      step = { nodeId: runtime.node.id, label: runtime.node.label, startedAt: round(now() - request.enteredAt), duration: 0, status: "ok" };
      request.steps.push(step);
    }
    const pinned = pool.lanes.length === 1 ? pool.lanes[0] : -1;
    const job: Job = {
      request,
      runtime,
      pool,
      enteredAt: now(),
      step,
      queueOwner: from.kind === "queue" ? from : runtime,
      waiting: false,
      settled: false,
      lane: pinned,
      stale,
      done,
    };
    request.pending.push(job);
    if (pinned >= 0) {
      runtime.routed[pinned]++;
      if (step) step.replica = pinned + 1;
    }
    if (stale) {
      request.stale = true;
      if (step) step.status = "stale";
    }

    if (failover || !poolHasLane(runtime, pool)) {
      const delay = Math.min(10, runtime.node.latency);
      if (delay > 0) scheduler.after(delay, () => failJob(job));
      else failJob(job);
      return;
    }

    const lane = freeLane(runtime, pool);
    if (lane >= 0) startJob(job, lane);
    else {
      job.waiting = true;
      pool.pending.push(job);
      pool.waiting++;
      changeQueue(job.queueOwner, 1);
    }
  }

  /** The node has finished its own processing. Decide what happens to the request next. */
  function finishService(job: Job) {
    const runtime = job.runtime;
    const request = job.request;
    if (request.finished || job.settled) return;
    switch (runtime.kind) {
      case "database": {
        if (!request.read && runtime.committed) runtime.committed.set(request.key, now());
        settle(job, job.stale ? "stale" : "ok");
        job.done(true);
        return;
      }
      case "cdn": {
        const rate = probabilisticHitRate(runtime.node.cacheHitRate, runtime.settings.warmupSeconds, now(), runtime.lastFlushAt);
        if (request.read) runtime.cacheReads++;
        if (request.read && request.edgeRoll < rate) {
          runtime.cacheHits++;
          settle(job, "hit");
          job.done(true);
          return;
        }
        settle(job, request.read ? "miss" : "bypass");
        enter(request, runtime.next[0], runtime, job.done);
        return;
      }
      case "load-balancer": {
        settle(job, "ok");
        routeBalanced(job);
        return;
      }
      case "rate-limiter": {
        settle(job, "ok");
        enter(request, runtime.next[0], runtime, job.done);
        return;
      }
      case "queue": {
        settle(job, "ok");
        enter(request, runtime.next[0], runtime, job.done);
        return;
      }
      case "cache": {
        serveCache(job);
        return;
      }
      default: {
        settle(job, "ok");
        callDependencies(job);
      }
    }
  }

  function serveCache(job: Job) {
    const runtime = job.runtime;
    const request = job.request;
    const settings = runtime.settings;
    const database = runtime.next[0];
    if (settings.cacheModel !== "keyed") {
      const rate = probabilisticHitRate(runtime.node.cacheHitRate, settings.warmupSeconds, now(), runtime.lastFlushAt);
      if (request.read) runtime.cacheReads++;
      if (request.read && request.cacheRoll < rate) {
        runtime.cacheHits++;
        settle(job, "hit");
        job.done(true);
        return;
      }
      settle(job, request.read ? "miss" : "bypass");
      enter(request, database, runtime, job.done);
      return;
    }
    const cache = runtime.cache!;
    const key = request.key;
    if (!request.read) {
      cache.noteWrite(key, now());
      settle(job, "bypass");
      enter(request, database, runtime, (ok) => {
        if (ok) cache.set(key, now());
        job.done(ok);
      });
      return;
    }
    runtime.cacheReads++;
    const lookup = cache.lookup(key, now());
    if (lookup !== "miss") {
      runtime.cacheHits++;
      if (lookup === "stale") {
        runtime.cacheStale++;
        request.stale = true;
      }
      settle(job, lookup === "stale" ? "stale" : "hit");
      job.done(true);
      return;
    }
    const coalescer = runtime.coalescer;
    if (coalescer) {
      if (
        coalescer.join(key, (ok) => {
          runtime.cacheCoalesced++;
          runtime.cacheHits++;
          settle(job, "coalesced");
          job.done(ok);
        })
      ) {
        return;
      }
      coalescer.lead(key);
    }
    settle(job, "miss");
    enter(request, database, runtime, (ok) => {
      if (ok) cache.set(key, now());
      if (coalescer) coalescer.settle(key, ok);
      job.done(ok);
    });
  }

  function callDependencies(job: Job) {
    const runtime = job.runtime;
    const request = job.request;
    const deps = runtime.next;
    if (!deps.length) {
      job.done(true);
      return;
    }
    if (runtime.breakerEnabled && !breakerAllows(runtime)) {
      pushStep(request, runtime, "open-circuit");
      runtime.rejected++;
      rejectRequest(request);
      return;
    }
    if (deps.length === 1) {
      if (runtime.simpleCall) enter(request, deps[0], runtime, job.done);
      else callDependency(job, deps[0], job.done);
      return;
    }
    if (runtime.settings.fanout === "sequential") {
      let index = 0;
      const step = (ok: boolean) => {
        if (!ok) {
          job.done(false);
          return;
        }
        index++;
        if (index >= deps.length) {
          job.done(true);
          return;
        }
        callDependency(job, deps[index], step);
      };
      callDependency(job, deps[0], step);
      return;
    }
    let remaining = deps.length;
    let broken = false;
    const onOne = (ok: boolean) => {
      if (broken) return;
      if (!ok) {
        broken = true;
        job.done(false);
        return;
      }
      remaining--;
      if (remaining === 0) job.done(true);
    };
    for (const dep of deps) callDependency(job, dep, onOne);
  }

  function callDependency(job: Job, dep: Runtime, onResult: Done) {
    const runtime = job.runtime;
    const request = job.request;
    const settings = runtime.settings;
    let attempt = 0;
    const attemptCall = () => {
      if (request.finished) return;
      let resolved = false;
      const complete = (ok: boolean) => {
        if (resolved) return;
        resolved = true;
        if (runtime.breakerEnabled) recordBreaker(runtime, ok);
        if (ok) {
          onResult(true);
          return;
        }
        if (attempt < settings.retries && !request.finished) {
          attempt++;
          scheduler.after(fullJitterBackoff(chaosRandom, settings.retryBackoffMs, attempt - 1), () => {
            // A retry that never leaves because the request already gave up is not a retry.
            if (request.finished) return;
            retriesIssued++;
            pushStep(request, runtime, "retry");
            attemptCall();
          });
          return;
        }
        onResult(false);
      };
      if (settings.timeoutMs > 0) {
        scheduler.after(settings.timeoutMs, () => {
          if (resolved || request.finished) return;
          abandonedCalls++;
          pushStep(request, runtime, "timeout");
          complete(false);
        });
      }
      enter(request, dep, runtime, (ok) => {
        if (resolved) {
          // The caller gave up on this call; the work still ran and consumed capacity.
          zombieReturns++;
          return;
        }
        complete(ok);
      });
    };
    attemptCall();
  }

  // ---------------------------------------------------------------- failure events

  function killLane(runtime: Runtime, lane: number) {
    if (!runtime.alive[lane]) return;
    runtime.alive[lane] = false;
    const active = runtime.active[lane];
    if (active) {
      runtime.active[lane] = undefined;
      runtime.busy[lane] = false;
      failJob(active);
    }
    const pool = runtime.pools[runtime.poolOfLane[lane]];
    if (!poolHasLane(runtime, pool)) {
      for (let index = pool.head; index < pool.pending.length; index++) {
        const job = pool.pending[index];
        if (!job.waiting) continue;
        failJob(job);
      }
      pool.pending.length = 0;
      pool.head = 0;
    }
    if (runtime.kind === "database" && runtime.settings.dbMode === "leader-follower" && lane === runtime.leaderLane) {
      const failoverMs = runtime.settings.failoverMs;
      runtime.failoverUntil = now() + failoverMs;
      emit(
        `${runtime.node.label} lost its leader`,
        `Writes fail for ${failoverMs.toLocaleString("en-US")} ms while a follower is promoted. Follower reads continue.`,
        runtime.node.id,
      );
      scheduler.after(failoverMs, () => {
        let promoted = -1;
        for (let candidate = 0; candidate < runtime.lanes; candidate++) {
          if (candidate !== runtime.leaderLane && runtime.alive[candidate]) {
            promoted = candidate;
            break;
          }
        }
        runtime.failoverUntil = 0;
        if (promoted < 0) {
          emit(`${runtime.node.label} has no follower to promote`, "Every replica is down, so writes and reads keep failing until a replica recovers.", runtime.node.id);
          return;
        }
        runtime.leaderLane = promoted;
        emit(`${runtime.node.label} promoted replica ${promoted + 1}`, "Writes resume on the new leader. Data written but not yet replicated before the failure is not modelled.", runtime.node.id);
      });
    }
    drain(runtime);
  }

  function reviveLane(runtime: Runtime, lane: number) {
    if (runtime.alive[lane] || !runtime.node.enabled) return;
    runtime.alive[lane] = true;
    drain(runtime);
  }

  for (const item of planned) {
    const atMs = item.atMs;
    if (item.kind === "cache-flush") {
      scheduler.after(atMs, () => {
        const targets = item.target ? [item.target] : caches;
        for (const cacheRuntime of targets) {
          cacheRuntime.lastFlushAt = now();
          cacheRuntime.flushes++;
          cacheRuntime.cache?.clear();
          cacheRuntime.coalescer?.clear();
          emit(`${cacheRuntime.node.label} was flushed`, "Every cached entry was dropped. Reads fall through to the origin until the cache refills.", cacheRuntime.node.id);
        }
      });
      continue;
    }
    if (item.kind === "slow-database") {
      const target = item.target;
      if (!target) continue;
      const until = atMs + (item.recoverMs || 5000);
      scheduler.after(atMs, () => {
        target.slowUntil = until;
        target.slowFactor = item.factor;
        emit(`${target.node.label} slowed down ${item.factor}x`, `Service time is multiplied by ${item.factor} for ${round((until - atMs) / 1000)}s. Queues build up behind it.`, target.node.id);
      });
      scheduler.after(until, () => {
        target.slowFactor = 1;
        emit(`${target.node.label} recovered its normal speed`, "Service time returned to 1,000 / capacity ms. Backlogged work still has to drain.", target.node.id);
      });
      continue;
    }
    if (item.kind === "region") {
      const victims = plannedDeadLanes(item);
      const names = [...new Set(victims.map((victim) => victim.runtime.node.label))];
      if (!victims.length) continue;
      scheduler.after(atMs, () => {
        for (const victim of victims) killLane(victim.runtime, victim.lane);
        emit(`Region ${item.region} went down`, `${names.length} component${names.length === 1 ? "" : "s"} lost every replica: ${names.join(", ")}.`);
      });
      if (item.recoverMs > 0) {
        scheduler.after(atMs + item.recoverMs, () => {
          for (const victim of victims) reviveLane(victim.runtime, victim.lane);
          emit(`Region ${item.region} came back`, "Every replica in the region is healthy again and starts from an idle queue.");
        });
      }
      continue;
    }
    const target = item.target;
    if (!target) {
      emit(`No ${item.kind} to fail`, `The design has no enabled ${item.kind} component, so this failure event did nothing.`);
      continue;
    }
    scheduler.after(atMs, () => {
      killLane(target, 0);
      emit(
        `${target.node.label} replica 1 failed`,
        item.recoverMs > 0
          ? `It returns after ${round(item.recoverMs / 1000)}s with an empty queue.`
          : "It does not recover during this run.",
        target.node.id,
      );
    });
    if (item.recoverMs > 0) {
      scheduler.after(atMs + item.recoverMs, () => {
        reviveLane(target, 0);
        emit(`${target.node.label} replica 1 recovered`, "The replica is healthy again and starts from an idle queue.", target.node.id);
      });
    }
  }

  // ---------------------------------------------------------------- arrivals

  const regionNames = plan.regions.map((region) => region.name);
  const regionShares = plan.regions.map((region) => region.share);

  function pickTrafficTarget(request: Req): Runtime {
    const targets = source.next;
    if (targets.length === 1) return targets[0];
    let preferred = targets.find((target) => target.region === request.region) ?? targets[0];
    if (!preferred.alive.some(Boolean)) {
      const alternative = targets.find((target) => target !== preferred && target.alive.some(Boolean));
      if (alternative) preferred = alternative;
    }
    return preferred;
  }

  for (let second = 0; second < plan.duration; second++) {
    const progress = (second + 0.5) / plan.duration;
    let multiplier = 1;
    if (plan.pattern === "spike") multiplier = progress >= 0.35 && progress < 0.65 ? 2 : 1;
    else if (plan.pattern === "ramp") multiplier = 0.3 + 1.4 * progress;
    else if (plan.pattern === "flash") multiplier = progress >= 0.4 && progress < 0.48 ? 6 : 1;
    const arrivals = Math.round(plan.requestRate * multiplier);
    for (let index = 0; index < arrivals; index++) {
      const arrivalTime = second * 1000 + ((index + 0.1 + workloadRandom() * 0.8) / arrivals) * 1000;
      const read = workloadRandom() < plan.readRatio;
      const key = powerLawKey(workloadRandom(), plan.keySpace, plan.keySkew);
      const region = regionNames[weightedIndex(workloadRandom(), regionShares)];
      const cacheRoll = workloadRandom();
      const edgeRoll = workloadRandom();
      scheduler.after(arrivalTime, () => {
        const id = ++requestCount;
        const request: Req = {
          id,
          enteredAt: now(),
          read,
          key,
          region,
          cacheRoll,
          edgeRoll,
          finished: false,
          traced: id <= 4 || id % traceStride === 0,
          stale: false,
          crossRegionMs: 0,
          steps: [],
          pending: [],
        };
        source.processed++;
        if (read) readRequests++;
        liveRequests.add(request);
        scheduler.after(REQUEST_DEADLINE_MS, () => finish(request, false, FINISH_DEADLINE));
        enter(request, pickTrafficTarget(request), source, (ok) => finish(request, ok));
      });
    }
  }
  for (let second = 0; second < buckets.length; second++) {
    scheduler.after((second + 1) * 1000 - 0.001, () => {
      buckets[second].queueDepth = globalQueueDepth;
    });
  }

  scheduler.run(horizon);
  for (const request of [...liveRequests]) finish(request, false, FINISH_DEADLINE);

  // ---------------------------------------------------------------- metrics

  successfulLatencies.sort((a, b) => a - b);
  crossRegionLatencies.sort((a, b) => a - b);
  localLatencies.sort((a, b) => a - b);
  crossRegionRequests = crossRegionLatencies.length;

  const lastActiveBucket = buckets.reduce(
    (last, bucket, index) => (bucket.completed || bucket.failed || bucket.queueDepth ? index : last),
    plan.duration - 1,
  );
  const samples: MetricSample[] = buckets.slice(0, lastActiveBucket + 1).map((bucket, index) => {
    bucket.latencies.sort((a, b) => a - b);
    return {
      time: index + 1,
      latency: round(bucket.latencies.reduce((sum, value) => sum + value, 0) / (bucket.latencies.length || 1)),
      p95: round(percentile(bucket.latencies, 0.95)),
      throughput: bucket.completed,
      errorRate: ratio(bucket.failed / (bucket.completed + bucket.failed || 1)),
      queueDepth: bucket.queueDepth,
      rejected: bucket.rejected,
    };
  });

  const nodes: NodeMetric[] = runtimes.map((runtime) => {
    const enabled = runtime.node.enabled;
    let busyTotal = 0;
    let availableTotal = 0;
    for (let lane = 0; lane < runtime.lanes; lane++) {
      busyTotal += runtime.busyTime[lane];
      availableTotal += enabled ? activeMs(runtime, lane, 0, durationMs) : 0;
    }
    const metric: NodeMetric = {
      nodeId: runtime.node.id,
      utilization: runtime.kind === "traffic" ? 0 : ratio(Math.min(1, busyTotal / (availableTotal || 1))),
      queueDepth: runtime.peakQueue,
      processed: runtime.processed,
      errors: runtime.errors,
      rejected: runtime.rejected,
      avgLatency: round(runtime.elapsed / (runtime.processed + runtime.errors || 1)),
      healthyReplicas: runtime.alive.filter(Boolean).length,
    };
    if (runtime.kind !== "traffic") {
      metric.replicas = runtime.busyTime.map((time, lane) => ({
        index: lane + 1,
        processed: runtime.laneProcessed[lane],
        errors: runtime.laneErrors[lane],
        utilization: enabled ? ratio(Math.min(1, time / (activeMs(runtime, lane, 0, durationMs) || 1))) : 0,
      }));
    }
    if (runtime.kind === "database" && runtime.settings.dbMode === "sharded") {
      const shards = Math.max(1, runtime.settings.shards);
      metric.shards = Array.from({ length: shards }, (_, shard) => {
        let busy = 0;
        let available = 0;
        for (const lane of runtime.pools[shard].lanes) {
          busy += runtime.busyTime[lane];
          available += enabled ? activeMs(runtime, lane, 0, durationMs) : 0;
        }
        return ratio(Math.min(1, busy / (available || 1)));
      });
    }
    return metric;
  });

  let amplification = 1;
  let amplifiedNode: Runtime | undefined;
  for (const runtime of runtimes) {
    if (runtime.kind === "traffic" || !runtime.parents.length) continue;
    let callersProcessed = 0;
    for (const parent of runtime.parents) callersProcessed += parent.processed;
    if (callersProcessed <= 0) continue;
    const value = runtime.callsReceived / callersProcessed;
    if (value > amplification) {
      amplification = value;
      amplifiedNode = runtime;
    }
  }

  const cacheReads = caches.reduce((sum, runtime) => sum + runtime.cacheReads, 0) + runtimes.filter((runtime) => runtime.kind === "cdn").reduce((sum, runtime) => sum + runtime.cacheReads, 0);
  const cacheHits = caches.reduce((sum, runtime) => sum + runtime.cacheHits, 0) + runtimes.filter((runtime) => runtime.kind === "cdn").reduce((sum, runtime) => sum + runtime.cacheHits, 0);

  const nodeTelemetry: NodeTelemetry[] = runtimes.map((runtime, index) => ({
    id: runtime.node.id,
    label: runtime.node.label,
    kind: runtime.kind,
    enabled: runtime.node.enabled,
    replicas: runtime.node.replicas,
    isApplication: runtime.isApplication,
    hasBalancerParent: runtime.parents.some((parent) => parent.kind === "load-balancer"),
    routed: runtime.routed.slice(),
    metric: nodes[index],
    callsReceived: runtime.callsReceived,
    callersProcessed: runtime.parents.reduce((sum, parent) => sum + parent.processed, 0),
    cacheReads: runtime.cacheReads,
    cacheHits: runtime.cacheHits,
    cacheCoalesced: runtime.cacheCoalesced,
    cacheModel: runtime.settings.cacheModel,
    dbMode: runtime.settings.dbMode,
    staleServed: runtime.staleServed + runtime.cacheStale,
    detectionFailures: runtime.detectionFailures,
    healthCheckMs: runtime.settings.healthCheckMs,
    breakerOpens: runtime.breakerOpens,
    retries: runtime.settings.retries,
    timeoutMs: runtime.settings.timeoutMs,
    maxQueue: runtime.settings.maxQueue,
    shardUtilization: nodes[index].shards,
  }));

  const flushSeconds = planned.filter((item) => item.kind === "cache-flush").map((item) => item.atMs / 1000);
  let postFlushDbCalls = 0;
  let postFlushSeconds = 0;
  let steadyDbCalls = 0;
  let steadySeconds = 0;
  const flushWindow = new Set<number>();
  for (const flushAt of flushSeconds) {
    for (let offset = 0; offset < 3; offset++) flushWindow.add(Math.floor(flushAt) + offset);
  }
  for (let second = 0; second < plan.duration; second++) {
    if (flushWindow.has(second)) {
      postFlushDbCalls += dbCallsPerSecond[second];
      postFlushSeconds++;
    } else {
      steadyDbCalls += dbCallsPerSecond[second];
      steadySeconds++;
    }
  }

  const telemetry: Telemetry = {
    workload: plan,
    duration: plan.duration,
    requestCount,
    completed,
    failed,
    rejected,
    deadlineTimeouts,
    errorRate: ratio((failed - rejected) / (requestCount || 1)),
    rejectedRate: ratio(rejected / (requestCount || 1)),
    successRate: ratio(completed / (requestCount || 1)),
    p50: round(percentile(successfulLatencies, 0.5)),
    p95: round(percentile(successfulLatencies, 0.95)),
    p99: round(percentile(successfulLatencies, 0.99)),
    maxQueueDepth: peakGlobalQueue,
    readRequests,
    staleReads,
    staleReadRate: ratio(staleReads / (readRequests || 1)),
    retriesIssued,
    abandonedCalls,
    zombieReturns,
    amplification: round(amplification),
    amplifiedNodeId: amplifiedNode?.node.id,
    amplifiedNodeLabel: amplifiedNode?.node.label,
    cacheReads,
    cacheHits,
    crossRegionRequests,
    crossRegionP95: round(percentile(crossRegionLatencies, 0.95)),
    localP95: round(percentile(localLatencies, 0.95)),
    postFlushDbRate: postFlushSeconds ? round(postFlushDbCalls / postFlushSeconds) : 0,
    steadyDbRate: steadySeconds ? round(steadyDbCalls / steadySeconds) : 0,
    hasCacheFlush: flushSeconds.length > 0,
    hasQueue: runtimes.some((runtime) => runtime.kind === "queue"),
    events,
    nodes: nodeTelemetry,
    failures: plan.failures,
    legacyFailure: workload.failure,
  };

  const traceMap = new Map([...traces, ...failedTraces].map((trace) => [trace.id, trace]));
  return {
    engineVersion: ENGINE_VERSION,
    seed: plan.seed,
    duration: plan.duration,
    requestCount,
    completed,
    failed,
    rejected,
    p50: telemetry.p50,
    p95: telemetry.p95,
    p99: telemetry.p99,
    throughput: round(completedWithinWindow / plan.duration),
    errorRate: telemetry.errorRate,
    rejectedRate: telemetry.rejectedRate,
    successRate: telemetry.successRate,
    staleReads,
    staleReadRate: telemetry.staleReadRate,
    retriesIssued,
    amplification: telemetry.amplification,
    cost: architectureCost(architecture.nodes),
    costBreakdown: architecture.nodes
      .filter((node) => node.kind !== "traffic" && node.enabled)
      .map((node) => ({ nodeId: node.id, label: node.label, cost: nodeCost(node) })),
    maxQueueDepth: peakGlobalQueue,
    nodes,
    samples,
    traces: [...traceMap.values()].sort((a, b) => a.id - b.id),
    events,
    insights: buildInsights(telemetry),
    assumptions: assumptionsFor(plan),
  };
}

function assumptionsFor(plan: Required<Workload>): string[] {
  return [
    `Engine ${ENGINE_VERSION}; discrete events scheduled by SIM.JS. Identical graph order, settings, seed and engine version reproduce identical results, byte for byte.`,
    "Each replica is one processing lane. Service time is 1,000 / capacity ms multiplied by a lognormal draw normalised to mean 1 (sigma 0.2 / 0.4 / 0.8 for low / medium / high variance), so the tail is heavy and p99 is not p50 plus a constant. Configured latency is added after the lane is released.",
    "A lane is occupied only while it processes. Waiting for a dependency is asynchronous: a server that calls a slow database keeps accepting work until its own queue or bound stops it. Connection pools, thread limits and memory pressure are not modelled.",
    "Application replicas keep separate FIFO queues and requests stay pinned to the replica they were routed to. Workers, single-mode databases, caches, CDNs, queues, rate limiters and load balancers share one FIFO queue per pool. A direct connection to an application server reaches replica 1 only; a load balancer spreads work over (server, replica) endpoints.",
    `Requests carry a key drawn from a power law over ${plan.keySpace.toLocaleString("en-US")} keys at skew ${plan.keySkew}, a read/write flag, and an origin region. Hot keys are what make caches, shards and coalescing behave differently from a hit-rate dial.`,
    "Keyed caches are an LRU over a fixed number of keys with an optional TTL, populated write-through when the database returns. A read served after a later write to the same key is counted stale. Probabilistic caches roll a hit per read and only model a warm-up ramp, not eviction or invalidation.",
    "Leader-follower databases send writes to the leader and reads round robin over healthy followers. A follower read of a key written inside the replication lag is stale unless read-your-writes routes it to the leader. Losing the leader fails writes for the configured failover time, then promotes the first healthy follower. Consensus, quorum reads, write-ahead logs and lost unreplicated writes are not modelled.",
    "Sharded databases are independent pools keyed by hash or range. Rebalancing, cross-shard transactions and secondary indexes are not modelled.",
    "Timeouts abandon a dependency call; the downstream work keeps running and keeps consuming capacity. Retries use exponential backoff with full jitter. A circuit breaker judges the last second of dependency calls and opens for five seconds after at least 20 calls with at least 50% failures, then closes on one successful probe.",
    "Rate limiters are token buckets, and bounded queues reject on arrival. Both count as rejected rather than as errors: shedding is a deliberate choice, not a fault.",
    `Load balancers refresh their view of endpoint health every healthCheckMs; a request sent to an endpoint that died since the last check fails after min(10, latency) ms. ${plan.crossRegionLatencyMs} ms is added to every hop that crosses a region, and a CDN is treated as being in the caller's own region.`,
    "All generated requests are simulated individually, with a 5,000 ms end-to-end deadline. Arrivals stop at the configured duration; outstanding work is watched for five more seconds. Supported runs are 1-60 seconds at 1-3,000 requests/s over at most 48 components.",
    "Throughput counts successful completions inside the traffic window. Latency percentiles cover successful requests only, including the drain period. errorRate excludes deliberate rejections; rejectedRate reports them separately. Utilization measures occupied lane time against the time a lane was both inside the window and alive.",
    "Costs are teaching credits from a per-kind nonlinear curve (fixed + base x (capacity / reference) ^ exponent per replica, times replicas, shards, and a premium for followers). Imported cost fields are ignored. This is not provider pricing, and it ignores data size, egress and storage.",
  ];
}
