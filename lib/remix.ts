import type { Architecture, Lesson, Objective, SimulationResult, Workload } from "./types";
import { createRandom } from "./simulation/distributions";

export interface RemixedLesson {
  workload: Workload;
  factor: number;
  readShift: number;
  reference: Architecture;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const roundTo10 = (value: number) => Math.max(10, Math.round(value / 10) * 10);

/**
 * Seeded remix: scales the lesson's request rate and nudges its read ratio, then scales the
 * (hidden) reference's server/worker/database capacities to match. Pattern and failures are
 * left alone; caches, balancers and queues keep their configured sizes (only a rate limiter's
 * limit/burst scale, since those are throughput knobs like capacity).
 */
export function remixLesson(lesson: Lesson, remixSeed: number): RemixedLesson {
  const random = createRandom(remixSeed);
  const factor = Math.round((0.7 + random() * 0.9) * 100) / 100; // [0.7, 1.6]
  const readShift = Math.round((random() * 2 - 1) * 0.15 * 100) / 100; // ±0.15
  const derivedSeed = Math.floor(random() * 1_000_000) + 1;

  const workload: Workload = {
    ...lesson.workload,
    requestRate: Math.max(1, Math.round(lesson.workload.requestRate * factor)),
    readRatio: clamp01(lesson.workload.readRatio + readShift),
    seed: derivedSeed,
  };

  const reference = structuredClone(lesson.reference);
  for (const node of reference.nodes) {
    if (node.kind === "server" || node.kind === "database" || node.kind === "object-store" || node.kind === "stream") {
      node.capacity = roundTo10(node.capacity * factor);
    } else if (node.kind === "rate-limiter") {
      if (node.limit !== undefined) node.limit = Math.max(1, Math.round(node.limit * factor));
      if (node.burst !== undefined) node.burst = Math.max(1, Math.round(node.burst * factor));
    }
  }

  return { workload, factor, readShift, reference };
}

type ScaledObjectiveMetric = "maxQueueDepth" | "staleReadRate" | "rejectedRate" | "duplicateRate" | "deadLetterRate" | "lostWrites" | "conflictingWrites" | "egressGb";

const labelFor = (metric: ScaledObjectiveMetric, target: number): string => {
  if (metric === "maxQueueDepth") return `Peak queue depth at most ${target}`;
  if (metric === "staleReadRate") return `Stale read rate at most ${Math.round(target * 1000) / 10}%`;
  if (metric === "rejectedRate") return `Rejected rate at most ${Math.round(target * 1000) / 10}%`;
  if (metric === "duplicateRate") return `Duplicate deliveries at most ${Math.round(target * 1000) / 10}%`;
  if (metric === "deadLetterRate") return `Dead-lettered jobs at most ${Math.round(target * 1000) / 10}%`;
  if (metric === "conflictingWrites") return `Conflicting writes at most ${target}`;
  if (metric === "egressGb") return `Egress at most ${target} GB`;
  return `Lost writes at most ${target}`;
};

/**
 * Derives objectives for a remixed mission from the reference's own measured runs on the three
 * assessment seeds, per §7's formulas. `workload` is the remixed workload from `remixLesson` --
 * needed for the requestRate/pattern the throughput target is built from, which the spec's
 * shorthand signature `(lesson, referenceResults)` omits; see remix.test.ts / final report.
 */
export function deriveRemixObjectives(lesson: Lesson, workload: Workload, referenceResults: SimulationResult[]): Objective[] {
  const maxP95 = Math.max(...referenceResults.map((result) => result.p95));
  const maxCost = Math.max(...referenceResults.map((result) => result.cost));
  const p95Target = Math.round(1.2 * maxP95);
  const costTarget = Math.round(1.1 * maxCost);
  const throughputFraction = workload.pattern === "steady" ? 0.95 : 0.9;
  // The pattern formula assumes every arrival is meant to complete. Lessons that shed on purpose
  // (rate limiter, bounded queue) never reach it, so the target is also capped just under what the
  // scaled reference actually measured: the derived objectives stay satisfiable by construction.
  const minReferenceThroughput = Math.min(...referenceResults.map((result) => result.throughput));
  const throughputTarget = Math.min(throughputFraction * workload.requestRate, Math.floor(0.9 * minReferenceThroughput));

  // A lesson that tolerates some errors on purpose (poison jobs, a deliberate outage window) keeps its own
  // error budget; everything else holds the 1% default.
  const lessonErrorTarget = lesson.objectives.find((objective) => objective.metric === "errorRate")?.target ?? 0.01;
  const worstErrorRate = Math.max(...referenceResults.map((result) => result.errorRate));
  const errorTarget = Math.max(0.01, lessonErrorTarget, Math.round(worstErrorRate * 1.5 * 1000) / 1000);

  const objectives: Objective[] = [
    { id: "p95", label: `P95 latency at most ${p95Target} ms`, metric: "p95", operator: "lte", target: p95Target },
    { id: "throughput", label: `Throughput at least ${Math.round(throughputTarget)} req/s`, metric: "throughput", operator: "gte", target: throughputTarget },
    { id: "errorRate", label: `Error rate at most ${Math.round(errorTarget * 1000) / 10}%`, metric: "errorRate", operator: "lte", target: errorTarget },
    { id: "cost", label: `Infrastructure cost at most ${costTarget} credits`, metric: "cost", operator: "lte", target: costTarget },
  ];

  for (const metric of ["maxQueueDepth", "staleReadRate", "rejectedRate", "duplicateRate", "deadLetterRate", "lostWrites", "conflictingWrites", "egressGb"] as const) {
    if (!lesson.objectives.some((objective) => objective.metric === metric)) continue;
    const worst = Math.max(...referenceResults.map((result) => result[metric] as number));
    const target = metric === "maxQueueDepth" ? Math.round(worst * 1.5)
      : metric === "lostWrites" ? worst + 2
      : metric === "conflictingWrites" ? worst + 1
      : metric === "egressGb" ? worst * 1.3
      : worst * 1.5;
    objectives.push({ id: metric, label: labelFor(metric, target), metric, operator: "lte", target });
  }

  return objectives;
}
