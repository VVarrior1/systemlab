import { z } from "zod";
import type { Lesson, RubricItem } from "./types";
import { generateJson, type GeminiClient } from "./gemini";
import { scoreTotal } from "./grading";
import type { TranscriptStats } from "./transcript-stats";

const MAX_TRANSCRIPT_ENTRIES = 12;
const MAX_TRANSCRIPT_TEXT = 3000;
const MAX_CONTEXT_STRING = 4000;
const MAX_TECH_CHOICES = 20;
const MAX_METRICS = 30;

export type InterviewRole = "interviewer" | "candidate";
export interface TranscriptEntry {
  role: InterviewRole;
  text: string;
}

/**
 * A candidate's one-line rationale for a node's technology choice, with an
 * optional expected number (v2.3 item 2, e.g. "cache: expect ~85% hits").
 * `TechChoice` is the pre-v2.3 shape (technology always given); mock-mode
 * sends the same data under `rationales` and technology may be omitted.
 */
export interface RationaleEntry {
  nodeId: string;
  label: string;
  kind: string;
  technology?: string;
  why: string;
  expected?: string;
}

export interface TechChoice extends RationaleEntry {
  technology: string;
}

/** A measured per-node number the client extracts from the last run, e.g. { nodeId: "cache1", value: "62% hit rate" }. */
export interface InterviewNodeMetric {
  nodeId: string;
  label?: string;
  value: string;
}

export interface InterviewContext {
  // Practice ("solo defense") mode fields.
  architecture?: string;
  result?: string;
  techChoices?: TechChoice[];
  estimation?: string;
  blankCanvas?: boolean;
  // Shared fields.
  dataModel?: string;
  metrics?: InterviewNodeMetric[];
  // Mock-interview mode fields (spec section 15 item 1).
  canvas?: string;
  lastRun?: string;
  rationales?: RationaleEntry[];
  stats?: TranscriptStats;
}

export type InterviewStage = "turn" | "grade";
export type InterviewMode = "practice" | "mock";

export const MOCK_PHASES = ["clarify", "estimate", "design", "deep-dive", "wrap"] as const;
export type MockPhase = (typeof MOCK_PHASES)[number];

/** Phase budgets in seconds: 5 / 5 / 20 / 10 / 5 minutes. */
export const PHASE_BUDGET_SECONDS: Record<MockPhase, number> = {
  clarify: 5 * 60,
  estimate: 5 * 60,
  design: 20 * 60,
  "deep-dive": 10 * 60,
  wrap: 5 * 60,
};

export interface InterviewRequest {
  lessonId: string;
  mode: InterviewMode;
  stage: InterviewStage;
  /** mock mode only */
  phase?: MockPhase;
  /** mock mode only, seconds */
  elapsedSeconds?: number;
  /** mock mode only, seconds */
  phaseElapsedSeconds?: number;
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

  let mode: InterviewMode = "practice";
  if (body.mode !== undefined) {
    if (body.mode !== "practice" && body.mode !== "mock") {
      throw new Error('mode must be "practice" or "mock".');
    }
    mode = body.mode;
  }

  const transcript = validateTranscript(body.transcript);
  const context = validateContext(body.context, mode);

  if (mode === "mock") {
    const phase = validateMockPhase(body.phase);
    const elapsedSeconds = validateNonNegativeNumber(body.elapsedSeconds, "elapsedSeconds");
    const phaseElapsedSeconds = validateNonNegativeNumber(body.phaseElapsedSeconds, "phaseElapsedSeconds");
    return { lessonId, mode, stage, phase, elapsedSeconds, phaseElapsedSeconds, transcript, context };
  }

  return { lessonId, mode, stage, transcript, context };
}

function validateMockPhase(value: unknown): MockPhase {
  if (typeof value !== "string" || !(MOCK_PHASES as readonly string[]).includes(value)) {
    throw new Error(`phase must be one of ${MOCK_PHASES.join(", ")}.`);
  }
  return value as MockPhase;
}

function validateNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return value;
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

function validateRationaleArray(input: unknown, field: string, technologyRequired: boolean): RationaleEntry[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) {
    throw new Error(`context.${field} must be an array.`);
  }
  if (input.length > MAX_TECH_CHOICES) {
    throw new Error(`context.${field} must contain at most ${MAX_TECH_CHOICES} entries.`);
  }
  return input.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`context.${field}[${index}] must be an object.`);
    }
    const { nodeId, label, kind, technology, why, expected } = entry as Record<string, unknown>;
    const requiredFields: Record<string, unknown> = { nodeId, label, kind, why };
    if (technologyRequired) requiredFields.technology = technology;
    for (const [name, value] of Object.entries(requiredFields)) {
      if (typeof value !== "string") {
        throw new Error(`context.${field}[${index}].${name} must be a string.`);
      }
      if (value.length > MAX_CONTEXT_STRING) {
        throw new Error(`context.${field}[${index}].${name} must be at most ${MAX_CONTEXT_STRING} characters.`);
      }
    }
    if (technology !== undefined && typeof technology !== "string") {
      throw new Error(`context.${field}[${index}].technology must be a string.`);
    }
    if (expected !== undefined && typeof expected !== "string") {
      throw new Error(`context.${field}[${index}].expected must be a string.`);
    }
    return {
      nodeId: nodeId as string,
      label: label as string,
      kind: kind as string,
      technology: technology as string | undefined,
      why: why as string,
      expected: expected as string | undefined,
    };
  });
}

function validateMetricsArray(input: unknown): InterviewNodeMetric[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) {
    throw new Error("context.metrics must be an array.");
  }
  if (input.length > MAX_METRICS) {
    throw new Error(`context.metrics must contain at most ${MAX_METRICS} entries.`);
  }
  return input.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`context.metrics[${index}] must be an object.`);
    }
    const { nodeId, label, value } = entry as Record<string, unknown>;
    if (typeof nodeId !== "string") throw new Error(`context.metrics[${index}].nodeId must be a string.`);
    if (label !== undefined && typeof label !== "string") throw new Error(`context.metrics[${index}].label must be a string.`);
    if (typeof value !== "string") throw new Error(`context.metrics[${index}].value must be a string.`);
    return { nodeId, label: label as string | undefined, value };
  });
}

function validateStats(input: unknown): TranscriptStats | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null) {
    throw new Error("context.stats must be an object.");
  }
  // The stats shape is produced by the trusted transcriptStats() helper on the
  // client; validate loosely (an object) and pass it through for the prompt.
  return input as TranscriptStats;
}

