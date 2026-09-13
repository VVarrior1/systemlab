"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Gauge,
  LoaderCircle,
  Mic,
  MicOff,
  MessageSquareText,
  Play,
  Radio,
  Send,
  SkipForward,
  Square,
  Timer,
  TriangleAlert,
  User,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { Architecture, Lesson, SimulationResult, SystemNode, Workload } from "@/lib/types";
import { lessons } from "@/lib/curriculum";
import { useEditor } from "@/lib/editor-store";
import { createSystemNode } from "@/lib/templates";
import { readProgress, saveProgress } from "@/lib/persistence";
import { ASSESSMENT_VERSION } from "@/lib/assessment-version";
import { transcriptStats, type TranscriptStats } from "@/lib/transcript-stats";
import {
  DRIFT_SECONDS,
  FULL_SESSION_MINUTES,
  MOCK_PHASES,
  PHASE_GOALS,
  PHASE_LABELS,
  SESSION_MINUTES,
  apiTranscript,
  createMockSession,
  currentPhase,
  endSession,
  formatClock,
  needsInterrupt,
  nextPhase,
  noteInterrupt,
  phaseBudget,
  phaseOvertime,
  phaseRemaining,
  recordUtterance,
  sessionRemaining,
  summarizeCanvas,
  summarizeRun,
  type InterruptReason,
  type MockPhase,
  type MockSession,
  type RunSummary,
} from "@/lib/mock-session";
import { ArchitectureCanvas } from "./architecture-canvas";
import { Shell } from "./shell";

// ---------------------------------------------------------------- grading shapes
// The mock grader (POST /api/interview, mode "mock", stage "grade") returns the content rubric plus
// the v2.3 additions. Every field is optional here on purpose: a partial body still renders.

interface ScoredItem { id: string; score: number; note?: string }
interface Contradiction { nodeId: string; claim: string; measured: string; note?: string }
interface PerformanceField { score: number; note?: string }
type PerformanceKey = "clarifiedFirst" | "statedNumbers" | "signposted" | "heldPosition" | "managedTime";
interface MockGrade {
  items?: ScoredItem[];
  recoveryScore?: number;
  techScore?: number;
  dataModelScore?: number;
  critique?: string;
  weakConcepts?: string[];
  contradictions?: Contradiction[];
  dataModelItems?: ScoredItem[];
  performance?: Partial<Record<PerformanceKey, PerformanceField>>;
  total?: number;
}
type GradeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "graded"; grade: MockGrade }
  | { status: "self" };

/** The performance rubric, graded from the transcript (§15.1). Ids match the grader's keys. */
const PERFORMANCE_RUBRIC: { id: PerformanceKey; criterion: string }[] = [
  { id: "clarifiedFirst", criterion: "Clarified the requirements before designing anything" },
  { id: "statedNumbers", criterion: "Stated concrete numbers and said where they came from" },
  { id: "signposted", criterion: "Signposted the structure: first, then, the trade-off is" },
  { id: "heldPosition", criterion: "Held or revised a position under pressure, with reasons" },
  { id: "managedTime", criterion: "Managed the clock across the five phases" },
];

/** The four data-model rubric ids the grader returns (lib/interview.ts DataModelItemIdSchema). */
const DATA_MODEL_LABELS: Record<string, string> = {
  "keys-unique": "Keys are unique and stable",
  "partition-key": "The partition key matches the hot path",
  "query-patterns": "Query patterns match the read/write mix",
  growth: "Growth is bounded",
};

/** POST /api/interview caps the transcript it accepts (MAX_TRANSCRIPT_ENTRIES / MAX_TRANSCRIPT_TEXT). */
const MAX_TURNS_SENT = 12;
const MAX_TURN_CHARS = 3000;
const MAX_METRICS_SENT = 30;

// ---------------------------------------------------------------- scripted interviewer (no key)

const SELF_PROMPTS: Record<MockPhase, string[]> = {
  clarify: [
    "Let's start. Tell me what this system has to do, and ask me anything you need about scale and constraints.",
    "Who are the users, how many of them, and what is the read-to-write mix?",
  ],
  estimate: [
    "Before you draw anything: give me the numbers. Requests per second, storage, bandwidth.",
    "Where did that number come from? Walk me through the arithmetic.",
  ],
  design: [
    "Now build it. Talk me through each component as you place it, and why it is sized the way it is.",
    "What happens to that design at ten times the traffic?",
    "Which component fails first, and what does the user see when it does?",
  ],
  "deep-dive": [
    "Pick the riskiest component and go deep: failure, consistency, and what it costs.",
    "Your last run measured something different from what you claimed. Reconcile the two.",
  ],
  wrap: [
    "We're nearly out of time. What would you fix first with another week, and what would you monitor?",
  ],
};

const INTERRUPT_LINES: Record<InterruptReason, string> = {
  "phase-over": "We're out of time for this part - park it and move on.",
  drift: "Let me stop you there. Give me a number or a decision, not a description.",
};

