"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleAlert, Clock3, Download, Eraser, FlaskConical, GitBranch, LoaderCircle, Play, Plus, RotateCcw, Save, Shuffle, Timer, Trash2, X } from "lucide-react";
import type { Architecture, EstimationId, FailureEvent, Lesson, LessonKind, NodeKind, ProgressRecord, SimulationResult, SystemNode, Workload } from "@/lib/types";
import { lessons } from "@/lib/curriculum";
import { createSystemNode, defaultWorkload, sandboxArchitecture, templates } from "@/lib/templates";
import { getPersistenceWarning, readAttempts, readDesigns, readDraft, readProgress, recordAttempt, saveDesign, saveDraft, saveProgress } from "@/lib/persistence";
import { assessmentSeeds, checkedObjectives, objectivePasses, validateMissionArchitecture, type MissionValidation } from "@/lib/assessment";
import { ASSESSMENT_VERSION, isCurrentProgress } from "@/lib/assessment-version";
import { estimationComplete, meanEstimationScore, scoreEstimations, type EstimationOutcome, type EstimationValues } from "@/lib/estimation";
import { compareAlternative, generateAlternatives } from "@/lib/alternatives";
import { deriveRemixObjectives, remixLesson } from "@/lib/remix";
import { LIMITS } from "@/lib/simulation/validate";
import { useEditor } from "@/lib/editor-store";
import { Shell } from "./shell";
import { Modal, Tip } from "./ui";
import { ArchitectureCanvas } from "./architecture-canvas";
import { Results, type AlternativeView } from "./results";
/** v2.3: `seedSpread` is added to Results by the results-view agent working concurrently on
 *  this file; cast until its prop type declares it, per the addendum's guidance. */
const ResultsWithSpread = Results as unknown as (props: Record<string, unknown>) => ReturnType<typeof Results>;
import { MissionPanel } from "./mission-panel";
import { DefenseStage, type DefenseOutcome, type InterviewContext } from "./defense-stage";
import { TechStage, type TechCommit } from "./tech-stage";
import { ClarificationStage } from "./clarification-stage";

const sandboxKinds: NodeKind[] = ["server", "load-balancer", "database", "cache", "queue", "cdn", "rate-limiter"];
const failureKinds: FailureEvent["kind"][] = ["server", "database", "cache-flush", "slow-database", "slow-server", "region", "flapping", "error-burst", "partition", "slow-partition"];
const failureKindLabels: Record<FailureEvent["kind"], string> = {
  server: "Server replica dies",
  database: "Database replica dies",
  "cache-flush": "Cache flushed (cold start)",
  "slow-database": "Database slows down",
  "slow-server": "Server slows down",
  region: "Region outage",
  flapping: "Replica flaps (dead/alive)",
  "error-burst": "Replica error burst",
  partition: "Network partition splits replicas",
  "slow-partition": "One partition slows down",
};

/** Extra seeds Check runs beyond the three assessment seeds, to show min/median/max spread. */
const VARIANCE_SEEDS = [4242, 9001];
interface SeedSpread { p95: [number, number, number]; throughput: [number, number, number]; errorRate: [number, number, number] }

function minMedianMax(values: number[]): [number, number, number] {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  return [sorted[0]!, mid, sorted[n - 1]!];
}

function seedSpreadFrom(results: SimulationResult[]): SeedSpread {
  return {
    p95: minMedianMax(results.map((r) => r.p95)),
    throughput: minMedianMax(results.map((r) => r.throughput)),
    errorRate: minMedianMax(results.map((r) => r.errorRate)),
  };
}

/** Per-node measurements from the last run, handed to the interviewer and shown next to claims in self mode. */
function nodeMetricSummaries(result: SimulationResult | null, architecture: Architecture): { nodeId: string; label: string; kind: string; utilization: number; processedPerSec: number; errors: number; hitRate?: number; shardSpread?: number[] }[] {
  if (!result) return [];
  return result.nodes.map((metric) => {
    const node = architecture.nodes.find((candidate) => candidate.id === metric.nodeId);
    const processedPerSec = result.duration > 0 ? Math.round((metric.processed / result.duration) * 10) / 10 : metric.processed;
    let hitRate: number | undefined;
    if (node?.kind === "cache") {
      const steps = result.traces.flatMap((trace) => trace.steps).filter((step) => step.nodeId === metric.nodeId && (step.status === "hit" || step.status === "miss"));
      if (steps.length > 0) hitRate = Math.round((steps.filter((step) => step.status === "hit").length / steps.length) * 1000) / 1000;
    }
    return {
      nodeId: metric.nodeId,
      label: node?.label ?? metric.nodeId,
      kind: node?.kind ?? "server",
      utilization: metric.utilization,
      processedPerSec,
      errors: metric.errors,
      ...(hitRate !== undefined ? { hitRate } : {}),
      ...(metric.shards ? { shardSpread: metric.shards } : {}),
    };
  });
}

/** The failure events a workload actually runs, including the legacy single-failure shorthand. */
function failureRows(workload: Workload): FailureEvent[] {
  if (workload.failures) return workload.failures;
  return workload.failure === "none" ? [] : [{ kind: workload.failure, at: 0.5 }];
}

function failureSummary(workload: Workload): string {
  const rows = failureRows(workload);
  if (rows.length === 0) return "no injected failure";
  if (rows.length === 1) return `one ${failureKindLabels[rows[0].kind].toLowerCase()} event`;
  return `${rows.length} injected failure events`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}

// ---------------------------------------------------------------- v2.2 wall clock

/** One clock per lesson visit. Interview budgets: 40 min for a brief, 15 for a sim, 12 for a written lesson. */
const WALL_CLOCK_BUDGET: Record<LessonKind, number> = { brief: 40 * 60, sim: 15 * 60, written: 12 * 60 };

function formatDuration(seconds: number): string {
  const clamped = Math.max(0, Math.round(seconds));
  return `${Math.floor(clamped / 60)}:${String(clamped % 60).padStart(2, "0")}`;
}

