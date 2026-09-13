"use client";
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronRight, CircleAlert, Cpu, Database, Lightbulb, SkipForward } from "lucide-react";
import type { Architecture, Lesson, NodeKind, SystemNode, Workload } from "@/lib/types";
import { suggestFor, techCatalog, workloadTraits, type TechOption, type Trait } from "@/lib/tech-catalog";

/** One committed technology decision for one node: which option was chosen, why, and what the
 *  learner expects to measure once the design runs ("~85% hits", "~120 writes/s"). */
export interface TechChoice {
  nodeId: string;
  kind: NodeKind;
  optionId: string;
  name: string;
  why: string;
  expected: string;
}
export interface TechCommit {
  techChoices: TechChoice[];
  dataModel: string;
}

const DEFAULT_DATA_MODEL_PROMPT = "List the main entities, their primary keys, the 3 most important query patterns, and how the data grows";
const WHY_MAX = 160;
const EXPECTED_MAX = 60;

const kindLabels: Record<NodeKind, string> = {
  traffic: "Traffic source",
  server: "Application server",
  "load-balancer": "Load balancer",
  database: "Database",
  cache: "Cache",
  queue: "Queue",
  cdn: "CDN",
  "rate-limiter": "Rate limiter",
  "object-store": "Object store",
  stream: "Stream",
};

interface ChecklistItem { id: string; label: string }
const DATA_MODEL_CHECKLIST: ChecklistItem[] = [
  { id: "entities", label: "I listed the main entities" },
  { id: "keys", label: "I named a primary key for each entity" },
  { id: "queryPatterns", label: "I described the query patterns that matter" },
  { id: "growth", label: "I said how the data grows over time" },
];

function readableTrait(trait: string): string {
  return trait.replace(/-/g, " ");
}

/** The nodes this lesson asks the learner to choose a technology for: every enabled, non-traffic
 *  node, or only those matching the lesson's tech focus when it sets one. */
