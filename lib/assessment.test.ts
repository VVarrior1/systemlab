import { describe, expect, it } from "vitest";
import { assessmentSeeds, checkedObjectives, objectivePasses, validateMissionArchitecture } from "./assessment";
import { getLesson, lessons } from "./curriculum";
import { createSystemNode } from "./templates";
import type { Architecture, Lesson, Objective, SimulationResult } from "./types";

const result: SimulationResult = {
  engineVersion: "1.0.0", seed: 42, duration: 30, requestCount: 3000,
  completed: 3000, failed: 0, rejected: 0, p50: 30, p95: 50, p99: 60, throughput: 99,
  errorRate: 0, rejectedRate: 0, successRate: 1, staleReads: 0, staleReadRate: 0,
  retriesIssued: 0, amplification: 1, cost: 7, costBreakdown: [], maxQueueDepth: 1,
  nodes: [], samples: [], traces: [], events: [], insights: [], assumptions: [],
};
const criterion = (metric: Objective["metric"], operator: Objective["operator"], target: number): Objective => ({ id: metric, label: metric, metric, operator, target });

describe("mission objective assessment", () => {
  it("does not turn exploratory runs or stale checks into green lesson criteria", () => {
    const lesson = getLesson("first-request")!;
    // Fixture comfortably clears first-request's targets (p95 <= 90 ms, throughput >= 57 req/s, errors <= 1%).
    const all = (value: boolean) => lesson.objectives.map(() => value);
    expect(lesson.objectives.length).toBeGreaterThan(0);
    expect(checkedObjectives(lesson, null, 4)).toEqual(all(false));
    const validation = { revision: 4, passed: true, results: assessmentSeeds(lesson).map((seed) => ({ ...result, seed })) };
    expect(checkedObjectives(lesson, validation, 4)).toEqual(all(true));
    expect(checkedObjectives(lesson, validation, 5)).toEqual(all(false));
    expect(checkedObjectives(lesson, { ...validation, results: [result] }, 4)).toEqual(all(false));
    // Three runs, but not the three assessment seeds: still not a graded check.
    expect(checkedObjectives(lesson, { ...validation, results: [result, result, result] }, 4)).toEqual(all(false));
  });

  it("rejects the removed load balancer before grading even with sufficient provisioned capacity", () => {
    // A v2 lesson whose starting graph already contains the balancer the mission depends on.
    const lesson = getLesson("when-caches-cannot-help")!;
    const architecture = structuredClone(lesson.architecture);
    const balancers = architecture.nodes.filter((node) => node.kind === "load-balancer").map((node) => node.id);
    expect(balancers.length).toBeGreaterThan(0);
    // Wire traffic straight at the servers the balancer used to feed, with capacity to spare.
    architecture.edges = architecture.edges.flatMap((edge) => {
      if (balancers.includes(edge.target)) return [];
      if (!balancers.includes(edge.source)) return [edge];
      return [{ id: `direct-${edge.target}`, source: "traffic", target: edge.target }];
    });
    architecture.nodes = architecture.nodes.filter((node) => !balancers.includes(node.id));
    for (const node of architecture.nodes) if (node.kind === "server") { node.capacity *= 4; node.replicas = 4; }
    expect(validateMissionArchitecture(lesson, architecture)).toMatch(/Required: load balancer/);
  });

  it("uses inclusive thresholds in both directions", () => {
    expect(objectivePasses(result, criterion("p95", "lte", 50))).toBe(true);
    expect(objectivePasses({ ...result, p95: 50.001 }, criterion("p95", "lte", 50))).toBe(false);
    expect(objectivePasses(result, criterion("throughput", "gte", 99))).toBe(true);
    expect(objectivePasses({ ...result, throughput: 98.999 }, criterion("throughput", "gte", 99))).toBe(false);
  });

  it("compares error rates as fractions and rejects non-finite measurements", () => {
    const errorObjective = criterion("errorRate", "lte", 0.01);
    expect(objectivePasses({ ...result, errorRate: 0.01 }, errorObjective)).toBe(true);
    expect(objectivePasses({ ...result, errorRate: 0.010001 }, errorObjective)).toBe(false);
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(objectivePasses({ ...result, errorRate: invalid }, errorObjective)).toBe(false);
      expect(objectivePasses({ ...result, throughput: invalid }, criterion("throughput", "gte", 90))).toBe(false);
    }
  });

  it("does not award a latency criterion when no requests succeeded", () => {
    const totalFailure = { ...result, completed: 0, failed: 3000, p50: 0, p95: 0, errorRate: 1, throughput: 0 };
    expect(objectivePasses(totalFailure, criterion("p95", "lte", 100))).toBe(false);
  });

  it("requires every seeded run to meet each criterion", () => {
    const objective = criterion("p95", "lte", 100);
    const seeded = [{ ...result, seed: 42, p95: 95 }, { ...result, seed: 123, p95: 101 }, { ...result, seed: 2026, p95: 98 }];
    expect(seeded.every((run) => objectivePasses(run, objective))).toBe(false);
    expect(seeded.filter((run) => !objectivePasses(run, objective)).map((run) => run.seed)).toEqual([123]);
  });
});

