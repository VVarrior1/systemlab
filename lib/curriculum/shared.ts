import type { Architecture, Clarification, DefenseSpec, EstimationId, EstimationPrompt, Lesson, NodeKind, Objective, ObjectiveMetric, Reading, RubricItem, SystemNode, Workload } from "../types";
import { createSystemNode, defaultWorkload } from "../templates";
import { componentCost } from "../cost";
import { readings as readingLibrary } from "../readings";

/** Chapter titles in curriculum order. Chapter files reference these by index. */
export const chapterTitles = [
  "Foundations",
  "Performance",
  "Workloads & queues",
  "Caching deep dive",
  "Reliability",
  "Replication & consistency",
  "Partitioning",
  "Traffic control",
  "Multi-region",
  "Data systems",
  "Interview toolkit",
  "Design briefs",
] as const;

export const allKinds: NodeKind[] = ["server", "load-balancer", "database", "cache", "queue", "cdn", "rate-limiter"];

/** A node placed on the canvas grid: column 0.. left to right, row 0 centered, -1 above, 1 below. */
export function node(kind: NodeKind, id: string, column: number, overrides: Partial<SystemNode> = {}, row = 0): SystemNode {
  const base = createSystemNode(kind, id, { x: 40 + column * 280, y: 140 + row * 170 });
  const merged = { ...base, ...overrides };
  return { ...merged, cost: componentCost(merged) };
}

/** A straight request path: each node connects to the next. */
export function chain(nodes: SystemNode[]): Architecture {
  return {
    nodes,
    edges: nodes.slice(1).map((target, index) => ({ id: `${nodes[index].id}-${target.id}`, source: nodes[index].id, target: target.id })),
  };
}

/** An arbitrary graph from (source, target) id pairs. */
export function graph(nodes: SystemNode[], edges: [string, string][]): Architecture {
  return { nodes, edges: edges.map(([source, target]) => ({ id: `${source}-${target}`, source, target })) };
}

/** Returns a copy of an architecture with per-node overrides applied (by node id). Handy for building the reference from the starter. */
export function tweak(architecture: Architecture, patches: Record<string, Partial<SystemNode>>): Architecture {
  return {
    nodes: architecture.nodes.map((item) => {
      const patch = patches[item.id];
      if (!patch) return { ...item };
      const merged = { ...item, ...patch };
      return { ...merged, cost: componentCost(merged) };
    }),
    edges: architecture.edges.map((edge) => ({ ...edge })),
  };
}

export function workload(overrides: Partial<Workload> = {}): Workload {
  return { ...defaultWorkload, ...overrides };
}

const metricLabels: Record<ObjectiveMetric, (target: number, operator: Objective["operator"]) => string> = {
  p95: (t) => `P95 latency at most ${t} ms`,
  p99: (t) => `P99 latency at most ${t} ms`,
  throughput: (t) => `Throughput at least ${t} req/s`,
  errorRate: (t) => `Error rate at most ${Math.round(t * 1000) / 10}%`,
  rejectedRate: (t) => `Rejected requests at most ${Math.round(t * 1000) / 10}%`,
  successRate: (t) => `Successful requests at least ${Math.round(t * 1000) / 10}%`,
  cost: (t) => `Infrastructure cost at most ${t} credits`,
  maxQueueDepth: (t) => `Peak queue depth at most ${t}`,
  staleReadRate: (t) => `Stale reads at most ${Math.round(t * 1000) / 10}%`,
  duplicateRate: (t) => `Duplicate deliveries at most ${Math.round(t * 1000) / 10}%`,
  deadLetterRate: (t) => `Dead-lettered jobs at most ${Math.round(t * 1000) / 10}%`,
  lostWrites: (t) => `Lost writes at most ${t}`,
};

export function objective(metric: ObjectiveMetric, operator: Objective["operator"], target: number, label?: string): Objective {
  return { id: metric, metric, operator, target, label: label ?? metricLabels[metric](target, operator) };
}

