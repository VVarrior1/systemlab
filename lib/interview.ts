import { z } from "zod";
import type { Lesson, RubricItem } from "./types";
import { generateJson, type GeminiClient } from "./gemini";
import { scoreTotal } from "./grading";

const MAX_TRANSCRIPT_ENTRIES = 12;
const MAX_TRANSCRIPT_TEXT = 3000;
const MAX_CONTEXT_STRING = 4000;
const MAX_TECH_CHOICES = 20;

export type InterviewRole = "interviewer" | "candidate";
export interface TranscriptEntry {
  role: InterviewRole;
  text: string;
}

export interface TechChoice {
  nodeId: string;
  label: string;
  kind: string;
  technology: string;
  why: string;
}

export interface InterviewContext {
  architecture: string;
  result: string;
  techChoices?: TechChoice[];
  dataModel?: string;
  estimation?: string;
  blankCanvas?: boolean;
}

export type InterviewStage = "turn" | "grade";

export interface InterviewRequest {
  lessonId: string;
  stage: InterviewStage;
  transcript: TranscriptEntry[];
  context: InterviewContext;
}

/**
 * Validates the raw request body into a well-typed InterviewRequest. Throws
 * a friendly Error (suitable for a 400 response) on invalid input.
 */
export function validateInterviewRequest(input: unknown): InterviewRequest {
  if (typeof input !== "object" || input === null) {
    throw new Error("Request body must be an object.");
  }
  const body = input as Record<string, unknown>;

  const { lessonId } = body;
  if (typeof lessonId !== "string" || lessonId.length === 0) {
    throw new Error("lessonId (string) is required.");
  }

  const stage = body.stage;
  if (stage !== "turn" && stage !== "grade") {
    throw new Error('stage must be "turn" or "grade".');
  }

  const transcript = validateTranscript(body.transcript);
  const context = validateContext(body.context);

  return { lessonId, stage, transcript, context };
}

function validateTranscript(input: unknown): TranscriptEntry[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new Error("transcript must be an array.");
  }
  if (input.length > MAX_TRANSCRIPT_ENTRIES) {
    throw new Error(`transcript must contain at most ${MAX_TRANSCRIPT_ENTRIES} entries.`);
  }
  return input.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`transcript[${index}] must be an object.`);
    }
    const { role, text } = entry as Record<string, unknown>;
    if (role !== "interviewer" && role !== "candidate") {
      throw new Error(`transcript[${index}].role must be "interviewer" or "candidate".`);
    }
    if (typeof text !== "string") {
      throw new Error(`transcript[${index}].text must be a string.`);
    }
    if (text.length > MAX_TRANSCRIPT_TEXT) {
      throw new Error(`transcript[${index}].text must be at most ${MAX_TRANSCRIPT_TEXT} characters.`);
    }
    return { role, text };
  });
}

function validateContextString(value: unknown, field: string, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) throw new Error(`context.${field} (string) is required.`);
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`context.${field} must be a string.`);
  }
  if (value.length > MAX_CONTEXT_STRING) {
    throw new Error(`context.${field} must be at most ${MAX_CONTEXT_STRING} characters.`);
  }
  return value;
}

function validateContext(input: unknown): InterviewContext {
  if (typeof input !== "object" || input === null) {
    throw new Error("context (object) is required.");
  }
  const body = input as Record<string, unknown>;

  const architecture = validateContextString(body.architecture, "architecture", true)!;
  const result = validateContextString(body.result, "result", true)!;
  const dataModel = validateContextString(body.dataModel, "dataModel", false);
  const estimation = validateContextString(body.estimation, "estimation", false);

  let blankCanvas: boolean | undefined;
  if (body.blankCanvas !== undefined) {
    if (typeof body.blankCanvas !== "boolean") {
      throw new Error("context.blankCanvas must be a boolean.");
    }
    blankCanvas = body.blankCanvas;
  }

  let techChoices: TechChoice[] | undefined;
  if (body.techChoices !== undefined) {
    if (!Array.isArray(body.techChoices)) {
      throw new Error("context.techChoices must be an array.");
    }
    if (body.techChoices.length > MAX_TECH_CHOICES) {
      throw new Error(`context.techChoices must contain at most ${MAX_TECH_CHOICES} entries.`);
    }
    techChoices = body.techChoices.map((entry, index) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`context.techChoices[${index}] must be an object.`);
      }
      const { nodeId, label, kind, technology, why } = entry as Record<string, unknown>;
      for (const [field, value] of Object.entries({ nodeId, label, kind, technology, why })) {
        if (typeof value !== "string") {
          throw new Error(`context.techChoices[${index}].${field} must be a string.`);
        }
        if (value.length > MAX_CONTEXT_STRING) {
          throw new Error(`context.techChoices[${index}].${field} must be at most ${MAX_CONTEXT_STRING} characters.`);
        }
      }
      return {
        nodeId: nodeId as string,
        label: label as string,
        kind: kind as string,
        technology: technology as string,
        why: why as string,
      };
    });
  }

  return { architecture, result, techChoices, dataModel, estimation, blankCanvas };
}

