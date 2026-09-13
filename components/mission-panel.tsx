"use client";
import { useState } from "react";
import { ArrowRight, BookMarked, BookOpen, Check, CheckCheck, ChevronRight, Circle, Clock3, ExternalLink, Eraser, Lightbulb, LoaderCircle, RotateCcw, Shuffle, ShieldCheck, Target } from "lucide-react";
import type { Lesson } from "@/lib/types";
import type { EstimationId, EstimationPrompt } from "@/lib/types";
import type { EstimationOutcome, EstimationValues } from "@/lib/estimation";
import { estimationComplete } from "@/lib/estimation";
import { EstimationPanel } from "./estimation-panel";

type Tab = "mission" | "learn" | "deep-dive";

export function MissionPanel({ lesson, objectiveChecks, status, assessmentSummary, hintCount, onRevealHint, estimation, check, remix, blankStart, attempts, hidden, onOpenReading, defaultTab }: {
  lesson: Lesson;
  objectiveChecks: boolean[];
  status: { text: string; warning: boolean };
  assessmentSummary: string;
  hintCount: number;
  onRevealHint: () => void;
  estimation: {
    prompts: EstimationPrompt[];
    values: EstimationValues;
    onChange: (id: EstimationId, value: number | undefined) => void;
    locked: boolean;
    outcomes: EstimationOutcome[] | null;
    required: boolean;
  };
  /** null on written lessons: there is nothing to simulate, so no assessment line and no Check button. */
  check: { label: string; disabled: boolean; passed: boolean; running: boolean; onClick: () => void } | null;
  remix: { active: boolean; factor?: number; preparing: boolean; onRemix: () => void; onReset: () => void } | null;
  /** v2.2: start this sim from a traffic-only canvas instead of the starter architecture. */
  blankStart?: { active: boolean; disabled: boolean; onStart: () => void; onRestore: () => void } | null;
  attempts: number;
  hidden?: boolean;
  onOpenReading?: () => void;
  /** Written lessons open on Learn, since the mission tab carries no objectives. */
  defaultTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(defaultTab ?? "mission");
  const passedCount = objectiveChecks.filter(Boolean).length;
  const estimationBlocked = estimation.required && !estimationComplete(estimation.prompts, estimation.values);

  return <aside className="mission-panel">
    <div className="mission-tabs">
      <button className={tab === "mission" ? "active" : ""} onClick={() => setTab("mission")}><Target size={14} />Mission</button>
      <button className={tab === "learn" ? "active" : ""} onClick={() => setTab("learn")}><BookOpen size={14} />Learn</button>
      <button className={tab === "deep-dive" ? "active" : ""} onClick={() => setTab("deep-dive")}><BookMarked size={14} />Deep dive</button>
    </div>

    {tab === "mission" && <>
      <div className="mission-body">
        <div className="mission-chapter-icon"><Target size={21} /></div>
        <h2>The scenario</h2>
        <p className="mission-brief">{lesson.brief}</p>

        {hidden ? (
          <div className="mission-rules clarification-note">
            <ShieldCheck size={14} />
            <span>Graded criteria and the traffic workload stay hidden until you clarify the brief. Ask enough questions in the Clarify stage to reveal them.</span>
          </div>
        ) : <>
          {lesson.objectives.length > 0 && <>
            <div className="requirements-heading"><span>GRADED CRITERIA</span><span>{passedCount}/{lesson.objectives.length}</span></div>
            <ul className="objective-list">
              {lesson.objectives.map((objective, index) => <li className={objectiveChecks[index] ? "passed" : ""} key={objective.id}>
                {objectiveChecks[index] ? <span className="objective-check"><Check size={11} /></span> : <Circle size={15} />}
                <span>{objective.label}</span>
              </li>)}
            </ul>
          </>}
          {check && <>
            <div className="mission-rules"><ShieldCheck size={14} /><span>{assessmentSummary}</span></div>
            <p className={`assessment-status ${status.warning ? "assessment-warning" : ""}`} role="status">{status.text}</p>
          </>}

          {blankStart && <div className="blank-start">
            {blankStart.active ? <>
              <span className="blank-start-badge"><Eraser size={12} />Blank canvas</span>
              <p>You are building this system from a traffic-only canvas. The starter architecture and the reference design stay hidden; only the objectives are graded.</p>
              <button className="text-button" onClick={blankStart.onRestore}><RotateCcw size={12} />Restore the starter architecture</button>
            </> : <>
              <button className="button full-width" onClick={blankStart.onStart} disabled={blankStart.disabled}>
                <Eraser size={14} />Start from a blank canvas
              </button>
              <p>{blankStart.disabled ? "Available before the first check on this lesson." : "Wipe the starter design and build this system yourself, from traffic alone."}</p>
            </>}
          </div>}

          {estimation.prompts.length > 0 && <EstimationPanel prompts={estimation.prompts} values={estimation.values} onChange={estimation.onChange} locked={estimation.locked} outcomes={estimation.outcomes} />}

          <div className="hint-box">
            <button onClick={onRevealHint} disabled={hintCount >= lesson.hints.length}>
              <Lightbulb size={16} />
              <span>{hintCount ? "Reveal another hint" : "Need a nudge?"}</span>
              <span className="hint-count">{hintCount}/{lesson.hints.length}</span>
              <ChevronRight size={13} />
            </button>
            {lesson.hints.slice(0, hintCount).map((hint, index) => <p key={hint}><span>{index + 1}.</span>{hint}</p>)}
          </div>

          <div className="mission-meta-row">
            <span className="mission-attempts"><RotateCcw size={12} />{attempts} attempt{attempts === 1 ? "" : "s"}</span>
            {remix && <span className="mission-remix-state">{remix.active ? <><Shuffle size={12} />Remixed x{remix.factor?.toFixed(2) ?? "?"}</> : "Original mission"}</span>}
          </div>
        </>}
      </div>

      {!hidden && check && <div className="mission-bottom">
        {remix && <div className="remix-controls">
          <button className="button" onClick={remix.onRemix} disabled={remix.preparing || remix.active}>
            {remix.preparing ? <LoaderCircle className="spin" size={14} /> : <Shuffle size={14} />}
            {remix.active ? "Remixed" : "Remix this mission"}
          </button>
          {remix.active && <button className="button" onClick={remix.onReset}><RotateCcw size={14} />Original</button>}
        </div>}
        {estimationBlocked && <p className="estimation-gate-note">Fill in every estimate above before checking your solution.</p>}
        <button className={`button ${check.passed ? "success-button" : "dark"} full-width`} onClick={check.onClick} disabled={check.disabled || estimationBlocked}>
          {check.running ? <LoaderCircle className="spin" size={15} /> : check.passed ? <CheckCheck size={16} /> : <ShieldCheck size={16} />}
          {check.label}
        </button>
      </div>}
    </>}

    {tab === "learn" && <div className="mission-body learn-content">
      <span className="eyebrow">THE IDEA BEHIND THE SYSTEM</span>
      <h2>{lesson.concept}</h2>
      {lesson.learning.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
      {onOpenReading && <button className="text-button" onClick={onOpenReading}>Open reading view<ArrowRight size={13} /></button>}
    </div>}

    {tab === "deep-dive" && <div className="mission-body deep-dive-content">
      <span className="eyebrow">GO DEEPER</span>
      {lesson.readings.length === 0 ? <p className="panel-empty">No readings for this lesson yet.</p> : <ul className="reading-cards">
        {lesson.readings.map((reading) => <li className="reading-card" key={reading.url}>
          <a href={reading.url} target="_blank" rel="noopener noreferrer">{reading.title}<ExternalLink size={12} /></a>
          <div className="reading-meta">
            <span>{reading.source}</span>
            {reading.minutes != null && <span><Clock3 size={11} />{reading.minutes} min</span>}
          </div>
          <p className="reading-why">{reading.why}</p>
        </li>)}
      </ul>}
    </div>}
  </aside>;
}