function validateContext(input: unknown, mode: InterviewMode): InterviewContext {
  if (typeof input !== "object" || input === null) {
    throw new Error("context (object) is required.");
  }
  const body = input as Record<string, unknown>;

  const architecture = validateContextString(body.architecture, "architecture", mode === "practice");
  const result = validateContextString(body.result, "result", mode === "practice");
  const canvas = validateContextString(body.canvas, "canvas", mode === "mock");
  const lastRun = validateContextString(body.lastRun, "lastRun", false);
  const dataModel = validateContextString(body.dataModel, "dataModel", false);
  const estimation = validateContextString(body.estimation, "estimation", false);

  let blankCanvas: boolean | undefined;
  if (body.blankCanvas !== undefined) {
    if (typeof body.blankCanvas !== "boolean") {
      throw new Error("context.blankCanvas must be a boolean.");
    }
    blankCanvas = body.blankCanvas;
  }

  const techChoices = validateRationaleArray(body.techChoices, "techChoices", true) as TechChoice[] | undefined;
  const rationales = validateRationaleArray(body.rationales, "rationales", false);
  const metrics = validateMetricsArray(body.metrics);
  const stats = validateStats(body.stats);

  return { architecture, result, canvas, lastRun, techChoices, rationales, dataModel, estimation, blankCanvas, metrics, stats };
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

function formatTechChoices(techChoices: RationaleEntry[] | undefined): string {
  if (!techChoices || techChoices.length === 0) return "(none picked yet)";
  return techChoices
    .map((tc) => {
      const expected = tc.expected ? ` [expects ${tc.expected}]` : "";
      return `- ${tc.label} (${tc.kind}, node ${tc.nodeId}): ${tc.technology ?? "(no technology named)"} — "${tc.why}"${expected}`;
    })
    .join("\n");
}

function formatMetrics(metrics: InterviewNodeMetric[] | undefined): string {
  if (!metrics || metrics.length === 0) return "(no measured metrics provided)";
  return metrics.map((m) => `- ${m.label ?? m.nodeId} (node ${m.nodeId}): ${m.value}`).join("\n");
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

export const DataModelItemIdSchema = z.union([
  z.literal("keys-unique"),
  z.literal("partition-key"),
  z.literal("query-patterns"),
  z.literal("growth"),
]);
export type DataModelItemId = z.infer<typeof DataModelItemIdSchema>;

export const DataModelItemSchema = z.object({
  id: DataModelItemIdSchema,
  score: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  note: z.string(),
});
export type DataModelItem = z.infer<typeof DataModelItemSchema>;

export const ContradictionSchema = z.object({
  nodeId: z.string(),
  claim: z.string(),
  measured: z.string(),
  note: z.string(),
});
export type Contradiction = z.infer<typeof ContradictionSchema>;

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
  contradictions: z.array(ContradictionSchema).default([]),
  dataModelItems: z.array(DataModelItemSchema).default([]),
});

export type InterviewGrade = z.infer<typeof InterviewGradeSchema>;

export interface InterviewGradeResult {
  mode: "graded";
  items: InterviewGrade["items"];
  recoveryScore: number;
  techScore: number;
  dataModelScore: number;
  critique: string;
  contradictions: Contradiction[];
  dataModelItems: DataModelItem[];
  weakConcepts: string[];
  total: number;
}

const DATA_MODEL_ITEMS_JSON_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      id: { type: "string", enum: ["keys-unique", "partition-key", "query-patterns", "growth"] },
      score: { type: "integer", enum: [0, 1, 2] },
      note: { type: "string" },
    },
    required: ["id", "score", "note"],
  },
};

const CONTRADICTIONS_JSON_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      nodeId: { type: "string" },
      claim: { type: "string" },
      measured: { type: "string" },
      note: { type: "string" },
    },
    required: ["nodeId", "claim", "measured", "note"],
  },
};

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
    contradictions: CONTRADICTIONS_JSON_SCHEMA,
    dataModelItems: DATA_MODEL_ITEMS_JSON_SCHEMA,
  },
  required: ["items", "recoveryScore", "techScore", "dataModelScore", "critique"],
};

const DATA_MODEL_RUBRIC = `- "keys-unique": keys are unique and stable across the entity's lifetime.
- "partition-key": the partition/shard key matches the hot access path (avoids hotspots for the described workload).
- "query-patterns": the modelled query patterns match the stated read/write ratio and access patterns.
- "growth": growth is bounded (TTL, archiving, capped fan-out) rather than unbounded.
Score each 0 (missing/wrong), 1 (partial), 2 (fully addressed). If no data model was given, score all four 0 with a note saying none was provided.`;

const CONTRADICTIONS_RUBRIC = `Compare each technology choice's stated "expected" number (if any) against the measured per-node metrics below. Return one entry per real, material contradiction: nodeId, claim (what the candidate expected, in their words), measured (what the run actually showed), and note (why it matters). Return an empty array if there are no expected numbers to check or nothing contradicts.`;

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
- dataModelItems: ${DATA_MODEL_RUBRIC}
- dataModelScore (0-2): overall quality of the data model, consistent with dataModelItems.
- contradictions: ${CONTRADICTIONS_RUBRIC}
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

Measured per-node metrics:
${formatMetrics(context.metrics)}