/** Number of interviewer turns already asked in the transcript. */
function interviewerTurnCount(transcript: TranscriptEntry[]): number {
  return transcript.filter((entry) => entry.role === "interviewer").length;
}

/** The round the next turn call is generating a question for (1-indexed). */
export function nextRound(transcript: TranscriptEntry[]): number {
  return interviewerTurnCount(transcript) + 1;
}

export const MAX_ROUNDS = 5;

export const TurnIntentSchema = z.union([
  z.literal("probe"),
  z.literal("pushback"),
  z.literal("escalate"),
  z.literal("clarify"),
]);

export const TurnModelSchema = z.object({
  question: z.string(),
  intent: TurnIntentSchema,
});

export type TurnIntent = z.infer<typeof TurnIntentSchema>;
export type TurnModel = z.infer<typeof TurnModelSchema>;

export interface TurnResult {
  question: string;
  intent: TurnIntent;
  round: number;
  done: boolean;
}

const TURN_JSON_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string" },
    intent: { type: "string", enum: ["probe", "pushback", "escalate", "clarify"] },
  },
  required: ["question", "intent"],
};

function formatTechChoices(techChoices: TechChoice[] | undefined): string {
  if (!techChoices || techChoices.length === 0) return "(none picked yet)";
  return techChoices
    .map((tc) => `- ${tc.label} (${tc.kind}, node ${tc.nodeId}): ${tc.technology} — "${tc.why}"`)
    .join("\n");
}

function formatTranscript(transcript: TranscriptEntry[]): string {
  if (transcript.length === 0) return "(no turns yet — this is the opening question)";
  return transcript.map((entry) => `${entry.role === "interviewer" ? "Interviewer" : "Candidate"}: ${entry.text}`).join("\n");
}

/**
 * Builds the system + contents sent to Gemini to produce the next
 * interviewer turn.
 */
export function buildTurnMessages(
  lesson: Lesson,
  transcript: TranscriptEntry[],
  context: InterviewContext
): { system: string; contents: { role: "user" | "model"; text: string }[] } {
  const round = nextRound(transcript);
  const rubricLines = lesson.defense.rubric.map((item) => `- [${item.id}] ${item.criterion}`).join("\n");
  const techThin =
    (context.techChoices ?? []).length === 0 || (context.techChoices ?? []).some((tc) => tc.why.trim().split(/\s+/).length < 8);
  const dataModelThin = !context.dataModel || context.dataModel.trim().length < 40;

  const system = `You are a staff-level system design interviewer conducting a live design review of this lesson. The learning points and rubric below are your hidden intent — never read them aloud or reference them explicitly.

Lesson: ${lesson.title}
Brief: ${lesson.brief}

Learning points:
${lesson.learning.map((point) => `- ${point}`).join("\n")}

Rubric (hidden intent, never quote directly):
${rubricLines}

Rules for this turn:
- Ask exactly one question, at most two sentences, in a direct spoken-interview tone.
- Never answer your own question or hint at the answer.
- This is round ${round} of ${MAX_ROUNDS}.
- In round 1, probe the weakest or vaguest claim in the candidate's opening statement.
- At least one turn across the whole interview must be a genuine push-back that challenges a specific number or choice in the candidate's own words (e.g. "you said 200ms p95 — why not 500ms?").
- By round 3, escalate the scenario with a concrete twist tied to this lesson (10x traffic, a cold cache, leader failover, or an entire region going down) and ask how the design holds up.
- If the technology choices or data model are present but thin (a technology named with little or no justification, or a data model with no entities/keys/query patterns), ask a concrete question about the specific technology or data model instead of a generic one.
- Technology choices thin: ${techThin}. Data model thin: ${dataModelThin}.

Return only the JSON described by the schema: "question" (the single question to ask next) and "intent" (one of "probe", "pushback", "escalate", "clarify" — describing what this question is doing).`;

  const userContent = `Architecture summary:
${context.architecture}

Latest result summary:
${context.result}

Technology choices:
${formatTechChoices(context.techChoices)}

Data model:
${context.dataModel ?? "(none provided)"}

Estimation:
${context.estimation ?? "(none provided)"}

Blank canvas run: ${context.blankCanvas ? "yes" : "no"}

Transcript so far:
${formatTranscript(transcript)}

Generate the interviewer's next question (round ${round}).`;

  return { system, contents: [{ role: "user", text: userContent }] };
}

/**
 * Generates the next interviewer turn with Gemini. `client` defaults to a
 * real GoogleGenAI client (reads GEMINI_API_KEY from the environment) but
 * accepts a fake for unit testing.
 */
export async function generateTurn(
  lesson: Lesson,
  transcript: TranscriptEntry[],
  context: InterviewContext,
  client?: GeminiClient
): Promise<TurnResult> {
  const round = nextRound(transcript);
  const { system, contents } = buildTurnMessages(lesson, transcript, context);

  const turn = await generateJson<TurnModel>({
    client,
    system,
    contents,
    schema: TURN_JSON_SCHEMA,
    parse: (value) => TurnModelSchema.parse(value),
    maxOutputTokens: 500,
  });

  return { question: turn.question, intent: turn.intent, round, done: round >= MAX_ROUNDS };
}

