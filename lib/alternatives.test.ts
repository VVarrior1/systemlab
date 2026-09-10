import { describe, expect, it } from "vitest";
import { compareAlternative, generateAlternatives } from "./alternatives";
import { runSimulation, validateSimulation } from "./simulation";
import { lessons } from "./curriculum";
import type { Architecture, Objective, SimulationResult } from "./types";

const criterion = (metric: Objective["metric"], operator: Objective["operator"], target: number): Objective => ({ id: metric, label: metric, metric, operator, target });

describe("generateAlternatives", () => {
  it("produces only valid, runnable architectures for every current lesson", () => {
    for (const lesson of lessons) {
      const alternatives = generateAlternatives(lesson.architecture, lesson);
      expect(alternatives.length).toBeGreaterThan(0);
      for (const alternative of alternatives) {
        expect(() => validateSimulation(alternative.architecture, lesson.workload), `${lesson.id}/${alternative.id}`).not.toThrow();
      }
    }
  });

  it("scales the highest-utilization node when a result is supplied", () => {
    const lesson = lessons.find((item) => item.id === "find-the-bottleneck")!;
    const result = runSimulation(lesson.architecture, lesson.workload);
    const busiest = [...result.nodes].sort((a, b) => b.utilization - a.utilization)[0];
    const alternatives = generateAlternatives(lesson.architecture, undefined, result);
    const scaled = alternatives.find((alt) => alt.id === "scale-bottleneck")!;
    const originalNode = lesson.architecture.nodes.find((node) => node.id === busiest.nodeId)!;
    const scaledNode = scaled.architecture.nodes.find((node) => node.id === busiest.nodeId)!;
    expect(scaledNode.capacity).toBe(Math.round(originalNode.capacity * 1.5));
  });

  it("falls back to the lowest-capacity server/database with no result", () => {
    const lesson = lessons.find((item) => item.id === "find-the-bottleneck")!;
    const alternatives = generateAlternatives(lesson.architecture);
    const scaled = alternatives.find((alt) => alt.id === "scale-bottleneck")!;
    // find-the-bottleneck: server capacity 100 < database capacity 400, so the server is scaled.
    const server = lesson.architecture.nodes.find((node) => node.kind === "server")!;
    const scaledServer = scaled.architecture.nodes.find((node) => node.id === server.id)!;
    expect(scaledServer.capacity).toBe(Math.round(server.capacity * 1.5));
  });

  it("inserts a cache only when the direct server-to-database edge has none yet", () => {
    const withoutCache = lessons.find((item) => item.id === "find-the-bottleneck")!;
    const added = generateAlternatives(withoutCache.architecture, withoutCache).find((alt) => alt.id === "add-cache");
    expect(added).toBeDefined();
    expect(added!.architecture.nodes.some((node) => node.kind === "cache")).toBe(true);
    expect(validateSimulation(added!.architecture, withoutCache.workload)).toBeUndefined();

    // Already routed server -> cache -> database (no direct server->database edge): nothing to add.
    const alreadyCached: Architecture = structuredClone(added!.architecture);
    const alreadyHasCache = generateAlternatives(alreadyCached).find((alt) => alt.id === "add-cache");
    expect(alreadyHasCache).toBeUndefined();
  });

  it("trims one replica off every node with two or more, and skips when nothing changes", () => {
    const lesson = lessons.find((item) => item.id === "survive-the-spike")!;
    const withReplicas: Architecture = structuredClone(lesson.architecture);
    withReplicas.nodes.find((node) => node.kind === "server")!.replicas = 2;
    const trimmed = generateAlternatives(withReplicas).find((alt) => alt.id === "trim-replicas")!;
    const server = trimmed.architecture.nodes.find((node) => node.kind === "server")!;
    expect(server.replicas).toBe(1);

    const allSingleReplica: Architecture = structuredClone(lesson.architecture);
    for (const node of allSingleReplica.nodes) node.replicas = 1;
    expect(generateAlternatives(allSingleReplica).find((alt) => alt.id === "trim-replicas")).toBeUndefined();
  });

  it("offers the reference only when a lesson is given and it differs from the learner's design", () => {
    const lesson = lessons.find((item) => item.id === "first-request")!;
    expect(generateAlternatives(lesson.architecture, lesson).find((alt) => alt.id === "reference")).toBeUndefined();
    const changed: Architecture = structuredClone(lesson.architecture);
    changed.nodes.find((node) => node.kind === "server")!.capacity = 1;
    const withReference = generateAlternatives(changed, lesson).find((alt) => alt.id === "reference");
    expect(withReference).toBeDefined();
    expect(withReference!.architecture).toEqual(lesson.reference);
    expect(generateAlternatives(lesson.architecture).find((alt) => alt.id === "reference")).toBeUndefined();
  });

  it("recomputes cost on the changed node instead of carrying the old value", () => {
    const lesson = lessons.find((item) => item.id === "find-the-bottleneck")!;
    const scaled = generateAlternatives(lesson.architecture).find((alt) => alt.id === "scale-bottleneck")!;
    const server = lesson.architecture.nodes.find((node) => node.kind === "server")!;
    const scaledServer = scaled.architecture.nodes.find((node) => node.id === server.id)!;
    expect(scaledServer.cost).not.toBe(server.cost);
    expect(scaledServer.cost).toBeGreaterThan(server.cost);
  });
});

describe("compareAlternative", () => {
  const base: SimulationResult = {
    engineVersion: "2.0.0", seed: 42, duration: 30, requestCount: 3000, completed: 3000, failed: 0, rejected: 0,
    p50: 20, p95: 50, p99: 70, throughput: 99, errorRate: 0, rejectedRate: 0, successRate: 1, staleReads: 0,
    staleReadRate: 0, retriesIssued: 0, amplification: 1, cost: 10, costBreakdown: [], maxQueueDepth: 1,
    nodes: [], samples: [], traces: [], events: [], insights: [], assumptions: [],
  };
  const objectives = [criterion("p95", "lte", 60), criterion("errorRate", "lte", 0.01)];

  it("names the cost delta, latency delta and objectives passed in one sentence", () => {
    const cheaperFaster: SimulationResult = { ...base, cost: 7.8, p95: 40 };
    const sentence = compareAlternative(base, cheaperFaster, objectives);
    expect(sentence).toMatch(/22% lower cost/);
    expect(sentence).toMatch(/10 ms lower p95/);
    expect(sentence).toMatch(/meets every target/);
  });

  it("reports a worse alternative honestly", () => {
    const pricier: SimulationResult = { ...base, cost: 12, p95: 65 };
    const sentence = compareAlternative(base, pricier, objectives);
    expect(sentence).toMatch(/20% higher cost/);
    expect(sentence).toMatch(/15 ms higher p95/);
    expect(sentence).toMatch(/meets 1\/2 targets/);
  });

  it("handles an unchanged cost and latency", () => {
    const sentence = compareAlternative(base, { ...base }, objectives);
    expect(sentence).toMatch(/same cost/);
    expect(sentence).toMatch(/unchanged p95/);
  });
});