/** The standard trio: p95, throughput, and 1% errors. */
export function healthy(throughput: number, p95 = 180, errorRate = 0.01): Objective[] {
  return [objective("p95", "lte", p95), objective("throughput", "gte", throughput), objective("errorRate", "lte", errorRate)];
}
export const budget = (credits: number) => objective("cost", "lte", credits);
export const queueDepth = (depth: number) => objective("maxQueueDepth", "lte", depth);
export const staleReads = (rate: number) => objective("staleReadRate", "lte", rate);
export const rejected = (rate: number) => objective("rejectedRate", "lte", rate);
export const p99 = (ms: number) => objective("p99", "lte", ms);
export const duplicates = (rate: number) => objective("duplicateRate", "lte", rate);
export const deadLetters = (rate: number) => objective("deadLetterRate", "lte", rate);
export const lostWrites = (count: number) => objective("lostWrites", "lte", count);

const estimationPresets: Record<EstimationId, Omit<EstimationPrompt, "id">> = {
  p95: { label: "Predicted P95 latency after your change", unit: "ms", tolerance: 0.25 },
  throughput: { label: "Predicted successful throughput", unit: "req/s", tolerance: 0.1 },
  cost: { label: "Predicted infrastructure cost of your design", unit: "credits", tolerance: 0.15 },
  dbLoad: { label: "Requests per second that will reach the database", unit: "req/s", tolerance: 0.2 },
  bottleneckCapacity: { label: "Capacity the bottleneck component needs per replica", unit: "req/s", tolerance: 0.2 },
  queueDepth: { label: "Peak number of waiting requests", unit: "requests", tolerance: 0.5 },
};
/** Pick the estimation prompts a lesson asks for, in order. */
export function estimate(...ids: EstimationId[]): EstimationPrompt[] {
  return ids.map((id) => ({ id, ...estimationPresets[id] }));
}

/** Rubric rows as [id, criterion, weight]. Weights must sum to 100 (test-enforced). */
export function rubric(rows: [string, string, number][]): RubricItem[] {
  return rows.map(([id, criterion, weight]) => ({ id, criterion, weight }));
}

export function defense(spec: { prompt?: string; followUps: string[]; rubric: RubricItem[]; modelAnswer: string }): DefenseSpec {
  return {
    prompt: spec.prompt ?? "Explain your final design in your own words: what you changed, why it works for this workload, and two alternatives you considered and rejected.",
    followUps: spec.followUps,
    rubric: spec.rubric,
    modelAnswer: spec.modelAnswer,
  };
}

export function readingsFor(lessonId: string): Reading[] {
  return readingLibrary[lessonId] ?? [];
}

export const clarification = (question: string, answer: string, relevant = true): Clarification => ({ question, answer, relevant });

type LessonInput = Omit<Lesson, "number" | "kind" | "readings" | "remixable" | "estimation"> & {
  kind?: Lesson["kind"];
  readings?: Reading[];
  remixable?: boolean;
  estimation?: EstimationPrompt[];
};

/** A simulation lesson. Number is assigned by the curriculum index; readings default to the library entry for the lesson id. */
export function lesson(input: LessonInput): Lesson {
  return {
    kind: "sim",
    remixable: true,
    readings: input.readings ?? readingsFor(input.id),
    estimation: input.estimation ?? estimate("p95", "throughput"),
    number: 0,
    ...input,
  };
}

/** A design brief: clarify first, then estimate, build and defend. */
export function brief(input: LessonInput & { clarifications: Clarification[] }): Lesson {
  // Blank-canvas briefs start from a traffic-only graph; the authored reference is kept as-is
  // (it is never shown to the learner, only used for grading).
  const architecture = input.blankCanvas ? chain([node("traffic", "traffic", 0)]) : input.architecture;
  return lesson({ ...input, architecture, kind: "brief", remixable: input.remixable ?? false });
}

const placeholder: Architecture = chain([node("traffic", "traffic", 0), node("server", "server", 1), node("database", "database", 2)]);

/** A knowledge lesson: readings and a written defense, no simulation. */
export function written(input: Omit<LessonInput, "objectives" | "architecture" | "reference" | "workload" | "allowedKinds" | "hints"> & { hints?: string[] }): Lesson {
  return lesson({
    hints: [],
    ...input,
    kind: "written",
    objectives: [],
    architecture: placeholder,
    reference: placeholder,
    workload: workload(),
    allowedKinds: [],
    estimation: [],
    remixable: false,
  });
}

export interface ChapterFile { title: (typeof chapterTitles)[number]; lessons: Lesson[] }