export const InterviewGradeSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      score: z.union([z.literal(0), z.literal(1), z.literal(2)]),
      note: z.string(),
    })
  ),
  recoveryScore: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  techScore: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  dataModelScore: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  critique: z.string(),
});

export type InterviewGrade = z.infer<typeof InterviewGradeSchema>;

export interface InterviewGradeResult {
  mode: "graded";
  items: InterviewGrade["items"];
  recoveryScore: number;
  techScore: number;
  dataModelScore: number;
  critique: string;
  weakConcepts: string[];
  total: number;
}

const INTERVIEW_GRADE_JSON_SCHEMA = {
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
    recoveryScore: { type: "integer", enum: [0, 1, 2] },
    techScore: { type: "integer", enum: [0, 1, 2] },
    dataModelScore: { type: "integer", enum: [0, 1, 2] },
    critique: { type: "string" },
  },
  required: ["items", "recoveryScore", "techScore", "dataModelScore", "critique"],
};

/**
 * Builds the system + contents sent to Gemini for grading the full
 * interview transcript.
 */
export function buildInterviewGradeMessages(
  lesson: Lesson,
  transcript: TranscriptEntry[],
  context: InterviewContext
): { system: string; contents: { role: "user" | "model"; text: string }[] } {
  const rubricLines = lesson.defense.rubric
    .map((item) => `- [${item.id}] (weight ${item.weight}): ${item.criterion}`)
    .join("\n");

  const system = `You are a staff-level system design interviewer grading the full live interview transcript below.

Lesson: ${lesson.title}
Brief: ${lesson.brief}

Learning points:
${lesson.learning.map((point) => `- ${point}`).join("\n")}

Rubric (grade each item 0-2, weights sum to 100):
${rubricLines}

Score:
- items: one entry per rubric id (0 = missing or wrong, 1 = partially addressed, 2 = fully and correctly addressed), each with a one-line note.
- recoveryScore (0-2): did the candidate revise a position under push-back, and did they give real reasons when they did (0 = never budged or caved with no reasoning, 1 = partial, 2 = clearly revised with sound reasoning).
- techScore (0-2): were the technology choices justified against the actual workload (0 if no technology choices were made or given, 1 = named but weakly justified, 2 = well justified against read/write/consistency/scale traits).
- dataModelScore (0-2): quality of the data model (entities, keys, query patterns, growth) if provided (0 if absent).
- critique: 3 to 5 sentences naming the strongest moment in the interview and the biggest remaining gap.

Be calibrated, not generous. Grade only what the candidate actually said; do not give credit for things they did not say.`;

  const userContent = `Architecture summary:
${context.architecture}

Latest result summary:
${context.result}

Technology choices:
${formatTechChoices(context.techChoices)}

Data model:
${context.dataModel ?? "(none provided)"}

Estimation:
${context.estimation ?? "(none provided)"}

Full transcript:
${formatTranscript(transcript)}`;

  return { system, contents: [{ role: "user", text: userContent }] };
}

/**
 * Computes the blended 0-100 interview total: 70% rubric total, 10% each for
 * recovery, tech, and data-model scores (each scaled from 0-2 to 0-100).
 */
export function computeInterviewTotal(
  lesson: Lesson,
  items: { id: string; score: 0 | 1 | 2 }[],
  recoveryScore: number,
  techScore: number,
  dataModelScore: number
): number {
  const rubricTotal = scoreTotal(lesson, items as { id: string; score: 0 | 1 | 2; note: string }[]);
  const scale = (score: number) => (score / 2) * 100;
  const total = rubricTotal * 0.7 + scale(recoveryScore) * 0.1 + scale(techScore) * 0.1 + scale(dataModelScore) * 0.1;
  return Math.round(total);
}

function weakConceptsFrom(items: { id: string; score: 0 | 1 | 2 }[]): string[] {
  return items.filter((item) => item.score === 0).map((item) => item.id);
}

/**
 * Grades the full interview transcript with Gemini. `client` defaults to a
 * real GoogleGenAI client (reads GEMINI_API_KEY from the environment) but
 * accepts a fake for unit testing.
 */
export async function gradeInterviewWithGemini(
  lesson: Lesson,
  transcript: TranscriptEntry[],
  context: InterviewContext,
  client?: GeminiClient
): Promise<InterviewGradeResult> {
  const { system, contents } = buildInterviewGradeMessages(lesson, transcript, context);

  const grade = await generateJson<InterviewGrade>({
    client,
    system,
    contents,
    schema: INTERVIEW_GRADE_JSON_SCHEMA,
    parse: (value) => InterviewGradeSchema.parse(value),
    maxOutputTokens: 4000,
  });

  const total = computeInterviewTotal(lesson, grade.items, grade.recoveryScore, grade.techScore, grade.dataModelScore);
  const weakConcepts = weakConceptsFrom(grade.items);

  return {
    mode: "graded",
    items: grade.items,
    recoveryScore: grade.recoveryScore,
    techScore: grade.techScore,
    dataModelScore: grade.dataModelScore,
    critique: grade.critique,
    weakConcepts,
    total,
  };
}

export type { RubricItem };
