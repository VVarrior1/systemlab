/**
 * The client side of the POST /api/interview (practice mode) and POST /api/grade contracts.
 *
 * The lesson screen keeps rich, structured per-node measurements (it renders them next to the
 * learner's claims in self mode), but the route validates a flatter wire shape: each metric is
 * { nodeId, label, value } with `value` a string. These builders are the one place that maps the
 * one onto the other, so the shape the client sends is pinned by lib/interview-payload.test.ts
 * against the real validators. Type-only imports keep every server module out of the client bundle.
 */
import type { InterviewNodeMetric } from "./interview";

/** Mirrors the server's caps in lib/interview.ts (MAX_METRICS, MAX_CONTEXT_STRING). */
export const MAX_WIRE_METRICS = 30;
export const MAX_WIRE_CONTEXT_STRING = 4000;

export interface TechRationale { nodeId: string; label: string; kind: string; technology: string; why: string; expected: string }

/** v2.3: the last check's per-node measurements, handed to the interviewer alongside the rationales
 *  so it can call out contradictions; also shown next to the learner's claims in self mode. */
export interface NodeMetricSummary {
  nodeId: string;
  label: string;
  kind: string;
  utilization: number;
  processedPerSec: number;
  errors: number;
  hitRate?: number;
  shardSpread?: number[];
}

/** The canvas-and-run snapshot the playground hands to the interviewer. */
export interface InterviewContext {
  architecture: string;
  result: string;
  rationales?: TechRationale[];
  dataModel?: string;
  estimation?: string;
  blankCanvas?: boolean;
  metrics?: NodeMetricSummary[];
}

/** The context exactly as POST /api/interview validates it. */
export interface WireInterviewContext extends Omit<InterviewContext, "metrics"> {
  metrics?: InterviewNodeMetric[];
}

export interface WireTurn { role: "interviewer" | "candidate"; text: string }
export interface FollowUpAnswer { question: string; answer: string }

/**
 * One node's measurements as the wire string. The comparable number comes first because the
 * server's contradiction check compares the first number in the learner's "expected" claim with
 * the first number in this value: hit rate for caches and CDNs, throughput for everything else.
 */
export function wireMetric(metric: NodeMetricSummary): InterviewNodeMetric {
  const utilization = `${Math.round(metric.utilization * 100)}% utilized`;
  const parts = metric.hitRate !== undefined
    ? [`${Math.round(metric.hitRate * 100)}% hit rate`, `${metric.processedPerSec} ops/s`, utilization]
    : [`${metric.processedPerSec} ops/s served`, utilization, `${metric.errors} errors`];
  if (metric.hitRate !== undefined && metric.errors > 0) parts.push(`${metric.errors} errors`);
  if (metric.shardSpread && metric.shardSpread.length > 0) parts.push(`shards ${metric.shardSpread.map((share) => `${Math.round(share * 100)}%`).join("/")}`);
  return { nodeId: metric.nodeId, label: metric.label, value: parts.join(", ") };
}

function clip(value: string): string {
  return value.length > MAX_WIRE_CONTEXT_STRING ? value.slice(0, MAX_WIRE_CONTEXT_STRING) : value;
}

export function wireContext(context: InterviewContext): WireInterviewContext {
  const { metrics, ...rest } = context;
  return {
    ...rest,
    architecture: clip(rest.architecture),
    result: clip(rest.result),
    ...(rest.dataModel !== undefined ? { dataModel: clip(rest.dataModel) } : {}),
    ...(rest.estimation !== undefined ? { estimation: clip(rest.estimation) } : {}),
    ...(metrics ? { metrics: metrics.slice(0, MAX_WIRE_METRICS).map(wireMetric) } : {}),
  };
}

/** Body for POST /api/interview in practice mode (the lesson's solo defense). */
export function practiceInterviewBody(lessonId: string, stage: "turn" | "grade", transcript: WireTurn[], context: InterviewContext) {
  return {
    lessonId,
    stage,
    transcript: transcript.map((turn) => ({ role: turn.role, text: turn.text })),
    context: wireContext(context),
  };
}

/** Body for POST /api/grade, stage "followups": the route reads `design` at the top level. */
export function followUpsBody(lessonId: string, design: string) {
  return { lessonId, stage: "followups" as const, design };
}

/** Body for POST /api/grade, stage "grade": the route validates `answers` ({ design, followUps }). */
export function gradeBody(lessonId: string, design: string, followUps: FollowUpAnswer[]) {
  return { lessonId, stage: "grade" as const, answers: { design, followUps } };
}