Full transcript:
${formatTranscript(transcript)}`;

  return { system, contents: [{ role: "user", text: userContent }] };
}

export interface PerformanceField {
  score: 0 | 1 | 2;
  note: string;
}

export interface PerformanceScores {
  clarifiedFirst: PerformanceField;
  statedNumbers: PerformanceField;
  signposted: PerformanceField;
  heldPosition: PerformanceField;
  managedTime: PerformanceField;
}

const PERFORMANCE_FIELD_JSON_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", enum: [0, 1, 2] },
    note: { type: "string" },
  },
  required: ["score", "note"],
};

const PERFORMANCE_JSON_SCHEMA = {
  type: "object",
  properties: {
    clarifiedFirst: PERFORMANCE_FIELD_JSON_SCHEMA,
    statedNumbers: PERFORMANCE_FIELD_JSON_SCHEMA,
    signposted: PERFORMANCE_FIELD_JSON_SCHEMA,
    heldPosition: PERFORMANCE_FIELD_JSON_SCHEMA,
    managedTime: PERFORMANCE_FIELD_JSON_SCHEMA,
  },
  required: ["clarifiedFirst", "statedNumbers", "signposted", "heldPosition", "managedTime"],
};

const PerformanceFieldSchema = z.object({
  score: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  note: z.string(),
});

export const PerformanceSchema = z.object({
  clarifiedFirst: PerformanceFieldSchema,
  statedNumbers: PerformanceFieldSchema,
  signposted: PerformanceFieldSchema,
  heldPosition: PerformanceFieldSchema,
  managedTime: PerformanceFieldSchema,
});

export const MockInterviewGradeSchema = InterviewGradeSchema.extend({
  performance: PerformanceSchema,
});
export type MockInterviewGrade = z.infer<typeof MockInterviewGradeSchema>;

export interface MockInterviewGradeResult extends InterviewGradeResult {
  performance: PerformanceScores;
}

const MOCK_GRADE_JSON_SCHEMA = {
  ...INTERVIEW_GRADE_JSON_SCHEMA,
  properties: {
    ...INTERVIEW_GRADE_JSON_SCHEMA.properties,
    performance: PERFORMANCE_JSON_SCHEMA,
  },
  required: [...INTERVIEW_GRADE_JSON_SCHEMA.required, "performance"],
};

function formatRationales(rationales: RationaleEntry[] | undefined, techChoices: TechChoice[] | undefined): string {
  return formatTechChoices(rationales ?? techChoices);
}

/**
 * Builds the system + contents sent to Gemini for grading a full mock
 * interview session, including the performance rubric.
 */
export function buildMockGradeMessages(
  lesson: Lesson,
  transcript: TranscriptEntry[],
  context: InterviewContext
): { system: string; contents: { role: "user" | "model"; text: string }[] } {
  const rubricLines = lesson.defense.rubric
    .map((item) => `- [${item.id}] (weight ${item.weight}): ${item.criterion}`)
    .join("\n");

  const system = `You are a staff-level system design interviewer grading a full 45-minute mock interview transcript.

Lesson: ${lesson.title}
Brief: ${lesson.brief}

Learning points:
${lesson.learning.map((point) => `- ${point}`).join("\n")}

Rubric (grade each item 0-2, weights sum to 100):
${rubricLines}

Score:
- items: one entry per rubric id (0 = missing or wrong, 1 = partially addressed, 2 = fully and correctly addressed), each with a one-line note.
- recoveryScore (0-2): did the candidate revise a position under push-back, with real reasons?
- techScore (0-2): were the technology choices justified against the actual workload?
- dataModelItems: ${DATA_MODEL_RUBRIC}
- dataModelScore (0-2): overall quality of the data model, consistent with dataModelItems.
- contradictions: ${CONTRADICTIONS_RUBRIC}
- performance: grade the candidate's interview conduct, each 0-2 with a one-line note:
  - clarifiedFirst: did they ask clarifying questions and state scope before proposing a design?
  - statedNumbers: did they state concrete numbers (traffic, latency, storage) rather than staying vague?
  - signposted: did they structure their answers (first/then/tradeoff/because) rather than rambling?
  - heldPosition: when pushed back on, did they hold their position with sound reasoning or revise it with sound reasoning (rather than simply caving or stonewalling)?
  - managedTime: did they pace themselves across phases rather than running out of time in design or deep-dive?
