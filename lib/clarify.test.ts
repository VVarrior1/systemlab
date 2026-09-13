import { describe, expect, it, vi } from "vitest";
import type { Clarification, Lesson } from "./types";
import {
  answerAsInterviewer,
  buildClarifyMessages,
  matchClarification,
  neutralReply,
} from "./clarify";
import type { GeminiClient } from "./gemini";

const clarifications: Clarification[] = [
  { question: "What is the expected request rate?", answer: "About 5,000 QPS at peak.", relevant: true },
  { question: "How strong does read consistency need to be?", answer: "Eventual consistency is fine; a few seconds of staleness is acceptable.", relevant: true },
  { question: "What is the budget for this system?", answer: "Keep monthly infra cost under $2,000.", relevant: true },
  { question: "Do we need multi-region support?", answer: "No, single region is fine for now.", relevant: false },
];

function makeLesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: "test-lesson",
    number: 1,
    chapter: "Foundations",
    title: "Test lesson",
    subtitle: "A lesson for tests",
    kind: "brief",
    difficulty: "Beginner",
    minutes: 10,
    concept: "Testing",
    brief: "Design a URL shortener.",
    learning: ["Point one."],
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
      prompt: "Explain your design.",
      followUps: [],
      rubric: [],
      modelAnswer: "n/a",
    },
    readings: [],
    reflection: { question: "?", options: ["a", "b"], answer: 0, explanation: "" },
    remixable: false,
    clarifications,
    ...overrides,
  };
}

describe("matchClarification", () => {
  it("matches a direct rephrasing using synonyms (qps <-> traffic)", () => {
    const match = matchClarification("What's the expected traffic?", clarifications);
    expect(match).not.toBeNull();
    expect(match!.index).toBe(0);
  });

  it("matches on consistency/stale synonyms", () => {
    const match = matchClarification("Can reads be a little stale?", clarifications);
    expect(match).not.toBeNull();
    expect(match!.index).toBe(1);
  });

  it("matches on budget/cost synonyms", () => {
    const match = matchClarification("Is there a cost budget I should design to?", clarifications);
    expect(match).not.toBeNull();
    expect(match!.index).toBe(2);
  });

  it("matches on region/geo synonyms", () => {
    const match = matchClarification("Do we need to support multiple geographic regions?", clarifications);
    expect(match).not.toBeNull();
    expect(match!.index).toBe(3);
  });

  it("returns null for an irrelevant question", () => {
    const match = matchClarification("What programming language should I use?", clarifications);
    expect(match).toBeNull();
  });

  it("returns null for an empty question", () => {
    expect(matchClarification("", clarifications)).toBeNull();
    expect(matchClarification("   ", clarifications)).toBeNull();
  });

  it("returns null for a near-miss that only shares stopwords", () => {
    const match = matchClarification("What should I do here?", clarifications);
    expect(match).toBeNull();
  });

  it("returns null when there are no clarifications", () => {
    expect(matchClarification("What's the expected traffic?", [])).toBeNull();
  });

  it("picks the best-scoring match when more than one is plausible", () => {
    const match = matchClarification("What's the request rate and is it read heavy with stale reads ok?", clarifications);
    expect(match).not.toBeNull();
    expect([0, 1]).toContain(match!.index);
  });
});

describe("neutralReply", () => {
  it("returns a non-empty in-character reply that doesn't leak facts", () => {
    const reply = neutralReply("What's the expected traffic?");
    expect(typeof reply).toBe("string");
    expect(reply.length).toBeGreaterThan(0);
    expect(reply).not.toContain("5,000");
  });
});

describe("buildClarifyMessages", () => {
  it("includes the brief and all clarifications as hidden facts, but never the relevant flag", () => {
    const lesson = makeLesson();
    const { system, contents } = buildClarifyMessages(lesson, "What about multi-region?");
    expect(system).toMatch(/interviewer/i);
    const userContent = contents[0]!.text;
    expect(userContent).toContain(lesson.brief);
    expect(userContent).toContain("5,000 QPS");
    expect(userContent).toContain("single region is fine");
    expect(userContent).not.toMatch(/"relevant"\s*:\s*(true|false)/);
  });
});

