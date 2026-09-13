import { describe, expect, it } from "vitest";
import { conceptStats, estimationDiagnosis, masterySummary, reviewQueue } from "./mastery";
import { ASSESSMENT_VERSION } from "./assessment-version";
import type { Lesson, ProgressRecord } from "./types";

function lesson(overrides: Partial<Lesson> & { id: string; concept: string; chapter: string }): Lesson {
  return {
    number: 1,
    title: overrides.id,
    subtitle: "",
    kind: "sim",
    difficulty: "Beginner",
    minutes: 10,
    brief: "",
    learning: [],
    hints: [],
    objectives: [],
    architecture: { nodes: [], edges: [] },
    workload: { requestRate: 1, readRatio: 0.5, duration: 30, seed: 1, pattern: "steady", failure: "none" },
    allowedKinds: [],
    reference: { nodes: [], edges: [] },
    estimation: [],
    defense: { prompt: "", followUps: [], rubric: [], modelAnswer: "" },
    readings: [],
    reflection: { question: "", options: [], answer: 0, explanation: "" },
    remixable: true,
    ...overrides,
  };
}

function progress(overrides: Partial<ProgressRecord> & { lessonId: string; completedAt: string }): ProgressRecord {
  return { bestP95: 100, cost: 5, assessmentVersion: ASSESSMENT_VERSION, ...overrides };
}

describe("conceptStats", () => {
  it("aggregates per-concept completion, average defense/estimation, and weak concepts", () => {
    const lessons = [
      lesson({ id: "l1", concept: "caching", chapter: "Foundations" }),
      lesson({ id: "l2", concept: "caching", chapter: "Foundations" }),
      lesson({ id: "l3", concept: "queues", chapter: "Workloads" }),
    ];
    const records = [
      progress({ lessonId: "l1", completedAt: "2026-09-01T00:00:00Z", defenseScore: 80, estimationScore: 0.9, weakConcepts: ["latency"] }),
      progress({ lessonId: "l2", completedAt: "2026-09-02T00:00:00Z", defenseScore: 60, estimationScore: 0.7 }),
    ];
    const stats = conceptStats(records, lessons);
    const caching = stats.find((item) => item.concept === "caching")!;
    expect(caching.lessons).toBe(2);
    expect(caching.completed).toBe(2);
    expect(caching.avgDefense).toBe(70);
    expect(caching.avgEstimation).toBeCloseTo(0.8);
    expect(caching.weakConcepts).toEqual(["latency"]);

    const queues = stats.find((item) => item.concept === "queues")!;
    expect(queues.completed).toBe(0);
    expect(queues.avgDefense).toBeNull();
    expect(queues.avgEstimation).toBeNull();
  });

  it("ignores stale (non-current) assessment versions", () => {
    const lessons = [lesson({ id: "l1", concept: "caching", chapter: "Foundations" })];
    const records = [progress({ lessonId: "l1", completedAt: "2026-09-01T00:00:00Z", defenseScore: 80, assessmentVersion: 1 })];
    const stats = conceptStats(records, lessons);
    expect(stats[0].completed).toBe(0);
  });
});

describe("reviewQueue", () => {
  const now = new Date("2026-09-12T00:00:00Z");

  it("orders items by due date and includes low-defense and weak-concept reasons immediately", () => {
    const lessons = [
      lesson({ id: "low-defense-lesson", concept: "a", chapter: "Foundations" }),
      lesson({ id: "weak-concept-lesson", concept: "b", chapter: "Foundations" }),
    ];
    const records = [
      progress({ lessonId: "low-defense-lesson", completedAt: "2026-09-11T00:00:00Z", defenseScore: 40 }),
      progress({ lessonId: "weak-concept-lesson", completedAt: "2026-09-10T00:00:00Z", weakConcepts: ["scaling"] }),
    ];
    const queue = reviewQueue(records, lessons, now);
    const reasons = queue.map((item) => `${item.lessonId}:${item.reason}`);
    expect(reasons).toContain("low-defense-lesson:low-defense");
    expect(reasons).toContain("weak-concept-lesson:weak-concept");
    // sorted ascending by due date
    for (let i = 1; i < queue.length; i++) expect(queue[i - 1].due.getTime()).toBeLessThanOrEqual(queue[i].due.getTime());
  });

  it("computes spaced-review due dates using 1/3/7/14 day intervals that grow with remixes", () => {
    const lessons = [lesson({ id: "l1", concept: "a", chapter: "Foundations" })];
    const completedAt = "2026-08-01T00:00:00Z";
    const noRemix = reviewQueue([progress({ lessonId: "l1", completedAt, remixes: 0 })], lessons, now).find((item) => item.reason === "spaced-review");
    expect(noRemix?.due.toISOString()).toBe(new Date(new Date(completedAt).getTime() + 1 * 86_400_000).toISOString());

    const twoRemixes = reviewQueue([progress({ lessonId: "l1", completedAt, remixes: 2 })], lessons, now).find((item) => item.reason === "spaced-review");
    expect(twoRemixes?.due.toISOString()).toBe(new Date(new Date(completedAt).getTime() + 7 * 86_400_000).toISOString());

    const manyRemixes = reviewQueue([progress({ lessonId: "l1", completedAt, remixes: 50 })], lessons, now).find((item) => item.reason === "spaced-review");
    expect(manyRemixes?.due.toISOString()).toBe(new Date(new Date(completedAt).getTime() + 14 * 86_400_000).toISOString());
  });

  it("does not surface a spaced-review item before it is due", () => {
    const lessons = [lesson({ id: "l1", concept: "a", chapter: "Foundations" })];
    const records = [progress({ lessonId: "l1", completedAt: "2026-09-11T23:00:00Z", remixes: 0 })];
    const queue = reviewQueue(records, lessons, now);
    expect(queue.some((item) => item.reason === "spaced-review")).toBe(false);
  });

  it("flags a completed sim lesson never attempted with blankCanvas", () => {
    const lessons = [lesson({ id: "sim-lesson", concept: "a", chapter: "Foundations", kind: "sim" })];
    const records = [progress({ lessonId: "sim-lesson", completedAt: "2026-09-01T00:00:00Z", blankCanvas: false })];
    const queue = reviewQueue(records, lessons, now);
    expect(queue.some((item) => item.reason === "blank-canvas-next")).toBe(true);
  });

  it("does not flag blank-canvas-next for a non-sim lesson or one already attempted blank", () => {
    const lessons = [
      lesson({ id: "brief-lesson", concept: "a", chapter: "Foundations", kind: "brief" }),
      lesson({ id: "sim-lesson", concept: "b", chapter: "Foundations", kind: "sim" }),
    ];
    const records = [
      progress({ lessonId: "brief-lesson", completedAt: "2026-09-01T00:00:00Z" }),
      progress({ lessonId: "sim-lesson", completedAt: "2026-09-01T00:00:00Z", blankCanvas: true }),
    ];
    const queue = reviewQueue(records, lessons, now);
    expect(queue.some((item) => item.reason === "blank-canvas-next")).toBe(false);
  });
});

