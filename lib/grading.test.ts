import { describe, expect, it, vi } from "vitest";
import type { Lesson } from "./types";
import { buildGradingMessages, gradeWithClaude, scoreTotal, validateAnswers, type ClaudeClient } from "./grading";

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

const longDesign = "word ".repeat(60).trim();

describe("validateAnswers", () => {
  it("accepts a valid design with follow-ups", () => {
    const result = validateAnswers({ design: longDesign, followUps: ["answer one", "answer two"] });
    expect(result.design).toBe(longDesign);
    expect(result.followUps).toEqual(["answer one", "answer two"]);
  });

  it("defaults followUps to an empty array when omitted", () => {
    const result = validateAnswers({ design: longDesign });
    expect(result.followUps).toEqual([]);
  });

  it("rejects a missing design", () => {
    expect(() => validateAnswers({})).toThrow();
  });

  it("rejects a non-object body", () => {
    expect(() => validateAnswers("nope")).toThrow();
    expect(() => validateAnswers(null)).toThrow();
  });

  it("rejects a design under 60 words", () => {
    expect(() => validateAnswers({ design: "too short" })).toThrow(/60 words/);
  });

  it("rejects a design over 4000 characters", () => {
    const huge = "a".repeat(4001);
    expect(() => validateAnswers({ design: huge })).toThrow(/4000 characters/);
  });

  it("rejects more than 4 follow-ups", () => {
    expect(() =>
      validateAnswers({ design: longDesign, followUps: ["a", "b", "c", "d", "e"] })
    ).toThrow(/At most 4/);
  });

  it("rejects a follow-up answer over 4000 characters", () => {
    const huge = "a".repeat(4001);
    expect(() => validateAnswers({ design: longDesign, followUps: [huge] })).toThrow(/4000 characters/);
  });

  it("rejects non-string follow-up entries", () => {
    expect(() => validateAnswers({ design: longDesign, followUps: [42] })).toThrow();
  });
});

describe("scoreTotal", () => {
  it("computes a weighted 0-100 total", () => {
    const lesson = makeLesson();
    const total = scoreTotal(lesson, [
      { id: "tradeoffs", score: 2, note: "good" },
      { id: "failure", score: 1, note: "partial" },
    ]);
    // tradeoffs: 2/2 * 60 = 60, failure: 1/2 * 40 = 20 -> 80/100
    expect(total).toBe(80);
  });

  it("returns 0 when all items score 0", () => {
    const lesson = makeLesson();
    const total = scoreTotal(lesson, [
      { id: "tradeoffs", score: 0, note: "" },
      { id: "failure", score: 0, note: "" },
    ]);
    expect(total).toBe(0);
  });

  it("returns 100 when all items score full marks", () => {
    const lesson = makeLesson();
    const total = scoreTotal(lesson, [
      { id: "tradeoffs", score: 2, note: "" },
      { id: "failure", score: 2, note: "" },
    ]);
    expect(total).toBe(100);
  });

  it("ignores items whose id is not in the rubric", () => {
    const lesson = makeLesson();
    const total = scoreTotal(lesson, [
      { id: "tradeoffs", score: 2, note: "" },
      { id: "failure", score: 2, note: "" },
      { id: "unknown", score: 2, note: "" },
    ]);
    expect(total).toBe(100);
  });
});

describe("buildGradingMessages", () => {
  it("includes rubric, model answer, design, and follow-ups", () => {
    const lesson = makeLesson();
    const { system, messages } = buildGradingMessages(lesson, {
      design: longDesign,
      followUps: ["my answer to follow-up one"],
    });
    expect(system).toMatch(/staff-level|calibrated/i);
    const userContent = messages[0]!.content as string;
    expect(userContent).toContain("tradeoffs");
    expect(userContent).toContain(lesson.defense.modelAnswer);
    expect(userContent).toContain(longDesign);
    expect(userContent).toContain("my answer to follow-up one");
    expect(userContent).toContain(lesson.defense.followUps[0]);
  });

  it("marks unanswered follow-ups", () => {
    const lesson = makeLesson();
    const { messages } = buildGradingMessages(lesson, { design: longDesign, followUps: [] });
    const userContent = messages[0]!.content as string;
    expect(userContent).toContain("(not answered)");
  });
});

describe("gradeWithClaude", () => {
  it("returns a graded result from a fake client's parsed_output", async () => {
    const lesson = makeLesson();
    const fakeClient: ClaudeClient = {
      messages: {
        parse: async () => ({
          parsed_output: {
            items: [
              { id: "tradeoffs", score: 2, note: "Clear tradeoffs." },
              { id: "failure", score: 1, note: "Partial failure discussion." },
            ],
            critique: "Strong on tradeoffs. Biggest gap: failure handling under load. Overall solid.",
          },
        }),
      },
    };

    const result = await gradeWithClaude(lesson, { design: longDesign, followUps: [] }, fakeClient);
    expect(result.mode).toBe("graded");
    expect(result.total).toBe(80);
    expect(result.items).toHaveLength(2);
    expect(result.critique).toMatch(/tradeoffs/i);
  });

  it("throws when parsed_output is null", async () => {
    const lesson = makeLesson();
    const fakeClient: ClaudeClient = {
      messages: { parse: async () => ({ parsed_output: null }) },
    };
    await expect(gradeWithClaude(lesson, { design: longDesign, followUps: [] }, fakeClient)).rejects.toThrow();
  });

  it("uses GRADER_MODEL env var when set", async () => {
    const original = process.env.GRADER_MODEL;
    process.env.GRADER_MODEL = "claude-test-model";
    let seenModel = "";
    const fakeClient: ClaudeClient = {
      messages: {
        parse: async (params) => {
          seenModel = params.model;
          return { parsed_output: { items: [], critique: "ok" } };
        },
      },
    };
    await gradeWithClaude(makeLesson(), { design: longDesign, followUps: [] }, fakeClient);
    expect(seenModel).toBe("claude-test-model");
    if (original === undefined) delete process.env.GRADER_MODEL;
    else process.env.GRADER_MODEL = original;
  });
});

describe("POST /api/grade", () => {
  it("returns 501 { mode: 'self' } when ANTHROPIC_API_KEY is unset", async () => {
    vi.resetModules();
    vi.doMock("./curriculum", () => ({
      getLesson: (id: string) => (id === "test-lesson" ? makeLesson() : undefined),
    }));

    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const { POST } = await import("../app/api/grade/route");
    const request = new Request("http://localhost/api/grade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lessonId: "test-lesson", answers: { design: longDesign, followUps: [] } }),
    });

    const response = await POST(request);
    expect(response.status).toBe(501);
    const json = await response.json();
    expect(json).toEqual({ mode: "self" });

    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
    vi.doUnmock("./curriculum");
    vi.resetModules();
  });
});