// ---------------------------------------------------------------- speech

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
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Milliseconds of silence after a final result before the running utterance is sent as a turn. */
const PAUSE_MS = 2500;

// ---------------------------------------------------------------- helpers

/** Blank-canvas start: keep only the traffic source, drop every component and every edge. */
function trafficOnly(source: Architecture): Architecture {
  const traffic = source.nodes.filter((node) => node.kind === "traffic");
  return {
    nodes: traffic.length > 0 ? structuredClone(traffic) : [createSystemNode("traffic", "traffic", { x: 40, y: 140 })],
    edges: [],
  };
}

/**
 * Per-node measurements in the shape POST /api/interview validates ({ nodeId, label, value }).
 * The comparable number comes first in `value` because the server's contradiction check reads the
 * first number out of both the claim and the measurement.
 */
function runMetrics(result: SimulationResult | null, graph: Architecture): { nodeId: string; label: string; value: string }[] {
  if (!result) return [];
  return result.nodes.slice(0, MAX_METRICS_SENT).map((metric) => {
    const node = graph.nodes.find((candidate) => candidate.id === metric.nodeId);
    const perSecond = result.duration > 0 ? Math.round((metric.processed / result.duration) * 10) / 10 : metric.processed;
    const utilization = `${Math.round(metric.utilization * 100)}% utilized`;
    if (node && (node.kind === "cache" || node.kind === "cdn")) {
      const steps = result.traces
        .flatMap((trace) => trace.steps)
        .filter((step) => step.nodeId === metric.nodeId && (step.status === "hit" || step.status === "miss"));
      if (steps.length > 0) {
        const hitRate = Math.round((steps.filter((step) => step.status === "hit").length / steps.length) * 100);
        return { nodeId: metric.nodeId, label: node.label, value: `${hitRate}% hit rate over ${steps.length} lookups, ${perSecond} ops/s` };
      }
    }
    return {
      nodeId: metric.nodeId,
      label: node?.label ?? metric.nodeId,
      value: `${perSecond} ops/s served, ${utilization}, ${metric.errors} errors`,
    };
  });
}

function compactRun(result: SimulationResult): RunSummary {
  return {
    p95: result.p95,
    p99: result.p99,
    throughput: result.throughput,
    errorRate: result.errorRate,
    rejectedRate: result.rejectedRate,
    cost: result.cost,
  };
}

/** A sensible expected number per kind, prefilled into the rationale form from the canvas itself. */
function expectedFromCanvas(node: SystemNode): string {
  switch (node.kind) {
    case "cache":
    case "cdn":
      return `${Math.round((node.cacheHitRate ?? 0) * 100)}% hit rate`;
    case "database":
      return `${node.capacity * node.replicas} ops/s`;
    case "server":
      return `${node.capacity * node.replicas} req/s`;
    case "queue":
    case "stream":
      return `${node.capacity} msg/s`;
    case "rate-limiter":
      return `${node.limit ?? node.capacity} req/s accepted`;
    case "object-store":
      return `${node.storedGb ?? 0} GB stored`;
    default:
      return `${node.capacity} req/s`;
  }
}

function meanScore(items: ScoredItem[] | undefined): number | null {
  if (!items || items.length === 0) return null;
  const total = items.reduce((sum, item) => sum + (Number.isFinite(item.score) ? item.score : 0), 0);
  return total / items.length;
}

