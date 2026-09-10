"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Check, CheckCheck, ChevronDown, ChevronRight, Circle, CircleAlert, Clock3, Download, FlaskConical, GitBranch, Lightbulb, LoaderCircle, Play, RotateCcw, Save, ShieldCheck, Sparkles, Target, Upload, X } from "lucide-react";
import type { Architecture, Lesson, NodeKind, SimulationResult, Workload } from "@/lib/types";
import { lessons } from "@/lib/curriculum";
import { defaultWorkload, sandboxArchitecture, templates } from "@/lib/templates";
import { getPersistenceWarning, readDesigns, readDraft, readProgress, saveDesign, saveDraft, saveProgress } from "@/lib/persistence";
import { checkedObjectives, objectivePasses, validateMissionArchitecture, type MissionValidation } from "@/lib/assessment";
import { ASSESSMENT_VERSION, isCurrentProgress } from "@/lib/assessment-version";
import { useEditor } from "@/lib/editor-store";
import { Shell } from "./shell";
import { Modal, Tip } from "./ui";
import { ArchitectureCanvas } from "./architecture-canvas";
import { Results } from "./results";

const allKinds: NodeKind[] = ["server", "load-balancer", "database", "cache", "queue"];

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
  const [missionTab, setMissionTab] = useState<"mission" | "learn">("mission");
  const [validation, setValidation] = useState<MissionValidation | null>(null);
  const [legacyCompletion, setLegacyCompletion] = useState(false);
  const [reflection, setReflection] = useState<number | null>(null);
  const [reflectChecked, setReflectChecked] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [workloadOpen, setWorkloadOpen] = useState(false);
  const taskRef = useRef(0);
  const workers = useRef(new Set<Worker>());
  const pendingDraft = useRef<{ key: string; architecture: Architecture; workload: Workload } | null>(null);
  const loadedKey = useRef<string | null>(null);
  const cancelRun = useCallback(() => {
    taskRef.current++;
    for (const worker of workers.current) worker.terminate();
    workers.current.clear(); setRunning(false); setRunLabel("Run simulation");
  }, []);
  const nextLesson = lesson ? lessons.find((l) => l.number === lesson.number + 1) : undefined;
  const storageKey = queryId ? `design:${queryId}` : lesson?.id ?? "sandbox";
  useEffect(() => {
    let initialArchitecture = lesson?.architecture ?? sandboxArchitecture;
    let initialWorkload = lesson?.workload ?? defaultWorkload;
    cancelRun(); setResult(null); setValidation(null); setCompleted(false); setReflection(null); setReflectChecked(false); setBaseline(null); setResultRevision(-1); setError(""); setHintCount(0);
    setLegacyCompletion(!!lesson && readProgress().some((record) => record.lessonId === lesson.id && !isCurrentProgress(record)));
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
  const run = async (check = false) => {
    if (running || !ready) return;
    const task = ++taskRef.current;
    const snapshot = structuredClone(architecture);
    let revisionSnapshot = revision;
    setRunning(true); setError(""); setValidation(null); setCompleted(false); setReflectChecked(false);
    try {
      if (check && lesson) {
        const issue = validateMissionArchitecture(lesson, snapshot);
        if (issue) throw new Error(issue);
        setWorkload({ ...lesson.workload });
        revisionSnapshot = useEditor.getState().revision;
        const results: SimulationResult[] = [];
        for (const [index, seed] of [lesson.workload.seed, 123, 2026].entries()) {
          setRunLabel(`Checking ${index + 1} of 3`);
          results.push(await simulate(snapshot, { ...lesson.workload, seed }));
          if (task !== taskRef.current) return;
        }
        const passed = results.every((r) => lesson.objectives.every((o) => objectivePasses(r, o)));
        const inspected = results.find((r) => lesson.objectives.some((o) => !objectivePasses(r, o))) ?? results[0];
        setValidation({ revision: revisionSnapshot, passed, results }); setResult(inspected); setResultWorkload({ ...lesson.workload, seed: inspected.seed }); setResultRevision(revisionSnapshot);
        if (passed) setToast("All three workload checks passed. Complete the reflection to finish.");
        else setError("Some requirements are not met across the three test workloads. Inspect the results and try another change.");
      } else {
        setRunLabel("Simulating...");
        const output = await simulate(snapshot, { ...workload });
        if (task !== taskRef.current) return;
        setResult(output); setResultWorkload({ ...workload }); setResultRevision(revisionSnapshot);
      }
    } catch (caught) { if (task === taskRef.current) setError(caught instanceof Error ? caught.message : "Simulation failed. Please try again."); }
    finally { if (task === taskRef.current) { setRunning(false); setRunLabel("Run simulation"); } }
  };
  const reset = () => {
    cancelRun();
    initialize(lesson?.architecture ?? sandboxArchitecture, lesson?.workload ?? defaultWorkload);
    setResult(null); setValidation(null); setCompleted(false); setReflection(null); setReflectChecked(false); setError(""); setResetOpen(false); setToast("Starting architecture restored.");
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
  const complete = () => {
    if (!lesson || !validation?.passed || validation.revision !== revision) return;
    setReflectChecked(true);
    if (reflection !== lesson.reflection.answer) return;
    const outcome = saveProgress({ lessonId: lesson.id, completedAt: new Date().toISOString(), bestP95: Math.max(...validation.results.map((r) => r.p95)), cost: validation.results[0].cost, assessmentVersion: ASSESSMENT_VERSION });
    if (!outcome.ok) { setError(outcome.error); return; }
    setCompleted(true); setLegacyCompletion(false); window.dispatchEvent(new Event("progress-updated"));
  };
  const valid = validation?.passed && validation.revision === revision;
  const stale = !!result && resultRevision !== revision;
  const objectiveChecks = lesson ? checkedObjectives(lesson, validation, revision) : [];
  const passedCount = objectiveChecks.filter(Boolean).length;
  const missionIssue = lesson && ready ? validateMissionArchitecture(lesson, architecture) : null;
  return <Shell currentLessonId={lesson?.id}>
    <header className="topbar"><div className="breadcrumb"><Link href={lesson ? "/learn" : "/sandbox"}>{lesson ? "Learning path" : "Workspace"}</Link><ChevronRight size={13} /><span>{lesson?.chapter ?? "Sandbox"}</span></div><div className="topbar-right"><span className="save-status">{saved ? <CheckCheck size={14} /> : <Clock3 size={13} />}{saved ? "Saved locally" : "Saving..."}</span><span className="topbar-divider" /><Tip label="Export architecture"><button className="icon-button" aria-label="Export architecture" onClick={exportDesign} disabled={!ready}><Download size={17} /></button></Tip><button className="button small" onClick={() => setSaveOpen(true)} disabled={!ready}><Save size={14} />Save design</button></div></header>
    <div className="workspace-heading"><div><div className="eyebrow">{lesson ? `CHAPTER ${String(lessons.filter((l) => l.number <= lesson.number).reduce((set, l) => set.add(l.chapter), new Set<string>()).size).padStart(2, "0")} / LESSON ${String(lesson.number).padStart(2, "0")}` : "YOUR IDEAS. UNDER LOAD."}</div><h1>{lesson?.title ?? "Architecture sandbox"}<span className={`difficulty ${(lesson?.difficulty ?? "Open").toLowerCase()}`}>{lesson?.difficulty ?? "Open exploration"}</span></h1><p>{lesson?.subtitle ?? "Build a system. Change the conditions. See what happens."}</p></div><div className="heading-actions">{lesson ? <span className="duration"><Clock3 size={14} />{lesson.minutes} min</span> : <button className="button" onClick={() => setTemplateOpen(true)}><GitBranch size={15} />Templates<ChevronDown size={13} /></button>}<button className="button primary run-button" onClick={() => run()} disabled={running || !ready}>{running ? <LoaderCircle size={16} className="spin" /> : <Play size={15} fill="currentColor" />}{runLabel}</button></div></div>
    {legacyCompletion && <div className="model-update-note" role="status"><CircleAlert size={17} />Earlier completion needs review after the routing and grading update. Your saved architecture is unchanged.</div>}
    {error && <div className="workspace-alert" role="alert"><CircleAlert size={17} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError("")}><X size={16} /></button></div>}
    <div className={`workspace-grid ${!lesson ? "sandbox-grid" : ""}`}>
      {lesson && <aside className="mission-panel"><div className="mission-tabs"><button className={missionTab === "mission" ? "active" : ""} onClick={() => setMissionTab("mission")}><Target size={14} />Your mission</button><button className={missionTab === "learn" ? "active" : ""} onClick={() => setMissionTab("learn")}><BookOpen size={14} />Learn</button></div>
        {missionTab === "mission" ? <><div className="mission-body"><div className="mission-chapter-icon"><Target size={21} /></div><h2>The scenario</h2><p className="mission-brief">{lesson.brief}</p><div className="requirements-heading"><span>GRADED CRITERIA</span><span>{passedCount}/{lesson.objectives.length}</span></div><ul className="objective-list">{lesson.objectives.map((objective, index) => <li className={objectiveChecks[index] ? "passed" : ""} key={objective.id}>{objectiveChecks[index] ? <span className="objective-check"><Check size={11} /></span> : <Circle size={15} />}<span>{objective.label}</span></li>)}</ul><div className="mission-rules"><ShieldCheck size={14} /><span>Assessment: {lesson.workload.requestRate} req/s, {lesson.workload.pattern} traffic, {Math.round(lesson.workload.readRatio * 100)}% reads, {lesson.workload.duration}s, {lesson.workload.failure === "none" ? "no injected failure" : `one ${lesson.workload.failure} failure`}. Three seeds must pass.</span></div><p className={`assessment-status ${missionIssue ? "assessment-warning" : ""}`} role="status">{missionIssue ?? (stale ? "Architecture or traffic changed. Recheck required." : validation?.revision === revision ? valid ? "All three assessment runs passed." : "Assessment incomplete: some targets failed." : result ? "Exploratory run only. Lesson criteria are not graded yet." : "Not assessed yet.")}</p><div className="hint-box"><button onClick={() => setHintCount(Math.min(lesson.hints.length, hintCount + 1))} disabled={hintCount === lesson.hints.length}><Lightbulb size={16} /><span>{hintCount ? "Reveal another hint" : "Need a nudge?"}</span><span className="hint-count">{hintCount}/{lesson.hints.length}</span><ChevronRight size={13} /></button>{lesson.hints.slice(0, hintCount).map((hint, index) => <p key={hint}><span>{index + 1}.</span>{hint}</p>)}</div></div><div className="mission-bottom"><button className={`button ${valid ? "success-button" : "dark"} full-width`} onClick={() => run(true)} disabled={running || !ready}>{running ? <LoaderCircle className="spin" size={15} /> : valid ? <CheckCheck size={16} /> : <ShieldCheck size={16} />}{valid ? "Requirements passed" : "Check solution"}</button></div></> : <div className="mission-body learn-content"><span className="eyebrow">THE IDEA BEHIND THE SYSTEM</span><h2>{lesson.concept}</h2>{lesson.learning.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}<button className="text-button" onClick={() => setConceptOpen(true)}>Open reading view<ArrowRight size={13} /></button></div>}
      </aside>}
      <div className="lab-column"><div className="workload-bar"><div className="workload-main"><span className="workload-label">TRAFFIC</span><input type="range" aria-label="Traffic rate" min="1" max="2000" step="1" value={workload.requestRate} onChange={(e) => setWorkload({ requestRate: Number(e.target.value) })} /><div className="traffic-value"><input aria-label="Requests per second" type="number" min="1" max="2000" value={workload.requestRate} onChange={(e) => setWorkload({ requestRate: Math.max(1, Math.min(2000, Number(e.target.value))) })} /><span>req/s</span></div></div><div className="workload-pattern"><select aria-label="Traffic pattern" value={workload.pattern} onChange={(e) => setWorkload({ pattern: e.target.value as Workload["pattern"] })}><option value="steady">Steady traffic</option><option value="spike">Traffic spike</option><option value="ramp">Gradual ramp</option></select></div><button className={`text-button workload-options ${workloadOpen ? "active" : ""}`} aria-expanded={workloadOpen} onClick={() => setWorkloadOpen(!workloadOpen)}>Configure<ChevronDown size={13} /></button></div>
      {workloadOpen && <div className="workload-settings"><label className="field-label">Read traffic <span>{Math.round(workload.readRatio * 100)}%</span><input aria-label="Read traffic percentage" type="range" min="0" max="100" value={workload.readRatio * 100} onChange={(e) => setWorkload({ readRatio: Number(e.target.value) / 100 })} /></label><label className="field-label">Failure at halfway<select aria-label="Injected failure" value={workload.failure} onChange={(e) => setWorkload({ failure: e.target.value as Workload["failure"] })}><option value="none">No failure</option><option value="server">One server replica</option><option value="database">One database replica</option></select></label><label className="field-label">Duration<select aria-label="Simulation duration" value={workload.duration} onChange={(e) => setWorkload({ duration: Number(e.target.value) })}><option value="15">15 seconds</option><option value="30">30 seconds</option><option value="60">60 seconds</option></select></label><label className="field-label">Seed<input type="number" aria-label="Simulation seed" min="1" max="999999" value={workload.seed} onChange={(e) => setWorkload({ seed: Math.max(1, Math.min(999999, Number(e.target.value))) })} /></label></div>}
        {ready ? <ArchitectureCanvas result={stale ? null : result} running={running} allowedKinds={lesson?.allowedKinds ?? allKinds} onReset={() => setResetOpen(true)} /> : <div className="canvas-loading"><LoaderCircle size={23} className="spin" />Opening architecture...</div>}
        <Results result={result} baseline={baseline} workload={resultWorkload} baselineWorkload={baselineWorkload} onPin={() => { setBaseline(result); setBaselineWorkload(resultWorkload); setToast("Baseline pinned for comparison."); }} onUnpin={() => { setBaseline(null); setBaselineWorkload(null); }} stale={stale} running={running} />
      </div>
    </div>
    {lesson && valid && <section className="reflection-section"><div className="reflection-heading"><span className="reflection-icon"><Sparkles size={20} /></span><div><span className="eyebrow">CONNECT THE DOTS</span><h2>{completed ? "Lesson complete." : "One last thought."}</h2></div>{completed && <span className="completion-badge"><CheckCheck size={16} />Progress saved</span>}</div>{!completed ? <><p>{lesson.reflection.question}</p><div className="reflection-options">{lesson.reflection.options.map((option, index) => <label className={reflection === index ? "selected" : ""} key={option}><input type="radio" name="reflection" checked={reflection === index} onChange={() => { setReflection(index); setReflectChecked(false); }} /><span>{option}</span></label>)}</div>{reflectChecked && reflection !== lesson.reflection.answer && <p className="reflection-feedback" role="status">Think about the behavior you just measured, then try again.</p>}<button className="button primary" disabled={reflection === null} onClick={complete}>Complete lesson<ArrowRight size={15} /></button></> : <><p>{lesson.reflection.explanation}</p><Link className="button primary" href={nextLesson ? `/learn/${nextLesson.id}` : "/learn"}>{nextLesson ? `Next: ${nextLesson.title}` : "Back to your learning path"}<ArrowRight size={15} /></Link></>}</section>}
    <footer className="workspace-footer"><span><FlaskConical size={13} />A little less theory. A little more discovery.</span>{lesson && <Link href="/sandbox">Explore freely in the sandbox<ArrowRight size={13} /></Link>}</footer>
    {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}
    <Modal open={saveOpen} onOpenChange={setSaveOpen} title="Save your design" description="Keep this architecture in your personal design library."><form onSubmit={(e) => { e.preventDefault(); save(); }}><label className="field-label">Design name<input autoFocus value={saveName} onChange={(e) => setSaveName(e.target.value)} maxLength={80} placeholder="My architecture" required /></label><div className="modal-actions"><button type="button" className="button" onClick={() => setSaveOpen(false)}>Cancel</button><button type="submit" className="button primary" disabled={!saveName.trim()}><Save size={15} />Save design</button></div></form></Modal>
    <Modal open={resetOpen} onOpenChange={setResetOpen} title="Reset this architecture?" description="This replaces the current draft with the starting system. Designs already saved to your library are kept."><div className="modal-actions"><button className="button" onClick={() => setResetOpen(false)}>Keep working</button><button className="button primary" onClick={reset}><RotateCcw size={15} />Reset architecture</button></div></Modal>
    <Modal open={templateOpen} onOpenChange={setTemplateOpen} title="Choose a starting point" description="A template replaces your current draft. Save your design first if you want to keep it."><div className="template-list">{templates.map((template) => <button key={template.id} onClick={() => { cancelRun(); if (queryId) { pendingDraft.current = null; saveDraft("sandbox", template.architecture, template.workload); router.replace("/sandbox"); } else initialize(template.architecture, template.workload); setResult(null); setValidation(null); setTemplateOpen(false); setDesignId(null); setSaveName(template.name); }}><span className="template-icon"><GitBranch size={23} /></span><span><strong>{template.name}</strong><small>{template.description}</small></span><ArrowRight size={17} /></button>)}</div></Modal>
    <Modal open={conceptOpen} onOpenChange={setConceptOpen} title={lesson?.concept ?? "Concept"} wide description={lesson?.subtitle}><div className="reading-view">{lesson?.learning.map((text, index) => <div key={text}><span>0{index + 1}</span><p>{text}</p></div>)}</div></Modal>
  </Shell>;
}
