"use client";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronRight, CircleAlert, Cpu, Database, Lightbulb, SkipForward } from "lucide-react";
import type { Architecture, Lesson, NodeKind, Workload } from "@/lib/types";
import { suggestFor, techCatalog, workloadTraits, type TechOption, type Trait } from "@/lib/tech-catalog";

/** One committed technology decision: which option was chosen for a node kind, and why. */
export interface TechChoice {
  kind: NodeKind;
  optionId: string;
  name: string;
  why: string;
}
export interface TechCommit {
  techChoices: TechChoice[];
  dataModel: string;
}

const DEFAULT_DATA_MODEL_PROMPT = "List the main entities, their primary keys, the 3 most important query patterns, and how the data grows";
const DATA_MODEL_MIN_WORDS = 20;
const WHY_MAX = 160;

const kindLabels: Record<NodeKind, string> = {
  traffic: "Traffic source",
  server: "Application server",
  "load-balancer": "Load balancer",
  database: "Database",
  cache: "Cache",
  queue: "Queue",
  cdn: "CDN",
  "rate-limiter": "Rate limiter",
};

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function readableTrait(trait: string): string {
  return trait.replace(/-/g, " ");
}

/** The node kinds this lesson asks the learner to choose a technology for. */
export function techKinds(lesson: Lesson | undefined, architecture: Architecture): NodeKind[] {
  const focus = lesson?.techFocus;
  const present = Array.from(new Set(architecture.nodes.filter((node) => node.enabled && node.kind !== "traffic").map((node) => node.kind)));
  if (focus && focus.length > 0) return focus.filter((kind) => kind !== "traffic");
  return present;
}

/** Options the catalog offers for a kind, best fit first; falls back to the raw catalog if the ranking fails. */
function optionsFor(kind: NodeKind, traits: Trait[]): TechOption[] {
  try {
    const ranked = suggestFor(kind, traits);
    if (ranked.length > 0) return ranked;
  } catch {
    // fall through to the unranked catalog
  }
  return techCatalog.filter((option) => option.kind === kind);
}

