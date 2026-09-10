import type { Architecture, Lesson, SimulationResult } from "./types";

export interface MissionValidation {
  revision: number;
  passed: boolean;
  results: SimulationResult[];
}

/** The three seeds every mission and reference is graded on: the lesson's own, then two fixed seeds. */
export function assessmentSeeds(lesson: Lesson): number[] {
  return [lesson.workload.seed, 123, 2026];
}

export function checkedObjectives(lesson: Lesson, validation: MissionValidation | null, revision: number): boolean[] {
  const seeds = assessmentSeeds(lesson);
  const checked = validation?.revision === revision && validation.results.length === seeds.length
    && validation.results.every((result, index) => result.seed === seeds[index]);
  return lesson.objectives.map((objective) => !!checked && validation!.results.every((result) => objectivePasses(result, objective)));
}

export function objectivePasses(result: SimulationResult, objective: Lesson["objectives"][number]) {
  if ((objective.metric === "p95" || objective.metric === "p99") && result.completed === 0) return false;
  const value = result[objective.metric];
  return Number.isFinite(value) && (objective.operator === "lte" ? value <= objective.target : value >= objective.target);
}

export function validateMissionArchitecture(lesson: Lesson, architecture: Architecture): string | null {
  if (lesson.kind === "written") return null;
  const signature = (node: Architecture["nodes"][number]) => `${node.kind}:${node.role ?? "application"}`;
  const required = new Map<string, number>();
  for (const node of lesson.architecture.nodes) required.set(signature(node), (required.get(signature(node)) ?? 0) + 1);
  for (const [kind, count] of required) {
    if (architecture.nodes.filter((node) => node.enabled && signature(node) === kind).length < count) return `Keep the mission's original component types and roles online. Required: ${kind.split(":")[0].replaceAll("-", " ")}${kind.endsWith(":worker") ? " with worker role" : ""} (${count}).`;
  }
  if (lesson.requiredBalancedReplicas) {
    const balancers = new Set(architecture.nodes.filter((node) => node.kind === "load-balancer" && node.enabled).map((node) => node.id));
    const balanced = architecture.nodes.filter((node) => node.kind === "server" && node.role !== "worker" && node.enabled
      && architecture.edges.some((edge) => edge.target === node.id && balancers.has(edge.source)));
    if (balanced.reduce((total, node) => total + node.replicas, 0) < lesson.requiredBalancedReplicas) {
      return `Route traffic through a load balancer to at least ${lesson.requiredBalancedReplicas} application replicas. Extra capacity on one replica does not distribute traffic.`;
    }
  }
  if (lesson.architecture.nodes.some((node) => node.kind === "database")) {
    const terminals = architecture.nodes.filter((node) => !architecture.edges.some((edge) => edge.source === node.id));
    // cdn/rate-limiter are pass-through components (validateSimulation already requires them to forward
    // somewhere once a design is runnable); an in-progress edit shouldn't be flagged for stopping there.
    if (terminals.some((node) => node.kind !== "database" && node.kind !== "cdn" && node.kind !== "rate-limiter")) {
      return "Every dependency path must end at a database. Cache misses and writes still need a storage connection.";
    }
  }
  return null;
}
