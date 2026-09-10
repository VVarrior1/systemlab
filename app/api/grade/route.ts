import Anthropic from "@anthropic-ai/sdk";
import { getLesson } from "../../../lib/curriculum";
import { gradeWithClaude, validateAnswers } from "../../../lib/grading";

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

  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "Request body must be an object." }, { status: 400 });
  }
  const { lessonId } = body as Record<string, unknown>;
  if (typeof lessonId !== "string") {
    return Response.json({ error: "lessonId (string) is required." }, { status: 400 });
  }

  const lesson = getLesson(lessonId);
  if (!lesson || lesson.defense.rubric.length === 0) {
    return Response.json({ error: "Unknown lesson." }, { status: 404 });
  }

  let answers;
  try {
    answers = validateAnswers((body as Record<string, unknown>).answers);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request.";
    return Response.json({ error: message }, { status: 400 });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ mode: "self" }, { status: 501 });
  }

  try {
    const result = await gradeWithClaude(lesson, answers);
    return Response.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      return Response.json({ error: `Grading service error: ${error.message}` }, { status: 502 });
    }
    const message = error instanceof Error ? error.message : "Grading failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