export function techNodes(lesson: Lesson | undefined, architecture: Architecture): SystemNode[] {
  const focus = lesson?.techFocus;
  const nodes = architecture.nodes.filter((node) => node.enabled && node.kind !== "traffic");
  if (focus && focus.length > 0) return nodes.filter((node) => focus.includes(node.kind));
  return nodes;
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
  const [expected, setExpected] = useState<Record<string, string>>({});
  const [dataModel, setDataModel] = useState("");
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const [committed, setCommitted] = useState<TechCommit | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    setSelection({});
    setWhy({});
    setExpected({});
    setDataModel("");
    setChecklist({});
    setCommitted(null);
    setTouched(false);
  }, [lesson.id]);

  const nodes = useMemo(() => techNodes(lesson, architecture), [lesson, architecture]);
  const activeTraits = useMemo<Trait[]>(() => {
    try {
      return workloadTraits(workload, architecture);
    } catch {
      return [];
    }
  }, [workload, architecture]);
  const options = useMemo(() => {
    const map = new Map<NodeKind, TechOption[]>();
    for (const node of nodes) if (!map.has(node.kind)) map.set(node.kind, optionsFor(node.kind, activeTraits));
    return map;
  }, [nodes, activeTraits]);

  const prompt = lesson.dataModelPrompt ?? DEFAULT_DATA_MODEL_PROMPT;
  const missingChoice = nodes.some((node) => !selection[node.id]);
  const missingWhy = nodes.some((node) => (why[node.id] ?? "").trim().length < 3);
  const missingExpected = nodes.some((node) => (expected[node.id] ?? "").trim().length < 2);
  const missingChecklist = DATA_MODEL_CHECKLIST.some((item) => !checklist[item.id]);
  const dataModelEmpty = dataModel.trim().length === 0;
  const ready = !missingChoice && !missingWhy && !missingExpected && !missingChecklist && !dataModelEmpty;

  function commit() {
    setTouched(true);
    if (!ready) return;
    const techChoices: TechChoice[] = nodes.map((node) => {
      const optionId = selection[node.id]!;
      const option = (options.get(node.kind) ?? []).find((candidate) => candidate.id === optionId);
      return {
        nodeId: node.id,
        kind: node.kind,
        optionId,
        name: option?.name ?? optionId,
        why: (why[node.id] ?? "").trim(),
        expected: (expected[node.id] ?? "").trim(),
      };
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
          const node = architecture.nodes.find((candidate) => candidate.id === choice.nodeId);
          const fits = option?.fits ?? [];
          const avoid = option?.avoid ?? [];
          const matchedFits = fits.filter((trait) => activeTraits.includes(trait));
          const matchedAvoid = avoid.filter((trait) => activeTraits.includes(trait));
          const rank = list.findIndex((candidate) => candidate.id === choice.optionId);
          const verdict = matchedAvoid.length > 0 ? "poor" : matchedFits.length > 0 ? "strong" : "neutral";
          return <li key={choice.nodeId} className={`tech-reveal ${verdict}`}>
            <div className="tech-reveal-head">
              <span className="tech-reveal-kind">{node?.label ?? kindLabels[choice.kind]}</span>
              <strong>{choice.name}</strong>
              <span className={`tech-fit ${verdict}`}>{verdict === "poor" ? "works against this workload" : verdict === "strong" ? "fits this workload" : "neutral for this workload"}</span>
              {rank >= 0 && list.length > 1 && <span className="tech-rank">catalog rank {rank + 1} of {list.length}</span>}
            </div>
            <p className="tech-reveal-why"><span>Your reason:</span> {choice.why}</p>
            <p className="tech-reveal-why"><span>You expected:</span> {choice.expected}</p>
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
      <p className="tech-handoff"><Lightbulb size={13} />The interviewer has your choices, your expectations and your data model. Contradictions between what you expected and what the run measured will cost points.</p>
    </section>;
  }

  return <section className="tech-stage">
    <div className="tech-heading">
      <span className="tech-icon"><Cpu size={17} /></span>
      <span>Technology and data model</span>
      <span className={`tech-badge ${required ? "required" : ""}`}>{required ? "Required before the defense" : "Optional step"}</span>
    </div>
    <p className="tech-intro">Pick a concrete technology for each component and say why in one line. Then state what you expect to measure once it runs ("~85% hits", "~120 writes/s") — a contradiction with the measured run costs points at the defense. Fit notes stay hidden until you commit.</p>

    {nodes.length === 0 ? <p className="tech-empty">No components in this design need a technology choice. Describe the data model and continue.</p> : <ul className="tech-choice-list">
      {nodes.map((node) => {
        const list = options.get(node.kind) ?? [];
        return <li key={node.id} className="tech-choice">
          <div className="tech-choice-kind">{node.label} <span>· {kindLabels[node.kind]}</span></div>
          <label className="field-label">
            Technology
            <select
              aria-label={`Technology for ${node.label}`}
              value={selection[node.id] ?? ""}
              onChange={(event) => setSelection((prev) => ({ ...prev, [node.id]: event.target.value }))}
            >
              <option value="">Choose a technology...</option>
              {list.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
          </label>
          <label className="field-label">
            Why this one
            <input
              aria-label={`Why ${node.label}`}
              maxLength={WHY_MAX}
              placeholder="One line: what about this workload makes it the right call?"
              value={why[node.id] ?? ""}
              onChange={(event) => setWhy((prev) => ({ ...prev, [node.id]: event.target.value }))}
            />
          </label>
          <label className="field-label">
            Expected
            <input
              aria-label={`Expected result for ${node.label}`}
              maxLength={EXPECTED_MAX}
              placeholder="~85% hits, ~120 writes/s..."
              value={expected[node.id] ?? ""}
              onChange={(event) => setExpected((prev) => ({ ...prev, [node.id]: event.target.value }))}
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
      <ul className="tech-checklist">
        {DATA_MODEL_CHECKLIST.map((item) => <li key={item.id}>
          <label>
            <input
              type="checkbox"
              checked={!!checklist[item.id]}
              onChange={() => setChecklist((prev) => ({ ...prev, [item.id]: !prev[item.id] }))}
            />
            <span>{item.label}</span>
          </label>
        </li>)}
      </ul>
    </div>

    {touched && !ready && <p className="tech-warning"><CircleAlert size={12} />Choose a technology, a one-line reason and an expected result for every component, describe the data model, and check off every item in the checklist.</p>}

    <div className="tech-actions">
      <button type="button" className="button primary" onClick={commit} disabled={!ready}>Commit choices<ChevronRight size={14} /></button>
      {!required && <button type="button" className="button" onClick={onSkip}><SkipForward size={14} />Skip this step</button>}
    </div>
  </section>;
}