- critique: 3 to 5 sentences naming the strongest moment and the biggest remaining gap.

Be calibrated, not generous. Grade only what the candidate actually said; do not give credit for things they did not say.`;

  const userContent = `Canvas:
${context.canvas ?? "(none provided)"}

Last run:
${context.lastRun ?? "(no run yet)"}

Technology rationales:
${formatRationales(context.rationales, context.techChoices)}

Data model:
${context.dataModel ?? "(none provided)"}

Measured per-node metrics:
${formatMetrics(context.metrics)}

Transcript stats:
${context.stats ? JSON.stringify(context.stats) : "(none provided)"}

Full transcript:
${formatTranscript(transcript)}`;

  return { system, contents: [{ role: "user", text: userContent }] };
}

/**
 * Computes the blended 0-100 interview total.
 * Weights: content (rubric) 60%, recovery/tech/dataModel 10% each, and
 * performance 10% when supplied (its weight otherwise redistributed
 * proportionally across the other components). Each contradiction costs 5
 * points off the final total, floored at 0.
 */
export function computeInterviewTotal(
  lesson: Lesson,
  items: { id: string; score: 0 | 1 | 2 }[],
  recoveryScore: number,
  techScore: number,
  dataModelScore: number,
  opts: { performance?: PerformanceScores; contradictions?: number } = {}
): number {
  const rubricTotal = scoreTotal(lesson, items as { id: string; score: 0 | 1 | 2; note: string }[]);
  const scale = (score: number) => (score / 2) * 100;

  const weighted: { weight: number; value: number }[] = [
    { weight: 60, value: rubricTotal },
    { weight: 10, value: scale(recoveryScore) },
    { weight: 10, value: scale(techScore) },
    { weight: 10, value: scale(dataModelScore) },
  ];

  if (opts.performance) {
    const p = opts.performance;
    const sum = p.clarifiedFirst.score + p.statedNumbers.score + p.signposted.score + p.heldPosition.score + p.managedTime.score;
    weighted.push({ weight: 10, value: (sum / 10) * 100 });
  }

  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
  const weightedSum = weighted.reduce((sum, w) => sum + w.weight * w.value, 0);
  const base = weightedSum / totalWeight;
  const penalty = 5 * (opts.contradictions ?? 0);

  return Math.max(0, Math.round(base - penalty));
}

/** Thin wrapper over computeInterviewTotal for the mock-mode grade result, where performance is always present. */
export function computeMockTotal(
  lesson: Lesson,
  items: { id: string; score: 0 | 1 | 2 }[],
  recoveryScore: number,
  techScore: number,
  dataModelScore: number,
  performance: PerformanceScores,
  contradictionsCount: number
): number {
  return computeInterviewTotal(lesson, items, recoveryScore, techScore, dataModelScore, {
    performance,
    contradictions: contradictionsCount,
  });
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

  const total = computeInterviewTotal(lesson, grade.items, grade.recoveryScore, grade.techScore, grade.dataModelScore, {
    contradictions: grade.contradictions.length,
  });
  const weakConcepts = weakConceptsFrom(grade.items);

  return {
    mode: "graded",
    items: grade.items,
    recoveryScore: grade.recoveryScore,
    techScore: grade.techScore,
    dataModelScore: grade.dataModelScore,
    critique: grade.critique,
    contradictions: grade.contradictions,
    dataModelItems: grade.dataModelItems,
    weakConcepts,
    total,
  };
}

/**
 * Grades a full mock-interview session with Gemini, including the
 * performance rubric. `client` defaults to a real GoogleGenAI client but
 * accepts a fake for unit testing.
 */
export async function gradeMockInterviewWithGemini(
  lesson: Lesson,
  transcript: TranscriptEntry[],
  context: InterviewContext,
  client?: GeminiClient
): Promise<MockInterviewGradeResult> {
  const { system, contents } = buildMockGradeMessages(lesson, transcript, context);

  const grade = await generateJson<MockInterviewGrade>({
    client,
    system,
    contents,
    schema: MOCK_GRADE_JSON_SCHEMA,
    parse: (value) => MockInterviewGradeSchema.parse(value),
    maxOutputTokens: 4000,
  });

  const total = computeMockTotal(
    lesson,
    grade.items,
    grade.recoveryScore,
    grade.techScore,
    grade.dataModelScore,
    grade.performance,
    grade.contradictions.length
  );
  const weakConcepts = weakConceptsFrom(grade.items);

  return {
    mode: "graded",
    items: grade.items,
    recoveryScore: grade.recoveryScore,
    techScore: grade.techScore,
    dataModelScore: grade.dataModelScore,
    critique: grade.critique,
    contradictions: grade.contradictions,
    dataModelItems: grade.dataModelItems,
    performance: grade.performance,
    weakConcepts,
    total,
  };
}

// --- Mock interview turns (spec section 15 item 1) ---------------------------------------

export const MockIntentSchema = z.union([
  z.literal("open"),
  z.literal("listen"),
  z.literal("probe"),
  z.literal("pushback"),
  z.literal("escalate"),
  z.literal("interrupt"),
  z.literal("phase-change"),
  z.literal("close"),
]);
export type MockIntent = z.infer<typeof MockIntentSchema>;

export const MockTurnModelSchema = z.object({
  utterance: z.string(),
  intent: MockIntentSchema,
});
export type MockTurnModel = z.infer<typeof MockTurnModelSchema>;

export interface MockTurnResult {
  utterance: string;
  intent: MockIntent;
  interrupt: boolean;
  done: boolean;
}

const MOCK_TURN_JSON_SCHEMA = {
  type: "object",
  properties: {
    utterance: { type: "string" },
    intent: {
      type: "string",
      enum: ["open", "listen", "probe", "pushback", "escalate", "interrupt", "phase-change", "close"],
    },
  },
  required: ["utterance", "intent"],
};

export type InterruptReason = "phase-budget" | "long-monologue" | "contradiction";

export interface InterruptDecision {
  interrupt: boolean;
  reason?: InterruptReason;
  forcedIntent?: MockIntent;
  contradiction?: Contradiction;
}

function extractNumber(text: string): number | undefined {
  const match = text.match(/-?\d+(\.\d+)?/);
  return match ? parseFloat(match[0]) : undefined;
}

/**
 * Pure numeric comparison between each rationale's expected number and the
 * measured metric for the same node. Used both to decide whether a "turn"
 * call must interrupt (no LLM round trip needed for that decision) and as a
 * seed the grader is shown at "grade" time.
 */
export function detectContradictions(
  rationales: RationaleEntry[] | undefined,
  metrics: InterviewNodeMetric[] | undefined
): Contradiction[] {
  if (!rationales || rationales.length === 0 || !metrics || metrics.length === 0) return [];
  const byNode = new Map(metrics.map((m) => [m.nodeId, m]));
  const out: Contradiction[] = [];
  for (const rationale of rationales) {
    if (!rationale.expected) continue;
    const metric = byNode.get(rationale.nodeId);
    if (!metric) continue;
    const expectedNum = extractNumber(rationale.expected);
    const measuredNum = extractNumber(metric.value);
    if (expectedNum === undefined || measuredNum === undefined) continue;
    const denom = Math.max(Math.abs(expectedNum), 1);
    const relativeDiff = Math.abs(expectedNum - measuredNum) / denom;
    if (relativeDiff > 0.25) {
      out.push({
        nodeId: rationale.nodeId,
        claim: `${rationale.label}: ${rationale.expected}`,
        measured: metric.value,
        note: `Expected ${rationale.expected} for ${rationale.label}, but the run measured ${metric.value}.`,
      });
    }
  }
  return out;
}

function contradictionAlreadyRaised(contradiction: Contradiction, transcript: TranscriptEntry[]): boolean {
  return transcript.some(
    (entry) => entry.role === "interviewer" && entry.text.toLowerCase().includes(contradiction.nodeId.toLowerCase())
  );
}

function lastCandidateTurn(transcript: TranscriptEntry[]): TranscriptEntry | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i]!.role === "candidate") return transcript[i];
  }
  return undefined;
}

/**
 * Server-side interrupt rules (the model is told the decision, never trusted
 * to make it): the phase clock running out beats a long undisciplined
 * monologue, which beats an unraised contradiction between a claim and the
 * measured run.
 */
export function decideInterrupt(
  phase: MockPhase,
  phaseElapsedSeconds: number,
  transcript: TranscriptEntry[],
  contradictions: Contradiction[]
): InterruptDecision {
  if (phaseElapsedSeconds > PHASE_BUDGET_SECONDS[phase]) {
    return { interrupt: true, reason: "phase-budget", forcedIntent: "phase-change" };
  }

  const last = lastCandidateTurn(transcript);
  if (last) {
    const wordCount = last.text.trim().length === 0 ? 0 : last.text.trim().split(/\s+/).length;
    if (wordCount > 180 && !/\d/.test(last.text)) {
      return { interrupt: true, reason: "long-monologue", forcedIntent: "interrupt" };
    }
  }

  const unraised = contradictions.find((c) => !contradictionAlreadyRaised(c, transcript));
  if (unraised) {
    return { interrupt: true, reason: "contradiction", forcedIntent: "pushback", contradiction: unraised };
  }

  return { interrupt: false };
}

function forcedInstruction(decision: InterruptDecision, phase: MockPhase, isOpening: boolean): string {
  if (isOpening) {
    return 'This is the opening of the interview. Return intent "open": greet the candidate briefly and hand them the brief.';
  }
  if (decision.interrupt && decision.reason === "phase-budget") {
    return `Time is up for the "${phase}" phase. You MUST interrupt now: use intent "phase-change" — acknowledge the time and move the interview into the next phase.`;
  }
  if (decision.interrupt && decision.reason === "long-monologue") {
    return 'The candidate has been talking at length with no concrete number or decision. You MUST interrupt now: use intent "interrupt" — cut in politely and demand a specific number or decision.';
  }
  if (decision.interrupt && decision.reason === "contradiction" && decision.contradiction) {
    return `The candidate has not yet addressed this contradiction between what they claimed and the measured run: node "${decision.contradiction.nodeId}" — claimed "${decision.contradiction.claim}", but the run measured "${decision.contradiction.measured}". You MUST interrupt now: use intent "pushback" and raise exactly this contradiction by name.`;
  }
  return 'Choose the single best next move: "listen" (a one-line acknowledgement so the candidate keeps going), "probe" (a clarifying or deepening question), "pushback" (challenge a specific claim in their own words), or "escalate" (introduce a concrete twist). If the phase and topic are naturally concluding and this is the wrap phase, you may use "close" to end the interview.';
}

/**
 * Builds the system + contents sent to Gemini to produce the next
 * mock-interview turn.
 */
export function buildMockTurnMessages(
  lesson: Lesson,
  phase: MockPhase,
  elapsedSeconds: number,
  phaseElapsedSeconds: number,
  transcript: TranscriptEntry[],
  context: InterviewContext,
  decision: InterruptDecision
): { system: string; contents: { role: "user" | "model"; text: string }[] } {
  const isOpening = transcript.length === 0;
  const instruction = forcedInstruction(decision, phase, isOpening);
  const budgetMin = PHASE_BUDGET_SECONDS[phase] / 60;

  const system = `You are a senior staff engineer running a live 45-minute system design mock interview for this lesson. Be concise — at most two sentences per turn. Never answer for the candidate; only ask, listen, or push back.