/** Same idea as `meanScore`, but over the performance rubric, which the grader returns keyed by id rather than as a list. */
function meanPerformanceScore(performance: Partial<Record<PerformanceKey, PerformanceField>> | undefined): number | null {
  if (!performance) return null;
  const values = Object.values(performance).filter((item): item is PerformanceField => !!item);
  if (values.length === 0) return null;
  const total = values.reduce((sum, item) => sum + (Number.isFinite(item.score) ? item.score : 0), 0);
  return total / values.length;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

// ---------------------------------------------------------------- component

interface Rationale { nodeId: string; label: string; kind: string; why: string; expected: string }

export function MockInterview() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedId = searchParams.get("lesson");

  /** Briefs first, then any sim that can be started from a blank canvas. */
  const candidates = useMemo(
    () => lessons.filter((item) => item.kind === "brief" || item.blankCanvas || (item.kind === "sim" && item.allowedKinds.length > 2)),
    []
  );
  const lesson: Lesson = useMemo(
    () => candidates.find((item) => item.id === requestedId) ?? candidates[0]!,
    [candidates, requestedId]
  );

  const { architecture, workload, initialize } = useEditor();
  const [minutes, setMinutes] = useState<number>(FULL_SESSION_MINUTES);
  const [session, setSession] = useState<MockSession>(() => createMockSession(lesson.id, FULL_SESSION_MINUTES));
  const [started, setStarted] = useState(false);
  const [ready, setReady] = useState(false);

  const [draft, setDraft] = useState("");
  const [interim, setInterim] = useState("");
  const [listening, setListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [speakAloud, setSpeakAloud] = useState(true);
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [selfMode, setSelfMode] = useState(false);
  const [error, setError] = useState("");

  const [result, setResult] = useState<SimulationResult | null>(null);
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);
  const [running, setRunning] = useState(false);

  const [rationales, setRationales] = useState<Rationale[]>([]);
  const [dataModel, setDataModel] = useState("");
  const [grade, setGrade] = useState<GradeState>({ status: "idle" });
  const [selfContent, setSelfContent] = useState<Record<string, boolean>>({});
  const [selfPerformance, setSelfPerformance] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState(false);

  const sessionRef = useRef(session);
  const draftRef = useRef("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const wantListening = useRef(false);
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scriptRef = useRef<string[]>([]);
  const scriptIndex = useRef(0);
  const askingRef = useRef(false);
  const workerRef = useRef<Worker | null>(null);
  const transcriptEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { draftRef.current = draft; }, [draft]);

  // ---------------------------------------------------------------- setup

  useEffect(() => {
    setSpeechSupported(!!getSpeechRecognitionCtor());
    setVoiceSupported(typeof window !== "undefined" && "speechSynthesis" in window);
  }, []);

  useEffect(() => {
    const starter = trafficOnly(lesson.architecture);
    const traffic: Workload = { ...lesson.workload };
    initialize(starter, traffic);
    setReady(true);
    setSession(createMockSession(lesson.id, minutes));
    setStarted(false);
    setResult(null);
    setLastRun(null);
    setDraft("");
    setInterim("");
    setGrade({ status: "idle" });
    setSelfMode(false);
    setSaved(false);
    setRationales([]);
    setDataModel("");
    scriptRef.current = [];
    scriptIndex.current = 0;
    // `minutes` deliberately excluded: changing the length before the start re-creates the session below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson, initialize]);

  useEffect(() => {
    if (started) return;
    setSession(createMockSession(lesson.id, minutes));
  }, [minutes, lesson.id, started]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: "end" });
  }, [session.transcript.length, interim]);

  // ---------------------------------------------------------------- simulation

  const simulate = useCallback((graph: Architecture, traffic: Workload) => new Promise<SimulationResult>((resolve, reject) => {
    const worker = new Worker(new URL("../lib/simulation.worker.ts", import.meta.url));
    workerRef.current = worker;
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("That run took too long. Simplify the design and try again."));
    }, 20000);
    const cleanup = () => { clearTimeout(timeout); worker.terminate(); workerRef.current = null; };
    worker.onmessage = (event: MessageEvent<{ result?: SimulationResult; error?: string }>) => {
      cleanup();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.result) resolve(event.data.result);
      else reject(new Error("The simulation returned an incomplete result."));
    };
    worker.onerror = (event) => { cleanup(); reject(new Error(event.message || "The simulation worker could not start.")); };
    worker.postMessage({ id: crypto.randomUUID(), architecture: graph, workload: traffic });
  }), []);

  useEffect(() => () => { workerRef.current?.terminate(); }, []);

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setError("");
    try {
      const output = await simulate(architecture, workload);
      setResult(output);
      setLastRun(compactRun(output));
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "The run failed.");
    } finally {
      setRunning(false);
    }
  }, [architecture, workload, running, simulate]);

  // ---------------------------------------------------------------- interviewer

  const speak = useCallback((text: string, onDone?: () => void) => {
    if (!speakAloud || typeof window === "undefined" || !("speechSynthesis" in window)) { onDone?.(); return; }
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.02;
      utterance.onend = () => onDone?.();
      utterance.onerror = () => onDone?.();
      window.speechSynthesis.speak(utterance);
    } catch {
      onDone?.();
    }
  }, [speakAloud]);

  const stopListening = useCallback(() => {
    wantListening.current = false;
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const startListening = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    if (recognitionRef.current) recognitionRef.current.stop();
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event: any) => {
      let interimText = "";
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const item = event.results[i];
        if (item.isFinal) finalText += item[0].transcript;
        else interimText += item[0].transcript;
      }
      if (finalText) {
        setInterim("");
        setDraft((prev) => `${prev}${prev && !prev.endsWith(" ") ? " " : ""}${finalText.trim()}`);
        schedulePause();
      } else {
        setInterim(interimText);
      }
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => {
      setListening(false);
      // Chrome ends the stream on its own every minute or so; a continuous session restarts it.
      if (wantListening.current) { try { recognition.start(); setListening(true); } catch { /* already starting */ } }
    };
    recognitionRef.current = recognition;
    wantListening.current = true;
    try { recognition.start(); setListening(true); } catch { /* already started */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => { wantListening.current = false; recognitionRef.current?.stop(); }, []);

  /** Sends the interviewer's next line into the transcript, speaking it when the voice is on. */
  const deliver = useCallback((text: string, options: { intent?: string; interrupt?: boolean }) => {
    setSession((prev) => recordUtterance(prev, "interviewer", text, options));
    if (options.interrupt) {
      const resume = wantListening.current;
      stopListening();
      speak(text, () => { if (resume) startListening(); });
      return;
    }
    speak(text);
  }, [speak, startListening, stopListening]);

  const scriptedLine = useCallback((phase: MockPhase, interruptReason: InterruptReason | null): string => {
    if (interruptReason) return INTERRUPT_LINES[interruptReason];
    const script = scriptRef.current;
    if (scriptIndex.current < script.length) return script[scriptIndex.current++]!;
    const prompts = SELF_PROMPTS[phase];
    const spoken = sessionRef.current.transcript.filter((entry) => entry.role === "interviewer" && entry.phase === phase).length;
    return prompts[Math.min(spoken, prompts.length - 1)]!;
  }, []);

  const askInterviewer = useCallback(async (interruptReason: InterruptReason | null = null) => {
    if (askingRef.current) return;
    askingRef.current = true;
    const current = sessionRef.current;
    const phase = currentPhase(current);
    setThinking(true);
    try {
      if (selfMode) {
        deliver(scriptedLine(phase, interruptReason), { intent: interruptReason ?? "probe", interrupt: !!interruptReason });
        return;
      }
      const stats = transcriptStats(current.transcript.map((entry) => ({
        role: entry.role,
        text: entry.text,
        at: entry.at * 1000,
        phase: entry.phase,
      })));
      const response = await fetch("/api/interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonId: lesson.id,
          mode: "mock",
          stage: "turn",
          phase,
          elapsedSeconds: current.elapsedSeconds,
          phaseElapsedSeconds: current.phaseElapsedSeconds,
          transcript: apiTranscript(current),
          context: {
            canvas: summarizeCanvas(architecture),
            lastRun: summarizeRun(lastRun),
            rationales,
            dataModel,
            stats: { ...stats, secondsPerPhase: current.phaseSeconds },
          },
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        if (response.status === 501 && body && Array.isArray(body.script)) scriptRef.current = body.script.filter((line: unknown) => typeof line === "string");
        setSelfMode(true);
        deliver(scriptedLine(phase, interruptReason), { intent: interruptReason ?? "probe", interrupt: !!interruptReason });
        return;
      }
      const body = (await response.json()) as { utterance?: string; intent?: string; interrupt?: boolean; done?: boolean };
      const utterance = typeof body.utterance === "string" && body.utterance.trim() ? body.utterance.trim() : scriptedLine(phase, interruptReason);
      deliver(utterance, { intent: body.intent, interrupt: body.interrupt === true || !!interruptReason });
      if (body.done === true) setSession((prev) => endSession(prev));
    } catch {
      setSelfMode(true);
      deliver(scriptedLine(phase, interruptReason), { intent: interruptReason ?? "probe", interrupt: !!interruptReason });
    } finally {
      setThinking(false);
      askingRef.current = false;
    }
  }, [architecture, dataModel, deliver, lastRun, lesson.id, rationales, scriptedLine, selfMode]);

  // ---------------------------------------------------------------- the candidate's turn

  const sendTurn = useCallback(() => {
    if (pauseTimer.current) { clearTimeout(pauseTimer.current); pauseTimer.current = null; }
    const text = draftRef.current.trim();
    if (!text || askingRef.current) return;
    setDraft("");
    setInterim("");
    setSession((prev) => recordUtterance(prev, "candidate", text));
    // The state update above is queued; sessionRef catches up on the next render, so defer the call.
    setTimeout(() => { void askInterviewer(null); }, 0);
  }, [askInterviewer]);

  const sendTurnRef = useRef(sendTurn);
  useEffect(() => { sendTurnRef.current = sendTurn; }, [sendTurn]);

  function schedulePause() {
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
    pauseTimer.current = setTimeout(() => { sendTurnRef.current(); }, PAUSE_MS);
  }

  useEffect(() => () => { if (pauseTimer.current) clearTimeout(pauseTimer.current); }, []);

  // ---------------------------------------------------------------- clocks

  useEffect(() => {
    if (!started || session.ended) return;
    const timer = setInterval(() => setSession((prev) => {
      const next = { ...prev };
      return next.ended ? next : tickOnce(prev);
    }), 1000);
    return () => clearInterval(timer);
  }, [started, session.ended]);

  // The interviewer's own reasons to cut in: the phase clock, or 90 s of speech with no substance.
  useEffect(() => {
    if (!started || session.ended || askingRef.current) return;
    const reason = needsInterrupt(session);
    if (!reason) return;
    setSession((prev) => noteInterrupt(prev, reason));
    void askInterviewer(reason);
  }, [session, started, askInterviewer]);

  // The session clock running out ends it, exactly like leaving wrap-up.
  useEffect(() => {
    if (session.ended) { stopListening(); }
  }, [session.ended, stopListening]);

  // ---------------------------------------------------------------- session control

  function startSession() {
    const fresh = createMockSession(lesson.id, minutes);
    setSession(fresh);
    sessionRef.current = fresh;
    setStarted(true);
    setGrade({ status: "idle" });
    setTimeout(() => { void askInterviewer(null); }, 0);
    if (speechSupported) startListening();
  }

  function goNextPhase() {
    setSession((prev) => nextPhase(prev));
    setTimeout(() => { void askInterviewer(null); }, 0);
  }

  function finishEarly() {
    setSession((prev) => endSession(prev));
  }

  // ---------------------------------------------------------------- wrap-up

  useEffect(() => {
    if (!session.ended || rationales.length > 0) return;
    setRationales(architecture.nodes
      .filter((node) => node.kind !== "traffic")
      .map((node) => ({ nodeId: node.id, label: node.label, kind: node.kind, why: "", expected: expectedFromCanvas(node) })));
  }, [session.ended, architecture.nodes, rationales.length]);

  const stats: TranscriptStats = useMemo(() => transcriptStats(session.transcript.map((entry) => ({
    role: entry.role,
    text: entry.text,
    at: entry.at * 1000,
    phase: entry.phase,
  }))), [session.transcript]);

  const persist = useCallback((total: number, performanceScore: number, contradictions: number, dataModelScore: number, mode: "graded" | "self") => {
    const prior = readProgress().find((record) => record.lessonId === lesson.id);
    saveProgress({
      lessonId: lesson.id,
      completedAt: new Date().toISOString(),
      bestP95: result ? Math.round(result.p95) : (prior?.bestP95 ?? 0),
      cost: result ? result.cost : (prior?.cost ?? 0),
      assessmentVersion: ASSESSMENT_VERSION,
      mockSessions: (prior?.mockSessions ?? 0) + 1,
      performanceScore: Math.round(performanceScore),
      contradictions,
      dataModelScore,
      defenseScore: Math.round(total),
      defenseMode: mode,
    });
    if (typeof window !== "undefined") window.dispatchEvent(new Event("progress-updated"));
    setSaved(true);
  }, [lesson.id, result]);

  async function requestGrade() {
    setGrade({ status: "loading" });
    setError("");
    const current = sessionRef.current;
    try {
      const response = await fetch("/api/interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonId: lesson.id,
          mode: "mock",
          stage: "grade",
          phase: currentPhase(current),
          elapsedSeconds: current.elapsedSeconds,
          phaseElapsedSeconds: current.phaseElapsedSeconds,
          transcript: apiTranscript(current, 40),
          context: {
            canvas: summarizeCanvas(architecture),
            lastRun: summarizeRun(lastRun),
            rationales,
            dataModel,
            stats: { ...stats, secondsPerPhase: current.phaseSeconds },
          },
        }),
      });
      if (!response.ok) {
        if (response.status !== 501) {
          const body = await response.json().catch(() => null);
          if (body && typeof body.error === "string") setError(body.error);
        }
        setGrade({ status: "self" });
        return;
      }
      const body = (await response.json()) as MockGrade;
      setGrade({ status: "graded", grade: body });
      const performance = meanPerformanceScore(body.performance);
      const dataModelGrade = typeof body.dataModelScore === "number" ? body.dataModelScore : meanScore(body.dataModelItems);
      persist(
        typeof body.total === "number" ? body.total : 0,
        performance === null ? 0 : (performance / 2) * 100,
        body.contradictions?.length ?? 0,
        dataModelGrade === null ? 0 : (dataModelGrade / 2) * 100,
        "graded"
      );
    } catch {
      setError("Could not reach the interviewer. Assess yourself against the rubric instead.");
      setGrade({ status: "self" });
    }
  }

  function confirmSelfAssessment() {
    const contentTotal = lesson.defense.rubric.reduce((sum, item) => (selfContent[item.id] ? sum + item.weight : sum), 0);
    const performanceTicks = PERFORMANCE_RUBRIC.filter((item) => selfPerformance[item.id]).length;
    persist(contentTotal, (performanceTicks / PERFORMANCE_RUBRIC.length) * 100, 0, 0, "self");
  }

  // ---------------------------------------------------------------- render

  const phase = currentPhase(session);
  const overtime = phaseOvertime(session);

  const topBar = <div className="mock-topbar">
    <div className="mock-clock-group">
      <span className={`mock-clock ${sessionRemaining(session) < 120 ? "over" : ""}`}>
        <Timer size={14} />{formatClock(sessionRemaining(session))} left
      </span>
      <span className="mock-phase-pill">{PHASE_LABELS[phase]}</span>
      <span className={`mock-clock small ${overtime > 0 ? "over" : ""}`}>
        {overtime > 0 ? `+${formatClock(overtime)} over` : `${formatClock(phaseRemaining(session))} of ${formatClock(phaseBudget(session))}`}
      </span>
      {selfMode && <span className="mock-self-badge"><TriangleAlert size={12} />Scripted interviewer</span>}
      {!selfMode && started && <span className="mock-live-badge"><Radio size={12} />Live interviewer</span>}
    </div>
    <div className="mock-topbar-actions">
      <button type="button" className="button small" onClick={goNextPhase} disabled={session.ended}>
        <SkipForward size={13} />Next phase
      </button>
      <button type="button" className="button small" onClick={finishEarly} disabled={session.ended}>
        <Square size={12} />End session
      </button>
    </div>
  </div>;

  const setup = <div className="mock-setup">
    <div className="mock-setup-card">
      <div className="field-label">Brief</div>
      <select
        value={lesson.id}
        onChange={(event) => router.replace(`/mock?lesson=${event.target.value}`)}
        aria-label="Choose a brief"
      >
        {candidates.map((item) => <option key={item.id} value={item.id}>{item.title} — {item.difficulty}</option>)}
      </select>
      <p className="mock-brief-text">{lesson.brief}</p>

      <div className="field-label">Session length</div>
      <div className="segmented">
        {SESSION_MINUTES.map((option) => <button
          key={option}
          type="button"
          className={minutes === option ? "active" : ""}
          onClick={() => setMinutes(option)}
        >{option} minutes</button>)}
      </div>

      <ul className="mock-phase-preview">
        {session.plan.map((slot) => <li key={slot.phase}>
          <span>{PHASE_LABELS[slot.phase]}</span>
          <span className="mono">{formatClock(slot.seconds)}</span>
        </li>)}
      </ul>

      <label className="mock-toggle">
        <input type="checkbox" checked={speakAloud} onChange={(event) => setSpeakAloud(event.target.checked)} disabled={!voiceSupported} />
        <span>{voiceSupported ? "Speak the interviewer's lines aloud" : "This browser cannot speak the interviewer's lines"}</span>
      </label>
      <p className="mock-note">
        {speechSupported
          ? `Your microphone stays on for the whole session. Pause for ${PAUSE_MS / 1000} seconds, or press Send, and the interviewer replies.`
          : "Speech recognition is unavailable here (try Chrome or Safari) — type your answers instead. Everything else works the same."}
      </p>
      <button type="button" className="button primary" onClick={startSession} disabled={!ready}>
        <Play size={15} fill="currentColor" />Start the interview
      </button>
    </div>
  </div>;

  const transcriptView = <div className="mock-transcript">
    {session.transcript.length === 0 && !started && <p className="mock-empty">The interviewer opens the session once you start.</p>}
    {session.transcript.map((entry, index) => <div
      key={index}
      className={`mock-turn ${entry.role}${entry.interrupt ? " interrupt" : ""}`}
    >
      <span className="mock-avatar">{entry.role === "interviewer" ? <MessageSquareText size={13} /> : <User size={13} />}</span>
      <div>
        <div className="mock-turn-head">
          <span className="mock-role">{entry.role === "interviewer" ? "Interviewer" : "You"}</span>
          <span className="mock-turn-phase">{PHASE_LABELS[entry.phase]}</span>
          <span className="mock-turn-time mono">{formatClock(entry.at)}</span>
          {entry.interrupt && <span className="mock-interrupt-tag">interrupts</span>}
        </div>
        <p>{entry.text}</p>
      </div>
    </div>)}
    {interim && <div className="mock-turn candidate interim">
      <span className="mock-avatar"><Mic size={13} /></span>
      <div><div className="mock-turn-head"><span className="mock-role">You</span><span className="mock-turn-phase">listening</span></div><p>{interim}</p></div>
    </div>}
    {thinking && <div className="mock-thinking"><LoaderCircle size={14} className="spin" />The interviewer is thinking...</div>}
    <div ref={transcriptEnd} />
  </div>;

  const inputRow = <div className="mock-input">
    <textarea
      rows={3}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); sendTurn(); } }}
      placeholder={listening ? "Listening — keep talking, or type here." : "Type your answer, or turn the microphone on."}
      disabled={session.ended}
    />
    <div className="mock-input-actions">
      {speechSupported ? <button
        type="button"
        className={`button small ${listening ? "active" : ""}`}
        onClick={() => (listening ? stopListening() : startListening())}
        disabled={session.ended}
      >{listening ? <><Mic size={13} />Listening</> : <><MicOff size={13} />Microphone off</>}</button>
        : <span className="mock-note small">Typing only in this browser.</span>}
      <button
        type="button"
        className={`button small ${speakAloud ? "active" : ""}`}
        onClick={() => setSpeakAloud((value) => !value)}
        disabled={!voiceSupported}
      >{speakAloud ? <Volume2 size={13} /> : <VolumeX size={13} />}{speakAloud ? "Voice on" : "Voice off"}</button>
      <button type="button" className="button primary small" onClick={sendTurn} disabled={session.ended || !draft.trim()}>
        <Send size={13} />Send
      </button>
    </div>
  </div>;

  const canvasColumn = <div className="mock-canvas-column">
    <div className="mock-canvas-head">
      <span className="field-label">Your design</span>
      <span className="mock-run-summary mono">{summarizeRun(lastRun)}</span>
      <button type="button" className="button small primary" onClick={run} disabled={running || !ready}>
        {running ? <LoaderCircle size={13} className="spin" /> : <Play size={13} fill="currentColor" />}Run
      </button>
    </div>
    {ready ? <ArchitectureCanvas
      result={result}
      running={running}
      allowedKinds={lesson.allowedKinds}
      onReset={() => initialize(trafficOnly(lesson.architecture), { ...lesson.workload })}
    /> : <div className="canvas-loading"><LoaderCircle size={23} className="spin" />Opening canvas...</div>}
  </div>;

  const statsView = <div className="mock-stats">
    <div className="mock-stat"><Activity size={14} /><strong>{Math.round(stats.wordsPerMinute)}</strong><span>words / min</span></div>
    <div className="mock-stat"><Gauge size={14} /><strong>{percent(stats.fillerRatio)}</strong><span>filler words</span></div>
    <div className="mock-stat"><Clock3 size={14} /><strong>{stats.numbersStated}</strong><span>numbers stated</span></div>
    <div className="mock-stat"><ChevronRight size={14} /><strong>{stats.signposts}</strong><span>signposts</span></div>
    <div className="mock-stat"><Radio size={14} /><strong>{percent(stats.candidateShare)}</strong><span>you talked</span></div>
    <div className="mock-stat"><MessageSquareText size={14} /><strong>{session.interruptions}</strong><span>interruptions</span></div>
  </div>;

  const phaseTimes = <ul className="mock-phase-times">
    {MOCK_PHASES.map((item) => <li key={item}>
      <span>{PHASE_LABELS[item]}</span>
      <span className="mono">{formatClock(session.phaseSeconds[item])}</span>
    </li>)}
  </ul>;

  const wrapForm = <div className="mock-wrap">
    <h2>Before the grade: what did you expect?</h2>
    <p className="mock-note">
      One line per component — why it is there and the number you expect from it. The grader compares each
      claim with what the run actually measured, and every contradiction costs you.
    </p>
    <div className="mock-rationales">
      {rationales.map((item, index) => <div className="mock-rationale" key={item.nodeId}>
        <div className="mock-rationale-head"><strong>{item.label}</strong><span className="mock-kind">{item.kind}</span></div>
        <input
          value={item.why}
          placeholder="Why is it here?"
          onChange={(event) => setRationales((prev) => prev.map((row, i) => (i === index ? { ...row, why: event.target.value } : row)))}
        />
        <input
          value={item.expected}
          placeholder="Expected number"
          onChange={(event) => setRationales((prev) => prev.map((row, i) => (i === index ? { ...row, expected: event.target.value } : row)))}
        />
      </div>)}
      {rationales.length === 0 && <p className="mock-empty">You did not place any components. The grade will say so.</p>}
    </div>
    <label className="field-label" htmlFor="mock-data-model">Data model</label>
    <textarea
      id="mock-data-model"
      rows={5}
      value={dataModel}
      onChange={(event) => setDataModel(event.target.value)}
      placeholder={lesson.dataModelPrompt ?? "Entities, keys, partitioning and the query patterns each one serves."}
    />
    <button type="button" className="button primary" onClick={requestGrade} disabled={grade.status === "loading"}>
      {grade.status === "loading" ? <><LoaderCircle size={15} className="spin" />Grading...</> : <>Grade my interview<ArrowRight size={15} /></>}
    </button>
  </div>;

  const gradedView = grade.status === "graded" ? <div className="mock-grade">
    <div className="mock-grade-head">
      <span className="mock-total">{Math.round(grade.grade.total ?? 0)}/100</span>
      {typeof grade.grade.recoveryScore === "number" && <span className="mock-subscore">recovery {grade.grade.recoveryScore}/2</span>}
      {typeof grade.grade.techScore === "number" && <span className="mock-subscore">tech {grade.grade.techScore}/2</span>}
      {typeof grade.grade.dataModelScore === "number" && <span className="mock-subscore">data model {grade.grade.dataModelScore}/2</span>}
      {saved && <span className="mock-saved"><CheckCircle2 size={13} />Saved to your progress</span>}
    </div>

    {grade.grade.items && grade.grade.items.length > 0 && <section>
      <h3>Content rubric</h3>
      <ul className="mock-rubric">
        {grade.grade.items.map((item) => {
          const criterion = lesson.defense.rubric.find((entry) => entry.id === item.id);
          return <li key={item.id}>
            <span className="mock-score">{item.score}/2</span>
            <div><strong>{criterion?.criterion ?? item.id}</strong>{item.note && <p>{item.note}</p>}</div>
          </li>;
        })}
      </ul>
    </section>}

    {grade.grade.contradictions && grade.grade.contradictions.length > 0 && <section>
      <h3>Contradictions <span className="mock-penalty">-5 each</span></h3>
      <ul className="mock-contradictions">
        {grade.grade.contradictions.map((item, index) => <li key={`${item.nodeId}-${index}`}>
          <CircleAlert size={14} />
          <div>
            <strong>{item.claim}</strong>
            <p>Measured: {item.measured}{item.note ? ` — ${item.note}` : ""}</p>
          </div>
        </li>)}
      </ul>
    </section>}

    {grade.grade.dataModelItems && grade.grade.dataModelItems.length > 0 && <section>
      <h3>Data model</h3>
      <ul className="mock-rubric">
        {grade.grade.dataModelItems.map((item) => <li key={item.id}>
          <span className="mock-score">{item.score}/2</span>
          <div><strong>{item.id}</strong>{item.note && <p>{item.note}</p>}</div>
        </li>)}
      </ul>
    </section>}

    {grade.grade.performance && Object.keys(grade.grade.performance).length > 0 && <section>
      <h3>Performance</h3>
      <ul className="mock-rubric">
        {(Object.entries(grade.grade.performance) as [PerformanceKey, PerformanceField][]).map(([id, item]) => {
          const criterion = PERFORMANCE_RUBRIC.find((entry) => entry.id === id);
          return <li key={id}>
            <span className="mock-score">{item.score}/2</span>
            <div><strong>{criterion?.criterion ?? id}</strong>{item.note && <p>{item.note}</p>}</div>
          </li>;
        })}
      </ul>
    </section>}

    {grade.grade.critique && <section><h3>Critique</h3><p className="mock-critique">{grade.grade.critique}</p></section>}
  </div> : null;

  const selfView = grade.status === "self" ? <div className="mock-grade">
    <p className="mock-note">
      Grading is unavailable, so this is a blind self-assessment: tick what you genuinely covered before you
      look at the model answer. The transcript stats below are measured either way.
    </p>
    <section>
      <h3>Content rubric</h3>
      <ul className="mock-self-checklist">
        {lesson.defense.rubric.map((item) => <li key={item.id}>
          <label>
            <input
              type="checkbox"
              checked={!!selfContent[item.id]}
              disabled={saved}
              onChange={() => setSelfContent((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
            />
            <span>{item.criterion}</span>
            <span className="mock-weight mono">{item.weight}</span>
          </label>
        </li>)}
      </ul>
    </section>
    <section>
      <h3>Performance</h3>
      <ul className="mock-self-checklist">
        {PERFORMANCE_RUBRIC.map((item) => <li key={item.id}>
          <label>
            <input
              type="checkbox"
              checked={!!selfPerformance[item.id]}
              disabled={saved}
              onChange={() => setSelfPerformance((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
            />
            <span>{item.criterion}</span>
          </label>
        </li>)}
      </ul>
    </section>
    {!saved
      ? <button type="button" className="button primary" onClick={confirmSelfAssessment}>Record this session<ArrowRight size={15} /></button>
      : <><p className="mock-model-answer">{lesson.defense.modelAnswer}</p><span className="mock-saved"><CheckCircle2 size={13} />Saved to your progress</span></>}
  </div> : null;

  return <Shell currentLessonId={lesson.id}>
    <header className="topbar">
      <div className="breadcrumb"><Link href="/learn">Learning path</Link><ChevronRight size={13} /><span>Mock interview</span></div>
      <div className="topbar-right">
        <span className="save-status"><Clock3 size={13} />{minutes} min session</span>
      </div>
    </header>

    <div className="workspace-heading">
      <div>
        <div className="eyebrow">VOICE MOCK INTERVIEW</div>
        <h1>{lesson.title}<span className={`difficulty ${lesson.difficulty.toLowerCase()}`}>{lesson.difficulty}</span></h1>
        <p>{lesson.subtitle}</p>
      </div>
    </div>

    {error && <div className="workspace-alert" role="alert"><CircleAlert size={17} /><span>{error}</span></div>}

    {!started ? setup : <>
      {topBar}
      <p className="mock-phase-goal">{PHASE_GOALS[phase]}</p>
      <div className="mock-grid">
        <div className="mock-left">
          {transcriptView}
          {inputRow}
        </div>
        {canvasColumn}
      </div>

      {session.ended && <div className="mock-results">
        <div className="mock-results-head">
          <h2>Session complete</h2>
          <span className="mock-note">
            {formatClock(session.elapsedSeconds)} spoken across {session.transcript.length} turns, {session.interruptions} interruption{session.interruptions === 1 ? "" : "s"}.
          </span>
        </div>
        {statsView}
        {phaseTimes}
        {grade.status === "idle" || grade.status === "loading" ? wrapForm : null}
        {gradedView}
        {selfView}
        {saved && <div className="mock-next">
          <Link className="button" href={`/learn/${lesson.id}`}>Open the full lesson<ArrowRight size={15} /></Link>
        </div>}
      </div>}
    </>}
  </Shell>;
}

/** One second of session clock. Split out so the interval body stays a pure call. */
function tickOnce(session: MockSession): MockSession {
  return {
    ...session,
    elapsedSeconds: session.elapsedSeconds + 1,
    phaseElapsedSeconds: session.phaseElapsedSeconds + 1,
    phaseSeconds: { ...session.phaseSeconds, [currentPhase(session)]: session.phaseSeconds[currentPhase(session)] + 1 },
    ended: session.elapsedSeconds + 1 >= session.totalSeconds,
  };
}
