"use client";
import { Gauge } from "lucide-react";
import type { EstimationOutcome, EstimationValues } from "@/lib/estimation";
import { meanEstimationScore } from "@/lib/estimation";
import type { EstimationId, EstimationPrompt } from "@/lib/types";

function calibration(score: 0 | 0.5 | 1): string {
  return score === 1 ? "calibrated" : score === 0.5 ? "close" : "off";
}

function calibrationLabel(score: 0 | 0.5 | 1): string {
  return score === 1 ? "Calibrated" : score === 0.5 ? "Close" : "Off";
}

function deltaPercent(outcome: EstimationOutcome): string {
  const base = Math.abs(outcome.actual) < 1e-9 ? 1 : Math.abs(outcome.actual);
  const delta = ((outcome.predicted - outcome.actual) / base) * 100;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(0)}%`;
}

export function EstimationPanel({ prompts, values, onChange, locked, outcomes }: {
  prompts: EstimationPrompt[];
  values: EstimationValues;
  onChange: (id: EstimationId, value: number | undefined) => void;
  locked: boolean;
  outcomes: EstimationOutcome[] | null;
}) {
  if (prompts.length === 0) return null;
  const outcomeFor = (id: EstimationId) => outcomes?.find((outcome) => outcome.id === id) ?? null;
  return <div className="estimation-panel">
    <div className="requirements-heading"><span>ESTIMATE FIRST</span>{outcomes && <span>{Math.round(meanEstimationScore(outcomes) * 100)}%</span>}</div>
    <ul className="estimation-list">
      {prompts.map((prompt) => {
        const outcome = outcomeFor(prompt.id);
        return <li key={prompt.id} className={outcome ? `graded ${calibration(outcome.score)}` : ""}>
          <label className="field-label" htmlFor={`estimate-${prompt.id}`}>{prompt.label}</label>
          <div className="estimation-input">
            <input
              id={`estimate-${prompt.id}`}
              type="number"
              inputMode="decimal"
              disabled={locked}
              placeholder="?"
              value={values[prompt.id] ?? ""}
              onChange={(event) => {
                const raw = event.target.value;
                onChange(prompt.id, raw === "" ? undefined : Number(raw));
              }}
            />
            <span className="estimation-unit">{prompt.unit}</span>
          </div>
          {outcome && <p className="estimation-result">
            <span className="estimation-actual">Actual {outcome.actual.toFixed(1)} {outcome.unit}</span>
            <span className="estimation-delta">{deltaPercent(outcome)}</span>
            <span className={`estimation-tag ${calibration(outcome.score)}`}><Gauge size={11} />{calibrationLabel(outcome.score)}</span>
          </p>}
        </li>;
      })}
    </ul>
  </div>;
}