describe("estimationDiagnosis", () => {
  it("reports a diagnosis only when bias averages at least 0.15 over at least 3 lessons", () => {
    const records = [
      progress({ lessonId: "l1", completedAt: "2026-09-01T00:00:00Z", estimationBias: { dbLoad: -0.3 } }),
      progress({ lessonId: "l2", completedAt: "2026-09-02T00:00:00Z", estimationBias: { dbLoad: -0.4 } }),
    ];
    expect(estimationDiagnosis(records)).toEqual([]);

    const enough = [...records, progress({ lessonId: "l3", completedAt: "2026-09-03T00:00:00Z", estimationBias: { dbLoad: -0.35 } })];
    const lines = estimationDiagnosis(enough);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/under-estimate database load by 35% on average across 3 lessons/);
  });

  it("reports over-estimation with the correct direction", () => {
    const records = [
      progress({ lessonId: "l1", completedAt: "2026-09-01T00:00:00Z", estimationBias: { cost: 0.2 } }),
      progress({ lessonId: "l2", completedAt: "2026-09-02T00:00:00Z", estimationBias: { cost: 0.2 } }),
      progress({ lessonId: "l3", completedAt: "2026-09-03T00:00:00Z", estimationBias: { cost: 0.2 } }),
    ];
    const lines = estimationDiagnosis(records);
    expect(lines[0]).toMatch(/over-estimate infrastructure cost by 20%/);
  });

  it("stays silent when the average bias is below the threshold", () => {
    const records = [
      progress({ lessonId: "l1", completedAt: "2026-09-01T00:00:00Z", estimationBias: { p95: 0.05 } }),
      progress({ lessonId: "l2", completedAt: "2026-09-02T00:00:00Z", estimationBias: { p95: -0.05 } }),
      progress({ lessonId: "l3", completedAt: "2026-09-03T00:00:00Z", estimationBias: { p95: 0.02 } }),
    ];
    expect(estimationDiagnosis(records)).toEqual([]);
  });
});

describe("masterySummary", () => {
  const now = new Date("2026-09-12T00:00:00Z");

  it("weights completion 40, defense 30, estimation 20, breadth 10", () => {
    const lessons = [
      lesson({ id: "l1", concept: "a", chapter: "Ch1" }),
      lesson({ id: "l2", concept: "b", chapter: "Ch2" }),
    ];
    const records = [progress({ lessonId: "l1", completedAt: "2026-09-01T00:00:00Z", defenseScore: 100, estimationScore: 1 })];
    const summary = masterySummary(records, lessons, now);
    // completion 50% -> 20, defense 100 -> 30, estimation 100% -> 20, breadth 50% -> 5 => 75
    expect(summary.score).toBe(75);
  });

  it("returns 0 with no completions and empty strongest/weakest", () => {
    const lessons = [lesson({ id: "l1", concept: "a", chapter: "Ch1" })];
    const summary = masterySummary([], lessons, now);
    expect(summary.score).toBe(0);
    expect(summary.strongest).toEqual([]);
    expect(summary.weakest).toEqual([]);
  });

  it("ranks strongest and weakest concepts by average defense score", () => {
    const lessons = [
      lesson({ id: "l1", concept: "strong", chapter: "Ch1" }),
      lesson({ id: "l2", concept: "weak", chapter: "Ch1" }),
    ];
    const records = [
      progress({ lessonId: "l1", completedAt: "2026-09-01T00:00:00Z", defenseScore: 95 }),
      progress({ lessonId: "l2", completedAt: "2026-09-01T00:00:00Z", defenseScore: 30 }),
    ];
    const summary = masterySummary(records, lessons, now);
    expect(summary.strongest[0]).toBe("strong");
    expect(summary.weakest[0]).toBe("weak");
  });
});