export function TechStage({ lesson, architecture, workload, required, onCommit, onSkip }: {
  lesson: Lesson;
  architecture: Architecture;
  workload: Workload;
  /** Briefs and blank-canvas runs must commit; other sims may skip the stage. */
  required: boolean;
  onCommit: (commit: TechCommit) => void;
  onSkip: () => void;
}) {
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [why, setWhy] = useState<Record<string, string>>({});
  const [dataModel, setDataModel] = useState("");
  const [committed, setCommitted] = useState<TechCommit | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    setSelection({});
    setWhy({});
    setDataModel("");
    setCommitted(null);
    setTouched(false);
  }, [lesson.id]);

  const kinds = useMemo(() => techKinds(lesson, architecture), [lesson, architecture]);
  const activeTraits = useMemo<Trait[]>(() => {
    try {
      return workloadTraits(workload, architecture);
    } catch {
      return [];
    }
  }, [workload, architecture]);
  const options = useMemo(() => {
    const map = new Map<NodeKind, TechOption[]>();
    for (const kind of kinds) map.set(kind, optionsFor(kind, activeTraits));
    return map;
  }, [kinds, activeTraits]);

  const prompt = lesson.dataModelPrompt ?? DEFAULT_DATA_MODEL_PROMPT;
  const missingChoice = kinds.some((kind) => !selection[kind]);
  const missingWhy = kinds.some((kind) => (why[kind] ?? "").trim().length < 3);
  const dataModelWords = wordCount(dataModel);
  const ready = !missingChoice && !missingWhy && dataModelWords >= DATA_MODEL_MIN_WORDS;

  function commit() {
    setTouched(true);
    if (!ready) return;
    const techChoices: TechChoice[] = kinds.map((kind) => {
      const optionId = selection[kind]!;
      const option = (options.get(kind) ?? []).find((candidate) => candidate.id === optionId);
      return { kind, optionId, name: option?.name ?? optionId, why: (why[kind] ?? "").trim() };
    });
    const commitValue: TechCommit = { techChoices, dataModel: dataModel.trim() };
    setCommitted(commitValue);
    onCommit(commitValue);
  }

  if (committed) {
    return <section className="tech-stage committed">
      <div className="tech-heading">
        <span className="tech-icon"><Cpu size={17} /></span>
        <span>Technology and data model</span>
        <span className="tech-badge committed"><CheckCircle2 size={13} />Committed</span>
      </div>
      <p className="tech-intro">Now that your choices are locked, here is what the catalog says about each one. The fit is measured against this workload{activeTraits.length > 0 ? <>: <strong>{activeTraits.map(readableTrait).join(", ")}</strong></> : null}.</p>
      <ul className="tech-reveal-list">
        {committed.techChoices.map((choice) => {
          const list = options.get(choice.kind) ?? [];
          const option = list.find((candidate) => candidate.id === choice.optionId);
          const fits = option?.fits ?? [];
          const avoid = option?.avoid ?? [];
          const matchedFits = fits.filter((trait) => activeTraits.includes(trait));
          const matchedAvoid = avoid.filter((trait) => activeTraits.includes(trait));
          const rank = list.findIndex((candidate) => candidate.id === choice.optionId);
          const verdict = matchedAvoid.length > 0 ? "poor" : matchedFits.length > 0 ? "strong" : "neutral";
          return <li key={choice.kind} className={`tech-reveal ${verdict}`}>
            <div className="tech-reveal-head">
              <span className="tech-reveal-kind">{kindLabels[choice.kind]}</span>
              <strong>{choice.name}</strong>
              <span className={`tech-fit ${verdict}`}>{verdict === "poor" ? "works against this workload" : verdict === "strong" ? "fits this workload" : "neutral for this workload"}</span>
              {rank >= 0 && list.length > 1 && <span className="tech-rank">catalog rank {rank + 1} of {list.length}</span>}
            </div>
            <p className="tech-reveal-why"><span>Your reason:</span> {choice.why}</p>
            {option?.note && <p className="tech-reveal-note">{option.note}</p>}
            <div className="tech-trait-row">
              {fits.map((trait) => <span key={`fit-${trait}`} className={`tech-trait fit ${activeTraits.includes(trait) ? "active" : ""}`}>{readableTrait(trait)}</span>)}
              {avoid.map((trait) => <span key={`avoid-${trait}`} className={`tech-trait avoid ${activeTraits.includes(trait) ? "active" : ""}`}>avoid: {readableTrait(trait)}</span>)}
            </div>
          </li>;
        })}
      </ul>
      <div className="tech-reveal-model">
        <span className="field-label">Your data model</span>
        <p>{committed.dataModel}</p>
      </div>
      <p className="tech-handoff"><Lightbulb size={13} />The interviewer has your choices and your data model. Expect questions about both.</p>
    </section>;
  }

  return <section className="tech-stage">
    <div className="tech-heading">
      <span className="tech-icon"><Cpu size={17} /></span>
      <span>Technology and data model</span>
      <span className={`tech-badge ${required ? "required" : ""}`}>{required ? "Required before the defense" : "Optional step"}</span>
    </div>
    <p className="tech-intro">Pick a concrete technology for each part of your design and say why in one line. Fit notes stay hidden until you commit — decide first, then see how the catalog scores it.</p>

    {kinds.length === 0 ? <p className="tech-empty">No component kinds in this design need a technology choice. Describe the data model and continue.</p> : <ul className="tech-choice-list">
      {kinds.map((kind) => {
        const list = options.get(kind) ?? [];
        return <li key={kind} className="tech-choice">
          <div className="tech-choice-kind">{kindLabels[kind]}</div>
          <label className="field-label">
            Technology
            <select
              aria-label={`Technology for ${kindLabels[kind]}`}
              value={selection[kind] ?? ""}
              onChange={(event) => setSelection((prev) => ({ ...prev, [kind]: event.target.value }))}
            >
              <option value="">Choose a technology...</option>
              {list.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
          </label>
          <label className="field-label">
            Why this one
            <input
              aria-label={`Why ${kindLabels[kind]}`}
              maxLength={WHY_MAX}
              placeholder="One line: what about this workload makes it the right call?"
              value={why[kind] ?? ""}
              onChange={(event) => setWhy((prev) => ({ ...prev, [kind]: event.target.value }))}
            />
          </label>
          {list.length === 0 && <p className="tech-warning"><CircleAlert size={12} />The catalog has no option for this kind yet.</p>}
        </li>;
      })}
    </ul>}

    <div className="tech-data-model">
      <div className="tech-choice-kind"><Database size={13} />Data model</div>
      <p className="tech-prompt">{prompt}</p>
      <textarea
        aria-label="Data model"
        rows={6}
        value={dataModel}
        onChange={(event) => setDataModel(event.target.value)}
        placeholder="Entities, primary keys, query patterns, growth..."
      />
      <div className="tech-word-count"><span className={dataModelWords >= DATA_MODEL_MIN_WORDS ? "ok" : ""}>{dataModelWords} / {DATA_MODEL_MIN_WORDS} words</span></div>
    </div>

    {touched && !ready && <p className="tech-warning"><CircleAlert size={12} />Choose a technology and give a one-line reason for every component, and describe the data model in at least {DATA_MODEL_MIN_WORDS} words.</p>}

    <div className="tech-actions">
      <button type="button" className="button primary" onClick={commit} disabled={!ready}>Commit choices<ChevronRight size={14} /></button>
      {!required && <button type="button" className="button" onClick={onSkip}><SkipForward size={14} />Skip this step</button>}
    </div>
  </section>;
}