/** Starts on the first interaction and never stops: past the budget it accumulates overtime instead. */
function useWallClock(key: string, budgetSeconds: number) {
  const [started, setStarted] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => { setStarted(false); setElapsed(0); }, [key]);
  useEffect(() => {
    if (!started) return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [started]);

  const start = useCallback(() => setStarted(true), []);
  return {
    started,
    elapsed,
    remaining: Math.max(0, budgetSeconds - elapsed),
    overtime: Math.max(0, elapsed - budgetSeconds),
    start,
  };
}

// ---------------------------------------------------------------- v2.2 interviewer context

/** Blank-canvas start: keep only the traffic source, drop every component and every edge. */
function trafficOnly(source: Architecture): Architecture {
  const traffic = source.nodes.filter((node) => node.kind === "traffic");
  return {
    nodes: traffic.length > 0 ? structuredClone(traffic) : [createSystemNode("traffic", "traffic", { x: 40, y: 140 })],
    edges: [],
  };
}

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
    if (node.dbMode === "sharded") settings.push(`${node.shards ?? 1} ${node.shardStrategy ?? "hash"} shards`);
    if (node.dbMode === "quorum") settings.push(`W${node.quorumWrite ?? 2}/R${node.quorumRead ?? 2}`);
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
  return settings;
}

