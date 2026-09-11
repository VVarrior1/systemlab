export type NodeKind = "traffic" | "server" | "load-balancer" | "database" | "cache" | "queue" | "cdn" | "rate-limiter";
export type Region = string;

export interface SystemNode {
  id: string;
  kind: NodeKind;
  label: string;
  position: { x: number; y: number };
  capacity: number;
  latency: number;
  replicas: number;
  cacheHitRate: number;
  enabled: boolean;
  cost: number;
  role?: "application" | "worker";
  /** Deployment region. Hops that cross regions add the workload's cross-region latency. Default "primary". */
  region?: Region;
  /** Service-time spread: lognormal sigma 0.2 / 0.4 / 0.8. Default "medium". */
  variance?: "low" | "medium" | "high";
  // server
  /** Dependency-call timeout in ms; 0 = none. */
  timeoutMs?: number;
  /** Retries after a timeout or failure, 0-3. */
  retries?: number;
  /** Base for exponential backoff with full jitter, ms. */
  retryBackoffMs?: number;
  circuitBreaker?: boolean;
  /** Per-replica queue bound; 0 = unbounded. Arrivals beyond it are rejected fast. Also used by queues. */
  maxQueue?: number;
  /** How a server calls several dependencies. */
  fanout?: "parallel" | "sequential";
  // load balancer
  algorithm?: "round-robin" | "least-connections";
  /** Dead-endpoint detection interval in ms; 0 = immediate. */
  healthCheckMs?: number;
  // database
  dbMode?: "single" | "leader-follower" | "sharded" | "quorum";
  shards?: number;
  shardStrategy?: "hash" | "range";
  replicationLagMs?: number;
  failoverMs?: number;
  consistency?: "eventual" | "read-your-writes";
  // cache
  cacheModel?: "probabilistic" | "keyed";
  cacheEntries?: number;
  ttlMs?: number;
  coalesce?: boolean;
  warmupSeconds?: number;
  // rate limiter
  /** Token-bucket refill rate, req/s. */
  limit?: number;
  /** Token-bucket size. Defaults to `limit`. */
  burst?: number;
  // v2.1 — queues
  /** at-most-once (default): a job lost with a dead worker is gone. at-least-once: it is redelivered after the visibility timeout. */
  ackMode?: "at-most-once" | "at-least-once";
  visibilityTimeoutMs?: number;
  /** Redeliveries beyond this count are dead-lettered. Default 3. */
  maxDeliveries?: number;
  // v2.1 — workers and servers
  /** Worker dedups redelivered jobs by key so duplicates do no work. */
  idempotent?: boolean;
  /** Max in-flight dependency calls per replica; 0 = unlimited. */
  poolSize?: number;
  breakerWindowMs?: number;
  breakerMinCalls?: number;
  breakerFailureRatio?: number;
  breakerOpenMs?: number;
  // v2.1 — quorum databases
  quorumWrite?: number;
  quorumRead?: number;
}
export interface SystemEdge { id: string; source: string; target: string }
export interface Architecture { nodes: SystemNode[]; edges: SystemEdge[] }

export interface FailureEvent {
  kind: "server" | "database" | "cache-flush" | "slow-database" | "slow-server" | "region" | "flapping" | "error-burst";
  /** Fraction of the run, 0..1. */
  at: number;
  /** Seconds until recovery. 0 or undefined: no recovery (server/database), 5 (slow-database), 0 (region). */
  duration?: number;
  /** slow-database service-time multiplier. Default 5. */
  factor?: number;
  /** Node id. Default: the first enabled matching component. */
  target?: string;
  /** Region outage target. */
  region?: Region;
  /** flapping: period of the dead/alive cycle in ms. Default 1000. */
  intervalMs?: number;
  /** error-burst: share of requests the target fails while looking healthy. Default 0.3. */
  ratio?: number;
}
export interface Workload {
  requestRate: number;
  readRatio: number;
  duration: number;
  seed: number;
  pattern: "steady" | "spike" | "ramp" | "flash";
  /** Legacy single failure at the halfway point. Ignored when `failures` is set. */
  failure: "none" | "server" | "database";
  failures?: FailureEvent[];
  /** Distinct keys. Default 10000. */
  keySpace?: number;
  /** 0 uniform … 0.95 extreme. Default 0.6. */
  keySkew?: number;
  /** Traffic origin mix. Default one region, "primary". */
  regions?: { name: Region; share: number }[];
  /** Added to every hop that crosses regions. Default 80. */
  crossRegionLatencyMs?: number;
  /** End-to-end request deadline. Default 5000. */
  deadlineMs?: number;
}

