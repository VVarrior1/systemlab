import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Lesson, RubricItem } from "./types";

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

export interface GradeAnswers {
  design: string;
  followUps: string[];
}

/**
 * Validates the raw request body into { design, followUps }. Throws friendly
 * Error messages (suitable for a 400 response) on invalid input.
 */
export function validateAnswers(input: unknown): GradeAnswers {
  if (typeof input !== "object" || input === null) {
    throw new Error("Request body must be an object with a design answer.");
  }
  const body = input as Record<string, unknown>;
  const design = body.design;
  if (typeof design !== "string") {
    throw new Error("A design answer (string) is required.");
  }
  if (design.length > MAX_ANSWER_LENGTH) {
    throw new Error(`Design answer must be at most ${MAX_ANSWER_LENGTH} characters.`);
  }
  const wordCount = design.trim().length === 0 ? 0 : design.trim().split(/\s+/).length;
  if (wordCount < MIN_DESIGN_WORDS) {
    throw new Error(`Design answer must be at least ${MIN_DESIGN_WORDS} words.`);
  }

  const followUpsRaw = body.followUps;
  let followUps: string[] = [];
  if (followUpsRaw !== undefined) {
    if (!Array.isArray(followUpsRaw)) {
      throw new Error("followUps must be an array of strings.");
    }
    if (followUpsRaw.length > MAX_FOLLOW_UPS) {
      throw new Error(`At most ${MAX_FOLLOW_UPS} follow-up answers are allowed.`);
    }
    followUps = followUpsRaw.map((answer, index) => {
      if (typeof answer !== "string") {
        throw new Error(`Follow-up answer at index ${index} must be a string.`);
      }
      if (answer.length > MAX_ANSWER_LENGTH) {
        throw new Error(`Follow-up answer at index ${index} must be at most ${MAX_ANSWER_LENGTH} characters.`);
      }
      return answer;
    });
  }

  return { design, followUps };
}

const SYSTEM_PROMPT = `You are a staff-level system design interviewer grading a candidate's written design defense.

For each rubric item, assign a score of 0, 1, or 2 (0 = missing or wrong, 1 = partially addressed, 2 = fully and correctly addressed) and write a one-line note explaining the score. Then write a critique of 3 to 5 sentences that names the strongest point of the candidate's answer and the biggest gap.

Be calibrated, not generous. A vague or hand-wavy answer that merely mentions a term without explaining the mechanism does not earn full credit. Grade only what the candidate actually wrote; do not give credit for things they did not say.`;

/**
 * Builds the system + user messages sent to Claude for grading. The model
 * answer is included only for the grader's reference and is never echoed
 * back to the client by the route.
 */
export function buildGradingMessages(
  lesson: Lesson,
  answers: GradeAnswers
): { system: string; messages: Anthropic.MessageParam[] } {
  const rubricLines = lesson.defense.rubric
    .map((item) => `- [${item.id}] (weight ${item.weight}): ${item.criterion}`)
    .join("\n");

  const followUpLines = lesson.defense.followUps
    .map((question, index) => {
      const answer = answers.followUps[index] ?? "(not answered)";
      return `Follow-up ${index + 1}: ${question}\nCandidate's answer: ${answer}`;
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
    messages: [{ role: "user", content: userContent }],
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

export interface ClaudeClient {
  messages: {
    parse: (params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Anthropic.MessageParam[];
      output_config: { effort: "medium"; format: ReturnType<typeof zodOutputFormat> };
    }) => Promise<{ parsed_output: Grade | null }>;
  };
}

/**
 * Grades a learner's design defense with Claude. `client` defaults to a new
 * Anthropic() (reads ANTHROPIC_API_KEY from the environment) but accepts a
 * fake for unit testing.
 */
export async function gradeWithClaude(
  lesson: Lesson,
  answers: GradeAnswers,
  client: ClaudeClient = new Anthropic() as unknown as ClaudeClient
): Promise<GradeResult> {
  const { system, messages } = buildGradingMessages(lesson, answers);
  const model = process.env.GRADER_MODEL ?? "claude-opus-5";

  const response = await client.messages.parse({
    model,
    max_tokens: 4000,
    system,
    messages,
    output_config: { effort: "medium", format: zodOutputFormat(GradeSchema) },
  });

  if (!response.parsed_output) {
    throw new Error("The grader failed to produce a structured response.");
  }

  const { items, critique } = response.parsed_output;
  const total = scoreTotal(lesson, items);

  return { mode: "graded", items, total, critique };
}
