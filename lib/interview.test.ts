import { describe, expect, it } from "vitest";
import type { Lesson } from "./types";
import type { GeminiClient } from "./gemini";
import {
  MAX_ROUNDS,
  PHASE_BUDGET_SECONDS,
  buildInterviewGradeMessages,
  buildMockScript,
  buildTurnMessages,
  computeInterviewTotal,
  computeMockTotal,
  decideInterrupt,
  detectContradictions,
  gradeInterviewWithGemini,
  gradeMockInterviewWithGemini,
  generateMockTurn,
  generateTurn,
  nextRound,
  validateInterviewRequest,
  type PerformanceScores,
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

  it("accepts a mock-mode request with phase/elapsedSeconds/phaseElapsedSeconds and a canvas context", () => {
    const req = validateInterviewRequest({
      lessonId: "test-lesson",
      mode: "mock",
      stage: "turn",
      phase: "design",
      elapsedSeconds: 600,
      phaseElapsedSeconds: 120,
      transcript: [],
      context: {
        canvas: "LB -> servers -> db",
        lastRun: "p95 120ms",
        rationales: [{ nodeId: "cache1", label: "Cache", kind: "cache", why: "hot keys", expected: "~85% hits" }],
        metrics: [{ nodeId: "cache1", label: "Cache", value: "42% hit rate" }],
      },
    });
    expect(req.mode).toBe("mock");
    expect(req.phase).toBe("design");
    expect(req.context.canvas).toBe("LB -> servers -> db");
    expect(req.context.rationales?.[0]?.expected).toBe("~85% hits");
  });

  it("rejects a mock-mode request missing canvas", () => {
    expect(() =>
      validateInterviewRequest({
        lessonId: "test-lesson",
        mode: "mock",
        stage: "turn",
        phase: "design",
        elapsedSeconds: 0,
        phaseElapsedSeconds: 0,
        transcript: [],
        context: {},
      })
    ).toThrow(/canvas/);
  });

  it("rejects a mock-mode request with an invalid phase", () => {
    expect(() =>
      validateInterviewRequest({
        lessonId: "test-lesson",
        mode: "mock",
        stage: "turn",
        phase: "nope",
        elapsedSeconds: 0,
        phaseElapsedSeconds: 0,
        transcript: [],
        context: { canvas: "x" },
      })
    ).toThrow(/phase/);
  });

  it("rejects an invalid mode", () => {
    expect(() =>
      validateInterviewRequest({ lessonId: "test-lesson", mode: "nope", stage: "turn", transcript: [], context: baseContext })
    ).toThrow(/mode/);
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
  it("blends 60% rubric with 10% each of recovery/tech/dataModel when performance is absent", () => {
    const lesson = makeLesson();
    // rubric: tradeoffs (weight 60) full marks, failure (weight 40) zero -> rubricTotal = 60
    const items: { id: string; score: 0 | 1 | 2 }[] = [
      { id: "tradeoffs", score: 2 },
      { id: "failure", score: 0 },
    ];
    // recovery=2 (100), tech=2 (100), dataModel=2 (100); weights 60/10/10/10 sum to 90
    const total = computeInterviewTotal(lesson, items, 2, 2, 2);
    // (60*60 + 10*100 + 10*100 + 10*100) / 90 = 6600 / 90 = 73.33 -> 73
    expect(total).toBe(73);
  });

  it("returns just the rubric-weighted share when recovery/tech/dataModel are 0", () => {
    const lesson = makeLesson();
    const items: { id: string; score: 0 | 1 | 2 }[] = [
      { id: "tradeoffs", score: 2 },
      { id: "failure", score: 2 },
    ];
    // rubricTotal = 100 -> (60*100) / 90 = 66.67 -> 67
    const total = computeInterviewTotal(lesson, items, 0, 0, 0);
    expect(total).toBe(67);
  });

  it("includes performance at 10% when provided, redistributing weight away from the others", () => {
    const lesson = makeLesson();
    const items: { id: string; score: 0 | 1 | 2 }[] = [
      { id: "tradeoffs", score: 2 },
      { id: "failure", score: 2 },
    ];
    const performance: PerformanceScores = {
      clarifiedFirst: { score: 2, note: "" },
      statedNumbers: { score: 2, note: "" },
      signposted: { score: 2, note: "" },
      heldPosition: { score: 2, note: "" },
      managedTime: { score: 2, note: "" },
    };
    // rubricTotal=100, recovery/tech/dataModel=2 (100), performance avg=100; all weights sum to 100
    const total = computeInterviewTotal(lesson, items, 2, 2, 2, { performance });
    expect(total).toBe(100);
  });

  it("subtracts 5 points per contradiction, floored at 0", () => {
    const lesson = makeLesson();
    const items: { id: string; score: 0 | 1 | 2 }[] = [
      { id: "tradeoffs", score: 0 },
      { id: "failure", score: 0 },
    ];
    const total = computeInterviewTotal(lesson, items, 0, 0, 0, { contradictions: 3 });
    expect(total).toBe(0);
  });

  it("computeMockTotal matches computeInterviewTotal with performance and contradictions passed through", () => {
    const lesson = makeLesson();
    const items: { id: string; score: 0 | 1 | 2 }[] = [
      { id: "tradeoffs", score: 2 },
      { id: "failure", score: 1 },
    ];
    const performance: PerformanceScores = {
      clarifiedFirst: { score: 1, note: "" },
      statedNumbers: { score: 2, note: "" },
      signposted: { score: 1, note: "" },
      heldPosition: { score: 2, note: "" },
      managedTime: { score: 1, note: "" },
    };
    const a = computeMockTotal(lesson, items, 1, 2, 1, performance, 1);
    const b = computeInterviewTotal(lesson, items, 1, 2, 1, { performance, contradictions: 1 });
    expect(a).toBe(b);
  });
});

describe("detectContradictions", () => {
  it("flags a rationale whose expected number is far from the measured value", () => {
    const contradictions = detectContradictions(
      [{ nodeId: "cache1", label: "Cache", kind: "cache", technology: "Redis", why: "hot keys", expected: "expect ~85% hit rate" }],
      [{ nodeId: "cache1", label: "Cache", value: "42% hit rate" }]
    );
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]!.nodeId).toBe("cache1");
    expect(contradictions[0]!.measured).toBe("42% hit rate");
  });

  it("does not flag a rationale close to the measured value", () => {
    const contradictions = detectContradictions(
      [{ nodeId: "db1", label: "Database", kind: "database", technology: "Postgres", why: "writes", expected: "~120 writes/s" }],
      [{ nodeId: "db1", label: "Database", value: "128 writes/s" }]
    );
    expect(contradictions).toHaveLength(0);
  });

  it("returns an empty array when no expected numbers or metrics are given", () => {
    expect(detectContradictions(undefined, undefined)).toEqual([]);
    expect(detectContradictions([{ nodeId: "a", label: "A", kind: "cache", why: "x" }], [{ nodeId: "a", value: "10" }])).toEqual([]);
  });
});

