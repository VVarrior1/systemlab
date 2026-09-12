import { describe, expect, it } from "vitest";
import { actualFor, estimationComplete, meanEstimationScore, scoreEstimations } from "./estimation";
import type { Architecture, EstimationPrompt, NodeMetric, SimulationResult } from "./types";

const baseResult: SimulationResult = {
  engineVersion: "1.0.0", seed: 42, duration: 30, requestCount: 3000,
  completed: 3000, failed: 0, rejected: 0, p50: 30, p95: 50, p99: 60, throughput: 99,
  errorRate: 0, rejectedRate: 0, successRate: 1, staleReads: 0, staleReadRate: 0,
  retriesIssued: 0, amplification: 1, cost: 7, provisionedCost: 7, usageCost: 0, costBreakdown: [], maxQueueDepth: 4,
  duplicates: 0, duplicateRate: 0, deadLettered: 0, deadLetterRate: 0, lostWrites: 0, poolRejections: 0,
  nodes: [], samples: [], traces: [], events: [], insights: [], assumptions: [],
};

function metric(nodeId: string, overrides: Partial<NodeMetric> = {}): NodeMetric {
  return { nodeId, utilization: 0, queueDepth: 0, processed: 0, errors: 0, avgLatency: 0, ...overrides };
}

const architecture: Architecture = {
  nodes: [
    { id: "traffic", kind: "traffic", label: "Traffic", position: { x: 0, y: 0 }, capacity: 0, latency: 0, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0 },
    { id: "lb", kind: "load-balancer", label: "LB", position: { x: 0, y: 0 }, capacity: 5000, latency: 1, replicas: 1, cacheHitRate: 0, enabled: true, cost: 1 },
    { id: "server", kind: "server", label: "Server", position: { x: 0, y: 0 }, capacity: 100, latency: 5, replicas: 3, cacheHitRate: 0, enabled: true, cost: 2 },
    { id: "db", kind: "database", label: "DB", position: { x: 0, y: 0 }, capacity: 200, latency: 8, replicas: 2, cacheHitRate: 0, enabled: true, cost: 3 },
    { id: "db2", kind: "database", label: "DB2", position: { x: 0, y: 0 }, capacity: 200, latency: 8, replicas: 1, cacheHitRate: 0, enabled: true, cost: 3 },
  ],
  edges: [],
};

describe("actualFor", () => {
  it("p95 is the max p95 across results", () => {
    const results = [{ ...baseResult, p95: 50 }, { ...baseResult, p95: 80 }, { ...baseResult, p95: 65 }];
    expect(actualFor("p95", results, architecture)).toBe(80);
  });

  it("throughput is the min throughput across results", () => {
    const results = [{ ...baseResult, throughput: 99 }, { ...baseResult, throughput: 40 }, { ...baseResult, throughput: 70 }];
    expect(actualFor("throughput", results, architecture)).toBe(40);
  });

  it("cost comes from the first result only", () => {
    const results = [{ ...baseResult, cost: 12 }, { ...baseResult, cost: 999 }];
    expect(actualFor("cost", results, architecture)).toBe(12);
  });

  it("dbLoad sums processed across all database nodes over duration, maxed across results", () => {
    const resultA: SimulationResult = { ...baseResult, duration: 30, nodes: [metric("db", { processed: 300 }), metric("db2", { processed: 300 }), metric("server", { processed: 9999 })] };
    const resultB: SimulationResult = { ...baseResult, duration: 30, nodes: [metric("db", { processed: 900 }), metric("db2", { processed: 900 })] };
    // resultA: (300+300)/30 = 20 ; resultB: (900+900)/30 = 60
    expect(actualFor("dbLoad", [resultA, resultB], architecture)).toBe(60);
  });

  it("bottleneckCapacity uses capacity x replicas of the highest-utilization non-traffic node in the first result", () => {
    const first: SimulationResult = {
      ...baseResult,
      nodes: [metric("traffic", { utilization: 1 }), metric("lb", { utilization: 0.2 }), metric("server", { utilization: 0.9 }), metric("db", { utilization: 0.5 })],
    };
    // server: capacity 100 x replicas 3 = 300, beats db's 200x2=400? db utilization lower so server should win by utilization even though db capacity larger.
    expect(actualFor("bottleneckCapacity", [first, baseResult], architecture)).toBe(300);
  });

  it("bottleneckCapacity picks the database when it has the highest utilization", () => {
    const first: SimulationResult = {
      ...baseResult,
      nodes: [metric("traffic", { utilization: 1 }), metric("server", { utilization: 0.3 }), metric("db", { utilization: 0.95 })],
    };
    expect(actualFor("bottleneckCapacity", [first], architecture)).toBe(400);
  });

  it("queueDepth is the max maxQueueDepth across results", () => {
    const results = [{ ...baseResult, maxQueueDepth: 2 }, { ...baseResult, maxQueueDepth: 9 }, { ...baseResult, maxQueueDepth: 5 }];
    expect(actualFor("queueDepth", results, architecture)).toBe(9);
  });
});

