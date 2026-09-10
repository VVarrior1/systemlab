export type NodeKind = "traffic" | "server" | "load-balancer" | "database" | "cache" | "queue";
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
}
export interface SystemEdge { id: string; source: string; target: string }
export interface Architecture { nodes: SystemNode[]; edges: SystemEdge[] }
export interface Workload {
  requestRate: number;
  readRatio: number;
  duration: number;
  seed: number;
  pattern: "steady" | "spike" | "ramp";
  failure: "none" | "server" | "database";
}
export interface NodeMetric {
  nodeId: string;
  utilization: number;
  queueDepth: number;
  processed: number;
  errors: number;
  avgLatency: number;
  replicas?: { index: number; processed: number; errors: number; utilization: number }[];
  healthyReplicas?: number;
}
export interface MetricSample {
  time: number;
  latency: number;
  p95: number;
  throughput: number;
  errorRate: number;
  queueDepth: number;
}
export interface TraceStep { nodeId: string; label: string; startedAt: number; duration: number; status: "ok" | "error" | "hit" | "miss" | "bypass"; replica?: number }
export interface RequestTrace { id: number; latency: number; success: boolean; steps: TraceStep[] }
export interface SimulationResult {
  engineVersion: string;
  seed: number;
  duration: number;
  requestCount: number;
  completed: number;
  failed: number;
  p50: number;
  p95: number;
  throughput: number;
  errorRate: number;
  cost: number;
  maxQueueDepth: number;
  nodes: NodeMetric[];
  samples: MetricSample[];
  traces: RequestTrace[];
  insights: { severity: "good" | "warning" | "critical"; title: string; detail: string; nodeId?: string }[];
  assumptions: string[];
}
export interface Objective {
  id: string;
  label: string;
  metric: "p95" | "throughput" | "errorRate" | "cost" | "maxQueueDepth";
  operator: "lte" | "gte";
  target: number;
}
export interface Lesson {
  id: string;
  number: number;
  chapter: string;
  title: string;
  subtitle: string;
  difficulty: "Beginner" | "Intermediate" | "Advanced";
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
  reflection: { question: string; options: string[]; answer: number; explanation: string };
}
export interface SavedDesign {
  id: string;
  name: string;
  lessonId: string | null;
  architecture: Architecture;
  workload: Workload;
  updatedAt: string;
}
export interface ProgressRecord { lessonId: string; completedAt: string; bestP95: number; cost: number; assessmentVersion?: number }
