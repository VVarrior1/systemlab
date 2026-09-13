import { describe, expect, it } from "vitest";
import type { Lesson } from "./types";
import type { GeminiClient } from "./gemini";
import {
  MAX_ROUNDS,
  buildInterviewGradeMessages,
  buildTurnMessages,
  computeInterviewTotal,
  gradeInterviewWithGemini,
  generateTurn,
  nextRound,
  validateInterviewRequest,
} from "./interview";

function makeLesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: "test-lesson",
    number: 1,
    chapter: "Foundations",
    title: "Test lesson",
    subtitle: "A lesson for tests",
    kind: "sim",
    difficulty: "Beginner",
    minutes: 10,
    concept: "Testing",
    brief: "A brief description of the problem.",
    learning: ["Point one.", "Point two."],
    hints: [],
    objectives: [],
    architecture: { nodes: [], edges: [] },
    workload: {
      requestRate: 100,
      readRatio: 0.8,
      duration: 30,
      seed: 1,
      pattern: "steady",
      failure: "none",
    },
    allowedKinds: [],
    reference: { nodes: [], edges: [] },
    estimation: [],
    defense: {
      prompt: "Explain your design and two alternatives you rejected.",
      followUps: ["What happens at 10x traffic?", "What if the cache is cold?"],
      rubric: [
        { id: "tradeoffs", criterion: "Names concrete tradeoffs", weight: 60 },
        { id: "failure", criterion: "Addresses failure modes", weight: 40 },
      ],
      modelAnswer: "A model answer that would score full marks on every rubric item.",
    },
    readings: [],
    reflection: { question: "?", options: ["a", "b"], answer: 0, explanation: "" },
    remixable: false,
    ...overrides,
  };
}

function fakeGeminiClient(payload: unknown): GeminiClient {
  return {
    models: {
      generateContent: async () => ({ text: JSON.stringify(payload) }),
    },
  };
}

const baseContext = { architecture: "LB -> servers -> db", result: "p95 120ms, cost $10/day" };

describe("validateInterviewRequest", () => {
  it("accepts a minimal valid body", () => {
    const req = validateInterviewRequest({
      lessonId: "test-lesson",
      stage: "turn",
      transcript: [],
      context: baseContext,
    });
    expect(req.lessonId).toBe("test-lesson");
    expect(req.stage).toBe("turn");
    expect(req.transcript).toEqual([]);
    expect(req.context.architecture).toBe(baseContext.architecture);
  });

  it("accepts full context including techChoices and dataModel", () => {
    const req = validateInterviewRequest({
      lessonId: "test-lesson",
      stage: "grade",
      transcript: [{ role: "interviewer", text: "Why a single database?" }],
      context: {
        ...baseContext,
        techChoices: [
          { nodeId: "db1", label: "Database", kind: "database", technology: "Postgres", why: "Strong consistency for orders." },
        ],
        dataModel: "orders(id, user_id, total), indexed by user_id",
        estimation: "throughput 500 rps",
        blankCanvas: true,
      },
    });
    expect(req.context.techChoices?.[0]?.technology).toBe("Postgres");
    expect(req.context.blankCanvas).toBe(true);
  });

  it("rejects a missing lessonId", () => {
    expect(() => validateInterviewRequest({ stage: "turn", transcript: [], context: baseContext })).toThrow(/lessonId/);
  });

  it("rejects an invalid stage", () => {
    expect(() =>
      validateInterviewRequest({ lessonId: "test-lesson", stage: "nope", transcript: [], context: baseContext })
    ).toThrow(/stage/);
  });

  it("rejects a transcript over 12 entries", () => {
    const transcript = Array.from({ length: 13 }, (_, i) => ({ role: "candidate" as const, text: `entry ${i}` }));
    expect(() =>
      validateInterviewRequest({ lessonId: "test-lesson", stage: "turn", transcript, context: baseContext })
    ).toThrow(/12/);
  });

  it("rejects a transcript entry over 3000 chars", () => {
    const transcript = [{ role: "candidate", text: "x".repeat(3001) }];
    expect(() =>
      validateInterviewRequest({ lessonId: "test-lesson", stage: "turn", transcript, context: baseContext })
    ).toThrow(/3000/);
  });

  it("rejects an invalid transcript role", () => {
    const transcript = [{ role: "coach", text: "hi" }];
    expect(() =>
      validateInterviewRequest({ lessonId: "test-lesson", stage: "turn", transcript, context: baseContext })
    ).toThrow(/role/);
  });

  it("rejects a context string over 4000 chars", () => {
    expect(() =>
      validateInterviewRequest({
        lessonId: "test-lesson",
        stage: "turn",
        transcript: [],
        context: { ...baseContext, architecture: "x".repeat(4001) },
      })
    ).toThrow(/4000/);
  });

  it("rejects a missing context", () => {
    expect(() => validateInterviewRequest({ lessonId: "test-lesson", stage: "turn", transcript: [] })).toThrow(/context/);
  });

  it("rejects a malformed techChoice", () => {
    expect(() =>
      validateInterviewRequest({
        lessonId: "test-lesson",
        stage: "turn",
        transcript: [],
        context: { ...baseContext, techChoices: [{ nodeId: "db1" }] },
      })
    ).toThrow();
  });
});

