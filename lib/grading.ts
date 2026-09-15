import { z } from "zod";
import type { Lesson, RubricItem } from "./types";
import { GRADER_MODEL, generateJson, type GeminiClient } from "./gemini";

export const GradeSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      score: z.union([z.literal(0), z.literal(1), z.literal(2)]),
      note: z.string(),
    })
  ),
  critique: z.string(),
});

export type Grade = z.infer<typeof GradeSchema>;

export interface GradeResult {
  mode: "graded";
  items: Grade["items"];
  total: number;
  critique: string;
}

const MAX_ANSWER_LENGTH = 4000;
const MAX_FOLLOW_UPS = 4;
const MIN_DESIGN_WORDS = 60;

export interface FollowUpAnswer {
  question: string;
  answer: string;
}

export interface GradeAnswers {
  design: string;
  followUps: FollowUpAnswer[];
}

/**
 * Validates a design answer string. Throws a friendly Error (suitable for a
 * 400 response) on invalid input. Shared by the "grade" and "followups"
 * stages of POST /api/grade.
 */
export function validateDesignText(input: unknown): string {
  if (typeof input !== "string") {
    throw new Error("A design answer (string) is required.");
  }
  if (input.length > MAX_ANSWER_LENGTH) {
    throw new Error(`Design answer must be at most ${MAX_ANSWER_LENGTH} characters.`);
  }
  const wordCount = input.trim().length === 0 ? 0 : input.trim().split(/\s+/).length;
  if (wordCount < MIN_DESIGN_WORDS) {
    throw new Error(`Design answer must be at least ${MIN_DESIGN_WORDS} words.`);
  }
  return input;
}

/**
 * Validates the raw request body into { design, followUps }. Accepts either
 * the new shape (followUps: [{ question, answer }]) or the legacy shape
 * (followUps: string[]), which is mapped onto the lesson's static follow-up
 * questions by index. Throws friendly Error messages (suitable for a 400
 * response) on invalid input.
 */
export function validateAnswers(input: unknown, lesson: Lesson): GradeAnswers {
  if (typeof input !== "object" || input === null) {
    throw new Error("Request body must be an object with a design answer.");
  }
  const body = input as Record<string, unknown>;
  const design = validateDesignText(body.design);

  const followUpsRaw = body.followUps;
  let followUps: FollowUpAnswer[] = [];
  if (followUpsRaw !== undefined) {
    if (!Array.isArray(followUpsRaw)) {
      throw new Error("followUps must be an array.");
    }
    if (followUpsRaw.length > MAX_FOLLOW_UPS) {
      throw new Error(`At most ${MAX_FOLLOW_UPS} follow-up answers are allowed.`);
    }
    followUps = followUpsRaw.map((entry, index) => {
      if (typeof entry === "string") {
        if (entry.length > MAX_ANSWER_LENGTH) {
          throw new Error(`Follow-up answer at index ${index} must be at most ${MAX_ANSWER_LENGTH} characters.`);
        }
        const question = lesson.defense.followUps[index] ?? `Follow-up ${index + 1}`;
        return { question, answer: entry };
      }
      if (typeof entry === "object" && entry !== null) {
        const { question, answer } = entry as Record<string, unknown>;
        if (typeof question !== "string") {
          throw new Error(`Follow-up at index ${index} must include a question (string).`);
        }
        if (typeof answer !== "string") {
          throw new Error(`Follow-up at index ${index} must include an answer (string).`);
        }
        if (answer.length > MAX_ANSWER_LENGTH) {
          throw new Error(`Follow-up answer at index ${index} must be at most ${MAX_ANSWER_LENGTH} characters.`);
        }
        return { question, answer };
      }
      throw new Error(`Follow-up at index ${index} must be a string or { question, answer } object.`);
    });
  }

  return { design, followUps };
}

const SYSTEM_PROMPT = `You are a staff-level system design interviewer grading a candidate's written design defense.

For each rubric item, assign a score of 0, 1, or 2 (0 = missing or wrong, 1 = partially addressed, 2 = fully and correctly addressed) and write a one-line note explaining the score. Then write a critique of 3 to 5 sentences that names the strongest point of the candidate's answer and the biggest gap.

Be calibrated, not generous. A vague or hand-wavy answer that merely mentions a term without explaining the mechanism does not earn full credit. Grade only what the candidate actually wrote; do not give credit for things they did not say.`;

/**
 * Builds the system + contents sent to Gemini for grading. The model answer
 * is included only for the grader's reference and is never echoed back to
 * the client by the route.
 */