/** One line per node: label, kind, capacity x replicas, key settings, connections. */
function architectureSummary(architecture: Architecture): string {
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

/** The headline numbers from the most recent check or run. */
function resultSummary(result: SimulationResult | null): string {
  if (!result) return "No run yet.";
  return [
    `p95 ${Math.round(result.p95)}ms`,
    `p99 ${Math.round(result.p99)}ms`,
    `throughput ${result.throughput.toFixed(1)} req/s`,
    `error rate ${(result.errorRate * 100).toFixed(2)}%`,
    `rejected ${(result.rejectedRate * 100).toFixed(2)}%`,
    `cost $${result.cost.toFixed(2)}/h`,
  ].join(", ");
}

export function Playground({ lesson }: { lesson?: Lesson }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryId = lesson ? null : searchParams.get("design");
  const { architecture, workload, initialize, setWorkload, revision } = useEditor();
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [baseline, setBaseline] = useState<SimulationResult | null>(null);
  const [resultWorkload, setResultWorkload] = useState<Workload | null>(null);
  const [baselineWorkload, setBaselineWorkload] = useState<Workload | null>(null);
  const [running, setRunning] = useState(false);
  const [runLabel, setRunLabel] = useState("Run simulation");
  const [resultRevision, setResultRevision] = useState(-1);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [saved, setSaved] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState(lesson?.title ?? "Untitled architecture");
  const [designId, setDesignId] = useState<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [conceptOpen, setConceptOpen] = useState(false);
  const [hintCount, setHintCount] = useState(0);
  const [validation, setValidation] = useState<MissionValidation | null>(null);
  const [legacyCompletion, setLegacyCompletion] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [workloadOpen, setWorkloadOpen] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [estimationValues, setEstimationValues] = useState<EstimationValues>({});
  const [estimationOutcomes, setEstimationOutcomes] = useState<EstimationOutcome[] | null>(null);
  const [asked, setAsked] = useState<string[]>([]);
  const [alternatives, setAlternatives] = useState<AlternativeView[] | null>(null);
  const [alternativesLoading, setAlternativesLoading] = useState(false);
  const [remixed, setRemixed] = useState<{ lesson: Lesson; factor: number } | null>(null);
  const [remixPreparing, setRemixPreparing] = useState(false);
  const [remixCount, setRemixCount] = useState(0);
  const [defenseActive, setDefenseActive] = useState(false);
  const [blankCanvas, setBlankCanvas] = useState(false);
  const [blankConfirmOpen, setBlankConfirmOpen] = useState(false);
  const [techCommit, setTechCommit] = useState<TechCommit | null>(null);
  const [techSkipped, setTechSkipped] = useState(false);
  const [seedSpread, setSeedSpread] = useState<SeedSpread | null>(null);
  const taskRef = useRef(0);
  const workers = useRef(new Set<Worker>());
  const pendingDraft = useRef<{ key: string; architecture: Architecture; workload: Workload } | null>(null);
  const loadedKey = useRef<string | null>(null);

  const cancelRun = useCallback(() => {
    taskRef.current++;
    for (const worker of workers.current) worker.terminate();
    workers.current.clear(); setRunning(false); setRunLabel("Run simulation");
  }, []);

  const activeLesson = remixed?.lesson ?? lesson;
  const isWritten = lesson?.kind === "written";
  const isBrief = lesson?.kind === "brief";
  const clarifications = lesson?.clarifications ?? [];
  const relevantTotal = clarifications.filter((item) => item.relevant).length;
  const relevantAsked = clarifications.filter((item) => item.relevant && asked.includes(item.question)).length;
  const revealed = !isBrief || relevantTotal === 0 || relevantAsked >= Math.ceil(relevantTotal / 2);
  const nextLesson = lesson ? lessons.find((l) => l.number === lesson.number + 1) : undefined;
  const storageKey = queryId ? `design:${queryId}` : lesson?.id ?? "sandbox";
  /** Either the lesson is a blank-canvas brief, or the learner started this sim from a blank canvas. */
  const blankRun = blankCanvas || !!activeLesson?.blankCanvas;
  const wallClock = useWallClock(storageKey, WALL_CLOCK_BUDGET[lesson?.kind ?? "sim"]);
  const startClock = wallClock.start;

  useEffect(() => {
    let initialArchitecture = lesson?.architecture ?? sandboxArchitecture;
    // A brief hides its workload until the learner has clarified the requirements.
    let initialWorkload = lesson ? (lesson.kind === "brief" ? { ...defaultWorkload, seed: lesson.workload.seed } : lesson.workload) : defaultWorkload;
    cancelRun();
    setResult(null); setValidation(null); setCompleted(false); setBaseline(null); setBaselineWorkload(null); setResultWorkload(null);
    setResultRevision(-1); setError(""); setHintCount(0); setEstimationValues({}); setEstimationOutcomes(null);
    setAsked([]); setAlternatives(null); setAlternativesLoading(false); setRemixed(null); setRemixPreparing(false); setRemixCount(0);
    setBlankCanvas(false); setBlankConfirmOpen(false); setTechCommit(null); setTechSkipped(false); setSeedSpread(null);
    setAttempts(lesson ? readAttempts(lesson.id) : 0);
    setLegacyCompletion(!!lesson && readProgress().some((record) => record.lessonId === lesson.id && !isCurrentProgress(record)));
    setCompleted(!!lesson && readProgress().some((record) => record.lessonId === lesson.id && isCurrentProgress(record)));
    if (!lesson && queryId) {
      const design = readDesigns().find((item) => item.id === queryId);
      if (design) { initialArchitecture = design.architecture; initialWorkload = design.workload; setDesignId(design.id); setSaveName(design.name); }
      else setError("That saved design is not available in this browser.");
    } else { setDesignId(null); setSaveName(lesson?.title ?? "Untitled architecture"); }
    const draft = readDraft(storageKey);
    if (draft) { initialArchitecture = draft.architecture; initialWorkload = draft.workload; }
    const warning = getPersistenceWarning();
    if (warning) setError(warning);
    loadedKey.current = storageKey;
    initialize(initialArchitecture, initialWorkload); setReady(true);
    return () => { cancelRun(); const pending = pendingDraft.current; if (pending) { saveDraft(pending.key, pending.architecture, pending.workload); pendingDraft.current = null; } };
  }, [lesson, initialize, storageKey, queryId, cancelRun]);

  useEffect(() => {
    if (!ready || loadedKey.current !== storageKey) return;
    pendingDraft.current = { key: storageKey, architecture, workload };
    setSaved(false);
    const timer = setTimeout(() => { const outcome = saveDraft(storageKey, architecture, workload); setSaved(outcome.ok); if (!outcome.ok) setError(outcome.error); }, 650);
    return () => clearTimeout(timer);
  }, [architecture, workload, ready, storageKey]);

  useEffect(() => {
    const flush = () => { const pending = pendingDraft.current; if (pending) saveDraft(pending.key, pending.architecture, pending.workload); };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 4000); return () => clearTimeout(timer); }, [toast]);

  const simulate = useCallback((graph: Architecture, traffic: Workload) => new Promise<SimulationResult>((resolve, reject) => {
    const worker = new Worker(new URL("../lib/simulation.worker.ts", import.meta.url));
    workers.current.add(worker);
    const timeout = setTimeout(() => { worker.terminate(); workers.current.delete(worker); reject(new Error("This simulation took too long. Reduce traffic or simplify the architecture and try again.")); }, 20000);
    const cleanup = () => { clearTimeout(timeout); worker.terminate(); workers.current.delete(worker); };
    worker.onmessage = (event: MessageEvent<{ result?: SimulationResult; error?: string }>) => { cleanup(); if (event.data.error) reject(new Error(event.data.error)); else if (event.data.result) resolve(event.data.result); else reject(new Error("The simulation returned an incomplete result.")); };
    worker.onerror = (event) => { cleanup(); reject(new Error(event.message || "The simulation worker could not start. Please reload the workspace.")); };
    worker.postMessage({ id: crypto.randomUUID(), architecture: graph, workload: traffic });
  }), []);

  /** Runs the generated alternatives one at a time on the lesson's own seed; a failure becomes a row, not a crash. */
  const runAlternatives = useCallback(async (task: number, snapshot: Architecture, learner: SimulationResult, mission: Lesson, blank: boolean) => {
    // Blank-canvas runs never show the hidden reference row: generate alternatives without the lesson.
    const variants = blank || mission.blankCanvas ? generateAlternatives(snapshot, undefined, learner) : generateAlternatives(snapshot, mission, learner);
    setAlternatives([]);
    if (variants.length === 0) return;
    setAlternativesLoading(true);
    const views: AlternativeView[] = [];
    for (const variant of variants) {
      if (task !== taskRef.current) { setAlternativesLoading(false); return; }
      try {
        const output = await simulate(variant.architecture, { ...mission.workload });
        views.push({
          id: variant.id, title: variant.title, rationale: variant.rationale, result: output,
          comparison: compareAlternative(learner, output, mission.objectives),
          passed: mission.objectives.filter((objective) => objectivePasses(output, objective)).length,
          total: mission.objectives.length,
        });
      } catch (caught) {
        views.push({
          id: variant.id, title: variant.title, rationale: variant.rationale, result: null, comparison: "",
          passed: 0, total: mission.objectives.length,
          error: caught instanceof Error ? caught.message : "This alternative could not be simulated.",
        });
      }
      if (task !== taskRef.current) { setAlternativesLoading(false); return; }
      setAlternatives([...views]);
    }
    setAlternativesLoading(false);
  }, [simulate]);

  const run = async (check = false) => {
    if (running || !ready || !revealed) return;
    startClock();
    const task = ++taskRef.current;
    const snapshot = structuredClone(architecture);
    let revisionSnapshot = revision;
    setRunning(true); setError("");
    if (check) { setValidation(null); setAlternatives(null); }
    try {
      if (check && activeLesson && activeLesson.kind !== "written") {
        // A blank-canvas run is graded on the objectives alone: the mission's shape rules do not apply.
        const issue = blankRun ? null : validateMissionArchitecture(activeLesson, snapshot);
        if (issue) throw new Error(issue);
        setWorkload({ ...activeLesson.workload });
        revisionSnapshot = useEditor.getState().revision;
        // Check runs the three assessment seeds plus two extra (variance view); objectives are
        // still judged on the three assessment seeds alone.
        const seeds = assessmentSeeds(activeLesson);
        const allSeeds = [...seeds, ...VARIANCE_SEEDS];
        const allResults: SimulationResult[] = [];
        for (const [index, seed] of allSeeds.entries()) {
          setRunLabel(`Checking ${index + 1} of ${allSeeds.length}`);
          allResults.push(await simulate(snapshot, { ...activeLesson.workload, seed }));
          if (task !== taskRef.current) return;
        }
        const results = allResults.slice(0, seeds.length);
        if (lesson) setAttempts(recordAttempt(lesson.id));
        const passed = results.every((r) => activeLesson.objectives.every((o) => objectivePasses(r, o)));
        const inspected = results.find((r) => activeLesson.objectives.some((o) => !objectivePasses(r, o))) ?? results[0];
        setValidation({ revision: revisionSnapshot, passed, results });
        setResult(inspected); setResultWorkload({ ...activeLesson.workload, seed: inspected.seed }); setResultRevision(revisionSnapshot);
        setSeedSpread(seedSpreadFrom(allResults));
        if (activeLesson.estimation.length > 0) setEstimationOutcomes(scoreEstimations(activeLesson.estimation, estimationValues, results, snapshot));
        if (passed) setToast("All three workload checks passed. Defend the design to finish.");
        else setError("Some requirements are not met across the three test workloads. Inspect the results and try another change.");
        setRunning(false); setRunLabel("Run simulation");
        await runAlternatives(task, snapshot, inspected, activeLesson, blankRun);
        return;
      }
      setRunLabel("Simulating...");
      const output = await simulate(snapshot, { ...workload });
      if (task !== taskRef.current) return;
      setResult(output); setResultWorkload({ ...workload }); setResultRevision(revisionSnapshot);
    } catch (caught) { if (task === taskRef.current) setError(caught instanceof Error ? caught.message : "Simulation failed. Please try again."); }
    finally { if (task === taskRef.current) { setRunning(false); setRunLabel("Run simulation"); } }
  };

  const resetAssessment = () => {
    setResult(null); setValidation(null); setCompleted(false); setEstimationValues({}); setEstimationOutcomes(null);
    setAlternatives(null); setAlternativesLoading(false); setResultRevision(-1);
    setTechCommit(null); setTechSkipped(false); setSeedSpread(null);
  };

  /** Re-initialises the editor with a traffic-only canvas and switches this run to blank-canvas rules. */
  const startBlankCanvas = () => {
    if (!lesson || !activeLesson) return;
    cancelRun();
    startClock();
    initialize(trafficOnly(activeLesson.architecture), workload);
    setBlankCanvas(true);
    resetAssessment();
    setBlankConfirmOpen(false);
    setError("");
    setToast("Blank canvas. Build the system yourself: only the objectives are graded.");
  };

  const requestBlankCanvas = () => {
    if (!lesson || !activeLesson) return;
    const edited = JSON.stringify(architecture) !== JSON.stringify(activeLesson.architecture);
    if (edited) { setBlankConfirmOpen(true); return; }
    startBlankCanvas();
  };

  const restoreStarter = () => {
    if (!activeLesson) return;
    cancelRun();
    initialize(activeLesson.architecture, workload);
    setBlankCanvas(false);
    resetAssessment();
    setToast("Starter architecture restored.");
  };

  /** Re-rolls the workload, rescales the hidden reference, measures it and derives satisfiable objectives. */
  const startRemix = async () => {
    if (!lesson || !lesson.remixable || remixPreparing) return;
    cancelRun();
    const task = ++taskRef.current;
    setRemixPreparing(true); setError("");
    try {
      const remixSeed = (lesson.workload.seed * 7919 + (remixCount + 1) * 104729 + (Date.now() % 100003)) >>> 0;
      const variant = remixLesson(lesson, remixSeed);
      const seeds = [variant.workload.seed, 123, 2026];
      const results: SimulationResult[] = [];
      for (const seed of seeds) {
        results.push(await simulate(variant.reference, { ...variant.workload, seed }));
        if (task !== taskRef.current) return;
      }
      const objectives = deriveRemixObjectives(lesson, variant.workload, results);
      setRemixed({ lesson: { ...lesson, workload: variant.workload, objectives, reference: variant.reference }, factor: variant.factor });
      setRemixCount((count) => count + 1);
      setWorkload({ ...variant.workload });
      resetAssessment();
      setToast("Remixed mission ready: new traffic, new targets, same idea.");
    } catch (caught) {
      if (task === taskRef.current) setError(caught instanceof Error ? caught.message : "The remix could not be prepared. Try again.");
    } finally { if (task === taskRef.current) setRemixPreparing(false); }
  };

  const clearRemix = () => {
    if (!lesson) return;
    cancelRun();
    setRemixed(null);
    setWorkload({ ...lesson.workload });
    resetAssessment();
    setToast("Original mission restored.");
  };

  const reset = () => {
    cancelRun();
    initialize(activeLesson?.architecture ?? sandboxArchitecture, activeLesson?.workload ?? defaultWorkload);
    setBlankCanvas(false);
    resetAssessment(); setError(""); setResetOpen(false); setToast("Starting architecture restored.");
  };

  const save = () => {
    if (!saveName.trim()) return;
    const id = designId ?? crypto.randomUUID();
    const outcome = saveDesign({ id, name: saveName.trim(), lessonId: lesson?.id ?? null, architecture, workload, updatedAt: new Date().toISOString() });
    if (!outcome.ok) { setError(outcome.error); return; }
    setDesignId(id); setSaveOpen(false); setToast("Design saved to My designs."); window.dispatchEvent(new Event("designs-updated"));
  };

  const exportDesign = () => {
    const data = { id: designId ?? crypto.randomUUID(), name: saveName, lessonId: lesson?.id ?? null, architecture, workload, updatedAt: new Date().toISOString() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `${saveName.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "architecture"}.json`; link.click(); URL.revokeObjectURL(url);
  };

  const askClarification = (question: string) => {
    if (!lesson || asked.includes(question)) return;
    startClock();
    const next = [...asked, question];
    setAsked(next);
    const answeredRelevant = clarifications.filter((item) => item.relevant && next.includes(item.question)).length;
    if (answeredRelevant >= Math.ceil(relevantTotal / 2) && !revealed) {
      setWorkload({ ...lesson.workload });
      setToast("Requirements clear. The workload and graded criteria are now visible.");
    }
  };

  const completeLesson = (outcome: DefenseOutcome) => {
    if (!lesson) return;
    const existing = readProgress().find((item) => item.lessonId === lesson.id);
    const results = validation?.results ?? [];
    const record: ProgressRecord = {
      lessonId: lesson.id,
      completedAt: new Date().toISOString(),
      bestP95: results.length ? Math.max(...results.map((item) => item.p95)) : 0,
      cost: results.length ? results[0].cost : 0,
      assessmentVersion: ASSESSMENT_VERSION,
      attempts,
      hintsUsed: hintCount,
      defenseScore: outcome.defenseScore,
      defenseMode: outcome.defenseMode,
      remixes: (existing?.remixes ?? 0) + (remixed ? 1 : 0),
      ...(estimationOutcomes ? { estimationScore: meanEstimationScore(estimationOutcomes) } : {}),
      ...(outcome.overtimeSeconds !== undefined ? { overtimeSeconds: outcome.overtimeSeconds } : {}),
      ...(outcome.followUpMode !== undefined ? { followUpMode: outcome.followUpMode } : {}),
      // v2.2
      ...(blankRun ? { blankCanvas: true } : {}),
      ...(outcome.interviewRounds > 0 ? { interviewRounds: outcome.interviewRounds } : {}),
      ...(outcome.recoveryScore !== undefined ? { recoveryScore: outcome.recoveryScore } : {}),
      ...(outcome.weakConcepts && outcome.weakConcepts.length > 0 ? { weakConcepts: outcome.weakConcepts } : {}),
      ...(outcome.estimationBias ? { estimationBias: outcome.estimationBias } : {}),
      ...(wallClock.overtime > 0 ? { wallClockOvertime: wallClock.overtime } : {}),
    };
    const status = saveProgress(record);
    if (!status.ok) { setError(status.error); return; }
    setCompleted(true); setLegacyCompletion(false);
    window.dispatchEvent(new Event("progress-updated"));
  };

  const valid = !!validation?.passed && validation.revision === revision;
  const stale = !!result && resultRevision !== revision;
  const objectiveChecks = activeLesson ? checkedObjectives(activeLesson, validation, revision) : [];
  const missionIssue = activeLesson && activeLesson.kind !== "written" && ready && !blankRun ? validateMissionArchitecture(activeLesson, architecture) : null;
  const estimationRequired = !!activeLesson && activeLesson.kind !== "written" && activeLesson.estimation.length > 0;
  const estimationBlocked = estimationRequired && !estimationComplete(activeLesson!.estimation, estimationValues);
  const statusText = missionIssue
    ?? (stale ? "Architecture or traffic changed. Recheck required."
      : validation?.revision === revision ? (valid ? "All three assessment runs passed." : "Assessment incomplete: some targets failed.")
        : result ? "Exploratory run only. Lesson criteria are not graded yet." : "Not assessed yet.");
  const trafficDisabled = !ready || (!!lesson && !revealed);
  const failures = failureRows(workload);

  // v2.2: the tech + data-model stage gates the defense for briefs and blank-canvas runs.
  const techApplicable = !!lesson && !isWritten;
  const techRequired = techApplicable && (isBrief || blankRun);
  const techDone = !techApplicable || techCommit !== null || techSkipped;
  const objectivesPassed = valid || completed;
  // Shown once this run's objectives pass; a lesson completed in an earlier visit does not re-open it.
  const showTechStage = techApplicable && !!activeLesson && revealed && valid && !techSkipped;
  const interviewContext: InterviewContext | undefined = lesson && !isWritten ? {
    architecture: architectureSummary(architecture),
    result: resultSummary(stale ? null : result),
    rationales: (techCommit?.techChoices ?? []).map((choice) => ({
      nodeId: choice.nodeId,
      label: architecture.nodes.find((candidate) => candidate.id === choice.nodeId)?.label ?? choice.kind,
      kind: choice.kind,
      technology: choice.name,
      why: choice.why,
      expected: choice.expected,
    })),
    dataModel: techCommit?.dataModel ?? "",
    estimation: (estimationOutcomes ?? [])
      .map((outcome) => `${outcome.label}: predicted ${outcome.predicted} ${outcome.unit}, actual ${Math.round(outcome.actual * 100) / 100} ${outcome.unit} (score ${outcome.score})`)
      .join("; "),
    blankCanvas: blankRun,
    metrics: nodeMetricSummaries(stale ? null : result, architecture),
  } : undefined;

  const setFailures = (next: FailureEvent[]) => setWorkload({ failures: next });
  const patchFailure = (index: number, patch: Partial<FailureEvent>) => setFailures(failures.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const heading = <div className="workspace-heading">
    <div>
      <div className="eyebrow">{lesson ? `CHAPTER ${String(lessons.filter((l) => l.number <= lesson.number).reduce((set, l) => set.add(l.chapter), new Set<string>()).size).padStart(2, "0")} / LESSON ${String(lesson.number).padStart(2, "0")}` : "YOUR IDEAS. UNDER LOAD."}</div>
      <h1>{lesson?.title ?? "Architecture sandbox"}<span className={`difficulty ${(lesson?.difficulty ?? "Open").toLowerCase()}`}>{lesson?.difficulty ?? "Open exploration"}</span>{remixed && <span className="remix-badge"><Shuffle size={11} />Remix x{remixed.factor.toFixed(2)}</span>}{blankRun && <span className="blank-canvas-badge"><Eraser size={11} />Blank canvas</span>}</h1>
      <p>{lesson?.subtitle ?? "Build a system. Change the conditions. See what happens."}</p>
    </div>
    <div className="heading-actions">
      {lesson && <span className={`wall-clock ${wallClock.overtime > 0 ? "over" : ""}`} title={`Interview budget: ${Math.round(WALL_CLOCK_BUDGET[lesson.kind] / 60)} minutes for this ${lesson.kind}`}>
        <Timer size={13} />
        {wallClock.started ? (wallClock.overtime > 0 ? `+${formatDuration(wallClock.overtime)} over` : `${formatDuration(wallClock.remaining)} left`) : `${Math.round(WALL_CLOCK_BUDGET[lesson.kind] / 60)} min budget`}
      </span>}
      {lesson ? <span className="duration"><Clock3 size={14} />{lesson.minutes} min</span> : <button className="button" onClick={() => setTemplateOpen(true)}><GitBranch size={15} />Templates<ChevronDown size={13} /></button>}
      {!isWritten && <button className="button primary run-button" onClick={() => run()} disabled={running || !ready || !revealed}>{running ? <LoaderCircle size={16} className="spin" /> : <Play size={15} fill="currentColor" />}{runLabel}</button>}
    </div>
  </div>;

  const missionPanel = activeLesson && lesson ? <MissionPanel
    lesson={activeLesson}
    objectiveChecks={objectiveChecks}
    status={{ text: statusText, warning: !!missionIssue }}
    assessmentSummary={blankRun
      ? "Blank canvas: build any architecture that meets the targets."
      : `Assessment: ${activeLesson.workload.requestRate} req/s, ${activeLesson.workload.pattern} traffic, ${Math.round(activeLesson.workload.readRatio * 100)}% reads, ${activeLesson.workload.duration}s, ${failureSummary(activeLesson.workload)}. Three seeds must pass.`}
    hintCount={hintCount}
    onRevealHint={() => { startClock(); setHintCount(Math.min(activeLesson.hints.length, hintCount + 1)); }}
    estimation={{
      prompts: activeLesson.estimation,
      values: estimationValues,
      onChange: (id: EstimationId, value: number | undefined) => { startClock(); setEstimationValues((prev) => ({ ...prev, [id]: value })); },
      locked: estimationOutcomes !== null,
      outcomes: estimationOutcomes,
      required: estimationRequired,
    }}
    check={isWritten ? null : { label: valid ? "Requirements passed" : "Check solution", disabled: running || !ready || remixPreparing || estimationBlocked, passed: valid, running, onClick: () => run(true) }}
    remix={lesson.remixable && !isWritten ? { active: !!remixed, factor: remixed?.factor, preparing: remixPreparing, onRemix: startRemix, onReset: clearRemix } : null}
    blankStart={lesson.kind === "sim" ? {
      active: blankCanvas,
      disabled: !ready || running || validation !== null || result !== null || completed,
      onStart: requestBlankCanvas,
      onRestore: restoreStarter,
    } : null}
    attempts={attempts}
    hidden={!revealed}
    defaultTab={isWritten ? "learn" : undefined}
    onOpenReading={() => setConceptOpen(true)}
  /> : null;

  const trafficControls = <>
    <div className="workload-bar">
      <div className="workload-main">
        <span className="workload-label">TRAFFIC</span>
        <input type="range" aria-label="Traffic rate" min="1" max={LIMITS.requestRate} step="1" value={workload.requestRate} disabled={trafficDisabled} onChange={(e) => setWorkload({ requestRate: Number(e.target.value) })} />
        <div className="traffic-value"><input aria-label="Requests per second" type="number" min="1" max={LIMITS.requestRate} disabled={trafficDisabled} value={workload.requestRate} onChange={(e) => setWorkload({ requestRate: clamp(Number(e.target.value), 1, LIMITS.requestRate) })} /><span>req/s</span></div>
      </div>
      <div className="workload-pattern">
        <select aria-label="Traffic pattern" value={workload.pattern} disabled={trafficDisabled} onChange={(e) => setWorkload({ pattern: e.target.value as Workload["pattern"] })}>
          <option value="steady">Steady traffic</option>
          <option value="spike">Traffic spike</option>
          <option value="ramp">Gradual ramp</option>
          <option value="flash">Flash crowd</option>
        </select>
      </div>
      <button className={`text-button workload-options ${workloadOpen ? "active" : ""}`} aria-expanded={workloadOpen} onClick={() => setWorkloadOpen(!workloadOpen)}>Configure<ChevronDown size={13} /></button>
    </div>
    {workloadOpen && <div className="workload-settings">
      <label className="field-label">Read traffic <span>{Math.round(workload.readRatio * 100)}%</span><input aria-label="Read traffic percentage" type="range" min="0" max="100" disabled={trafficDisabled} value={Math.round(workload.readRatio * 100)} onChange={(e) => setWorkload({ readRatio: Number(e.target.value) / 100 })} /></label>
      <label className="field-label">Duration<select aria-label="Simulation duration" value={workload.duration} disabled={trafficDisabled} onChange={(e) => setWorkload({ duration: Number(e.target.value) })}><option value="15">15 seconds</option><option value="30">30 seconds</option><option value="60">60 seconds</option></select></label>
      <label className="field-label">Seed<input type="number" aria-label="Simulation seed" min="1" max="999999" disabled={trafficDisabled} value={workload.seed} onChange={(e) => setWorkload({ seed: clamp(Math.round(Number(e.target.value)), 1, 999999) })} /></label>
      <label className="field-label">Key space <span>distinct keys</span><input type="number" aria-label="Key space" min="1" max={LIMITS.keySpace} step="100" disabled={trafficDisabled} value={workload.keySpace ?? 10000} onChange={(e) => setWorkload({ keySpace: clamp(Math.round(Number(e.target.value)), 1, LIMITS.keySpace) })} /></label>
      <label className="field-label">Key skew <span>{(workload.keySkew ?? 0.6).toFixed(2)}</span><input type="range" aria-label="Key skew" min="0" max="95" disabled={trafficDisabled} value={Math.round((workload.keySkew ?? 0.6) * 100)} onChange={(e) => setWorkload({ keySkew: Number(e.target.value) / 100 })} /></label>
      <label className="field-label">Cross-region latency <span>ms</span><input type="number" aria-label="Cross-region latency" min="0" max="5000" step="10" disabled={trafficDisabled} value={workload.crossRegionLatencyMs ?? 80} onChange={(e) => setWorkload({ crossRegionLatencyMs: clamp(Math.round(Number(e.target.value)), 0, 5000) })} /></label>
      <label className="field-label">Request deadline <span>ms, end-to-end</span><input type="number" aria-label="Request deadline" min="0" max="60000" step="50" disabled={trafficDisabled} value={workload.deadlineMs ?? 5000} onChange={(e) => setWorkload({ deadlineMs: clamp(Math.round(Number(e.target.value)), 0, 60000) })} /></label>
      <div className="failure-editor">
        <div className="requirements-heading"><span>FAILURE EVENTS</span><span>{failures.length}/{LIMITS.failureEvents}</span></div>
        {failures.length === 0 && <p className="field-note">No failures injected. Add one to see how the design behaves while something is broken.</p>}
        {failures.map((row, index) => <div className="failure-row" key={index}>
          <label className="field-label">Event<select aria-label={`Failure ${index + 1} kind`} value={row.kind} disabled={trafficDisabled} onChange={(e) => patchFailure(index, { kind: e.target.value as FailureEvent["kind"] })}>{failureKinds.map((kind) => <option key={kind} value={kind}>{failureKindLabels[kind]}</option>)}</select></label>
          <label className="field-label">At <span>% of run</span><input type="number" aria-label={`Failure ${index + 1} start`} min="0" max="100" disabled={trafficDisabled} value={Math.round(row.at * 100)} onChange={(e) => patchFailure(index, { at: clamp(Number(e.target.value), 0, 100) / 100 })} /></label>
          <label className="field-label">Recovery <span>s, 0 = never</span><input type="number" aria-label={`Failure ${index + 1} duration`} min="0" max="600" disabled={trafficDisabled} value={row.duration ?? 0} onChange={(e) => patchFailure(index, { duration: clamp(Math.round(Number(e.target.value)), 0, 600) })} /></label>
          {(row.kind === "slow-database" || row.kind === "slow-server" || row.kind === "slow-partition") && <label className="field-label">Slowdown <span>x</span><input type="number" aria-label={`Failure ${index + 1} factor`} min="1" max="100" disabled={trafficDisabled} value={row.factor ?? 5} onChange={(e) => patchFailure(index, { factor: clamp(Number(e.target.value), 1, 100) })} /></label>}
          {row.kind === "region" && <label className="field-label">Region<input aria-label={`Failure ${index + 1} region`} maxLength={24} disabled={trafficDisabled} value={row.region ?? ""} placeholder="primary" onChange={(e) => patchFailure(index, { region: e.target.value.trim() || undefined })} /></label>}
          {row.kind === "flapping" && <label className="field-label">Flap interval <span>ms</span><input type="number" aria-label={`Failure ${index + 1} interval`} min="50" max="60000" step="50" disabled={trafficDisabled} value={row.intervalMs ?? 1000} onChange={(e) => patchFailure(index, { intervalMs: clamp(Math.round(Number(e.target.value)), 50, 60000) })} /></label>}
          {row.kind === "error-burst" && <label className="field-label">Error ratio <span>{Math.round((row.ratio ?? 0.3) * 100)}%</span><input type="range" aria-label={`Failure ${index + 1} error ratio`} min="0" max="100" disabled={trafficDisabled} value={Math.round((row.ratio ?? 0.3) * 100)} onChange={(e) => patchFailure(index, { ratio: Number(e.target.value) / 100 })} /></label>}
          {row.kind === "partition" && <label className="field-label">Split ratio <span>{Math.round((row.ratio ?? 0.5) * 100)}% isolated</span><input type="range" aria-label={`Failure ${index + 1} split ratio`} min="10" max="90" disabled={trafficDisabled} value={Math.round((row.ratio ?? 0.5) * 100)} onChange={(e) => patchFailure(index, { ratio: Number(e.target.value) / 100 })} /></label>}
          <button className="icon-button" aria-label={`Remove failure event ${index + 1}`} disabled={trafficDisabled} onClick={() => setFailures(failures.filter((_, i) => i !== index))}><Trash2 size={14} /></button>
        </div>)}
        <button className="button small" disabled={trafficDisabled || failures.length >= LIMITS.failureEvents} onClick={() => setFailures([...failures, { kind: "server", at: 0.5, duration: 0 }])}><Plus size={14} />Add failure event</button>
      </div>
    </div>}
  </>;

  return <Shell currentLessonId={lesson?.id}>
    <header className="topbar">
      <div className="breadcrumb"><Link href={lesson ? "/learn" : "/sandbox"}>{lesson ? "Learning path" : "Workspace"}</Link><ChevronRight size={13} /><span>{lesson?.chapter ?? "Sandbox"}</span></div>
      <div className="topbar-right">
        <span className="save-status">{saved ? <CheckCheck size={14} /> : <Clock3 size={13} />}{saved ? "Saved locally" : "Saving..."}</span>
        <span className="topbar-divider" />
        <Tip label="Export architecture"><button className="icon-button" aria-label="Export architecture" onClick={exportDesign} disabled={!ready}><Download size={17} /></button></Tip>
        <button className="button small" onClick={() => setSaveOpen(true)} disabled={!ready}><Save size={14} />Save design</button>
      </div>
    </header>
    {heading}
    {legacyCompletion && <div className="model-update-note" role="status"><CircleAlert size={17} />Earlier completion needs review after the v2 curriculum update. Your saved architecture is unchanged.</div>}
    {remixPreparing && <div className="model-update-note" role="status"><LoaderCircle size={17} className="spin" />Preparing remix: rescaling the reference and measuring it on three seeds to set fair targets.</div>}
    {error && <div className="workspace-alert" role="alert"><CircleAlert size={17} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError("")}><X size={16} /></button></div>}

    {isWritten && lesson ? <div className="workspace-grid written-grid">
      {missionPanel}
      <div className={`lab-column written-column ${defenseActive ? "defense-dimmed" : ""}`}>
        <DefenseStage lesson={lesson} nextLesson={nextLesson ? { id: nextLesson.id, title: nextLesson.title } : undefined} enabled completed={completed} hintCount={hintCount} onComplete={completeLesson} onActive={setDefenseActive} wallClockOvertime={wallClock.overtime} estimationOutcomes={estimationOutcomes} />
      </div>
    </div> : <>
      <div className={`workspace-grid ${!lesson ? "sandbox-grid" : ""}`}>
        {missionPanel}
        <div className={`lab-column ${defenseActive ? "defense-dimmed" : ""}`}>
          {trafficControls}
          {isBrief && lesson && clarifications.length > 0 && <div className="brief-stage"><ClarificationStage lesson={lesson} asked={asked} onAsk={askClarification} revealed={revealed} /></div>}
          {ready ? <ArchitectureCanvas result={stale ? null : result} running={running} allowedKinds={activeLesson?.allowedKinds ?? sandboxKinds} onReset={() => setResetOpen(true)} /> : <div className="canvas-loading"><LoaderCircle size={23} className="spin" />Opening architecture...</div>}
          <ResultsWithSpread
            result={result} baseline={baseline} workload={resultWorkload} baselineWorkload={baselineWorkload}
            onPin={() => { setBaseline(result); setBaselineWorkload(resultWorkload); setToast("Baseline pinned for comparison."); }}
            onUnpin={() => { setBaseline(null); setBaselineWorkload(null); }}
            stale={stale} running={running} alternatives={alternatives} alternativesLoading={alternativesLoading}
            seedSpread={seedSpread}
          />
        </div>
      </div>
      {showTechStage && activeLesson && <TechStage
        lesson={activeLesson}
        architecture={architecture}
        workload={workload}
        required={techRequired}
        onCommit={setTechCommit}
        onSkip={() => setTechSkipped(true)}
      />}
      {lesson && activeLesson && revealed && <DefenseStage
        lesson={activeLesson}
        nextLesson={nextLesson ? { id: nextLesson.id, title: nextLesson.title } : undefined}
        enabled={objectivesPassed && (completed || techDone)}
        completed={completed}
        hintCount={hintCount}
        onComplete={completeLesson}
        onActive={setDefenseActive}
        remixActive={!!remixed}
        interviewContext={interviewContext}
        wallClockOvertime={wallClock.overtime}
        estimationOutcomes={estimationOutcomes}
      />}
    </>}

    <footer className="workspace-footer"><span><FlaskConical size={13} />A little less theory. A little more discovery.</span>{lesson ? <Link href="/sandbox">Explore freely in the sandbox<ArrowRight size={13} /></Link> : <Link href="/learn"><ArrowLeft size={13} />Back to the learning path</Link>}</footer>
    {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}

    <Modal open={saveOpen} onOpenChange={setSaveOpen} title="Save your design" description="Keep this architecture in your personal design library."><form onSubmit={(e) => { e.preventDefault(); save(); }}><label className="field-label">Design name<input autoFocus value={saveName} onChange={(e) => setSaveName(e.target.value)} maxLength={80} placeholder="My architecture" required /></label><div className="modal-actions"><button type="button" className="button" onClick={() => setSaveOpen(false)}>Cancel</button><button type="submit" className="button primary" disabled={!saveName.trim()}><Save size={15} />Save design</button></div></form></Modal>
    <Modal open={resetOpen} onOpenChange={setResetOpen} title="Reset this architecture?" description="This replaces the current draft with the starting system. Designs already saved to your library are kept."><div className="modal-actions"><button className="button" onClick={() => setResetOpen(false)}>Keep working</button><button className="button primary" onClick={reset}><RotateCcw size={15} />Reset architecture</button></div></Modal>
    <Modal open={blankConfirmOpen} onOpenChange={setBlankConfirmOpen} title="Start from a blank canvas?" description="Your current architecture for this lesson is replaced by the traffic source alone. Designs already saved to your library are kept."><div className="modal-actions"><button className="button" onClick={() => setBlankConfirmOpen(false)}>Keep my design</button><button className="button primary" onClick={startBlankCanvas}><Eraser size={15} />Clear the canvas</button></div></Modal>
    <Modal open={templateOpen} onOpenChange={setTemplateOpen} title="Choose a starting point" description="A template replaces your current draft. Save your design first if you want to keep it."><div className="template-list">{templates.map((template) => <button key={template.id} onClick={() => { cancelRun(); if (queryId) { pendingDraft.current = null; saveDraft("sandbox", template.architecture, template.workload); router.replace("/sandbox"); } else initialize(template.architecture, template.workload); resetAssessment(); setTemplateOpen(false); setDesignId(null); setSaveName(template.name); }}><span className="template-icon"><GitBranch size={23} /></span><span><strong>{template.name}</strong><small>{template.description}</small></span><ArrowRight size={17} /></button>)}</div></Modal>
    <Modal open={conceptOpen} onOpenChange={setConceptOpen} title={activeLesson?.concept ?? "Concept"} wide description={activeLesson?.subtitle}><div className="reading-view">{activeLesson?.learning.map((text, index) => <div key={text}><span>0{index + 1}</span><p>{text}</p></div>)}</div></Modal>
  </Shell>;
}
