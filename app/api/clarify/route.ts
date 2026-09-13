import { getLesson } from "../../../lib/curriculum";
import { matchClarification, neutralReply, answerAsInterviewer } from "../../../lib/clarify";
import { hasGeminiKey } from "../../../lib/gemini";

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

const MAX_QUESTION_LENGTH = 500;

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
  const { lessonId, question } = body as Record<string, unknown>;
  if (typeof lessonId !== "string") {
    return Response.json({ error: "lessonId (string) is required." }, { status: 400 });
  }
  if (typeof question !== "string" || question.trim().length === 0) {
    return Response.json({ error: "A question (non-empty string) is required." }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return Response.json({ error: `question must be at most ${MAX_QUESTION_LENGTH} characters.` }, { status: 400 });
  }

  const lesson = getLesson(lessonId);
  if (!lesson) {
    return Response.json({ error: "Unknown lesson." }, { status: 404 });
  }

  const match = matchClarification(question, lesson.clarifications ?? []);
  if (match) {
    const clarification = (lesson.clarifications ?? [])[match.index]!;
    return Response.json(
      { mode: "matched", index: match.index, answer: clarification.answer },
      { status: 200 }
    );
  }

  if (!hasGeminiKey()) {
    return Response.json({ mode: "neutral", answer: neutralReply(question) }, { status: 200 });
  }

  try {
    const answer = await answerAsInterviewer(lesson, question);
    return Response.json({ mode: "answered", answer }, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Clarification failed.";
    return Response.json({ error: `Interviewer service error: ${message}` }, { status: 502 });
  }
}
