"use client";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  Dumbbell,
  Eye,
  EyeOff,
  Flame,
  RotateCcw,
  Target,
  Trophy,
  X,
} from "lucide-react";
import { drills, checkDrill, type DrillInstance, type DrillTemplate } from "@/lib/drills";
import { readGym, saveGym, type GymState } from "@/lib/persistence";
import { Shell } from "./shell";

const numbersToKnow = [
  { label: "L1 cache reference", value: "~1 ns" },
  { label: "Main memory reference", value: "~100 ns" },
  { label: "SSD random read", value: "~100 µs" },
  { label: "HDD disk seek", value: "~10 ms" },
  { label: "Round trip, same datacenter", value: "~0.5 ms" },
  { label: "Round trip, cross-continent", value: "~150 ms" },
  { label: "Send 1 MB over a 1 Gbps link", value: "~10 ms" },
];

const ALL_TOPICS = "All";

function topicsOf(): string[] {
  return Array.from(new Set(drills.map((d) => d.topic)));
}

/** Picks a template restricted to `topic` (or any, for "All"), deterministic per seed. */
function pickFiltered(seed: number, topic: string): { template: DrillTemplate; instance: DrillInstance } {
  const pool = topic === ALL_TOPICS ? drills : drills.filter((d) => d.topic === topic);
  const list = pool.length ? pool : drills;
  const index = Math.abs(seed) % list.length;
  const template = list[index];
  return { template, instance: template.generate(seed) };
}

function offByPercent(predicted: number, expected: number): number {
  const base = Math.abs(expected) < 1e-9 ? 1 : Math.abs(expected);
  return Math.abs(((predicted - expected) / base) * 100);
}

type Result = { correct: boolean; expected: number; predicted: number; explanation: string; working: string };