Lesson: ${lesson.title}
Brief: ${lesson.brief}

Phases and budgets: clarify 5m, estimate 5m, design 20m, deep-dive 10m, wrap 5m.
Current phase: ${phase} (budget ${budgetMin}m). Elapsed in this phase: ${Math.round(phaseElapsedSeconds / 60)}m. Total elapsed: ${Math.round(elapsedSeconds / 60)}m.

${instruction}

Return only the JSON: "utterance" (what you say next) and "intent" (one of open, listen, probe, pushback, escalate, interrupt, phase-change, close).`;

  const userContent = `Canvas:
${context.canvas ?? "(blank canvas)"}

Last run:
${context.lastRun ?? "(no run yet)"}

Technology rationales:
${formatRationales(context.rationales, context.techChoices)}

Data model:
${context.dataModel ?? "(none provided)"}

Transcript so far:
${formatTranscript(transcript)}`;

  return { system, contents: [{ role: "user", text: userContent }] };
}

/**
 * Generates the next mock-interview turn. Interrupt is always decided
 * server-side by `decideInterrupt`; the model is only told the decision (and
 * forced intent when one applies), never trusted to invent it.
 */
export async function generateMockTurn(
  lesson: Lesson,
  phase: MockPhase,
  elapsedSeconds: number,
  phaseElapsedSeconds: number,
  transcript: TranscriptEntry[],
  context: InterviewContext,
  client?: GeminiClient
): Promise<MockTurnResult> {
  const contradictions = detectContradictions(context.rationales ?? context.techChoices, context.metrics);
  const decision = decideInterrupt(phase, phaseElapsedSeconds, transcript, contradictions);
  const { system, contents } = buildMockTurnMessages(lesson, phase, elapsedSeconds, phaseElapsedSeconds, transcript, context, decision);

  const turn = await generateJson<MockTurnModel>({
    client,
    system,
    contents,
    schema: MOCK_TURN_JSON_SCHEMA,
    parse: (value) => MockTurnModelSchema.parse(value),
    maxOutputTokens: 400,
  });

  const intent = decision.forcedIntent ?? (transcript.length === 0 ? "open" : turn.intent);
  const done = intent === "close";

  return { utterance: turn.utterance, intent, interrupt: decision.interrupt, done };
}

// --- Self mode (no Gemini key): scripted mock session -------------------------------------

export interface MockScriptEntry {
  phase: MockPhase;
  utterance: string;
}

/**
 * A fixed, per-lesson scripted mock session used when no Gemini key is
 * configured, so the UI can still run a timed session end to end: an opener,
 * one clarify prompt, one estimate prompt, two design probes drawn from
 * lesson.defense.followUps, a deep-dive escalation, and a close.
 */
export function buildMockScript(lesson: Lesson): MockScriptEntry[] {
  const followUps = lesson.defense.followUps ?? [];
  const fallbackProbes = ["What's the biggest risk in this design, and where would it show up first?", "What did you choose not to build, and why?"];
  const probes = [followUps[0] ?? fallbackProbes[0]!, followUps[1] ?? fallbackProbes[1]!];

  return [
    { phase: "clarify", utterance: `Let's start: walk me through how you're reading "${lesson.title}" — what's in scope, and what are you deliberately leaving out?` },
    { phase: "clarify", utterance: "Before you design anything: what numbers do you need from me — traffic, read/write ratio, data size, latency target?" },
    { phase: "estimate", utterance: "Give me your back-of-envelope numbers: requests per second, storage growth per day, and where you expect the bottleneck." },
    { phase: "design", utterance: probes[0] },
    { phase: "design", utterance: probes[1] },
    { phase: "deep-dive", utterance: "Say this system just hit 10x its expected traffic overnight — what breaks first, and how would you know before it pages you?" },
    { phase: "wrap", utterance: "We're out of time. In one sentence: what's the single change you'd make first if you kept working on this?" },
  ];
}

export type { RubricItem };
