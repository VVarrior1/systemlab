import type { Architecture, Lesson, Objective, SimulationResult, SystemNode } from "./types";
import { componentCost } from "./cost";
import { createSystemNode } from "./templates";
import { objectivePasses } from "./assessment";

export type AlternativeId = "scale-bottleneck" | "add-cache" | "trim-replicas" | "reference";

export interface Alternative {
  id: AlternativeId;
  title: string;
  rationale: string;
  architecture: Architecture;
}

const clone = <T>(value: T): T => structuredClone(value);

/** Picks the node to scale when the learner's own run is available: highest utilization, traffic excluded. */
function pickByPressure(architecture: Architecture, result: SimulationResult): SystemNode | undefined {
  const utilizationByNode = new Map(result.nodes.map((metric) => [metric.nodeId, metric.utilization]));
  return architecture.nodes
    .filter((node) => node.enabled && node.kind !== "traffic")
    .sort((a, b) => (utilizationByNode.get(b.id) ?? -1) - (utilizationByNode.get(a.id) ?? -1))[0];
}

/** No run available yet: guess the bottleneck as the smallest server or database. */
function pickByCapacity(architecture: Architecture): SystemNode | undefined {
  return architecture.nodes
    .filter((node) => node.enabled && (node.kind === "server" || node.kind === "database"))
    .sort((a, b) => a.capacity - b.capacity)[0];
}

function scaleBottleneck(architecture: Architecture, result?: SimulationResult): Alternative | null {
  const scaled = clone(architecture);
  const targetId = (result ? pickByPressure(architecture, result) : pickByCapacity(architecture))?.id;
  if (!targetId) return null;
  const node = scaled.nodes.find((candidate) => candidate.id === targetId);
  if (!node) return null;
  node.capacity = Math.round(node.capacity * 1.5);
  node.cost = componentCost(node);
  return {
    id: "scale-bottleneck",
    title: "Scale the bottleneck",
    rationale: `+50% capacity on ${node.label}, the component under the most pressure.`,
    architecture: scaled,
  };
}

function addCache(architecture: Architecture): Alternative | null {
  const withCache = clone(architecture);
  const databaseIds = new Set(withCache.nodes.filter((node) => node.kind === "database").map((node) => node.id));
  const cacheSources = new Set(
    withCache.edges
      .filter((edge) => withCache.nodes.find((node) => node.id === edge.source)?.kind === "cache")
      .map((edge) => edge.target),
  );
  const serversWithCache = new Set(
    withCache.edges
      .filter((edge) => withCache.nodes.find((node) => node.id === edge.target)?.kind === "cache")
      .map((edge) => edge.source),
  );
  const candidate = withCache.edges.find((edge) => {
    const source = withCache.nodes.find((node) => node.id === edge.source);
    return source?.kind === "server" && databaseIds.has(edge.target)
      && !cacheSources.has(edge.target) && !serversWithCache.has(edge.source);
  });
  if (!candidate) return null;
  const source = withCache.nodes.find((node) => node.id === candidate.source)!;
  const database = withCache.nodes.find((node) => node.id === candidate.target)!;
  const cache = createSystemNode("cache", `alt-cache-${database.id}`, {
    x: (source.position.x + database.position.x) / 2,
    y: (source.position.y + database.position.y) / 2 - 60,
  });
  cache.cost = componentCost(cache);
  withCache.nodes.push(cache);
  withCache.edges = withCache.edges.filter((edge) => edge.id !== candidate.id);
  withCache.edges.push(
    { id: `${candidate.id}-to-cache`, source: candidate.source, target: cache.id },
    { id: `${candidate.id}-cache-storage`, source: cache.id, target: candidate.target },
  );
  return {
    id: "add-cache",
    title: "Add a cache",
    rationale: `Insert a cache between ${source.label} and ${database.label} to absorb repeated reads.`,
    architecture: withCache,
  };
}

function trimReplicas(architecture: Architecture): Alternative | null {
  const trimmed = clone(architecture);
  let changed = false;
  for (const node of trimmed.nodes) {
    const quorumFloor = node.kind === "database" && node.dbMode === "quorum" ? Math.max(node.quorumWrite ?? 2, node.quorumRead ?? 2) : 1;
    if (node.replicas >= 2 && node.replicas - 1 >= quorumFloor) {
      node.replicas -= 1;
      changed = true;
    }
  }
  if (!changed) return null;
  return {
    id: "trim-replicas",
    title: "Trim replicas",
    rationale: "Remove one replica from every over-provisioned component to cut cost.",
    architecture: trimmed,
  };
}

function referenceAlternative(lesson: Lesson | undefined, architecture: Architecture): Alternative | null {
  if (!lesson) return null;
  // Blank-canvas briefs never reveal the instructor's reference design.
  if (lesson.blankCanvas) return null;
  if (JSON.stringify(lesson.reference) === JSON.stringify(architecture)) return null;
  return {
    id: "reference",
    title: "Reference design",
    rationale: "The instructor's solution to this mission.",
    architecture: clone(lesson.reference),
  };
}

/**
 * Pure variant generator: no simulation happens here. Callers run each returned architecture
 * (on the lesson seed, in the worker) to compare against the learner's own result.
 */
export function generateAlternatives(architecture: Architecture, lesson?: Lesson, result?: SimulationResult): Alternative[] {
  const alternatives: Alternative[] = [];
  const scaled = scaleBottleneck(architecture, result);
  if (scaled) alternatives.push(scaled);
  const cached = addCache(architecture);
  if (cached) alternatives.push(cached);
  const trimmed = trimReplicas(architecture);
  if (trimmed) alternatives.push(trimmed);
  const reference = referenceAlternative(lesson, architecture);
  if (reference) alternatives.push(reference);
  return alternatives;
}

/** One calibrated sentence comparing an alternative's measured run against the learner's own. */
export function compareAlternative(learner: SimulationResult, alternative: SimulationResult, objectives: Objective[]): string {
  const passed = objectives.filter((objective) => objectivePasses(alternative, objective)).length;
  const total = objectives.length;
  const costDelta = learner.cost > 0 ? Math.round(((alternative.cost - learner.cost) / learner.cost) * 100) : 0;
  const p95Delta = Math.round(alternative.p95 - learner.p95);

  const objectivePhrase = total === 0 ? "runs without a scored objective" : passed === total ? "meets every target" : `meets ${passed}/${total} targets`;
  const costPhrase = costDelta === 0 ? "at the same cost" : costDelta < 0 ? `at ${Math.abs(costDelta)}% lower cost` : `at ${costDelta}% higher cost`;
  const latencyPhrase = p95Delta === 0 ? "with unchanged p95 latency" : p95Delta < 0 ? `and ${Math.abs(p95Delta)} ms lower p95` : `but ${p95Delta} ms higher p95`;

  return `This alternative ${objectivePhrase} ${costPhrase} ${latencyPhrase}.`;
}
