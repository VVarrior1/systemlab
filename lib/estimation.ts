import type { Architecture, EstimationId, EstimationPrompt, NodeMetric, SimulationResult } from "./types";

export type EstimationValues = Partial<Record<EstimationId, number>>;

export interface EstimationOutcome {
  id: EstimationId;
  label: string;
  unit: string;
  predicted: number;
  actual: number;
  score: 0 | 0.5 | 1;
}

/** The measured value a given estimation prompt is graded against, derived from the check's results. */
export function actualFor(id: EstimationId, results: SimulationResult[], architecture: Architecture): number {
  switch (id) {
    case "p95":
      return Math.max(...results.map((result) => result.p95));
    case "throughput":
      return Math.min(...results.map((result) => result.throughput));
    case "cost":
      return results[0].cost;
    case "dbLoad": {
      const databaseIds = new Set(architecture.nodes.filter((node) => node.kind === "database").map((node) => node.id));
      return Math.max(...results.map((result) => {
        const processed = result.nodes.filter((metric) => databaseIds.has(metric.nodeId)).reduce((sum, metric) => sum + metric.processed, 0);
        return result.duration > 0 ? processed / result.duration : 0;
      }));
    }
    case "bottleneckCapacity": {
      const first = results[0];
      let busiest: NodeMetric | null = null;
      for (const metric of first.nodes) {
        const node = architecture.nodes.find((item) => item.id === metric.nodeId);
        if (!node || node.kind === "traffic") continue;
        if (!busiest || metric.utilization > busiest.utilization) busiest = metric;
      }
      if (!busiest) return 0;
      const node = architecture.nodes.find((item) => item.id === busiest!.nodeId);
      return node ? node.capacity * node.replicas : 0;
    }
    case "queueDepth":
      return Math.max(...results.map((result) => result.maxQueueDepth));
  }
}

/** score 1 within tolerance of the actual, 0.5 within 2x tolerance, else 0. Tolerance is relative to the
 *  actual value with an absolute floor of 1 unit, so a near-zero actual still allows a little slack. */
export function scoreEstimations(prompts: EstimationPrompt[], values: EstimationValues, results: SimulationResult[], architecture: Architecture): EstimationOutcome[] {
  return prompts.map((prompt) => {
    const actual = actualFor(prompt.id, results, architecture);
    const predicted = values[prompt.id] ?? 0;
    const allowed = Math.max(prompt.tolerance * Math.abs(actual), 1);
    const diff = Math.abs(predicted - actual);
    const score: 0 | 0.5 | 1 = diff <= allowed ? 1 : diff <= allowed * 2 ? 0.5 : 0;
    return { id: prompt.id, label: prompt.label, unit: prompt.unit, predicted, actual, score };
  });
}

export function estimationComplete(prompts: EstimationPrompt[], values: EstimationValues): boolean {
  return prompts.every((prompt) => Number.isFinite(values[prompt.id]));
}

export function meanEstimationScore(outcomes: EstimationOutcome[]): number {
  if (outcomes.length === 0) return 0;
  return outcomes.reduce((sum, outcome) => sum + outcome.score, 0) / outcomes.length;
}