export interface NodeMetric {
  nodeId: string;
  utilization: number;
  queueDepth: number;
  processed: number;
  errors: number;
  rejected?: number;
  avgLatency: number;
  replicas?: { index: number; processed: number; errors: number; utilization: number }[];
  healthyReplicas?: number;
  /** Sharded databases: utilization per shard. */
  shards?: number[];
}
export interface MetricSample {
  time: number;
  latency: number;
  p95: number;
  throughput: number;
  errorRate: number;
  queueDepth: number;
  rejected?: number;
}
export type TraceStatus = "ok" | "error" | "hit" | "miss" | "bypass" | "rejected" | "timeout" | "retry" | "coalesced" | "stale" | "open-circuit" | "redelivered" | "duplicate" | "dead-letter" | "pool-exhausted" | "lost-write";
export interface TraceStep { nodeId: string; label: string; startedAt: number; duration: number; status: TraceStatus; replica?: number }
export interface RequestTrace { id: number; latency: number; success: boolean; steps: TraceStep[] }
export interface SimulationEvent { time: number; title: string; detail: string; nodeId?: string }
export interface SimulationResult {
  engineVersion: string;
  seed: number;
  duration: number;
  requestCount: number;
  completed: number;
  failed: number;
  /** Shed deliberately by a rate limiter, bounded queue, or open circuit. Included in `failed`. */
  rejected: number;
  p50: number;
  p95: number;
  p99: number;
  throughput: number;
  /** Unexpected failures only: (failed - rejected) / requestCount. */
  errorRate: number;
  rejectedRate: number;
  successRate: number;
  staleReads: number;
  staleReadRate: number;
  retriesIssued: number;
  /** Calls received by the most-amplified dependency divided by the requests its callers processed. 1 = no amplification. */
  amplification: number;
  /** provisionedCost + usageCost. */
  cost: number;
  provisionedCost: number;
  /** Measured operations extrapolated to an hour at per-kind rates. */
  usageCost: number;
  costBreakdown: { nodeId: string; label: string; cost: number; usage?: number }[];
  duplicates: number;
  duplicateRate: number;
  deadLettered: number;
  deadLetterRate: number;
  lostWrites: number;
  poolRejections: number;
  maxQueueDepth: number;
  nodes: NodeMetric[];
  samples: MetricSample[];
  traces: RequestTrace[];
  events: SimulationEvent[];
  insights: { severity: "good" | "warning" | "critical"; title: string; detail: string; nodeId?: string }[];
  assumptions: string[];
}

export type ObjectiveMetric = "p95" | "p99" | "throughput" | "errorRate" | "rejectedRate" | "successRate" | "cost" | "maxQueueDepth" | "staleReadRate" | "duplicateRate" | "deadLetterRate" | "lostWrites";
export interface Objective {
  id: string;
  label: string;
  metric: ObjectiveMetric;
  operator: "lte" | "gte";
  target: number;
}

export interface Reading { title: string; url: string; source: string; why: string; minutes?: number }
export type EstimationId = "p95" | "throughput" | "cost" | "dbLoad" | "bottleneckCapacity" | "queueDepth";
export interface EstimationPrompt { id: EstimationId; label: string; unit: string; tolerance: number }
export interface RubricItem { id: string; criterion: string; weight: number }
export interface DefenseSpec {
  prompt: string;
  followUps: string[];
  rubric: RubricItem[];
  modelAnswer: string;
}
export interface Clarification { question: string; answer: string; relevant: boolean }
export type LessonKind = "sim" | "brief" | "written";
export type Difficulty = "Beginner" | "Intermediate" | "Advanced" | "Expert";
export interface Lesson {
  id: string;
  number: number;
  chapter: string;
  title: string;
  subtitle: string;
  kind: LessonKind;
  difficulty: Difficulty;
  minutes: number;
  concept: string;
  brief: string;
  learning: string[];
  hints: string[];
  objectives: Objective[];
  architecture: Architecture;
  workload: Workload;
  allowedKinds: NodeKind[];
  requiredBalancedReplicas?: number;
  /** Hidden solution. Must pass every objective on the three assessment seeds. */
  reference: Architecture;
  estimation: EstimationPrompt[];
  defense: DefenseSpec;
  readings: Reading[];
  reflection: { question: string; options: string[]; answer: number; explanation: string };
  /** Briefs only. The workload stays hidden until at least half of the relevant questions are asked. */
  clarifications?: Clarification[];
  remixable: boolean;
  /** Briefs: the starter is traffic-only and the reference is never shown; only objectives and runnability are graded. */
  blankCanvas?: boolean;
}
export interface SavedDesign {
  id: string;
  name: string;
  lessonId: string | null;
  architecture: Architecture;
  workload: Workload;
  updatedAt: string;
}
export interface ProgressRecord {
  lessonId: string;
  completedAt: string;
  bestP95: number;
  cost: number;
  assessmentVersion?: number;
  attempts?: number;
  hintsUsed?: number;
  /** Mean estimation score, 0-1. */
  estimationScore?: number;
  /** Defense score, 0-100. */
  defenseScore?: number;
  defenseMode?: "graded" | "self";
  remixes?: number;
  /** Seconds over the interview clocks across the defense. */
  overtimeSeconds?: number;
  followUpMode?: "dynamic" | "static";
}