describe("answerAsInterviewer", () => {
  it("returns the answer from a fake client's response", async () => {
    const lesson = makeLesson();
    const fakeClient: GeminiClient = {
      models: {
        generateContent: async () => ({ text: JSON.stringify({ answer: "We expect about 5,000 QPS at peak." }) }),
      },
    };
    const answer = await answerAsInterviewer(lesson, "What's the traffic?", fakeClient);
    expect(answer).toBe("We expect about 5,000 QPS at peak.");
  });

  it("throws when the response is empty", async () => {
    const lesson = makeLesson();
    const fakeClient: GeminiClient = {
      models: { generateContent: async () => ({ text: "" }) },
    };
    await expect(answerAsInterviewer(lesson, "What's the traffic?", fakeClient)).rejects.toThrow();
  });
});

describe("POST /api/clarify", () => {
  it("returns 200 { mode: 'matched' } when the question matches an authored clarification", async () => {
    vi.resetModules();
    const lesson = makeLesson();
    vi.doMock("./curriculum", () => ({
      getLesson: (id: string) => (id === "test-lesson" ? lesson : undefined),
    }));

    const { POST } = await import("../app/api/clarify/route");
    const request = new Request("http://localhost/api/clarify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lessonId: "test-lesson", question: "What's the expected traffic?" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.mode).toBe("matched");
    expect(json.index).toBe(0);
    expect(json.answer).toBe("About 5,000 QPS at peak.");
    expect(json).not.toHaveProperty("relevant");

    vi.doUnmock("./curriculum");
    vi.resetModules();
  });

  it("returns 200 { mode: 'neutral' } for an unmatched question without a key", async () => {
    vi.resetModules();
    const lesson = makeLesson();
    vi.doMock("./curriculum", () => ({
      getLesson: (id: string) => (id === "test-lesson" ? lesson : undefined),
    }));

    const original = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    const { POST } = await import("../app/api/clarify/route");
    const request = new Request("http://localhost/api/clarify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lessonId: "test-lesson", question: "What language should I use?" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.mode).toBe("neutral");
    expect(typeof json.answer).toBe("string");

    if (original === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = original;
    vi.doUnmock("./curriculum");
    vi.resetModules();
  });

  it("returns 200 { mode: 'answered' } for an unmatched question with a key", async () => {
    vi.resetModules();
    const lesson = makeLesson();
    vi.doMock("./curriculum", () => ({
      getLesson: (id: string) => (id === "test-lesson" ? lesson : undefined),
    }));
    vi.doMock("./gemini", async () => {
      const actual = await vi.importActual<typeof import("./gemini")>("./gemini");
      return {
        ...actual,
        hasGeminiKey: () => true,
        generateJson: async (args: { parse: (value: unknown) => unknown }) =>
          args.parse({ answer: "I don't have a strong requirement there; assume what a careful engineer would." }),
      };
    });

    const { POST } = await import("../app/api/clarify/route");
    const request = new Request("http://localhost/api/clarify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lessonId: "test-lesson", question: "What language should I use?" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.mode).toBe("answered");
    expect(typeof json.answer).toBe("string");

    vi.doUnmock("./curriculum");
    vi.doUnmock("./gemini");
    vi.resetModules();
  });

  it("rejects a missing lessonId", async () => {
    vi.resetModules();
    const { POST } = await import("../app/api/clarify/route");
    const request = new Request("http://localhost/api/clarify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What's the traffic?" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    vi.resetModules();
  });

  it("rejects a missing question", async () => {
    vi.resetModules();
    vi.doMock("./curriculum", () => ({
      getLesson: (id: string) => (id === "test-lesson" ? makeLesson() : undefined),
    }));
    const { POST } = await import("../app/api/clarify/route");
    const request = new Request("http://localhost/api/clarify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lessonId: "test-lesson" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    vi.doUnmock("./curriculum");
    vi.resetModules();
  });

  it("returns 404 for an unknown lesson", async () => {
    vi.resetModules();
    vi.doMock("./curriculum", () => ({
      getLesson: () => undefined,
    }));
    const { POST } = await import("../app/api/clarify/route");
    const request = new Request("http://localhost/api/clarify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lessonId: "unknown", question: "What's the traffic?" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(404);
    vi.doUnmock("./curriculum");
    vi.resetModules();
  });
});
