"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Lock,
  Mic,
  MessageSquareText,
  Radio,
  Send,
  Sparkles,
  Timer,
  TriangleAlert,
  User,
  XCircle,
} from "lucide-react";
import type { EstimationId, Lesson, RubricItem } from "@/lib/types";
import type { EstimationOutcome } from "@/lib/estimation";
import { applyPenalties, type Deduction } from "@/lib/defense-scoring";

// ---------------------------------------------------------------- shuffle

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return function random() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledOptions(lesson: Lesson, attempt: number): { options: string[]; correctIndex: number } {
  const random = mulberry32(hashSeed(`${lesson.id}:reflection:${attempt}`));
  const indices = lesson.reflection.options.map((_, index) => index);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = indices[i]!;
    const b = indices[j]!;
    indices[i] = b;
    indices[j] = a;
  }
  return {
    options: indices.map((i) => lesson.reflection.options[i]!),
    correctIndex: indices.indexOf(lesson.reflection.answer),
  };
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function formatClock(seconds: number): string {
  const clamped = Math.max(0, Math.round(seconds));
  const m = Math.floor(clamped / 60);
  const s = clamped % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Signed relative error per estimation prompt: (predicted - actual) / max(actual, 1).
 *  Clamped to +/-10 (a 10x miss) because that is the range persistence accepts, and a wilder
 *  outlier would otherwise make the whole progress record unsaveable. */
export function estimationBiasFrom(outcomes: EstimationOutcome[] | null | undefined): Partial<Record<EstimationId, number>> | undefined {
  if (!outcomes || outcomes.length === 0) return undefined;
  const bias: Partial<Record<EstimationId, number>> = {};
  for (const outcome of outcomes) {
    const denominator = Math.max(Math.abs(outcome.actual), 1);
    const value = (outcome.predicted - outcome.actual) / denominator;
    bias[outcome.id] = Number.isFinite(value) ? Math.max(-10, Math.min(10, value)) : 0;
  }
  return bias;
}

// ---------------------------------------------------------------- speech recognition

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: any) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** A "Speak" button that appends interim/final transcripts to a textarea; falls back to a dictation note. */
function SpeechInput({ onTranscript }: { onTranscript: (text: string, final: boolean) => void }) {
  const [supported, setSupported] = useState(true);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const baseRef = useRef("");

  useEffect(() => {
    setSupported(!!getSpeechRecognitionCtor());
  }, []);

  function toggle() {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event: any) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (final) onTranscript(final, true);
      else if (interim) onTranscript(interim, false);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognitionRef.current = recognition;
    baseRef.current = "";
    recognition.start();
    setListening(true);
  }

  useEffect(() => () => recognitionRef.current?.stop(), []);

  if (!supported) return <p className="defense-dictation-note">Dictation needs Chrome or Safari on this device.</p>;
  return <button type="button" className={`button small defense-speak ${listening ? "active" : ""}`} onClick={toggle}>
    <Mic size={13} />{listening ? "Listening..." : "Speak"}
  </button>;
}

// ---------------------------------------------------------------- per-stage clock

