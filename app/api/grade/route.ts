import Anthropic from "@anthropic-ai/sdk";
import { getLesson } from "../../../lib/curriculum";
import { gradeWithClaude, generateFollowUps, validateAnswers, validateDesignText } from "../../../lib/grading";

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

export async function GET(): Promise<Response> {
  return Response.json({ mode: process.env.ANTHROPIC_API_KEY ? "graded" : "self" }, { status: 200 });
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
  const bodyRecord = body as Record<string, unknown>;
  const { lessonId } = bodyRecord;
  if (typeof lessonId !== "string") {
    return Response.json({ error: "lessonId (string) is required." }, { status: 400 });
  }

  const stageRaw = bodyRecord.stage ?? "grade";
  if (stageRaw !== "followups" && stageRaw !== "grade") {
    return Response.json({ error: 'stage must be "followups" or "grade".' }, { status: 400 });
  }

  const lesson = getLesson(lessonId);
  if (!lesson || lesson.defense.rubric.length === 0) {
    return Response.json({ error: "Unknown lesson." }, { status: 404 });
  }

  if (stageRaw === "followups") {
    let design: string;
    try {
      design = validateDesignText(bodyRecord.design);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid request.";
      return Response.json({ error: message }, { status: 400 });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return Response.json({ mode: "self", followUps: lesson.defense.followUps }, { status: 501 });
    }

    try {
      const followUps = await generateFollowUps(lesson, design);
      return Response.json({ mode: "graded", followUps }, { status: 200 });
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        return Response.json({ error: `Interviewer service error: ${error.message}` }, { status: 502 });
      }
      const message = error instanceof Error ? error.message : "Follow-up generation failed.";
      return Response.json({ error: message }, { status: 502 });
    }
  }

  let answers;
  try {
    answers = validateAnswers(bodyRecord.answers, lesson);
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