export function buildGradingMessages(
  lesson: Lesson,
  answers: GradeAnswers
): { system: string; contents: { role: "user" | "model"; text: string }[] } {
  const rubricLines = lesson.defense.rubric
    .map((item) => `- [${item.id}] (weight ${item.weight}): ${item.criterion}`)
    .join("\n");

  const followUpLines = answers.followUps
    .map(({ question, answer }, index) => {
      const given = answer.trim().length === 0 ? "(not answered)" : answer;
      return `Follow-up ${index + 1}: ${question}\nCandidate's answer: ${given}`;
    })
    .join("\n\n");

  const userContent = `Lesson: ${lesson.title}
Brief: ${lesson.brief}

Learning points:
${lesson.learning.map((point) => `- ${point}`).join("\n")}

Rubric (grade each item 0-2, weights sum to 100):
${rubricLines}

Model answer (grader reference only, never shown to the candidate):
${lesson.defense.modelAnswer}

Design defense prompt given to the candidate: ${lesson.defense.prompt}

Candidate's design answer:
${answers.design}

${followUpLines}`;

  return {
    system: SYSTEM_PROMPT,
    contents: [{ role: "user", text: userContent }],
  };
}

/**
 * Computes the weighted 0-100 total from rubric item scores (0-2 each).
 */
export function scoreTotal(lesson: Lesson, items: Grade["items"]): number {
  const rubric = lesson.defense.rubric;
  const byId = new Map<string, RubricItem>(rubric.map((item) => [item.id, item]));
  let earned = 0;
  let possible = 0;
  for (const item of items) {
    const rubricItem = byId.get(item.id);
    if (!rubricItem) continue;
    possible += rubricItem.weight;
    earned += (item.score / 2) * rubricItem.weight;
  }
  if (possible === 0) return 0;
  return Math.round((earned / possible) * 100);
}

const GRADE_JSON_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          score: { type: "integer", enum: [0, 1, 2] },
          note: { type: "string" },
        },
        required: ["id", "score", "note"],
      },
    },
    critique: { type: "string" },
  },
  required: ["items", "critique"],
};

/**
 * Grades a learner's design defense with Gemini. `client` defaults to a real
 * GoogleGenAI client (reads GEMINI_API_KEY from the environment) but accepts
 * a fake for unit testing.
 */
export async function gradeWithGemini(
  lesson: Lesson,
  answers: GradeAnswers,
  client?: GeminiClient
): Promise<GradeResult> {
  const { system, contents } = buildGradingMessages(lesson, answers);

  const grade = await generateJson<Grade>({
    client,
    system,
    contents,
    schema: GRADE_JSON_SCHEMA,
    parse: (value) => GradeSchema.parse(value),
    // Thinking tokens are drawn from this same budget on gemini-3.x flash, and
    // grading reasons over every rubric item before emitting JSON. Without wide
    // headroom the JSON truncates mid-string and parsing fails. See gemini.ts.
    maxOutputTokens: 12000,
  });

  const total = scoreTotal(lesson, grade.items);

  return { mode: "graded", items: grade.items, total, critique: grade.critique };
}

export const FollowUpsSchema = z.object({
  followUps: z.array(z.string()).length(3),
});

export type FollowUps = z.infer<typeof FollowUpsSchema>;

const FOLLOWUPS_SYSTEM_PROMPT = `You are a staff-level system design interviewer. You have just read a candidate's written design answer.

Write exactly 3 short follow-up questions to ask next. Each question must target a specific claim in the candidate's own answer that is weak, hand-wavy, or missing entirely — not a generic checklist item. Never answer the question for them, and never suggest the answer. Each question must be a single sentence. Output only the questions themselves, with no preamble, numbering, or explanation.`;

const FOLLOWUPS_JSON_SCHEMA = {
  type: "object",
  properties: {
    followUps: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 3,
    },
  },
  required: ["followUps"],
};

/**
 * Builds the system + contents sent to Gemini to generate dynamic follow-up
 * questions targeting weak or missing claims in the learner's own design
 * text.
 */
export function buildFollowUpsMessages(
  lesson: Lesson,
  design: string
): { system: string; contents: { role: "user" | "model"; text: string }[] } {
  const rubricLines = lesson.defense.rubric
    .map((item) => `- ${item.criterion}`)
    .join("\n");

  const userContent = `Lesson: ${lesson.title}
Brief: ${lesson.brief}

Learning points:
${lesson.learning.map((point) => `- ${point}`).join("\n")}

What a strong answer should cover:
${rubricLines}

Candidate's design answer:
${design}`;

  return {
    system: FOLLOWUPS_SYSTEM_PROMPT,
    contents: [{ role: "user", text: userContent }],
  };
}

/**
 * Generates 3 dynamic follow-up questions targeting the weakest claims in
 * the learner's own design text. `client` defaults to a real GoogleGenAI
 * client (reads GEMINI_API_KEY from the environment) but accepts a fake for
 * unit testing.
 */
export async function generateFollowUps(
  lesson: Lesson,
  design: string,
  client?: GeminiClient
): Promise<string[]> {
  const { system, contents } = buildFollowUpsMessages(lesson, design);

  const result = await generateJson<FollowUps>({
    client,
    system,
    contents,
    schema: FOLLOWUPS_JSON_SCHEMA,
    parse: (value) => FollowUpsSchema.parse(value),
    // Same thinking-shares-the-budget constraint as grading above: observed
    // thinking alone ran 317-671 tokens for this prompt, against a former cap
    // of 1000, so a long think truncated the JSON. See gemini.ts.
    maxOutputTokens: 4000,
  });

  return result.followUps;
}

export { GRADER_MODEL };
