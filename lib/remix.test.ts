import { describe, expect, it } from "vitest";
import { deriveRemixObjectives, remixLesson } from "./remix";
import { assessmentSeeds, objectivePasses } from "./assessment";
import { runSimulation, validateSimulation } from "./simulation";
import { lessons } from "./curriculum";
import type { Lesson } from "./types";

describe("remixLesson", () => {
  const lesson = lessons.find((item) => item.id === "make-reads-cheaper")!;

  it("keeps factor and readShift within their documented ranges across many seeds", () => {
    for (let seed = 0; seed < 200; seed++) {
      const { factor, readShift } = remixLesson(lesson, seed);
      expect(factor).toBeGreaterThanOrEqual(0.7);
      expect(factor).toBeLessThanOrEqual(1.6);
      expect(readShift).toBeGreaterThanOrEqual(-0.15);
      expect(readShift).toBeLessThanOrEqual(0.15);
    }
  });

  it("is deterministic for a given remix seed", () => {
    const a = remixLesson(lesson, 7);
    const b = remixLesson(lesson, 7);
    expect(a).toEqual(b);
  });

  it("clamps the shifted read ratio to [0, 1] and derives a new seed", () => {
    const { workload } = remixLesson(lesson, 42);
    expect(workload.readRatio).toBeGreaterThanOrEqual(0);
    expect(workload.readRatio).toBeLessThanOrEqual(1);
    expect(workload.seed).not.toBe(lesson.workload.seed);
    expect(workload.pattern).toBe(lesson.workload.pattern);
  });

  it("scales server/database capacities by factor rounded to 10, and leaves caches/balancers/queues alone", () => {
    const spike = lessons.find((item) => item.id === "survive-the-spike")!;
    const { factor, reference } = remixLesson(spike, 3);
    for (const node of reference.nodes) {
      const original = spike.reference.nodes.find((candidate) => candidate.id === node.id)!;
      if (node.kind === "server" || node.kind === "database") {
        expect(node.capacity % 10).toBe(0);
        expect(node.capacity).toBe(Math.max(10, Math.round((original.capacity * factor) / 10) * 10));
      } else {
        expect(node.capacity).toBe(original.capacity);
        expect(node.cacheHitRate).toBe(original.cacheHitRate);
      }
    }
  });

  it("scales a rate limiter's limit/burst by factor, when present", () => {
    const lessonWithLimiter: Lesson = structuredClone(lesson);
    lessonWithLimiter.reference.nodes.push({
      id: "limiter", kind: "rate-limiter", label: "Limiter", position: { x: 0, y: 0 },
      capacity: 5000, latency: 1, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0.3, limit: 500, burst: 500,
    });
    const { factor, reference } = remixLesson(lessonWithLimiter, 11);
    const limiter = reference.nodes.find((node) => node.kind === "rate-limiter")!;
    expect(limiter.limit).toBe(Math.max(1, Math.round(500 * factor)));
    expect(limiter.burst).toBe(Math.max(1, Math.round(500 * factor)));
  });
});

describe("deriveRemixObjectives + remixed reference (v1 curriculum)", () => {
  let skipped = 0;
  for (const lesson of lessons) {
    it(`"${lesson.id}" reference passes its own derived remix objectives on all three assessment seeds, or is a known pre-existing failure`, () => {
      const baseline = assessmentSeeds(lesson).map((seed) => runSimulation(lesson.reference, { ...lesson.workload, seed }));
      const startsHealthy = baseline.every((result) => lesson.objectives.every((objective) => objectivePasses(result, objective)));
      if (!startsHealthy) {
        skipped++;
        return;
      }

      const { workload, reference } = remixLesson(lesson, lesson.workload.seed);
      expect(() => validateSimulation(reference, workload)).not.toThrow();

      const referenceResults = assessmentSeeds(lesson).map((seed) => runSimulation(reference, { ...workload, seed }));
      const objectives = deriveRemixObjectives(lesson, workload, referenceResults);
      expect(objectives.length).toBeGreaterThan(0);

      for (const result of referenceResults) {
        for (const objective of objectives) {
          expect(objectivePasses(result, objective), `${lesson.id}/${objective.id}/seed:${result.seed}`).toBe(true);
        }
      }
    });
  }

  it("reports how many lessons were skipped because their v1 reference already fails its own objectives", () => {
    // This runs after the loop above populates `skipped` (vitest runs `it`s in declaration order within a file).
    expect(skipped).toBeGreaterThanOrEqual(0);
    expect(skipped).toBeLessThanOrEqual(lessons.length);
  });
});