describe("decideInterrupt", () => {
  it("interrupts when the phase clock has run out", () => {
    const decision = decideInterrupt("clarify", PHASE_BUDGET_SECONDS.clarify + 1, [], []);
    expect(decision.interrupt).toBe(true);
    expect(decision.reason).toBe("phase-budget");
    expect(decision.forcedIntent).toBe("phase-change");
  });

  it("interrupts on a long candidate monologue with no digit", () => {
    const longText = Array.from({ length: 181 }, () => "word").join(" ");
    const transcript = [{ role: "candidate" as const, text: longText }];
    const decision = decideInterrupt("design", 10, transcript, []);
    expect(decision.interrupt).toBe(true);
    expect(decision.reason).toBe("long-monologue");
  });

  it("does not interrupt a long monologue that contains a digit", () => {
    const longText = Array.from({ length: 181 }, () => "word").join(" ") + " 42";
    const transcript = [{ role: "candidate" as const, text: longText }];
    const decision = decideInterrupt("design", 10, transcript, []);
    expect(decision.interrupt).toBe(false);
  });

  it("interrupts on an unraised contradiction", () => {
    const contradiction = { nodeId: "cache1", claim: "expect ~85%", measured: "42%", note: "gap" };
    const decision = decideInterrupt("design", 10, [], [contradiction]);
    expect(decision.interrupt).toBe(true);
    expect(decision.reason).toBe("contradiction");
    expect(decision.contradiction).toEqual(contradiction);
  });

  it("does not re-raise a contradiction the interviewer already mentioned", () => {
    const contradiction = { nodeId: "cache1", claim: "expect ~85%", measured: "42%", note: "gap" };
    const transcript = [{ role: "interviewer" as const, text: "About that cache1 estimate — walk me through it." }];
    const decision = decideInterrupt("design", 10, transcript, [contradiction]);
    expect(decision.interrupt).toBe(false);
  });

  it("does not interrupt when nothing triggers", () => {
    const decision = decideInterrupt("design", 10, [{ role: "candidate" as const, text: "short answer" }], []);
    expect(decision.interrupt).toBe(false);
    expect(decision.forcedIntent).toBeUndefined();
  });
});

