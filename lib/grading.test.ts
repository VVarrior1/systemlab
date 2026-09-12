import { describe, expect, it, vi } from "vitest";
import type { Lesson } from "./types";
import {
  buildFollowUpsMessages,
  buildGradingMessages,
  generateFollowUps,
  gradeWithClaude,
  scoreTotal,
  validateAnswers,
  validateDesignText,
  type ClaudeClient,
  type FollowUpsClient,
} from "./grading";

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

describe("validateDesignText", () => {
  it("accepts a valid design", () => {
    expect(validateDesignText(longDesign)).toBe(longDesign);
  });

  it("rejects a non-string design", () => {
    expect(() => validateDesignText(42)).toThrow();
    expect(() => validateDesignText(undefined)).toThrow();
  });

  it("rejects a design under 60 words", () => {
    expect(() => validateDesignText("too short")).toThrow(/60 words/);
  });

  it("rejects a design over 4000 characters", () => {
    const huge = "a".repeat(4001);
    expect(() => validateDesignText(huge)).toThrow(/4000 characters/);
  });
});

describe("validateAnswers", () => {
  const lesson = makeLesson();

  it("accepts a valid design with new-shape follow-ups", () => {
    const result = validateAnswers(
      {
        design: longDesign,
        followUps: [
          { question: "Custom question one?", answer: "answer one" },
          { question: "Custom question two?", answer: "answer two" },
        ],
      },
      lesson
    );
    expect(result.design).toBe(longDesign);
    expect(result.followUps).toEqual([
      { question: "Custom question one?", answer: "answer one" },
      { question: "Custom question two?", answer: "answer two" },
    ]);
  });

  it("maps legacy string[] follow-ups onto the lesson's static questions", () => {
    const result = validateAnswers({ design: longDesign, followUps: ["answer one", "answer two"] }, lesson);
    expect(result.followUps).toEqual([
      { question: lesson.defense.followUps[0], answer: "answer one" },
      { question: lesson.defense.followUps[1], answer: "answer two" },
    ]);
  });

  it("defaults followUps to an empty array when omitted", () => {
    const result = validateAnswers({ design: longDesign }, lesson);
    expect(result.followUps).toEqual([]);
  });

  it("rejects a missing design", () => {
    expect(() => validateAnswers({}, lesson)).toThrow();
  });

  it("rejects a non-object body", () => {
    expect(() => validateAnswers("nope", lesson)).toThrow();
    expect(() => validateAnswers(null, lesson)).toThrow();
  });

  it("rejects a design under 60 words", () => {
    expect(() => validateAnswers({ design: "too short" }, lesson)).toThrow(/60 words/);
  });

  it("rejects more than 4 follow-ups", () => {
    expect(() =>
      validateAnswers({ design: longDesign, followUps: ["a", "b", "c", "d", "e"] }, lesson)
    ).toThrow(/At most 4/);
  });

  it("rejects a legacy follow-up answer over 4000 characters", () => {
    const huge = "a".repeat(4001);
    expect(() => validateAnswers({ design: longDesign, followUps: [huge] }, lesson)).toThrow(/4000 characters/);
  });

  it("rejects a new-shape follow-up missing a question", () => {
    expect(() =>
      validateAnswers({ design: longDesign, followUps: [{ answer: "a" }] }, lesson)
    ).toThrow(/question/);
  });

  it("rejects a new-shape follow-up missing an answer", () => {
    expect(() =>
      validateAnswers({ design: longDesign, followUps: [{ question: "q?" }] }, lesson)
    ).toThrow(/answer/);
  });

  it("rejects non-string/object follow-up entries", () => {
    expect(() => validateAnswers({ design: longDesign, followUps: [42] }, lesson)).toThrow();
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
      followUps: [{ question: "What about 10x traffic?", answer: "my answer to follow-up one" }],
    });
    expect(system).toMatch(/staff-level|calibrated/i);
    const userContent = messages[0]!.content as string;
    expect(userContent).toContain("tradeoffs");
    expect(userContent).toContain(lesson.defense.modelAnswer);
    expect(userContent).toContain(longDesign);
    expect(userContent).toContain("my answer to follow-up one");
    expect(userContent).toContain("What about 10x traffic?");
  });

  it("marks a follow-up with a blank answer as unanswered", () => {
    const lesson = makeLesson();
    const { messages } = buildGradingMessages(lesson, {
      design: longDesign,
      followUps: [{ question: "What about 10x traffic?", answer: "" }],
    });
    const userContent = messages[0]!.content as string;
    expect(userContent).toContain("(not answered)");
  });

  it("includes nothing follow-up related when no follow-ups were asked", () => {
    const lesson = makeLesson();
    const { messages } = buildGradingMessages(lesson, { design: longDesign, followUps: [] });
    const userContent = messages[0]!.content as string;
    expect(userContent).not.toContain("Follow-up 1:");
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

describe("buildFollowUpsMessages", () => {
  it("includes the brief, learning points, rubric, and the candidate's design", () => {
    const lesson = makeLesson();
    const { system, messages } = buildFollowUpsMessages(lesson, longDesign);
    expect(system).toMatch(/interviewer/i);
    expect(system).toMatch(/never answer/i);
    const userContent = messages[0]!.content as string;
    expect(userContent).toContain(lesson.brief);
    expect(userContent).toContain("Point one.");
    expect(userContent).toContain("Names concrete tradeoffs");
    expect(userContent).toContain(longDesign);
    expect(userContent).not.toContain(lesson.defense.modelAnswer);
  });
});

describe("generateFollowUps", () => {
  it("returns 3 questions from a fake client's parsed_output", async () => {
    const lesson = makeLesson();
    const fakeClient: FollowUpsClient = {
      messages: {
        parse: async () => ({
          parsed_output: {
            followUps: [
              "How does your design handle a 10x spike in traffic?",
              "What happens when the primary database fails over?",
              "How do you keep the cache consistent with the source of truth?",
            ],
          },
        }),
      },
    };
    const followUps = await generateFollowUps(lesson, longDesign, fakeClient);
    expect(followUps).toHaveLength(3);
    expect(followUps[0]).toMatch(/traffic/i);
  });

  it("throws when parsed_output is null", async () => {
    const lesson = makeLesson();
    const fakeClient: FollowUpsClient = {
      messages: { parse: async () => ({ parsed_output: null }) },
    };
    await expect(generateFollowUps(lesson, longDesign, fakeClient)).rejects.toThrow();
  });

  it("uses GRADER_MODEL env var when set", async () => {
    const original = process.env.GRADER_MODEL;
    process.env.GRADER_MODEL = "claude-test-model";
    let seenModel = "";
    const fakeClient: FollowUpsClient = {
      messages: {
        parse: async (params) => {
          seenModel = params.model;
          return { parsed_output: { followUps: ["a?", "b?", "c?"] } };
        },
      },
    };
    await generateFollowUps(makeLesson(), longDesign, fakeClient);
    expect(seenModel).toBe("claude-test-model");
    if (original === undefined) delete process.env.GRADER_MODEL;
    else process.env.GRADER_MODEL = original;
  });
});

describe("GET /api/grade", () => {
  it("returns { mode: 'self' } without a key", async () => {
    vi.resetModules();
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const { GET } = await import("../app/api/grade/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ mode: "self" });

    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
    vi.resetModules();
  });

  it("returns { mode: 'graded' } with a key", async () => {
    vi.resetModules();
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";

    const { GET } = await import("../app/api/grade/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ mode: "graded" });

    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
    vi.resetModules();
  });
});

describe("POST /api/grade", () => {
  it("returns 501 { mode: 'self' } when ANTHROPIC_API_KEY is unset (grade stage)", async () => {
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

  it("returns 501 { mode: 'self', followUps } for the followups stage without a key", async () => {
    vi.resetModules();
    const lesson = makeLesson();
    vi.doMock("./curriculum", () => ({
      getLesson: (id: string) => (id === "test-lesson" ? lesson : undefined),
    }));

    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const { POST } = await import("../app/api/grade/route");
    const request = new Request("http://localhost/api/grade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lessonId: "test-lesson", stage: "followups", design: longDesign }),
    });

    const response = await POST(request);
    expect(response.status).toBe(501);
    const json = await response.json();
    expect(json).toEqual({ mode: "self", followUps: lesson.defense.followUps });

    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
    vi.doUnmock("./curriculum");
    vi.resetModules();
  });

  it("returns 200 { mode: 'graded', followUps } for the followups stage with a key", async () => {
    vi.resetModules();
    const lesson = makeLesson();
    vi.doMock("./curriculum", () => ({
      getLesson: (id: string) => (id === "test-lesson" ? lesson : undefined),
    }));
    vi.doMock("@anthropic-ai/sdk", async () => {
      const actual = await vi.importActual<typeof import("@anthropic-ai/sdk")>("@anthropic-ai/sdk");
      class FakeAnthropic {
        messages = {
          parse: async () => ({
            parsed_output: { followUps: ["a?", "b?", "c?"] },
          }),
        };
      }
      return { ...actual, default: FakeAnthropic };
    });

    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";

    const { POST } = await import("../app/api/grade/route");
    const request = new Request("http://localhost/api/grade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lessonId: "test-lesson", stage: "followups", design: longDesign }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ mode: "graded", followUps: ["a?", "b?", "c?"] });

    if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = original;
    vi.doUnmock("./curriculum");
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });

  it("rejects an invalid stage", async () => {
    vi.resetModules();
    vi.doMock("./curriculum", () => ({
      getLesson: (id: string) => (id === "test-lesson" ? makeLesson() : undefined),
    }));

    const { POST } = await import("../app/api/grade/route");
    const request = new Request("http://localhost/api/grade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lessonId: "test-lesson", stage: "nonsense" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);

    vi.doUnmock("./curriculum");
    vi.resetModules();
  });
});