describe("scoreEstimations", () => {
  const prompts: EstimationPrompt[] = [{ id: "p95", label: "p95 latency", unit: "ms", tolerance: 0.2 }];
  const results = [{ ...baseResult, p95: 100 }];

  it("scores 1 within tolerance", () => {
    const outcomes = scoreEstimations(prompts, { p95: 110 }, results, architecture);
    expect(outcomes[0]).toMatchObject({ id: "p95", predicted: 110, actual: 100, score: 1 });
  });

  it("scores 1 exactly at the tolerance boundary", () => {
    const outcomes = scoreEstimations(prompts, { p95: 120 }, results, architecture);
    expect(outcomes[0].score).toBe(1);
  });

  it("scores 0.5 beyond tolerance but within 2x tolerance", () => {
    const outcomes = scoreEstimations(prompts, { p95: 130 }, results, architecture);
    expect(outcomes[0].score).toBe(0.5);
  });

  it("scores 0.5 exactly at the 2x tolerance boundary", () => {
    const outcomes = scoreEstimations(prompts, { p95: 140 }, results, architecture);
    expect(outcomes[0].score).toBe(0.5);
  });

  it("scores 0 beyond 2x tolerance", () => {
    const outcomes = scoreEstimations(prompts, { p95: 141 }, results, architecture);
    expect(outcomes[0].score).toBe(0);
  });

  it("applies an absolute floor of 1 unit when the actual value is near zero", () => {
    const zeroPrompts: EstimationPrompt[] = [{ id: "queueDepth", label: "Queue depth", unit: "items", tolerance: 0.2 }];
    const zeroResults = [{ ...baseResult, maxQueueDepth: 0 }];
    expect(scoreEstimations(zeroPrompts, { queueDepth: 1 }, zeroResults, architecture)[0].score).toBe(1);
    expect(scoreEstimations(zeroPrompts, { queueDepth: 2 }, zeroResults, architecture)[0].score).toBe(0.5);
    expect(scoreEstimations(zeroPrompts, { queueDepth: 3 }, zeroResults, architecture)[0].score).toBe(0);
  });

  it("treats a missing prediction as 0", () => {
    const outcomes = scoreEstimations(prompts, {}, results, architecture);
    expect(outcomes[0].predicted).toBe(0);
    expect(outcomes[0].score).toBe(0);
  });
});

describe("estimationComplete", () => {
  const prompts: EstimationPrompt[] = [
    { id: "p95", label: "p95 latency", unit: "ms", tolerance: 0.2 },
    { id: "cost", label: "Cost", unit: "credits", tolerance: 0.2 },
  ];

  it("is false until every prompt has a finite value", () => {
    expect(estimationComplete(prompts, {})).toBe(false);
    expect(estimationComplete(prompts, { p95: 100 })).toBe(false);
    expect(estimationComplete(prompts, { p95: 100, cost: NaN })).toBe(false);
    expect(estimationComplete(prompts, { p95: 100, cost: 5 })).toBe(true);
  });
});

describe("meanEstimationScore", () => {
  it("averages outcome scores", () => {
    expect(meanEstimationScore([{ id: "p95", label: "", unit: "", predicted: 1, actual: 1, score: 1 }, { id: "cost", label: "", unit: "", predicted: 1, actual: 1, score: 0.5 }])).toBeCloseTo(0.75);
  });

  it("is 0 for no outcomes", () => {
    expect(meanEstimationScore([])).toBe(0);
  });
});
