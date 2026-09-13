import type { Architecture, SystemNode } from "./types";

/**
 * v2.3 §15.1 — the pure state machine behind the voice mock interview (/mock).
 *
 * Everything here is a pure function over a plain `MockSession` value: the React component owns
 * the timer and the microphone, this module owns the phases, the clocks, the transcript and the
 * canvas snapshot the interviewer reads. That split is what makes the session testable without a
 * browser.
 */

// ---------------------------------------------------------------- phases

export type MockPhase = "clarify" | "estimate" | "design" | "deep-dive" | "wrap";

export const MOCK_PHASES: readonly MockPhase[] = ["clarify", "estimate", "design", "deep-dive", "wrap"];

/** Minutes per phase in a full 45-minute loop. Shorter sessions scale these proportionally. */
export const BASE_PHASE_MINUTES: Record<MockPhase, number> = {
  clarify: 5,
  estimate: 5,
  design: 20,
  "deep-dive": 10,
  wrap: 5,
};

/** The reference session length the budgets above are written for. */
export const FULL_SESSION_MINUTES = 45;

/** Session lengths the UI offers. */
export const SESSION_MINUTES = [45, 30] as const;
export type SessionMinutes = (typeof SESSION_MINUTES)[number];

export const PHASE_LABELS: Record<MockPhase, string> = {
  clarify: "Clarify",
  estimate: "Estimate",
  design: "Design",
  "deep-dive": "Deep dive",
  wrap: "Wrap-up",
};

/** One line telling the candidate what this phase is for; shown under the phase clock. */
export const PHASE_GOALS: Record<MockPhase, string> = {
  clarify: "Ask about scale, users, read/write mix and what must not break. Do not design yet.",
  estimate: "Say the numbers out loud: request rate, storage, bandwidth, the size of the hot set.",
  design: "Build the architecture on the canvas and narrate the decisions as you make them.",
  "deep-dive": "Defend one component in depth: failure, scale, consistency, cost.",
  wrap: "Name the bottleneck you would fix first and what you would monitor.",
};

/** One slot of the phase plan: how long the phase runs and where it sits on the session clock. */
export interface PhaseSlot {
  phase: MockPhase;
  seconds: number;
  /** Session seconds at which this phase starts. */
  startSeconds: number;
  /** Session seconds at which this phase ends (exclusive). */
  endSeconds: number;
}

/** Total wall clock of a session, in seconds. */
export function sessionSeconds(totalMinutes: number): number {
  return Math.max(1, Math.round(totalMinutes)) * 60;
}

/**
 * The phase budgets scaled to `totalMinutes`. Rounding is done on the cumulative boundaries so
 * the slots always tile the session exactly: a 30-minute session is 200 / 200 / 800 / 400 / 200 s,
 * never 199 or 801, and the last phase never has to absorb the drift.
 */
export function phasePlan(totalMinutes: number = FULL_SESSION_MINUTES): PhaseSlot[] {
  const total = sessionSeconds(totalMinutes);
  const baseTotal = MOCK_PHASES.reduce((sum, phase) => sum + BASE_PHASE_MINUTES[phase], 0) * 60;
  const slots: PhaseSlot[] = [];
  let cumulativeBase = 0;
  let startSeconds = 0;
  for (const phase of MOCK_PHASES) {
    cumulativeBase += BASE_PHASE_MINUTES[phase] * 60;
    const endSeconds = Math.round((cumulativeBase / baseTotal) * total);
    slots.push({ phase, seconds: endSeconds - startSeconds, startSeconds, endSeconds });
    startSeconds = endSeconds;
  }
  return slots;
}

/** The phase the session clock is inside at `elapsedSeconds`. Past the end, the last phase. */
export function phaseAt(plan: PhaseSlot[], elapsedSeconds: number): MockPhase {
  for (const slot of plan) if (elapsedSeconds < slot.endSeconds) return slot.phase;
  return plan[plan.length - 1]!.phase;
}

// ---------------------------------------------------------------- transcript

export type MockRole = "interviewer" | "candidate";

export interface MockTranscriptEntry {
  role: MockRole;
  text: string;
  /** The phase the session was in when the line was said. */
  phase: MockPhase;
  /** Session seconds at which the line was recorded. */
  at: number;
  /** Interviewer lines only: what the turn was doing. */
  intent?: string;
  /** Interviewer lines only: this line cut the candidate off. */
  interrupt?: boolean;
}