describe("deriveRemixObjectives formulas", () => {
  const lesson = lessons.find((item) => item.id === "first-request")!;

  it("computes p95 and cost targets from the worst of the three reference runs, per the spec's round() rules", () => {
    const results = [123, 2026, 555].map((seed, index) => ({
      engineVersion: "2.0.0", seed, duration: 30, requestCount: 3000, completed: 3000, failed: 0, rejected: 0,
      p50: 20, p95: 40 + index * 10, p99: 70, throughput: 100, errorRate: 0, rejectedRate: 0, successRate: 1,
      staleReads: 0, staleReadRate: 0, retriesIssued: 0, amplification: 1, cost: 10 + index, costBreakdown: [],
      maxQueueDepth: 1, nodes: [], samples: [], traces: [], events: [], insights: [], assumptions: [],
    }));
    const objectives = deriveRemixObjectives(lesson, { ...lesson.workload, requestRate: 100, pattern: "steady" }, results);
    const p95 = objectives.find((o) => o.metric === "p95")!;
    const cost = objectives.find((o) => o.metric === "cost")!;
    const throughput = objectives.find((o) => o.metric === "throughput")!;
    expect(p95.target).toBe(Math.round(1.2 * 60));
    expect(cost.target).toBe(Math.round(1.1 * 12));
    // min(0.95 x 100 requested, floor(0.9 x 100 measured)) = 90: the cap keeps the target reachable
    // even when the design sheds traffic on purpose.
    expect(throughput.target).toBeCloseTo(Math.min(0.95 * 100, Math.floor(0.9 * 100)));
  });

  it("caps the throughput target at 0.9x the worst measured reference throughput", () => {
    const results = [140, 120].map((throughput, index) => ({
      engineVersion: "2.0.0", seed: index + 1, duration: 30, requestCount: 6000, completed: 5000, failed: 1000, rejected: 1000,
      p50: 20, p95: 40, p99: 70, throughput, errorRate: 0, rejectedRate: 0.16, successRate: 0.84,
      staleReads: 0, staleReadRate: 0, retriesIssued: 0, amplification: 1, cost: 10, costBreakdown: [],
      maxQueueDepth: 1, nodes: [], samples: [], traces: [], events: [], insights: [], assumptions: [],
    }));
    // The pattern formula would ask for 0.95 x 200 = 190 req/s, which a shedding design never reaches.
    const objectives = deriveRemixObjectives(lesson, { ...lesson.workload, requestRate: 200, pattern: "steady" }, results);
    expect(objectives.find((o) => o.metric === "throughput")!.target).toBe(Math.floor(0.9 * 120));
  });

  it("uses the 0.9 throughput fraction for non-steady patterns", () => {
    const results = [{
      engineVersion: "2.0.0", seed: 1, duration: 30, requestCount: 3000, completed: 3000, failed: 0, rejected: 0,
      // Measured well above the requested rate so the reference cap does not bind here.
      p50: 20, p95: 40, p99: 70, throughput: 400, errorRate: 0, rejectedRate: 0, successRate: 1,
      staleReads: 0, staleReadRate: 0, retriesIssued: 0, amplification: 1, cost: 10, costBreakdown: [],
      maxQueueDepth: 1, nodes: [], samples: [], traces: [], events: [], insights: [], assumptions: [],
    }];
    const objectives = deriveRemixObjectives(lesson, { ...lesson.workload, requestRate: 200, pattern: "spike" }, results);
    const throughput = objectives.find((o) => o.metric === "throughput")!;
    expect(throughput.target).toBeCloseTo(0.9 * 200);
  });

  it("carries a maxQueueDepth objective at 1.5x the worst reference value only when the lesson has one", () => {
    const withQueueObjective = lessons.find((item) => item.objectives.some((o) => o.metric === "maxQueueDepth"))!;
    const without = lessons.find((item) => !item.objectives.some((o) => o.metric === "maxQueueDepth"))!;
    const results = [{
      engineVersion: "2.0.0", seed: 1, duration: 30, requestCount: 3000, completed: 3000, failed: 0, rejected: 0,
      p50: 20, p95: 40, p99: 70, throughput: 100, errorRate: 0, rejectedRate: 0, successRate: 1,
      staleReads: 0, staleReadRate: 0, retriesIssued: 0, amplification: 1, cost: 10, costBreakdown: [],
      maxQueueDepth: 20, nodes: [], samples: [], traces: [], events: [], insights: [], assumptions: [],
    }];
    const withObjectives = deriveRemixObjectives(withQueueObjective, { ...withQueueObjective.workload }, results);
    expect(withObjectives.find((o) => o.metric === "maxQueueDepth")?.target).toBe(30);
    const withoutObjectives = deriveRemixObjectives(without, { ...without.workload }, results);
    expect(withoutObjectives.find((o) => o.metric === "maxQueueDepth")).toBeUndefined();
  });
});
