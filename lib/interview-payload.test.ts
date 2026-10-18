import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateInterviewRequest, detectContradictions } from "./interview";
import { validateAnswers, validateDesignText } from "./grading";
import { getLesson } from "./curriculum";
import {
  MAX_WIRE_METRICS,
  followUpsBody,
  gradeBody,
  practiceInterviewBody,
  wireMetric,
  type InterviewContext,
  type NodeMetricSummary,
} from "./interview-payload";

// Pins the client/server contract for the lesson defense. The bodies below are built exactly the way
// components/defense-stage.tsx builds them, from the structured context components/playground.tsx
// produces, and are fed through the real route validators. Both live 400s ("context.metrics[0].value
// must be a string." and "A design answer (string) is required.") came from these shapes drifting.

const design = "The path is traffic to API to database and every request pays every hop. ".repeat(6).trim();

function metric(overrides: Partial<NodeMetricSummary> = {}): NodeMetricSummary {
  return { nodeId: "api", label: "API server", kind: "server", utilization: 0.31, processedPerSec: 60.2, errors: 0, ...overrides };
}

/** The structured context the playground hands DefenseStage after a passing check. */
function playgroundContext(metrics: NodeMetricSummary[] = [
  metric(),
  metric({ nodeId: "cache", label: "Read cache", kind: "cache", utilization: 0.12, processedPerSec: 54, hitRate: 0.62 }),
  metric({ nodeId: "db", label: "Orders database", kind: "database", utilization: 0.4, processedPerSec: 22.5, errors: 3, shardSpread: [0.4, 0.35, 0.25] }),
]): InterviewContext {
  return {
    architecture: "traffic -> API server (200 req/s x1) -> Orders database (150 req/s x1)",
    result: "p95 58 ms, throughput 60 req/s, error rate 0%",
    rationales: [{ nodeId: "cache", label: "Read cache", kind: "cache", technology: "Redis", why: "Hot product reads fit in memory.", expected: "~85% hits" }],
    dataModel: "",
    estimation: "Predicted P95 latency: predicted 55 ms, actual 58 ms (score 1)",
    blankCanvas: false,
    metrics,
  };
}

describe("practice interview body (POST /api/interview)", () => {
  it("passes the route validator for a turn and for the grade", () => {
    const context = playgroundContext();
    const turn = validateInterviewRequest(practiceInterviewBody("first-request", "turn", [{ role: "candidate", text: design }], context));
    expect(turn.mode).toBe("practice");
    expect(turn.context.metrics?.every((entry) => typeof entry.value === "string")).toBe(true);

    const grade = validateInterviewRequest(practiceInterviewBody("first-request", "grade", [
      { role: "candidate", text: design },
      { role: "interviewer", text: "What happens when the database slows down?" },
      { role: "candidate", text: "Every percentile shifts up by the added latency." },
    ], context));
    expect(grade.stage).toBe("grade");
    expect(grade.transcript).toHaveLength(3);
  });

  it("documents the regression: the raw structured metrics are rejected", () => {
    const raw = { lessonId: "first-request", stage: "turn", transcript: [], context: playgroundContext() };
    expect(() => validateInterviewRequest(raw)).toThrow("context.metrics[0].value must be a string.");
  });

  it("puts the comparable number first so the contradiction check can read it", () => {
    expect(wireMetric(metric({ kind: "cache", hitRate: 0.62, processedPerSec: 54 })).value).toMatch(/^62% hit rate/);
    expect(wireMetric(metric({ processedPerSec: 60.2 })).value).toMatch(/^60\.2 ops\/s served/);
    const request = validateInterviewRequest(practiceInterviewBody("first-request", "turn", [], playgroundContext()));
    const contradictions = detectContradictions(request.context.rationales, request.context.metrics);
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]!.nodeId).toBe("cache");
  });

  it("stays inside the route's caps on a large design", () => {
    const many = Array.from({ length: MAX_WIRE_METRICS + 8 }, (_, index) => metric({ nodeId: `n${index}` }));
    const context = { ...playgroundContext(many), architecture: "x".repeat(6000) };
    const request = validateInterviewRequest(practiceInterviewBody("first-request", "turn", [], context));
    expect(request.context.metrics).toHaveLength(MAX_WIRE_METRICS);
    expect(request.context.architecture?.length).toBe(4000);
  });
});

describe("grade bodies (POST /api/grade)", () => {
  it("followups puts the design at the top level, where the route reads it", () => {
    const body = followUpsBody("first-request", design) as Record<string, unknown>;
    expect(validateDesignText(body.design)).toBe(design);
  });

  it("grade nests the design and follow-up answers under answers", () => {
    const lesson = getLesson("first-request")!;
    const body = gradeBody("first-request", design, [{ question: lesson.defense.followUps[0]!, answer: "" }]) as Record<string, unknown>;
    expect(validateAnswers(body.answers, lesson).followUps).toHaveLength(1);
  });
});

describe("the routes accept the real payloads (no key: validation passes, then the self-mode 501)", () => {
  let original: string | undefined;
  beforeEach(() => { original = process.env.GEMINI_API_KEY; delete process.env.GEMINI_API_KEY; });
  afterEach(() => { if (original === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = original; });

  const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("/api/interview", async () => {
    const { POST } = await import("../app/api/interview/route");
    const response = await POST(new Request("http://localhost/api/interview", post(practiceInterviewBody("first-request", "turn", [{ role: "candidate", text: design }], playgroundContext()))));
    expect(response.status).toBe(501);
    expect((await response.json()).mode).toBe("self");
  });

  it("/api/grade followups and grade", async () => {
    const { POST } = await import("../app/api/grade/route");
    const followups = await POST(new Request("http://localhost/api/grade", post(followUpsBody("first-request", design))));
    expect(followups.status).toBe(501);
    const graded = await POST(new Request("http://localhost/api/grade", post(gradeBody("first-request", design, []))));
    expect(graded.status).toBe(501);
  });
});