/** Counts a stage clock down from durationSeconds; once at zero it keeps counting overtime instead of stopping. */
function useStageClock(key: string, durationSeconds: number, active: boolean) {
  const [remaining, setRemaining] = useState(durationSeconds);
  const [overtime, setOvertime] = useState(0);

  useEffect(() => {
    setRemaining(durationSeconds);
    setOvertime(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, durationSeconds]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setRemaining((r) => {
        if (r > 0) return r - 1;
        setOvertime((o) => o + 1);
        return 0;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [active]);

  return { remaining, overtime };
}

// ---------------------------------------------------------------- grading types

interface GradedItem { id: string; score: 0 | 1 | 2; note: string }
/** v2.3: a stated expectation ("cache: ~85% hits") that the measured run contradicted. */
export interface GradedContradiction { nodeId: string; claim: string; measured: string; note: string }
/** v2.3: rubric-style scoring of the data model text (keys, partition/hot path, query patterns, growth). */
export interface DataModelItem { id: string; score: 0 | 1 | 2; note: string }
interface GradedResult {
  mode?: "graded";
  items: GradedItem[];
  total: number;
  critique: string;
  /** v2.2 live interviewer only. */
  recoveryScore?: number;
  techScore?: number;
  dataModelScore?: number;
  weakConcepts?: string[];
  /** v2.3 */
  contradictions?: GradedContradiction[];
  dataModelItems?: DataModelItem[];
}
type GradeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "graded"; result: GradedResult }
  | { status: "self" };

interface FollowUpAnswer { question: string; answer: string }

// ---------------------------------------------------------------- live interviewer

export type InterviewIntent = "probe" | "pushback" | "escalate" | "clarify";
export interface InterviewTurn { role: "interviewer" | "candidate"; text: string; intent?: InterviewIntent }
/** The canvas-and-run snapshot the playground hands to the interviewer.
 *  Mirrors the server-side InterviewContext in lib/interview.ts; kept local so no server module
 *  reaches the client bundle. Anything the route rejects becomes a 400, which falls back to static. */
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
export interface InterviewContext {
  architecture: string;
  result: string;
  rationales?: TechRationale[];
  dataModel?: string;
  estimation?: string;
  blankCanvas?: boolean;
  metrics?: NodeMetricSummary[];
}

/** Renders one node's measured metrics as a short human-readable string for the self-mode comparison. */
function formatNodeMetric(metric: NodeMetricSummary): string {
  const parts = [`${Math.round(metric.utilization * 100)}% utilization`, `${metric.processedPerSec}/s processed`];
  if (metric.errors > 0) parts.push(`${metric.errors} errors`);
  if (metric.hitRate !== undefined) parts.push(`${Math.round(metric.hitRate * 100)}% hit rate`);
  if (metric.shardSpread && metric.shardSpread.length > 0) parts.push(`shards ${metric.shardSpread.map((s) => `${Math.round(s * 100)}%`).join("/")}`);
  return parts.join(", ");
}

const intentLabels: Record<InterviewIntent, string> = {
  probe: "Probe",
  pushback: "Pushback",
  escalate: "Escalate",
  clarify: "Clarify",
};

const DESIGN_MIN_WORDS = 60;
const FOLLOWUP_MIN_WORDS = 20;
const TURN_MIN_WORDS = 15;
const PASS_THRESHOLD = 60;
const DESIGN_CLOCK_SECONDS = 120;
const FOLLOWUP_CLOCK_SECONDS = 60;
const TURN_CLOCK_SECONDS = 60;
const MAX_ROUNDS = 5;

export interface DefenseOutcome {
  reflectionAttempts: number;
  defenseScore: number;
  defenseMode: "graded" | "self";
  overtimeSeconds: number;
  followUpMode: "dynamic" | "static";
  /** v2.2 */
  interviewRounds: number;
  recoveryScore?: number;
  weakConcepts?: string[];
  estimationBias?: Partial<Record<EstimationId, number>>;
  /** v2.3 */
  contradictions?: number;
  dataModelScore?: number;
}

export function DefenseStage({ lesson, nextLesson, enabled, completed, hintCount, onComplete, onActive, remixActive, interviewContext, wallClockOvertime, estimationOutcomes }: {
  lesson: Lesson;
  nextLesson?: { id: string; title: string };
  enabled: boolean;
  completed: boolean;
  /** Hints revealed so far this lesson, used to compute interview-mode penalties. */
  hintCount?: number;
  onComplete: (outcome: DefenseOutcome) => void;
  /** Lets the parent dim the canvas column while the defense is in progress. */
  onActive?: (active: boolean) => void;
  remixActive?: boolean;
  /** v2.2: the design snapshot the live interviewer reads. Without it the static follow-ups are used. */
  interviewContext?: InterviewContext;
  /** v2.2: seconds over the single lesson wall clock, folded into the deductions. */
  wallClockOvertime?: number;
  /** v2.2: used to report the signed estimation bias with the completion. */
  estimationOutcomes?: EstimationOutcome[] | null;
}) {
  // Reflection state
  const [attempt, setAttempt] = useState(1);
  const [choice, setChoice] = useState<{ chosen: number; correct: boolean } | null>(null);
  const [reflectionSolved, setReflectionSolved] = useState(false);

  // Interview mode
  const [interviewMode, setInterviewMode] = useState(true);

  // Defense state
  const [design, setDesign] = useState("");
  const [designConfirmed, setDesignConfirmed] = useState(false);
  const [followUpQuestions, setFollowUpQuestions] = useState<string[]>(lesson.defense.followUps);
  const [followUpMode, setFollowUpMode] = useState<"dynamic" | "static">("static");
  const [followUpsLoading, setFollowUpsLoading] = useState(false);
  const [followUps, setFollowUps] = useState<string[]>(() => lesson.defense.followUps.map(() => ""));
  const [revealedCount, setRevealedCount] = useState(0);
  const [grade, setGrade] = useState<GradeState>({ status: "idle" });
  const [selfChecked, setSelfChecked] = useState<Record<string, boolean>>({});
  const [selfRevealed, setSelfRevealed] = useState(false);
  const [selfRevised, setSelfRevised] = useState(false);
  const [gradeError, setGradeError] = useState<string | null>(null);
  const [totalOvertime, setTotalOvertime] = useState(0);

  // v2.2 live interviewer
  const [live, setLive] = useState(false);
  const [transcript, setTranscript] = useState<InterviewTurn[]>([]);
  const [turnAnswer, setTurnAnswer] = useState("");
  const [turnLoading, setTurnLoading] = useState(false);
  const [interviewDone, setInterviewDone] = useState(false);
  const [interviewNote, setInterviewNote] = useState<string | null>(null);

  const [finished, setFinished] = useState<DefenseOutcome | null>(null);
  const completedOnce = useRef(false);

  const inDefense = reflectionSolved && !finished;
  useEffect(() => { onActive?.(inDefense); return () => onActive?.(false); }, [inDefense, onActive]);

  useEffect(() => {
    // Reset local flow state whenever the lesson changes.
    setAttempt(1);
    setChoice(null);
    setReflectionSolved(false);
    setDesign("");
    setDesignConfirmed(false);
    setFollowUpQuestions(lesson.defense.followUps);
    setFollowUpMode("static");
    setFollowUpsLoading(false);
    setFollowUps(lesson.defense.followUps.map(() => ""));
    setRevealedCount(0);
    setGrade({ status: "idle" });
    setSelfChecked({});
    setSelfRevealed(false);
    setSelfRevised(false);
    setGradeError(null);
    setTotalOvertime(0);
    setLive(false);
    setTranscript([]);
    setTurnAnswer("");
    setTurnLoading(false);
    setInterviewDone(false);
    setInterviewNote(null);
    setFinished(null);
    completedOnce.current = false;
  }, [lesson.id]);

  const interviewerTurns = transcript.filter((turn) => turn.role === "interviewer").length;
  const awaitingAnswer = live && !interviewDone && !turnLoading && transcript.length > 0 && transcript[transcript.length - 1]!.role === "interviewer";
  const graded = grade.status === "graded" || grade.status === "self";

  const designClock = useStageClock(`${lesson.id}:design`, DESIGN_CLOCK_SECONDS, interviewMode && inDefense && !designConfirmed);
  const followUpClock = useStageClock(`${lesson.id}:followup:${revealedCount}`, FOLLOWUP_CLOCK_SECONDS, interviewMode && inDefense && !live && designConfirmed && revealedCount > 0 && revealedCount <= followUpQuestions.length && !graded);
  const turnClock = useStageClock(`${lesson.id}:turn:${transcript.length}`, TURN_CLOCK_SECONDS, interviewMode && inDefense && awaitingAnswer && !graded);

  function currentOvertime(): number {
    return totalOvertime + designClock.overtime + (live ? turnClock.overtime : followUpClock.overtime);
  }

  function penalties(total: number, reflectionAttempts: number, overtimeSeconds: number) {
    return applyPenalties(total, {
      hintsUsed: hintCount ?? 0,
      reflectionAttempts,
      overtimeSeconds,
      wallClockOvertime: wallClockOvertime ?? 0,
    });
  }

  function finish(outcome: { reflectionAttempts: number; defenseScore: number; defenseMode: "graded" | "self"; recoveryScore?: number; weakConcepts?: string[]; contradictions?: number; dataModelScore?: number }) {
    const overtimeSeconds = currentOvertime();
    const result: DefenseOutcome = {
      ...outcome,
      overtimeSeconds,
      followUpMode: live ? "dynamic" : followUpMode,
      interviewRounds: interviewerTurns,
      ...(estimationBiasFrom(estimationOutcomes) ? { estimationBias: estimationBiasFrom(estimationOutcomes) } : {}),
    };
    setFinished(result);
    if (!completedOnce.current) {
      completedOnce.current = true;
      onComplete(result);
    }
  }

  function pickOption(index: number) {
    if (choice) return;
    const correct = index === lesson.reflection.answer;
    setChoice({ chosen: index, correct });
    if (correct) setReflectionSolved(true);
  }

  function retryReflection() {
    setAttempt((a) => a + 1);
    setChoice(null);
  }

  // -------------------------------------------------------------- live interviewer calls

  /** One interviewer turn. Returns null on 501, any other error, or a malformed body: the caller falls back. */
  async function requestTurn(turns: InterviewTurn[]): Promise<{ question: string; intent: InterviewIntent; round: number; done: boolean } | null> {
    if (!interviewContext) return null;
    try {
      const res = await fetch("/api/interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonId: lesson.id,
          stage: "turn",
          transcript: turns.map((turn) => ({ role: turn.role, text: turn.text })),
          context: interviewContext,
        }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { question?: string; intent?: InterviewIntent; round?: number; done?: boolean };
      if (!body || typeof body.question !== "string" || body.question.trim().length === 0) return null;
      return {
        question: body.question,
        intent: body.intent && body.intent in intentLabels ? body.intent : "probe",
        round: typeof body.round === "number" ? body.round : turns.filter((turn) => turn.role === "interviewer").length + 1,
        done: body.done === true,
      };
    } catch {
      return null;
    }
  }

  /** The pre-v2.2 path: dynamic follow-ups from /api/grade, or the lesson's static list. */
  async function startStaticFollowUps() {
    setFollowUpsLoading(true);
    try {
      const res = await fetch("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: lesson.id, stage: "followups", answers: { design } }),
      });
      if (res.ok) {
        const body = (await res.json()) as { mode: "graded"; followUps: string[] };
        const questions = body.followUps.length > 0 ? body.followUps : lesson.defense.followUps;
        setFollowUpQuestions(questions);
        setFollowUpMode("dynamic");
        setFollowUps(questions.map(() => ""));
        if (questions.length > 0) setRevealedCount(1);
        return;
      }
      // 501 or any other non-ok: fall back to the lesson's static follow-ups.
      setFollowUpQuestions(lesson.defense.followUps);
      setFollowUpMode("static");
      setFollowUps(lesson.defense.followUps.map(() => ""));
      if (lesson.defense.followUps.length > 0) setRevealedCount(1);
    } catch {
      setFollowUpQuestions(lesson.defense.followUps);
      setFollowUpMode("static");
      setFollowUps(lesson.defense.followUps.map(() => ""));
      if (lesson.defense.followUps.length > 0) setRevealedCount(1);
    } finally {
      setFollowUpsLoading(false);
    }
  }

  async function submitDesign() {
    setTotalOvertime((o) => o + designClock.overtime);
    setDesignConfirmed(true);
    if (!interviewMode) {
      if (lesson.defense.followUps.length > 0) setRevealedCount(1);
      return;
    }
    setFollowUpsLoading(true);
    const opening: InterviewTurn[] = [{ role: "candidate", text: design }];
    const first = await requestTurn(opening);
    setFollowUpsLoading(false);
    if (first) {
      setLive(true);
      setFollowUpMode("dynamic");
      setTranscript([...opening, { role: "interviewer", text: first.question, intent: first.intent }]);
      setInterviewDone(first.done || first.round >= MAX_ROUNDS);
      return;
    }
    await startStaticFollowUps();
  }

  async function sendTurnAnswer() {
    if (wordCount(turnAnswer) < TURN_MIN_WORDS || turnLoading) return;
    const answered: InterviewTurn[] = [...transcript, { role: "candidate", text: turnAnswer.trim() }];
    setTranscript(answered);
    setTurnAnswer("");
    setTotalOvertime((o) => o + turnClock.overtime);
    if (interviewDone || interviewerTurns >= MAX_ROUNDS) {
      setInterviewDone(true);
      return;
    }
    setTurnLoading(true);
    const next = await requestTurn(answered);
    setTurnLoading(false);
    if (!next) {
      setInterviewDone(true);
      setInterviewNote("The interviewer stopped responding. Submit what you have for grading.");
      return;
    }
    setTranscript([...answered, { role: "interviewer", text: next.question, intent: next.intent }]);
    if (next.done || next.round >= MAX_ROUNDS) setInterviewDone(true);
  }

  function revealNextFollowUp() {
    setTotalOvertime((o) => o + followUpClock.overtime);
    setRevealedCount((count) => Math.min(count + 1, followUpQuestions.length));
  }

  async function submitForGrading() {
    setTotalOvertime((o) => o + (live ? turnClock.overtime : followUpClock.overtime));
    setGrade({ status: "loading" });
    setGradeError(null);
    try {
      const res = live
        ? await fetch("/api/interview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lessonId: lesson.id,
            stage: "grade",
            transcript: transcript.map((turn) => ({ role: turn.role, text: turn.text })),
            context: interviewContext,
          }),
        })
        : await fetch("/api/grade", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lessonId: lesson.id,
            stage: "grade",
            answers: { design, followUps: followUpQuestions.map((question, index): FollowUpAnswer => ({ question, answer: followUps[index] ?? "" })) },
          }),
        });
      if (res.ok) {
        const body = (await res.json()) as GradedResult;
        setGrade({ status: "graded", result: body });
        const penalized = penalties(body.total, attempt, currentOvertime());
        if (penalized.total >= PASS_THRESHOLD) {
          finish({
            reflectionAttempts: attempt,
            defenseScore: penalized.total,
            defenseMode: "graded",
            ...(typeof body.recoveryScore === "number" ? { recoveryScore: body.recoveryScore } : {}),
            ...(Array.isArray(body.weakConcepts) ? { weakConcepts: body.weakConcepts } : {}),
            ...(Array.isArray(body.contradictions) ? { contradictions: body.contradictions.length } : {}),
            ...(typeof body.dataModelScore === "number" ? { dataModelScore: body.dataModelScore } : {}),
          });
        }
        return;
      }
      const body = await res.json().catch(() => null);
      if (res.status !== 501 && body && typeof body.error === "string") setGradeError(body.error);
      setGrade({ status: "self" });
    } catch {
      setGradeError("Could not reach the grading service.");
      setGrade({ status: "self" });
    }
  }

  function reviseDesign() {
    setGrade({ status: "idle" });
  }

  function toggleRubricItem(id: string) {
    setSelfChecked((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function revealModelAnswer() {
    setSelfRevealed(true);
  }

  function confirmSelfAssessment() {
    if (selfRevealed && !selfRevised) {
      // First confirmation after reveal counts as the one allowed revision pass.
      setSelfRevised(true);
      return finalizeSelfAssessment();
    }
    if (!selfRevealed) {
      // Blind pass: lock the rubric ticks, then reveal the model answer.
      revealModelAnswer();
      return;
    }
    finalizeSelfAssessment();
  }

  function finalizeSelfAssessment() {
    const rubric = lesson.defense.rubric;
    const total = rubric.reduce((sum, item) => (selfChecked[item.id] ? sum + item.weight : sum), 0);
    const penalized = penalties(Math.round(total), attempt, currentOvertime());
    finish({ reflectionAttempts: attempt, defenseScore: penalized.total, defenseMode: "self" });
  }

  // ---------------------------------------------------------------- render

  if (!enabled) {
    return <div className="defense-stage locked-state">
      <div className="panel-empty">
        <Lock size={22} strokeWidth={1.3} />
        <p>Pass every objective in Check to unlock the reflection and defense for this lesson.</p>
      </div>
    </div>;
  }

  if (finished || (completed && !reflectionSolved)) {
    const outcome = finished;
    const finalDeductions = outcome && grade.status === "graded"
      ? penalties(grade.result.total, outcome.reflectionAttempts, outcome.overtimeSeconds).deductions
      : [];
    return <div className="defense-stage">
      <div className="reflection-section completion-section">
        <div className="reflection-heading">
          <span className="reflection-icon"><Sparkles size={17} /></span>
          <span>Lesson complete</span>
          {outcome && <span className="completion-badge"><CheckCircle2 size={13} />{outcome.defenseMode === "graded" ? `${outcome.defenseScore}/100 graded` : `${outcome.defenseScore}/100 self-assessed`}</span>}
        </div>
        {outcome ? <>
          <p className="reflection-feedback">{lesson.reflection.explanation}</p>
          {grade.status === "graded" && <p className="defense-critique">{grade.result.critique}</p>}
          {grade.status === "self" && <p className="defense-critique">Self-assessed against the model answer and rubric.</p>}
          {outcome.interviewRounds > 0 && <p className="defense-interview-summary">{outcome.interviewRounds} interviewer round{outcome.interviewRounds === 1 ? "" : "s"}{outcome.recoveryScore !== undefined ? ` - recovery ${outcome.recoveryScore}/2` : ""}.</p>}
          {(outcome.contradictions !== undefined || outcome.dataModelScore !== undefined) && <p className="defense-interview-summary">
            {outcome.contradictions !== undefined && `${outcome.contradictions} contradiction${outcome.contradictions === 1 ? "" : "s"} between claims and the measured run.`}
            {outcome.contradictions !== undefined && outcome.dataModelScore !== undefined && " "}
            {outcome.dataModelScore !== undefined && `Data model scored ${outcome.dataModelScore}/2.`}
          </p>}
          {outcome.weakConcepts && outcome.weakConcepts.length > 0 && <WeakConcepts ids={outcome.weakConcepts} rubric={lesson.defense.rubric} />}
          {finalDeductions.length > 0 && <DeductionsList deductions={finalDeductions} />}
        </> : <p className="reflection-feedback">You&apos;ve already completed this lesson. Revisit the mission any time — your reflection and defense answers aren&apos;t re-shown here.</p>}
        {remixActive && <p className="defense-remix-note">Remix objectives completed.</p>}
        <div className="defense-next">
          {nextLesson ? <Link className="button primary" href={`/learn/${nextLesson.id}`}>Next: {nextLesson.title}<ArrowRight size={15} /></Link> : <Link className="button primary" href="/learn">Back to learning path<ArrowRight size={15} /></Link>}
        </div>
      </div>
    </div>;
  }

  const { options, correctIndex } = shuffledOptions(lesson, attempt);
  const currentClock = !designConfirmed ? designClock : live ? turnClock : followUpClock;
  const showClock = interviewMode && reflectionSolved && !graded && (!designConfirmed || (live ? awaitingAnswer : revealedCount > 0));
  const canGradeLive = live && (interviewDone || interviewerTurns >= MAX_ROUNDS) && !awaitingAnswer && !turnLoading;

  return <div className="defense-stage">
    <div className="reflection-section">
      <div className="reflection-heading">
        <span className="reflection-icon"><MessageSquareText size={17} /></span>
        <span>Reflection</span>
        {attempt > 1 && !reflectionSolved && <span className="completion-badge">Attempt {attempt}</span>}
      </div>
      <p>{lesson.reflection.question}</p>
      <div className="reflection-options">
        {options.map((option, index) => {
          const isChosen = choice?.chosen === index;
          const state = choice
            ? index === correctIndex
              ? "correct"
              : isChosen
                ? "wrong"
                : "idle"
            : "idle";
          return <button
            key={option}
            type="button"
            className={`reflection-option ${state}`}
            onClick={() => pickOption(index)}
            disabled={!!choice}
          >
            {state === "correct" && <CheckCircle2 size={15} />}
            {state === "wrong" && <XCircle size={15} />}
            <span>{option}</span>
          </button>;
        })}
      </div>
      {choice && !choice.correct && <div className="reflection-nudge">
        <p className="reflection-feedback">Not quite. Look again at what changes, and what stays the same, before you retry.</p>
        <button type="button" className="button" onClick={retryReflection}>Try again<ChevronRight size={14} /></button>
      </div>}
      {choice?.correct && <p className="reflection-feedback">{lesson.reflection.explanation}</p>}
    </div>

    {reflectionSolved && <div className="defense-section">
      <div className="reflection-heading">
        <span className="reflection-icon"><ClipboardCheck size={17} /></span>
        <span>Defend your design</span>
        {live && <span className="defense-live-badge"><Radio size={12} />Live interviewer</span>}
        <label className="defense-interview-toggle">
          <input type="checkbox" checked={interviewMode} disabled={designConfirmed} onChange={(e) => setInterviewMode(e.target.checked)} />
          <span>Interview mode</span>
        </label>
        {showClock && <span className={`defense-clock ${currentClock.overtime > 0 ? "over" : ""}`}>
          <Timer size={13} />{currentClock.overtime > 0 ? `+${formatClock(currentClock.overtime)} over` : formatClock(currentClock.remaining)}
        </span>}
      </div>
      <p className="defense-prompt">{lesson.defense.prompt}</p>

      {!designConfirmed ? <div className="defense-answer">
        <label className="field-label" htmlFor="defense-design">Your answer</label>
        <textarea
          id="defense-design"
          rows={6}
          value={design}
          onChange={(e) => setDesign(e.target.value)}
          placeholder="Explain your design decisions..."
        />
        <div className="defense-answer-tools">
          <SpeechInput onTranscript={(text, final) => setDesign((prev) => (final ? `${prev}${prev && !prev.endsWith(" ") ? " " : ""}${text}` : prev))} />
          <div className="defense-word-count"><span className={wordCount(design) >= DESIGN_MIN_WORDS ? "ok" : ""}>{wordCount(design)} / {DESIGN_MIN_WORDS} words</span></div>
        </div>
        <button type="button" className="button primary" disabled={wordCount(design) < DESIGN_MIN_WORDS || followUpsLoading} onClick={submitDesign}>{followUpsLoading ? "Calling the interviewer..." : "Continue"}<ChevronRight size={14} /></button>
      </div> : live ? <>
        {/* ------------------------------------------------ live interview */}
        <div className="interview-transcript">
          {transcript.map((turn, index) => <div key={index} className={`interview-turn ${turn.role}`}>
            <span className="interview-avatar">{turn.role === "interviewer" ? <MessageSquareText size={13} /> : <User size={13} />}</span>
            <div>
              <div className="interview-turn-head">
                <span className="interview-role">{turn.role === "interviewer" ? "Interviewer" : "You"}</span>
                {turn.role === "interviewer" && turn.intent && <span className={`interview-intent ${turn.intent}`}>{intentLabels[turn.intent]}</span>}
                {turn.role === "interviewer" && <span className="interview-round">Round {transcript.slice(0, index + 1).filter((t) => t.role === "interviewer").length} of {MAX_ROUNDS}</span>}
              </div>
              <p>{turn.text}</p>
            </div>
          </div>)}
          {turnLoading && <div className="interview-turn interviewer pending">
            <span className="interview-avatar"><MessageSquareText size={13} /></span>
            <div><div className="interview-turn-head"><span className="interview-role">Interviewer</span></div><p className="interview-thinking">Thinking about your answer...</p></div>
          </div>}
        </div>

        {interviewNote && <p className="defense-grade-error"><TriangleAlert size={12} /> {interviewNote}</p>}

        {awaitingAnswer && !graded && <div className="defense-answer interview-reply">
          <label className="field-label" htmlFor="interview-reply">Your reply</label>
          <textarea
            id="interview-reply"
            rows={4}
            value={turnAnswer}
            onChange={(e) => setTurnAnswer(e.target.value)}
            placeholder="Answer the interviewer..."
          />
          <div className="defense-answer-tools">
            <SpeechInput onTranscript={(text, final) => setTurnAnswer((prev) => (final ? `${prev}${prev && !prev.endsWith(" ") ? " " : ""}${text}` : prev))} />
            <div className="defense-word-count"><span className={wordCount(turnAnswer) >= TURN_MIN_WORDS ? "ok" : ""}>{wordCount(turnAnswer)} / {TURN_MIN_WORDS} words</span></div>
          </div>
          <button type="button" className="button primary" disabled={wordCount(turnAnswer) < TURN_MIN_WORDS} onClick={sendTurnAnswer}>Send reply<Send size={14} /></button>
        </div>}

        {canGradeLive && !graded && <button type="button" className="button primary" disabled={grade.status === "loading"} onClick={submitForGrading}>
          {grade.status === "loading" ? "Grading..." : "Finish and grade the interview"}<Send size={14} />
        </button>}

        <GradeViews
          grade={grade}
          lesson={lesson}
          attempt={attempt}
          overtimeSeconds={currentOvertime()}
          penalties={penalties}
          gradeError={gradeError}
          selfChecked={selfChecked}
          selfRevealed={selfRevealed}
          selfRevised={selfRevised}
          onToggleRubric={toggleRubricItem}
          onConfirmSelf={confirmSelfAssessment}
          onRevise={reviseDesign}
          interviewContext={interviewContext}
        />
      </> : <>
        {/* ------------------------------------------------ static follow-ups */}
        <div className="defense-answer submitted">
          <span className="field-label">Your answer</span>
          <p>{design}</p>
        </div>

        {followUpQuestions.slice(0, revealedCount).map((question, index) => {
          const isLast = index === revealedCount - 1;
          const answered = index < revealedCount - 1;
          return <div className="defense-followup" key={question}>
            <span className="field-label">Follow-up {index + 1}</span>
            <p className="defense-prompt">{question}</p>
            {answered ? <p className="defense-answer-readonly">{followUps[index]}</p> : <>
              <textarea
                rows={4}
                value={followUps[index] ?? ""}
                onChange={(e) => setFollowUps((prev) => prev.map((v, i) => (i === index ? e.target.value : v)))}
                placeholder="Answer the follow-up..."
              />
              <div className="defense-answer-tools">
                <SpeechInput onTranscript={(text, final) => setFollowUps((prev) => prev.map((v, i) => {
                  if (i !== index) return v;
                  return final ? `${v}${v && !v.endsWith(" ") ? " " : ""}${text}` : v;
                }))} />
                <div className="defense-word-count"><span className={wordCount(followUps[index] ?? "") >= FOLLOWUP_MIN_WORDS ? "ok" : ""}>{wordCount(followUps[index] ?? "")} / {FOLLOWUP_MIN_WORDS} words</span></div>
              </div>
              {isLast && index < followUpQuestions.length - 1 && <button type="button" className="button" disabled={wordCount(followUps[index] ?? "") < FOLLOWUP_MIN_WORDS} onClick={revealNextFollowUp}>Next follow-up<ChevronRight size={14} /></button>}
            </>}
          </div>;
        })}

        {revealedCount >= followUpQuestions.length && !graded && <button
          type="button"
          className="button primary"
          disabled={grade.status === "loading" || (wordCount(followUps[followUps.length - 1] ?? "") < FOLLOWUP_MIN_WORDS && followUpQuestions.length > 0)}
          onClick={submitForGrading}
        >
          {grade.status === "loading" ? "Grading..." : "Submit for grading"}<Send size={14} />
        </button>}

        <GradeViews
          grade={grade}
          lesson={lesson}
          attempt={attempt}
          overtimeSeconds={currentOvertime()}
          penalties={penalties}
          gradeError={gradeError}
          selfChecked={selfChecked}
          selfRevealed={selfRevealed}
          selfRevised={selfRevised}
          onToggleRubric={toggleRubricItem}
          onConfirmSelf={confirmSelfAssessment}
          onRevise={reviseDesign}
          interviewContext={interviewContext}
        />
      </>}
    </div>}
  </div>;
}

// ---------------------------------------------------------------- grade + self-assessment views

function GradeViews({ grade, lesson, attempt, overtimeSeconds, penalties, gradeError, selfChecked, selfRevealed, selfRevised, onToggleRubric, onConfirmSelf, onRevise, interviewContext }: {
  grade: GradeState;
  lesson: Lesson;
  attempt: number;
  overtimeSeconds: number;
  penalties: (total: number, reflectionAttempts: number, overtimeSeconds: number) => { total: number; deductions: Deduction[] };
  gradeError: string | null;
  selfChecked: Record<string, boolean>;
  selfRevealed: boolean;
  selfRevised: boolean;
  onToggleRubric: (id: string) => void;
  onConfirmSelf: () => void;
  onRevise: () => void;
  interviewContext?: InterviewContext;
}) {
  return <>
    {grade.status === "graded" && (() => {
      const result = grade.result;
      const penalized = penalties(result.total, attempt, overtimeSeconds);
      return <div className="defense-grade">
        <div className="defense-grade-header">
          <span className={penalized.total >= PASS_THRESHOLD ? "defense-total pass" : "defense-total fail"}>{penalized.total}/100</span>
          <span className={penalized.total >= PASS_THRESHOLD ? "defense-pass-line pass" : "defense-pass-line fail"}>{penalized.total >= PASS_THRESHOLD ? "Passed" : "Below the 60 pass line"}</span>
        </div>
        {(result.recoveryScore !== undefined || result.techScore !== undefined || result.dataModelScore !== undefined) && <div className="defense-score-tiles">
          {result.recoveryScore !== undefined && <div className="defense-score-tile"><span>Recovery under pushback</span><strong>{result.recoveryScore}/2</strong></div>}
          {result.techScore !== undefined && <div className="defense-score-tile"><span>Technology choices</span><strong>{result.techScore}/2</strong></div>}
          {result.dataModelScore !== undefined && <div className="defense-score-tile"><span>Data model</span><strong>{result.dataModelScore}/2</strong></div>}
        </div>}
        {penalized.deductions.length > 0 && <DeductionsList deductions={penalized.deductions} />}
        {result.contradictions && result.contradictions.length > 0 && <ContradictionsList items={result.contradictions} />}
        {result.dataModelItems && result.dataModelItems.length > 0 && <DataModelItemsList items={result.dataModelItems} />}
        <ul className="defense-rubric-results">
          {result.items.map((item) => {
            const rubricItem = lesson.defense.rubric.find((r) => r.id === item.id);
            return <li key={item.id}>
              <span className="defense-rubric-score">{item.score}/2</span>
              <div><strong>{rubricItem?.criterion ?? item.id}</strong><p>{item.note}</p></div>
            </li>;
          })}
        </ul>
        <p className="defense-critique">{result.critique}</p>
        {result.weakConcepts && result.weakConcepts.length > 0 && <WeakConcepts ids={result.weakConcepts} rubric={lesson.defense.rubric} />}
        {penalized.total < PASS_THRESHOLD && <button type="button" className="button" onClick={onRevise}>Revise and resubmit<ChevronRight size={14} /></button>}
      </div>;
    })()}

    {gradeError && <p className="defense-grade-error">{gradeError}</p>}

    {grade.status === "self" && <div className="defense-self-assessment">
      <p className="defense-self-intro">{selfRevealed
        ? "Compare your answer with the model answer below. You may revise your ticks once, then confirm."
        : "Grading is unavailable right now. Tick every rubric item you believe you covered before you see the model answer — this stays a blind self-assessment."}</p>
      {selfRevealed && <details className="defense-model-answer" open>
        <summary>Model answer</summary>
        <p>{lesson.defense.modelAnswer}</p>
      </details>}
      {interviewContext?.rationales && interviewContext.rationales.length > 0 && <div className="defense-claims-check">
        <span className="field-label">Your claims vs. what the run measured</span>
        <ul>
          {interviewContext.rationales.map((rationale) => {
            const metric = interviewContext.metrics?.find((m) => m.nodeId === rationale.nodeId);
            return <li key={rationale.nodeId}>
              <strong>{rationale.label}</strong>
              <span className="defense-claim">expected {rationale.expected || "(nothing stated)"}</span>
              {metric && <span className="defense-measured">measured: {formatNodeMetric(metric)}</span>}
            </li>;
          })}
        </ul>
      </div>}
      <ul className="defense-rubric-checklist">
        {lesson.defense.rubric.map((item: RubricItem) => <li key={item.id}>
          <label>
            <input type="checkbox" checked={!!selfChecked[item.id]} onChange={() => onToggleRubric(item.id)} disabled={selfRevealed && selfRevised} />
            <span>{item.criterion}</span>
            <span className="defense-rubric-weight">{item.weight}</span>
          </label>
        </li>)}
      </ul>
      <div className="defense-self-total">Total: {lesson.defense.rubric.reduce((sum, item) => (selfChecked[item.id] ? sum + item.weight : sum), 0)}/100</div>
      {!(selfRevealed && selfRevised) && <button type="button" className="button primary" onClick={onConfirmSelf}>{!selfRevealed ? "Confirm blind assessment" : "Confirm final assessment"}<CheckCircle2 size={14} /></button>}
    </div>}
  </>;
}

function WeakConcepts({ ids, rubric }: { ids: string[]; rubric: RubricItem[] }) {
  return <div className="defense-weak-concepts">
    <span className="field-label">Come back to these</span>
    <ul>
      {ids.map((id) => <li key={id}>{rubric.find((item) => item.id === id)?.criterion ?? id}</li>)}
    </ul>
  </div>;
}

function DeductionsList({ deductions }: { deductions: Deduction[] }) {
  return <ul className="defense-deductions">
    {deductions.map((d) => <li key={d.reason}><span>{d.reason}</span><span>-{d.points}</span></li>)}
  </ul>;
}

function ContradictionsList({ items }: { items: GradedContradiction[] }) {
  return <div className="defense-contradictions">
    <span className="field-label">Contradictions with the measured run</span>
    <ul>
      {items.map((item, index) => <li key={`${item.nodeId}-${index}`}>
        <p>You expected <strong>{item.claim}</strong>; measured <strong>{item.measured}</strong>.</p>
        {item.note && <p className="defense-contradiction-note">{item.note}</p>}
      </li>)}
    </ul>
  </div>;
}

function DataModelItemsList({ items }: { items: DataModelItem[] }) {
  return <ul className="defense-datamodel-items">
    {items.map((item) => <li key={item.id}>
      <span className="defense-rubric-score">{item.score}/2</span>
      <p>{item.note}</p>
    </li>)}
  </ul>;
}