export function Gym() {
  const [ready, setReady] = useState(false);
  const [seedBase, setSeedBase] = useState(0);
  const [counter, setCounter] = useState(0);
  const [topic, setTopic] = useState<string>(ALL_TOPICS);
  const [answerText, setAnswerText] = useState("");
  const [choiceIndex, setChoiceIndex] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [gym, setGym] = useState<GymState>({ solved: {}, streak: 0, best: 0 });
  const [showNumbers, setShowNumbers] = useState(true);

  useEffect(() => {
    setSeedBase(Date.now());
    setGym(readGym());
    setReady(true);
  }, []);

  const seed = seedBase + counter;
  const topics = useMemo(topicsOf, []);
  const { template, instance } = useMemo(() => pickFiltered(seed, topic), [seed, topic]);

  function reset() {
    setAnswerText("");
    setChoiceIndex(null);
    setResult(null);
  }

  function handleTopic(next: string) {
    setTopic(next);
    setCounter((c) => c + 1);
    reset();
  }

  function handleNext() {
    setCounter((c) => c + 1);
    reset();
  }

  function handleCheck() {
    if (result) return;
    let predicted: number;
    if (template.kind === "choice") {
      if (choiceIndex === null) return;
      predicted = choiceIndex;
    } else {
      predicted = parseFloat(answerText);
      if (!Number.isFinite(predicted)) return;
    }
    const outcome = checkDrill(template, seed, predicted);
    setResult({ correct: outcome.correct, expected: outcome.expected, predicted, explanation: outcome.explanation, working: instance.working });
    setGym((prev) => {
      const streak = outcome.correct ? prev.streak + 1 : 0;
      const next: GymState = {
        solved: outcome.correct ? { ...prev.solved, [template.id]: (prev.solved[template.id] ?? 0) + 1 } : prev.solved,
        streak,
        best: Math.max(prev.best, streak),
      };
      saveGym(next);
      return next;
    });
  }

  const totalSolved = Object.values(gym.solved).reduce((sum, n) => sum + n, 0);
  const topicCounts = topics.map((t) => ({
    topic: t,
    solved: drills.filter((d) => d.topic === t).reduce((sum, d) => sum + (gym.solved[d.id] ?? 0), 0),
  }));

  if (!ready) return <Shell><div className="page-loading">Opening the gym...</div></Shell>;

  return (
    <Shell>
      <header className="topbar">
        <div className="breadcrumb"><span>Personal workspace</span><ArrowRight size={12} /><span>Estimation gym</span></div>
        <span className="topbar-note"><span className="tiny-dot" />Back-of-envelope drills</span>
      </header>
      <div className="library-page gym-page">
        <div className="gym-heading">
          <span className="eyebrow">DUMBBELL FOR YOUR NUMBER SENSE</span>
          <h1><Dumbbell size={22} /> Estimation gym</h1>
          <p>
            Every design interview turns on numbers you should be able to produce in seconds: QPS from DAU, storage
            growth, bandwidth, servers with headroom, queueing math. Drill them here until the arithmetic is reflex,
            so in the real conversation you're spending your attention on the design, not the multiplication.
          </p>
        </div>

        <div className="segmented" aria-label="Filter by topic">
          {[ALL_TOPICS, ...topics].map((t) => (
            <button key={t} aria-pressed={topic === t} className={topic === t ? "active" : ""} onClick={() => handleTopic(t)}>
              {t}
            </button>
          ))}
        </div>

        <div className="gym-layout">
          <section className="gym-card" aria-live="polite">
            <div className="gym-card-head">
              <span className="status-chip">{template.topic}</span>
              <h2>{template.title}</h2>
            </div>
            <p className="gym-prompt">{instance.prompt}</p>

            {template.kind === "choice" ? (
              <div className="gym-choices" role="group" aria-label="Answer choices">
                {(instance.choices ?? []).map((choiceLabel, index) => {
                  const state = result
                    ? index === result.expected
                      ? "correct"
                      : index === choiceIndex
                        ? "wrong"
                        : ""
                    : index === choiceIndex
                      ? "selected"
                      : "";
                  return (
                    <button
                      key={choiceLabel}
                      className={`gym-choice ${state}`}
                      disabled={!!result}
                      aria-pressed={choiceIndex === index}
                      onClick={() => setChoiceIndex(index)}
                    >
                      {choiceLabel}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="estimation-input">
                <input
                  type="number"
                  inputMode="decimal"
                  aria-label="Your estimate"
                  placeholder="Your estimate"
                  disabled={!!result}
                  value={answerText}
                  onChange={(e) => setAnswerText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCheck(); }}
                />
                <span className="estimation-unit">{instance.unit}</span>
              </div>
            )}

            <div className="gym-actions">
              {!result ? (
                <button
                  className="button primary"
                  onClick={handleCheck}
                  disabled={template.kind === "choice" ? choiceIndex === null : answerText.trim() === ""}
                >
                  <Check size={15} />Check
                </button>
              ) : (
                <button className="button primary" onClick={handleNext}>
                  Next drill<ArrowRight size={15} />
                </button>
              )}
              <button className="button" onClick={handleNext}><RotateCcw size={14} />Skip</button>
            </div>

            {result && (
              <div className={`gym-result ${result.correct ? "correct" : "wrong"}`}>
                <p className="gym-result-line">
                  {result.correct ? <Check size={15} /> : <X size={15} />}
                  {template.kind === "choice"
                    ? result.correct
                      ? "Correct."
                      : `Not quite — correct answer: ${instance.choices?.[result.expected]}.`
                    : result.correct
                      ? "Correct — within tolerance."
                      : `Off by ${offByPercent(result.predicted, result.expected).toFixed(0)}%.`}
                  {template.kind !== "choice" && (
                    <span className="gym-expected">Expected {result.expected.toLocaleString("en-US")} {instance.unit}</span>
                  )}
                </p>
                <p className="gym-explanation">{result.explanation}</p>
                <p className="gym-working">{result.working}</p>
              </div>
            )}
          </section>

          <aside className="gym-side">
            <div className="gym-stats">
              <div className="gym-stat"><Target size={15} /><strong>{totalSolved}</strong><span>Solved</span></div>
              <div className="gym-stat"><Flame size={15} /><strong>{gym.streak}</strong><span>Streak</span></div>
              <div className="gym-stat"><Trophy size={15} /><strong>{gym.best}</strong><span>Best streak</span></div>
            </div>
            <div className="gym-topic-counts">
              <span className="field-label">By topic</span>
              <ul>
                {topicCounts.map((tc) => (
                  <li key={tc.topic}><span>{tc.topic}</span><span>{tc.solved}</span></li>
                ))}
              </ul>
            </div>

            <div className="gym-numbers">
              <button className="gym-numbers-toggle" onClick={() => setShowNumbers((s) => !s)} aria-expanded={showNumbers}>
                {showNumbers ? <EyeOff size={13} /> : <Eye size={13} />}
                Numbers to know
              </button>
              {showNumbers && (
                <ul>
                  {numbersToKnow.map((n) => (
                    <li key={n.label}><span>{n.label}</span><span>{n.value}</span></li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      </div>
    </Shell>
  );
}
