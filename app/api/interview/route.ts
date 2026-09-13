import { getLesson } from "../../../lib/curriculum";
import { hasGeminiKey } from "../../../lib/gemini";
import {
  validateInterviewRequest,
  generateTurn,
  generateMockTurn,
  gradeInterviewWithGemini,
  gradeMockInterviewWithGemini,
  buildMockScript,
} from "../../../lib/interview";

export const runtime = "nodejs";

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > RATE_LIMIT;
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (!forwarded) return "unknown";
  return forwarded.split(",")[0]!.trim();
}

export async function POST(req: Request): Promise<Response> {
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    return Response.json({ error: "Too many requests. Try again in a minute." }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  let request;
  try {
    request = validateInterviewRequest(body);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return Response.json({ error: message }, { status: 400 });
  }

  const lesson = getLesson(request.lessonId);
  if (!lesson || lesson.defense.rubric.length === 0) {
    return Response.json({ error: "Unknown lesson." }, { status: 404 });
  }

  if (!hasGeminiKey()) {
    if (request.mode === "mock") {
      return Response.json({ mode: "self", script: buildMockScript(lesson) }, { status: 501 });
    }
    return Response.json({ mode: "self", followUps: lesson.defense.followUps }, { status: 501 });
  }

  if (request.mode === "mock") {
    if (request.stage === "turn") {
      try {
        const turn = await generateMockTurn(
          lesson,
          request.phase!,
          request.elapsedSeconds!,
          request.phaseElapsedSeconds!,
          request.transcript,
          request.context
        );
        return Response.json(turn, { status: 200 });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Mock interview turn generation failed.";
        return Response.json({ error: `Interviewer service error: ${message}` }, { status: 502 });
      }
    }

    try {
      const result = await gradeMockInterviewWithGemini(lesson, request.transcript, request.context);
      return Response.json(result, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Mock interview grading failed.";
      return Response.json({ error: `Interviewer service error: ${message}` }, { status: 502 });
    }
  }

  if (request.stage === "turn") {
    try {
      const turn = await generateTurn(lesson, request.transcript, request.context);
      return Response.json(turn, { status: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Interview turn generation failed.";
      return Response.json({ error: `Interviewer service error: ${message}` }, { status: 502 });
    }
  }

  try {
    const result = await gradeInterviewWithGemini(lesson, request.transcript, request.context);
    return Response.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Interview grading failed.";
    return Response.json({ error: `Interviewer service error: ${message}` }, { status: 502 });
  }
}