const NUMBER_PATTERN = /\d/;
/**
 * Words that mark a decision rather than narration. Matched on word boundaries: "so it is kind of
 * like a thing" is drift, "so I'll shard on user id" is not.
 */
const DECISION_PATTERN = /\b(?:because|i['\u2019]?ll|i will|we['\u2019]?ll|we will|let['\u2019]?s|instead|therefore|trade-?off|trade-?offs|choose|chose|choosing|pick|picked|decide|decided|prefer|rather than|shard|sharded|sharding|cache|cached|caching|replicate|replication|partition|partitioned|denormali[sz]e|index|indexed)\b/;

/**
 * Did this utterance carry a number or a decision? 90 seconds of candidate speech with neither is
 * the interviewer's cue to interrupt (§15.1).
 */
export function hasSubstance(text: string): boolean {
  const lower = text.toLowerCase();
  return NUMBER_PATTERN.test(lower) || DECISION_PATTERN.test(lower);
}

// ---------------------------------------------------------------- session state

export type InterruptReason = "phase-over" | "drift";

/** Seconds of candidate speech without a number or a decision before the interviewer cuts in. */
export const DRIFT_SECONDS = 90;

export interface MockSession {
  lessonId: string;
  totalMinutes: number;
  totalSeconds: number;
  plan: PhaseSlot[];
  /** Index into `plan`. The learner can advance early; the clock never drags them forward. */
  phaseIndex: number;
  elapsedSeconds: number;
  phaseElapsedSeconds: number;
  /** Seconds actually spent in each phase, including the one in progress. */
  phaseSeconds: Record<MockPhase, number>;
  transcript: MockTranscriptEntry[];
  interruptions: number;
  /** Session seconds of the last interruption; -1 before the first one. */
  lastInterruptAt: number;
  /** Session seconds at which the candidate last said a number or a decision. */
  lastSubstanceAt: number;
  /**
   * Session seconds at which the candidate's current stretch of substance-free speech began, or
   * null when they are not in one. Silence is not drift: the clock only runs while they talk.
   */
  driftSince: number | null;
  /** The current phase's overrun has already produced an interruption. */
  phaseExpiryHandled: boolean;
  /** The wrap phase was left, or the session clock ran out. */
  ended: boolean;
}

function emptyPhaseSeconds(): Record<MockPhase, number> {
  return { clarify: 0, estimate: 0, design: 0, "deep-dive": 0, wrap: 0 };
}

export function createMockSession(lessonId: string, totalMinutes: number = FULL_SESSION_MINUTES): MockSession {
  return {
    lessonId,
    totalMinutes,
    totalSeconds: sessionSeconds(totalMinutes),
    plan: phasePlan(totalMinutes),
    phaseIndex: 0,
    elapsedSeconds: 0,
    phaseElapsedSeconds: 0,
    phaseSeconds: emptyPhaseSeconds(),
    transcript: [],
    interruptions: 0,
    lastInterruptAt: -1,
    lastSubstanceAt: 0,
    driftSince: null,
    phaseExpiryHandled: false,
    ended: false,
  };
}

export function currentPhase(session: MockSession): MockPhase {
  return session.plan[Math.min(session.phaseIndex, session.plan.length - 1)]!.phase;
}

/** The budget of the phase in progress, in seconds. */
export function phaseBudget(session: MockSession): number {
  return session.plan[Math.min(session.phaseIndex, session.plan.length - 1)]!.seconds;
}

export function phaseRemaining(session: MockSession): number {
  return Math.max(0, phaseBudget(session) - session.phaseElapsedSeconds);
}

export function phaseOvertime(session: MockSession): number {
  return Math.max(0, session.phaseElapsedSeconds - phaseBudget(session));
}

export function sessionRemaining(session: MockSession): number {
  return Math.max(0, session.totalSeconds - session.elapsedSeconds);
}

export function isLastPhase(session: MockSession): boolean {
  return session.phaseIndex >= session.plan.length - 1;
}

/** Advances both clocks by `seconds`. Once the session clock is spent the session ends. */
export function tick(session: MockSession, seconds: number = 1): MockSession {
  if (session.ended || seconds <= 0) return session;
  const phase = currentPhase(session);
  const elapsedSeconds = session.elapsedSeconds + seconds;
  return {
    ...session,
    elapsedSeconds,
    phaseElapsedSeconds: session.phaseElapsedSeconds + seconds,
    phaseSeconds: { ...session.phaseSeconds, [phase]: session.phaseSeconds[phase] + seconds },
    ended: elapsedSeconds >= session.totalSeconds,
  };
}

/**
 * Moves to the next phase and resets the phase clock. Leaving the last phase ends the session,
 * which is what opens the wrap-up form and the grade.
 */
export function nextPhase(session: MockSession): MockSession {
  if (session.ended) return session;
  if (isLastPhase(session)) return { ...session, ended: true };
  return {
    ...session,
    phaseIndex: session.phaseIndex + 1,
    phaseElapsedSeconds: 0,
    phaseExpiryHandled: false,
  };
}

/** Ends the session without advancing phases (the clock ran out, or the learner stopped early). */
export function endSession(session: MockSession): MockSession {
  return session.ended ? session : { ...session, ended: true };
}

export interface RecordOptions {
  intent?: string;
  interrupt?: boolean;
}

/**
 * Appends one utterance, stamped with the phase and the session clock. A candidate line that
 * carries a number or a decision resets the drift timer; an interviewer interruption is counted.
 */
export function recordUtterance(session: MockSession, role: MockRole, text: string, options: RecordOptions = {}): MockSession {
  const trimmed = text.trim();
  if (trimmed.length === 0) return session;
  const entry: MockTranscriptEntry = {
    role,
    text: trimmed,
    phase: currentPhase(session),
    at: session.elapsedSeconds,
    ...(options.intent ? { intent: options.intent } : {}),
    ...(options.interrupt ? { interrupt: true } : {}),
  };
  const drift = role === "candidate"
    ? hasSubstance(trimmed)
      ? { lastSubstanceAt: session.elapsedSeconds, driftSince: null }
      : { driftSince: session.driftSince ?? session.elapsedSeconds }
    : {};
  return {
    ...session,
    transcript: [...session.transcript, entry],
    ...drift,
    ...(role === "interviewer" && options.interrupt
      ? { interruptions: session.interruptions + 1, lastInterruptAt: session.elapsedSeconds }
      : {}),
  };
}

/**
 * Does the interviewer have a reason to cut in right now? "phase-over" fires once per phase when
 * its budget is spent; "drift" fires after DRIFT_SECONDS of candidate speech with no number and no
 * decision. The component asks the model for the actual line; this only decides when to ask.
 */
export function needsInterrupt(session: MockSession): InterruptReason | null {
  if (session.ended) return null;
  if (!session.phaseExpiryHandled && session.phaseElapsedSeconds >= phaseBudget(session)) return "phase-over";
  if (session.driftSince !== null && session.elapsedSeconds - session.driftSince >= DRIFT_SECONDS) return "drift";
  return null;
}

/** Books an interruption so the same reason does not fire again on the next tick. */
export function noteInterrupt(session: MockSession, reason: InterruptReason): MockSession {
  return {
    ...session,
    ...(reason === "phase-over"
      ? { phaseExpiryHandled: true }
      : { driftSince: null, lastSubstanceAt: session.elapsedSeconds }),
  };
}

/** The transcript in the shape POST /api/interview accepts. */
export function apiTranscript(session: MockSession, limit = 12): { role: MockRole; text: string }[] {
  return session.transcript.slice(-limit).map((entry) => ({ role: entry.role, text: entry.text }));
}

/** mm:ss for any clock in the UI. */
export function formatClock(seconds: number): string {
  const clamped = Math.max(0, Math.round(seconds));
  return `${Math.floor(clamped / 60)}:${String(clamped % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------- canvas snapshot

/** The settings that actually change behaviour for a node kind, as short "key=value" pairs. */
function nodeSettings(node: SystemNode): string[] {
  const settings: string[] = [];
  if (node.region && node.region !== "primary") settings.push(`region ${node.region}`);
  if (node.variance && node.variance !== "medium") settings.push(`${node.variance} variance`);
  if (node.kind === "server") {
    if (node.role === "worker") settings.push("worker");
    if (node.timeoutMs) settings.push(`timeout ${node.timeoutMs}ms`);
    if (node.retries) settings.push(`${node.retries} retries`);
    if (node.circuitBreaker) settings.push("circuit breaker");
    if (node.maxQueue) settings.push(`queue bound ${node.maxQueue}`);
    if (node.poolSize) settings.push(`pool ${node.poolSize}`);
    if (node.fanout === "sequential") settings.push("sequential fanout");
    if (node.idempotent) settings.push("idempotent");
  }
  if (node.kind === "database") {
    settings.push(node.dbMode ?? "single");
    if (node.dbMode === "sharded") settings.push(`${node.shards ?? 4} ${node.shardStrategy ?? "hash"} shards`);
    if (node.dbMode === "quorum") settings.push(`W${node.quorumWrite ?? 2}/R${node.quorumRead ?? 2}`);
    if (node.dbMode === "leader-follower") settings.push(`${node.election ?? "heartbeat"} election`);
    if (node.replicationLagMs) settings.push(`${node.replicationLagMs}ms replication lag`);
    if (node.consistency) settings.push(node.consistency);
  }
  if (node.kind === "cache") {
    settings.push(node.cacheModel ?? "probabilistic");
    if (node.cacheModel === "keyed") settings.push(`${node.cacheEntries ?? 0} entries`);
    else settings.push(`${Math.round((node.cacheHitRate ?? 0) * 100)}% hit rate`);
    if (node.ttlMs) settings.push(`ttl ${node.ttlMs}ms`);
    if (node.coalesce) settings.push("coalescing");
  }
  if (node.kind === "queue") {
    settings.push(node.ackMode ?? "at-most-once");
    if (node.maxQueue) settings.push(`depth ${node.maxQueue}`);
    if (node.visibilityTimeoutMs) settings.push(`visibility ${node.visibilityTimeoutMs}ms`);
  }
  if (node.kind === "load-balancer") settings.push(node.algorithm ?? "round-robin");
  if (node.kind === "rate-limiter") settings.push(`${node.limit ?? 0} req/s, burst ${node.burst ?? node.limit ?? 0}`);
  if (node.kind === "cdn") settings.push(`${Math.round((node.cacheHitRate ?? 0) * 100)}% edge hit rate`);
  if (node.kind === "object-store") settings.push(`${node.storedGb ?? 0} GB stored`);
  if (node.kind === "stream") {
    settings.push(`${node.partitions ?? 1} partitions`);
    settings.push(`${node.consumerGroups ?? 1} consumer group${(node.consumerGroups ?? 1) === 1 ? "" : "s"}`);
    if (node.retentionSeconds) settings.push(`${Math.round(node.retentionSeconds / 3600)}h retention`);
  }
  return settings;
}

/**
 * One line per node — label, kind, capacity x replicas, key settings, outgoing edges — which is
 * what the interviewer reads as `context.canvas`. Kept short on purpose: the model gets a design,
 * not a serialised graph.
 */
export function summarizeCanvas(architecture: Architecture): string {
  if (architecture.nodes.length === 0) return "Empty canvas.";
  return architecture.nodes.map((node) => {
    const targets = architecture.edges
      .filter((edge) => edge.source === node.id)
      .map((edge) => architecture.nodes.find((candidate) => candidate.id === edge.target)?.label ?? edge.target);
    const settings = nodeSettings(node);
    return [
      `${node.label} (${node.kind}${node.enabled ? "" : ", disabled"})`,
      node.kind === "traffic" ? null : `${node.capacity} cap x ${node.replicas} replica${node.replicas === 1 ? "" : "s"}`,
      settings.length > 0 ? settings.join(", ") : null,
      targets.length > 0 ? `-> ${targets.join(", ")}` : "-> nothing",
    ].filter(Boolean).join("; ");
  }).join("\n");
}

/** A compact run summary stored as `lastRun` and sent with every turn. */
export interface RunSummary {
  p95: number;
  p99: number;
  throughput: number;
  errorRate: number;
  rejectedRate: number;
  cost: number;
}

export function summarizeRun(run: RunSummary | null): string {
  if (!run) return "No run yet.";
  return [
    `p95 ${Math.round(run.p95)}ms`,
    `p99 ${Math.round(run.p99)}ms`,
    `throughput ${run.throughput.toFixed(1)} req/s`,
    `error rate ${(run.errorRate * 100).toFixed(2)}%`,
    `rejected ${(run.rejectedRate * 100).toFixed(2)}%`,
    `cost $${run.cost.toFixed(2)}/h`,
  ].join(", ");
}