describe("mission architecture constraints", () => {
  it("identifies the routing task in the authored starting graph", () => {
    for (const lesson of lessons) {
      const required = lesson.requiredBalancedReplicas;
      if (required) expect(validateMissionArchitecture(lesson, lesson.architecture), lesson.id).toMatch(new RegExp(`at least ${required} application replicas`));
      else expect(validateMissionArchitecture(lesson, lesson.architecture), lesson.id).toBeNull();
    }
  });

  it("requires actual replica distribution, not just a decorative balancer", () => {
    const lesson = getLesson("share-the-load")!;
    const required = lesson.requiredBalancedReplicas!;
    expect(required).toBeGreaterThan(1);
    // The reference is the balanced topology: a balancer in front of the application fleet.
    const architecture = structuredClone(lesson.reference);
    const balancerId = architecture.nodes.find((node) => node.kind === "load-balancer")!.id;
    const databaseId = architecture.nodes.find((node) => node.kind === "database")!.id;
    const server = architecture.nodes.find((node) => node.kind === "server" && node.role !== "worker")!;
    server.replicas = 1;
    server.capacity = 1000;
    expect(validateMissionArchitecture(lesson, architecture)).toMatch(/Extra capacity on one replica/);
    server.replicas = required;
    expect(validateMissionArchitecture(lesson, architecture)).toBeNull();
    // The same replica count spread over separate balanced servers is equally acceptable.
    server.replicas = 1;
    for (let index = 1; index < required; index++) {
      architecture.nodes.push({ ...server, id: `extra-server-${index}` });
      architecture.edges.push(
        { id: `extra-route-${index}`, source: balancerId, target: `extra-server-${index}` },
        { id: `extra-storage-${index}`, source: `extra-server-${index}`, target: databaseId },
      );
    }
    expect(validateMissionArchitecture(lesson, architecture)).toBeNull();
  });

  it("requires the original component types to remain online", () => {
    const lesson = lessons[0];
    const removed = structuredClone(lesson.architecture);
    removed.nodes = removed.nodes.filter((node) => node.kind !== "database");
    removed.edges = removed.edges.filter((edge) => removed.nodes.some((node) => node.id === edge.target));
    expect(validateMissionArchitecture(lesson, removed)).toMatch(/component types and roles online/);
    const disabled = structuredClone(lesson.architecture);
    disabled.nodes.find((node) => node.kind === "database")!.enabled = false;
    expect(validateMissionArchitecture(lesson, disabled)).toMatch(/component types and roles online/);
  });

  it("rejects storage bypasses even when required component counts are preserved", () => {
    const lesson = lessons[0];
    const architecture = structuredClone(lesson.architecture);
    architecture.edges = architecture.edges.filter((edge) => !architecture.nodes.some((node) => node.kind === "database" && node.id === edge.target));
    expect(validateMissionArchitecture(lesson, architecture)).toMatch(/Every dependency path must end at a database/);
  });

  it("preserves worker roles and component multiplicity", () => {
    const lesson = lessons.find((item) => item.id === "jobs-in-the-queue")!;
    const architecture = structuredClone(lesson.architecture);
    architecture.nodes.find((node) => node.role === "worker")!.role = "application";
    expect(validateMissionArchitecture(lesson, architecture)).toMatch(/component types and roles online/);
    const missingApplication = structuredClone(lesson.architecture);
    missingApplication.nodes = missingApplication.nodes.filter((node) => !(node.kind === "server" && node.role !== "worker"));
    expect(validateMissionArchitecture(lesson, missingApplication)).toMatch(/component types and roles online/);
  });

  it("allows replacement identifiers and added capacity without prescribing one topology", () => {
    const lesson = lessons[0];
    const architecture: Architecture = {
      nodes: lesson.architecture.nodes.map((node) => ({ ...node, id: `replacement-${node.id}`, replicas: node.kind === "server" ? 2 : node.replicas })),
      edges: lesson.architecture.edges.map((edge) => ({ ...edge, source: `replacement-${edge.source}`, target: `replacement-${edge.target}` })),
    };
    expect(validateMissionArchitecture(lesson, architecture)).toBeNull();
  });

  it("allows cache insertion while retaining a database path for misses and writes", () => {
    const lesson = lessons.find((item) => item.id === "make-reads-cheaper")!;
    const architecture = structuredClone(lesson.architecture);
    const storageEdge = architecture.edges.find((edge) => architecture.nodes.some((node) => node.id === edge.target && node.kind === "database"))!;
    architecture.nodes.push(createSystemNode("cache", "new-cache", { x: 600, y: 100 }));
    architecture.edges = architecture.edges.filter((edge) => edge.id !== storageEdge.id);
    architecture.edges.push(
      { id: "to-cache", source: storageEdge.source, target: "new-cache" },
      { id: "cache-storage", source: "new-cache", target: storageEdge.target },
    );
    expect(validateMissionArchitecture(lesson, architecture)).toBeNull();
  });
});