describe("nextRound", () => {
  it("is 1 with an empty transcript", () => {
    expect(nextRound([])).toBe(1);
  });

  it("counts only interviewer turns", () => {
    const transcript = [
      { role: "interviewer" as const, text: "Q1" },
      { role: "candidate" as const, text: "A1" },
      { role: "interviewer" as const, text: "Q2" },
      { role: "candidate" as const, text: "A2" },
    ];
    expect(nextRound(transcript)).toBe(3);
  });
});

describe("buildTurnMessages / buildInterviewGradeMessages", () => {
  it("includes the round and rubric in the turn system prompt", () => {
    const lesson = makeLesson();
    const { system, contents } = buildTurnMessages(lesson, [], baseContext);
    expect(system).toContain("round 1");
    expect(system).toContain("tradeoffs");
    expect(contents).toHaveLength(1);
    expect(contents[0]!.role).toBe("user");
  });

  it("includes the transcript and tech choices in the grade prompt", () => {
    const lesson = makeLesson();
    const transcript = [{ role: "interviewer" as const, text: "Why Postgres?" }, { role: "candidate" as const, text: "Consistency." }];
    const { contents } = buildInterviewGradeMessages(lesson, transcript, {
      ...baseContext,
      techChoices: [{ nodeId: "db1", label: "Database", kind: "database", technology: "Postgres", why: "ACID" }],
    });
    expect(contents[0]!.text).toContain("Postgres");
    expect(contents[0]!.text).toContain("Why Postgres?");
  });
});

describe("generateTurn", () => {
  it("returns a parsed turn with computed round and done flag", async () => {
    const lesson = makeLesson();
    const client = fakeGeminiClient({ question: "Why one database instance?", intent: "probe" });
    const turn = await generateTurn(lesson, [], baseContext, client);
    expect(turn.question).toBe("Why one database instance?");
    expect(turn.intent).toBe("probe");
    expect(turn.round).toBe(1);
    expect(turn.done).toBe(false);
  });

  it("marks done at the final round", async () => {
    const lesson = makeLesson();
    const transcript = Array.from({ length: MAX_ROUNDS - 1 }, (_, i) => [
      { role: "interviewer" as const, text: `Q${i}` },
      { role: "candidate" as const, text: `A${i}` },
    ]).flat();
    const client = fakeGeminiClient({ question: "One last one: what fails if the region goes down?", intent: "escalate" });
    const turn = await generateTurn(lesson, transcript, baseContext, client);
    expect(turn.round).toBe(MAX_ROUNDS);
    expect(turn.done).toBe(true);
  });
});

describe("gradeInterviewWithGemini", () => {
  it("returns items, sub-scores, weakConcepts, and a blended total", async () => {
    const lesson = makeLesson();
    const client = fakeGeminiClient({
      items: [
        { id: "tradeoffs", score: 2, note: "Named clear tradeoffs." },
        { id: "failure", score: 0, note: "Never addressed failure modes." },
      ],
      recoveryScore: 1,
      techScore: 2,
      dataModelScore: 1,
      critique: "Strong on tradeoffs but never engaged with failure scenarios under pushback.",
    });
    const result = await gradeInterviewWithGemini(lesson, [], baseContext, client);
    expect(result.mode).toBe("graded");
    expect(result.weakConcepts).toEqual(["failure"]);
    expect(result.recoveryScore).toBe(1);
    expect(result.techScore).toBe(2);
    expect(result.dataModelScore).toBe(1);
    expect(typeof result.total).toBe("number");
  });
});

describe("computeInterviewTotal", () => {
  it("blends 70% rubric with 10% each of recovery/tech/dataModel", () => {
    const lesson = makeLesson();
    // rubric: tradeoffs (weight 60) full marks, failure (weight 40) zero -> rubricTotal = 60
    const items: { id: string; score: 0 | 1 | 2 }[] = [
      { id: "tradeoffs", score: 2 },
      { id: "failure", score: 0 },
    ];
    // recovery=2 (100), tech=2 (100), dataModel=2 (100)
    const total = computeInterviewTotal(lesson, items, 2, 2, 2);
    // 60*0.7 + 100*0.1 + 100*0.1 + 100*0.1 = 42 + 30 = 72
    expect(total).toBe(72);
  });

  it("returns 0 tech/dataModel contribution when those scores are 0", () => {
    const lesson = makeLesson();
    const items: { id: string; score: 0 | 1 | 2 }[] = [
      { id: "tradeoffs", score: 2 },
      { id: "failure", score: 2 },
    ];
    // rubricTotal = 100
    const total = computeInterviewTotal(lesson, items, 0, 0, 0);
    // 100*0.7 + 0 + 0 + 0 = 70
    expect(total).toBe(70);
  });
});
