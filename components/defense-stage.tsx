"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Lock,
  MessageSquareText,
  Send,
  Sparkles,
  XCircle,
} from "lucide-react";
import type { Lesson, RubricItem } from "@/lib/types";

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

// ---------------------------------------------------------------- grading types

interface GradedItem { id: string; score: 0 | 1 | 2; note: string }
interface GradedResult { mode: "graded"; items: GradedItem[]; total: number; critique: string }
type GradeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "graded"; result: GradedResult }
  | { status: "self" };

const DESIGN_MIN_WORDS = 60;
const FOLLOWUP_MIN_WORDS = 20;
const PASS_THRESHOLD = 60;

export function DefenseStage({ lesson, nextLesson, enabled, completed, onComplete, remixActive }: {
  lesson: Lesson;
  nextLesson?: { id: string; title: string };
  enabled: boolean;
  completed: boolean;
  onComplete: (outcome: { reflectionAttempts: number; defenseScore: number; defenseMode: "graded" | "self" }) => void;
  remixActive?: boolean;
}) {
  // Reflection state
  const [attempt, setAttempt] = useState(1);
  const [choice, setChoice] = useState<{ chosen: number; correct: boolean } | null>(null);
  const [reflectionSolved, setReflectionSolved] = useState(false);

  // Defense state
  const [design, setDesign] = useState("");
  const [designConfirmed, setDesignConfirmed] = useState(false);
  const [followUps, setFollowUps] = useState<string[]>(() => lesson.defense.followUps.map(() => ""));
  const [revealedCount, setRevealedCount] = useState(0);
  const [grade, setGrade] = useState<GradeState>({ status: "idle" });
  const [selfChecked, setSelfChecked] = useState<Record<string, boolean>>({});
  const [selfConfirmed, setSelfConfirmed] = useState(false);
  const [gradeError, setGradeError] = useState<string | null>(null);

  const [finished, setFinished] = useState<{ reflectionAttempts: number; defenseScore: number; defenseMode: "graded" | "self" } | null>(null);
  const completedOnce = useRef(false);

  useEffect(() => {
    // Reset local flow state whenever the lesson changes.
    setAttempt(1);
    setChoice(null);
    setReflectionSolved(false);
    setDesign("");
    setDesignConfirmed(false);
    setFollowUps(lesson.defense.followUps.map(() => ""));
    setRevealedCount(0);
    setGrade({ status: "idle" });
    setSelfChecked({});
    setSelfConfirmed(false);
    setGradeError(null);
    setFinished(null);
    completedOnce.current = false;
  }, [lesson.id]);

  function finish(outcome: { reflectionAttempts: number; defenseScore: number; defenseMode: "graded" | "self" }) {
    setFinished(outcome);
    if (!completedOnce.current) {
      completedOnce.current = true;
      onComplete(outcome);
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

  async function submitDesign() {
    setDesignConfirmed(true);
    if (lesson.defense.followUps.length > 0) setRevealedCount(1);
  }

  function revealNextFollowUp() {
    setRevealedCount((count) => Math.min(count + 1, lesson.defense.followUps.length));
  }

  async function submitForGrading() {
    setGrade({ status: "loading" });
    setGradeError(null);
    try {
      const res = await fetch("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: lesson.id, answers: { design, followUps } }),
      });
      if (res.ok) {
        const body = (await res.json()) as GradedResult;
        setGrade({ status: "graded", result: body });
        if (body.total >= PASS_THRESHOLD) {
          finish({ reflectionAttempts: attempt, defenseScore: body.total, defenseMode: "graded" });
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

  function confirmSelfAssessment() {
    const rubric = lesson.defense.rubric;
    const total = rubric.reduce((sum, item) => (selfChecked[item.id] ? sum + item.weight : sum), 0);
    setSelfConfirmed(true);
    finish({ reflectionAttempts: attempt, defenseScore: Math.round(total), defenseMode: "self" });
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
    return <div className="defense-stage">
      <div className="reflection-section completion-section">
        <div className="reflection-heading">
          <span className="reflection-icon"><Sparkles size={17} /></span>
          <span>Lesson complete</span>
          {outcome && <span className="completion-badge"><CheckCircle2 size={13} />{outcome.defenseMode === "graded" ? `${outcome.defenseScore}/100 graded` : "self-assessed"}</span>}
        </div>
        {outcome ? <>
          <p className="reflection-feedback">{lesson.reflection.explanation}</p>
          {grade.status === "graded" && <p className="defense-critique">{grade.result.critique}</p>}
          {grade.status === "self" && <p className="defense-critique">Self-assessment confirmed against the model answer and rubric.</p>}
        </> : <p className="reflection-feedback">You've already completed this lesson. Revisit the mission any time — your reflection and defense answers aren't re-shown here.</p>}
        {remixActive && <p className="defense-remix-note">Remix objectives completed.</p>}
        <div className="defense-next">
          {nextLesson ? <Link className="button primary" href={`/learn/${nextLesson.id}`}>Next: {nextLesson.title}<ArrowRight size={15} /></Link> : <Link className="button primary" href="/learn">Back to learning path<ArrowRight size={15} /></Link>}
        </div>
      </div>
    </div>;
  }

  const { options, correctIndex } = shuffledOptions(lesson, attempt);

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
        <div className="defense-word-count"><span className={wordCount(design) >= DESIGN_MIN_WORDS ? "ok" : ""}>{wordCount(design)} / {DESIGN_MIN_WORDS} words</span></div>
        <button type="button" className="button primary" disabled={wordCount(design) < DESIGN_MIN_WORDS} onClick={submitDesign}>Continue<ChevronRight size={14} /></button>
      </div> : <>
        <div className="defense-answer submitted">
          <span className="field-label">Your answer</span>
          <p>{design}</p>
        </div>

        {lesson.defense.followUps.slice(0, revealedCount).map((question, index) => {
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
              <div className="defense-word-count"><span className={wordCount(followUps[index] ?? "") >= FOLLOWUP_MIN_WORDS ? "ok" : ""}>{wordCount(followUps[index] ?? "")} / {FOLLOWUP_MIN_WORDS} words</span></div>
              {isLast && index < lesson.defense.followUps.length - 1 && <button type="button" className="button" disabled={wordCount(followUps[index] ?? "") < FOLLOWUP_MIN_WORDS} onClick={revealNextFollowUp}>Next follow-up<ChevronRight size={14} /></button>}
            </>}
          </div>;
        })}

        {revealedCount >= lesson.defense.followUps.length && grade.status !== "self" && grade.status !== "graded" && <button
          type="button"
          className="button primary"
          disabled={grade.status === "loading" || wordCount(followUps[followUps.length - 1] ?? "") < FOLLOWUP_MIN_WORDS && lesson.defense.followUps.length > 0}
          onClick={submitForGrading}
        >
          {grade.status === "loading" ? "Grading..." : "Submit for grading"}<Send size={14} />
        </button>}

        {grade.status === "graded" && <div className="defense-grade">
          <div className="defense-grade-header">
            <span className={grade.result.total >= PASS_THRESHOLD ? "defense-total pass" : "defense-total fail"}>{grade.result.total}/100</span>
            <span className={grade.result.total >= PASS_THRESHOLD ? "defense-pass-line pass" : "defense-pass-line fail"}>{grade.result.total >= PASS_THRESHOLD ? "Passed" : "Below the 60 pass line"}</span>
          </div>
          <ul className="defense-rubric-results">
            {grade.result.items.map((item) => {
              const rubricItem = lesson.defense.rubric.find((r) => r.id === item.id);
              return <li key={item.id}>
                <span className="defense-rubric-score">{item.score}/2</span>
                <div><strong>{rubricItem?.criterion ?? item.id}</strong><p>{item.note}</p></div>
              </li>;
            })}
          </ul>
          <p className="defense-critique">{grade.result.critique}</p>
          {grade.result.total < PASS_THRESHOLD && <button type="button" className="button" onClick={reviseDesign}>Revise and resubmit<ChevronRight size={14} /></button>}
        </div>}

        {gradeError && <p className="defense-grade-error">{gradeError}</p>}

        {grade.status === "self" && <div className="defense-self-assessment">
          <p className="defense-self-intro">Grading is unavailable right now. Compare your answer with the model answer below, then tick every rubric item you actually covered.</p>
          <details className="defense-model-answer">
            <summary>Model answer</summary>
            <p>{lesson.defense.modelAnswer}</p>
          </details>
          <ul className="defense-rubric-checklist">
            {lesson.defense.rubric.map((item: RubricItem) => <li key={item.id}>
              <label>
                <input type="checkbox" checked={!!selfChecked[item.id]} onChange={() => toggleRubricItem(item.id)} disabled={selfConfirmed} />
                <span>{item.criterion}</span>
                <span className="defense-rubric-weight">{item.weight}</span>
              </label>
            </li>)}
          </ul>
          <div className="defense-self-total">Total: {lesson.defense.rubric.reduce((sum, item) => (selfChecked[item.id] ? sum + item.weight : sum), 0)}/100</div>
          {!selfConfirmed && <button type="button" className="button primary" onClick={confirmSelfAssessment}>Confirm self-assessment<CheckCircle2 size={14} /></button>}
        </div>}
      </>}
    </div>}
  </div>;
}