describe("assessmentSeeds", () => {
  it("is the lesson's own seed followed by the two fixed assessment seeds", () => {
    for (const lesson of lessons) {
      expect(assessmentSeeds(lesson)).toEqual([lesson.workload.seed, 123, 2026]);
    }
  });
});

describe("objectivePasses covers every ObjectiveMetric", () => {
  it("fails p99 (like p95) when nothing completed", () => {
    const totalFailure = { ...result, completed: 0, failed: 3000, p99: 0 };
    expect(objectivePasses(totalFailure, { id: "p99", label: "p99", metric: "p99", operator: "lte", target: 100 })).toBe(false);
  });

  it("reads rejectedRate, successRate and staleReadRate straight from the result", () => {
    expect(objectivePasses({ ...result, rejectedRate: 0.02 }, { id: "r", label: "r", metric: "rejectedRate", operator: "lte", target: 0.05 })).toBe(true);
    expect(objectivePasses({ ...result, rejectedRate: 0.2 }, { id: "r", label: "r", metric: "rejectedRate", operator: "lte", target: 0.05 })).toBe(false);
    expect(objectivePasses({ ...result, successRate: 0.99 }, { id: "s", label: "s", metric: "successRate", operator: "gte", target: 0.95 })).toBe(true);
    expect(objectivePasses({ ...result, staleReadRate: 0.4 }, { id: "st", label: "st", metric: "staleReadRate", operator: "lte", target: 0.5 })).toBe(true);
    expect(objectivePasses({ ...result, staleReadRate: 0.6 }, { id: "st", label: "st", metric: "staleReadRate", operator: "lte", target: 0.5 })).toBe(false);
  });
});

describe("validateMissionArchitecture on new lesson kinds", () => {
  const writtenLesson: Lesson = {
    ...lessons[0],
    id: "written-placeholder",
    kind: "written",
    objectives: [],
    architecture: { nodes: [], edges: [] },
    reference: { nodes: [], edges: [] },
  };

  it("returns null unconditionally for a written lesson, regardless of the submitted architecture", () => {
    expect(validateMissionArchitecture(writtenLesson, { nodes: [], edges: [] })).toBeNull();
    expect(validateMissionArchitecture(writtenLesson, lessons[0].architecture)).toBeNull();
  });

  it("treats cdn and rate-limiter as valid path components, not bypasses of the database rule", () => {
    const lesson = lessons.find((item) => item.id === "make-reads-cheaper")!;
    const architecture: Architecture = structuredClone(lesson.architecture);
    // Terminate the path at a rate-limiter instead of the database (e.g. a design mid-edit).
    architecture.nodes.push(createSystemNode("rate-limiter", "trailing-limiter", { x: 900, y: 100 }));
    const server = architecture.nodes.find((node) => node.kind === "server")!;
    architecture.edges.push({ id: "server-to-limiter", source: server.id, target: "trailing-limiter" });
    expect(validateMissionArchitecture(lesson, architecture)).toBeNull();
  });
});
