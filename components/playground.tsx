"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, CheckCheck, ChevronDown, ChevronRight, CircleAlert, Clock3, Download, FlaskConical, GitBranch, LoaderCircle, Play, Plus, RotateCcw, Save, Shuffle, Trash2, X } from "lucide-react";
import type { Architecture, EstimationId, FailureEvent, Lesson, NodeKind, ProgressRecord, SimulationResult, Workload } from "@/lib/types";
import { lessons } from "@/lib/curriculum";
import { defaultWorkload, sandboxArchitecture, templates } from "@/lib/templates";
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
import { MissionPanel } from "./mission-panel";
import { DefenseStage } from "./defense-stage";
import { ClarificationStage } from "./clarification-stage";

const sandboxKinds: NodeKind[] = ["server", "load-balancer", "database", "cache", "queue", "cdn", "rate-limiter"];
const failureKinds: FailureEvent["kind"][] = ["server", "database", "cache-flush", "slow-database", "slow-server", "region", "flapping", "error-burst"];
const failureKindLabels: Record<FailureEvent["kind"], string> = {
  server: "Server replica dies",
  database: "Database replica dies",
  "cache-flush": "Cache flushed (cold start)",
  "slow-database": "Database slows down",
  "slow-server": "Server slows down",
  region: "Region outage",
  flapping: "Replica flaps (dead/alive)",
  "error-burst": "Replica error burst",
};

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

  useEffect(() => {
    let initialArchitecture = lesson?.architecture ?? sandboxArchitecture;
    // A brief hides its workload until the learner has clarified the requirements.
    let initialWorkload = lesson ? (lesson.kind === "brief" ? { ...defaultWorkload, seed: lesson.workload.seed } : lesson.workload) : defaultWorkload;
    cancelRun();
    setResult(null); setValidation(null); setCompleted(false); setBaseline(null); setBaselineWorkload(null); setResultWorkload(null);
    setResultRevision(-1); setError(""); setHintCount(0); setEstimationValues({}); setEstimationOutcomes(null);
    setAsked([]); setAlternatives(null); setAlternativesLoading(false); setRemixed(null); setRemixPreparing(false); setRemixCount(0);
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
  const runAlternatives = useCallback(async (task: number, snapshot: Architecture, learner: SimulationResult, mission: Lesson) => {
    // Blank-canvas briefs never show the hidden reference row: generate alternatives without the lesson.
    const variants = mission.blankCanvas ? generateAlternatives(snapshot, undefined, learner) : generateAlternatives(snapshot, mission, learner);
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
    const task = ++taskRef.current;
    const snapshot = structuredClone(architecture);
    let revisionSnapshot = revision;
    setRunning(true); setError("");
    if (check) { setValidation(null); setAlternatives(null); }
    try {
      if (check && activeLesson && activeLesson.kind !== "written") {
        const issue = validateMissionArchitecture(activeLesson, snapshot);
        if (issue) throw new Error(issue);
        setWorkload({ ...activeLesson.workload });
        revisionSnapshot = useEditor.getState().revision;
        const seeds = assessmentSeeds(activeLesson);
        const results: SimulationResult[] = [];
        for (const [index, seed] of seeds.entries()) {
          setRunLabel(`Checking ${index + 1} of ${seeds.length}`);
          results.push(await simulate(snapshot, { ...activeLesson.workload, seed }));
          if (task !== taskRef.current) return;
        }
        if (lesson) setAttempts(recordAttempt(lesson.id));
        const passed = results.every((r) => activeLesson.objectives.every((o) => objectivePasses(r, o)));
        const inspected = results.find((r) => activeLesson.objectives.some((o) => !objectivePasses(r, o))) ?? results[0];
        setValidation({ revision: revisionSnapshot, passed, results });
        setResult(inspected); setResultWorkload({ ...activeLesson.workload, seed: inspected.seed }); setResultRevision(revisionSnapshot);
        if (activeLesson.estimation.length > 0) setEstimationOutcomes(scoreEstimations(activeLesson.estimation, estimationValues, results, snapshot));
        if (passed) setToast("All three workload checks passed. Defend the design to finish.");
        else setError("Some requirements are not met across the three test workloads. Inspect the results and try another change.");
        setRunning(false); setRunLabel("Run simulation");
        await runAlternatives(task, snapshot, inspected, activeLesson);
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
    const next = [...asked, question];
    setAsked(next);
    const answeredRelevant = clarifications.filter((item) => item.relevant && next.includes(item.question)).length;
    if (answeredRelevant >= Math.ceil(relevantTotal / 2) && !revealed) {
      setWorkload({ ...lesson.workload });
      setToast("Requirements clear. The workload and graded criteria are now visible.");
    }
  };

  const completeLesson = (outcome: { defenseScore: number; defenseMode: "graded" | "self"; overtimeSeconds?: number; followUpMode?: "dynamic" | "static" }) => {
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
    };
    const status = saveProgress(record);
    if (!status.ok) { setError(status.error); return; }
    setCompleted(true); setLegacyCompletion(false);
    window.dispatchEvent(new Event("progress-updated"));
  };

  const valid = !!validation?.passed && validation.revision === revision;
  const stale = !!result && resultRevision !== revision;
  const objectiveChecks = activeLesson ? checkedObjectives(activeLesson, validation, revision) : [];
  const missionIssue = activeLesson && activeLesson.kind !== "written" && ready ? validateMissionArchitecture(activeLesson, architecture) : null;
  const estimationRequired = !!activeLesson && activeLesson.kind !== "written" && activeLesson.estimation.length > 0;
  const estimationBlocked = estimationRequired && !estimationComplete(activeLesson!.estimation, estimationValues);
  const statusText = missionIssue
    ?? (stale ? "Architecture or traffic changed. Recheck required."
      : validation?.revision === revision ? (valid ? "All three assessment runs passed." : "Assessment incomplete: some targets failed.")
        : result ? "Exploratory run only. Lesson criteria are not graded yet." : "Not assessed yet.");
  const trafficDisabled = !ready || (!!lesson && !revealed);
  const failures = failureRows(workload);

  const setFailures = (next: FailureEvent[]) => setWorkload({ failures: next });
  const patchFailure = (index: number, patch: Partial<FailureEvent>) => setFailures(failures.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const heading = <div className="workspace-heading">
    <div>
      <div className="eyebrow">{lesson ? `CHAPTER ${String(lessons.filter((l) => l.number <= lesson.number).reduce((set, l) => set.add(l.chapter), new Set<string>()).size).padStart(2, "0")} / LESSON ${String(lesson.number).padStart(2, "0")}` : "YOUR IDEAS. UNDER LOAD."}</div>
      <h1>{lesson?.title ?? "Architecture sandbox"}<span className={`difficulty ${(lesson?.difficulty ?? "Open").toLowerCase()}`}>{lesson?.difficulty ?? "Open exploration"}</span>{remixed && <span className="remix-badge"><Shuffle size={11} />Remix x{remixed.factor.toFixed(2)}</span>}</h1>
      <p>{lesson?.subtitle ?? "Build a system. Change the conditions. See what happens."}</p>
    </div>
    <div className="heading-actions">
      {lesson ? <span className="duration"><Clock3 size={14} />{lesson.minutes} min</span> : <button className="button" onClick={() => setTemplateOpen(true)}><GitBranch size={15} />Templates<ChevronDown size={13} /></button>}
      {!isWritten && <button className="button primary run-button" onClick={() => run()} disabled={running || !ready || !revealed}>{running ? <LoaderCircle size={16} className="spin" /> : <Play size={15} fill="currentColor" />}{runLabel}</button>}
    </div>
  </div>;

  const missionPanel = activeLesson && lesson ? <MissionPanel
    lesson={activeLesson}
    objectiveChecks={objectiveChecks}
    status={{ text: statusText, warning: !!missionIssue }}
    assessmentSummary={activeLesson.blankCanvas
      ? "Blank canvas: build any architecture that meets the targets."
      : `Assessment: ${activeLesson.workload.requestRate} req/s, ${activeLesson.workload.pattern} traffic, ${Math.round(activeLesson.workload.readRatio * 100)}% reads, ${activeLesson.workload.duration}s, ${failureSummary(activeLesson.workload)}. Three seeds must pass.`}
    hintCount={hintCount}
    onRevealHint={() => setHintCount(Math.min(activeLesson.hints.length, hintCount + 1))}
    estimation={{
      prompts: activeLesson.estimation,
      values: estimationValues,
      onChange: (id: EstimationId, value: number | undefined) => setEstimationValues((prev) => ({ ...prev, [id]: value })),
      locked: estimationOutcomes !== null,
      outcomes: estimationOutcomes,
      required: estimationRequired,
    }}
    check={isWritten ? null : { label: valid ? "Requirements passed" : "Check solution", disabled: running || !ready || remixPreparing || estimationBlocked, passed: valid, running, onClick: () => run(true) }}
    remix={lesson.remixable && !isWritten ? { active: !!remixed, factor: remixed?.factor, preparing: remixPreparing, onRemix: startRemix, onReset: clearRemix } : null}
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
          {(row.kind === "slow-database" || row.kind === "slow-server") && <label className="field-label">Slowdown <span>x</span><input type="number" aria-label={`Failure ${index + 1} factor`} min="1" max="100" disabled={trafficDisabled} value={row.factor ?? 5} onChange={(e) => patchFailure(index, { factor: clamp(Number(e.target.value), 1, 100) })} /></label>}
          {row.kind === "region" && <label className="field-label">Region<input aria-label={`Failure ${index + 1} region`} maxLength={24} disabled={trafficDisabled} value={row.region ?? ""} placeholder="primary" onChange={(e) => patchFailure(index, { region: e.target.value.trim() || undefined })} /></label>}
          {row.kind === "flapping" && <label className="field-label">Flap interval <span>ms</span><input type="number" aria-label={`Failure ${index + 1} interval`} min="50" max="60000" step="50" disabled={trafficDisabled} value={row.intervalMs ?? 1000} onChange={(e) => patchFailure(index, { intervalMs: clamp(Math.round(Number(e.target.value)), 50, 60000) })} /></label>}
          {row.kind === "error-burst" && <label className="field-label">Error ratio <span>{Math.round((row.ratio ?? 0.3) * 100)}%</span><input type="range" aria-label={`Failure ${index + 1} error ratio`} min="0" max="100" disabled={trafficDisabled} value={Math.round((row.ratio ?? 0.3) * 100)} onChange={(e) => patchFailure(index, { ratio: Number(e.target.value) / 100 })} /></label>}
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
        <DefenseStage lesson={lesson} nextLesson={nextLesson ? { id: nextLesson.id, title: nextLesson.title } : undefined} enabled completed={completed} hintCount={hintCount} onComplete={completeLesson} onActive={setDefenseActive} />
      </div>
    </div> : <>
      <div className={`workspace-grid ${!lesson ? "sandbox-grid" : ""}`}>
        {missionPanel}
        <div className={`lab-column ${defenseActive ? "defense-dimmed" : ""}`}>
          {trafficControls}
          {isBrief && lesson && clarifications.length > 0 && <div className="brief-stage"><ClarificationStage lesson={lesson} asked={asked} onAsk={askClarification} revealed={revealed} /></div>}
          {ready ? <ArchitectureCanvas result={stale ? null : result} running={running} allowedKinds={activeLesson?.allowedKinds ?? sandboxKinds} onReset={() => setResetOpen(true)} /> : <div className="canvas-loading"><LoaderCircle size={23} className="spin" />Opening architecture...</div>}
          <Results
            result={result} baseline={baseline} workload={resultWorkload} baselineWorkload={baselineWorkload}
            onPin={() => { setBaseline(result); setBaselineWorkload(resultWorkload); setToast("Baseline pinned for comparison."); }}
            onUnpin={() => { setBaseline(null); setBaselineWorkload(null); }}
            stale={stale} running={running} alternatives={alternatives} alternativesLoading={alternativesLoading}
          />
        </div>
      </div>
      {lesson && activeLesson && revealed && <DefenseStage
        lesson={activeLesson}
        nextLesson={nextLesson ? { id: nextLesson.id, title: nextLesson.title } : undefined}
        enabled={valid || completed}
        completed={completed}
        hintCount={hintCount}
        onComplete={completeLesson}
        onActive={setDefenseActive}
        remixActive={!!remixed}
      />}
    </>}

    <footer className="workspace-footer"><span><FlaskConical size={13} />A little less theory. A little more discovery.</span>{lesson ? <Link href="/sandbox">Explore freely in the sandbox<ArrowRight size={13} /></Link> : <Link href="/learn"><ArrowLeft size={13} />Back to the learning path</Link>}</footer>
    {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}

    <Modal open={saveOpen} onOpenChange={setSaveOpen} title="Save your design" description="Keep this architecture in your personal design library."><form onSubmit={(e) => { e.preventDefault(); save(); }}><label className="field-label">Design name<input autoFocus value={saveName} onChange={(e) => setSaveName(e.target.value)} maxLength={80} placeholder="My architecture" required /></label><div className="modal-actions"><button type="button" className="button" onClick={() => setSaveOpen(false)}>Cancel</button><button type="submit" className="button primary" disabled={!saveName.trim()}><Save size={15} />Save design</button></div></form></Modal>
    <Modal open={resetOpen} onOpenChange={setResetOpen} title="Reset this architecture?" description="This replaces the current draft with the starting system. Designs already saved to your library are kept."><div className="modal-actions"><button className="button" onClick={() => setResetOpen(false)}>Keep working</button><button className="button primary" onClick={reset}><RotateCcw size={15} />Reset architecture</button></div></Modal>
    <Modal open={templateOpen} onOpenChange={setTemplateOpen} title="Choose a starting point" description="A template replaces your current draft. Save your design first if you want to keep it."><div className="template-list">{templates.map((template) => <button key={template.id} onClick={() => { cancelRun(); if (queryId) { pendingDraft.current = null; saveDraft("sandbox", template.architecture, template.workload); router.replace("/sandbox"); } else initialize(template.architecture, template.workload); resetAssessment(); setTemplateOpen(false); setDesignId(null); setSaveName(template.name); }}><span className="template-icon"><GitBranch size={23} /></span><span><strong>{template.name}</strong><small>{template.description}</small></span><ArrowRight size={17} /></button>)}</div></Modal>
    <Modal open={conceptOpen} onOpenChange={setConceptOpen} title={activeLesson?.concept ?? "Concept"} wide description={activeLesson?.subtitle}><div className="reading-view">{activeLesson?.learning.map((text, index) => <div key={text}><span>0{index + 1}</span><p>{text}</p></div>)}</div></Modal>
  </Shell>;
}