describe("buildMockScript", () => {
  it("returns an opener, clarify, estimate, two design probes, a deep-dive, and a close", () => {
    const lesson = makeLesson();
    const script = buildMockScript(lesson);
    expect(script.map((e) => e.phase)).toEqual(["clarify", "clarify", "estimate", "design", "design", "deep-dive", "wrap"]);
    expect(script[3]!.utterance).toBe(lesson.defense.followUps[0]);
    expect(script[4]!.utterance).toBe(lesson.defense.followUps[1]);
  });
});

const mockBaseContext = { canvas: "LB -> servers -> db" };

describe("generateMockTurn", () => {
  it("forces the opening intent on the first turn", async () => {
    const lesson = makeLesson();
    const client = fakeGeminiClient({ utterance: "Tell me about the design.", intent: "probe" });
    const turn = await generateMockTurn(lesson, "clarify", 0, 0, [], mockBaseContext, client);
    expect(turn.intent).toBe("open");
    expect(turn.interrupt).toBe(false);
    expect(turn.done).toBe(false);
  });

  it("forces phase-change and interrupt=true when the phase budget is exceeded", async () => {
    const lesson = makeLesson();
    const client = fakeGeminiClient({ utterance: "Let's move on.", intent: "probe" });
    const transcript = [
      { role: "interviewer" as const, text: "Opening question." },
      { role: "candidate" as const, text: "An answer." },
    ];
    const turn = await generateMockTurn(lesson, "clarify", 100, PHASE_BUDGET_SECONDS.clarify + 5, transcript, mockBaseContext, client);
    expect(turn.intent).toBe("phase-change");
    expect(turn.interrupt).toBe(true);
  });

  it("marks done when the model closes the interview", async () => {
    const lesson = makeLesson();
    const client = fakeGeminiClient({ utterance: "That's time — thanks for walking me through it.", intent: "close" });
    const transcript = [
      { role: "interviewer" as const, text: "Opening question." },
      { role: "candidate" as const, text: "An answer." },
    ];
    const turn = await generateMockTurn(lesson, "wrap", 2700, 60, transcript, mockBaseContext, client);
    expect(turn.intent).toBe("close");
    expect(turn.done).toBe(true);
  });
});

describe("gradeMockInterviewWithGemini", () => {
  it("returns performance, contradictions, dataModelItems, and a total", async () => {
    const lesson = makeLesson();
    const client = fakeGeminiClient({
      items: [
        { id: "tradeoffs", score: 2, note: "Named clear tradeoffs." },
        { id: "failure", score: 1, note: "Partially addressed failure modes." },
      ],
      recoveryScore: 1,
      techScore: 2,
      dataModelScore: 1,
      critique: "Solid on tradeoffs, thin on failure handling.",
      contradictions: [{ nodeId: "cache1", claim: "expect ~85%", measured: "42%", note: "big gap" }],
      dataModelItems: [
        { id: "keys-unique", score: 2, note: "Keys are unique." },
        { id: "partition-key", score: 1, note: "Partly matches hot path." },
        { id: "query-patterns", score: 1, note: "Mostly matches." },
        { id: "growth", score: 0, note: "Unbounded." },
      ],
      performance: {
        clarifiedFirst: { score: 2, note: "Asked scope questions first." },
        statedNumbers: { score: 1, note: "Some numbers, not all." },
        signposted: { score: 2, note: "Clear structure." },
        heldPosition: { score: 1, note: "Partially held under pressure." },
        managedTime: { score: 1, note: "Ran long in design." },
      },
    });
    const result = await gradeMockInterviewWithGemini(lesson, [], mockBaseContext, client);
    expect(result.mode).toBe("graded");
    expect(result.contradictions).toHaveLength(1);
    expect(result.dataModelItems).toHaveLength(4);
    expect(result.performance.clarifiedFirst.score).toBe(2);
    expect(typeof result.total).toBe("number");
  });
});
