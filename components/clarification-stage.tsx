"use client";
import { Circle, HelpCircle, MapPin, ShieldCheck, Sparkles } from "lucide-react";
import type { Lesson } from "@/lib/types";

export function ClarificationStage({ lesson, asked, onAsk, revealed }: {
  lesson: Lesson;
  asked: string[];
  onAsk: (question: string) => void;
  revealed: boolean;
}) {
  const clarifications = lesson.clarifications ?? [];
  const relevantTotal = clarifications.filter((item) => item.relevant).length;
  const relevantAsked = clarifications.filter((item) => item.relevant && asked.includes(item.question)).length;
  const needed = Math.ceil(relevantTotal / 2);
  return <div className="clarification-stage">
    <div className="requirements-heading"><span>CLARIFY THE BRIEF</span><span>{relevantAsked}/{relevantTotal}</span></div>
    <p className="clarification-progress">{relevantAsked} of {relevantTotal} relevant questions asked; ask at least {needed} to reveal the workload.</p>
    <ul className="clarification-list">
      {clarifications.map((item) => {
        const isAsked = asked.includes(item.question);
        return <li key={item.question} className={isAsked ? "asked" : ""}>
          <button type="button" onClick={() => onAsk(item.question)} disabled={isAsked}>
            <HelpCircle size={14} />
            <span>{item.question}</span>
            {isAsked && <span className={`clarification-tag ${item.relevant ? "useful" : "not-needed"}`}>{item.relevant ? "Useful" : "Not needed"}</span>}
          </button>
          {isAsked && <p className="clarification-answer">{item.answer}</p>}
        </li>;
      })}
    </ul>
    {revealed && <div className="workload-summary">
      <div className="requirements-heading"><span>WORKLOAD REVEALED</span><Sparkles size={13} /></div>
      <ul>
        <li><ShieldCheck size={13} /><span>{lesson.workload.requestRate} req/s, {lesson.workload.pattern} traffic</span></li>
        <li><MapPin size={13} /><span>{Math.round(lesson.workload.readRatio * 100)}% reads / {Math.round((1 - lesson.workload.readRatio) * 100)}% writes</span></li>
        <li><HelpCircle size={13} /><span>{lesson.workload.failure === "none" && !lesson.workload.failures?.length ? "No injected failure" : lesson.workload.failures?.length ? `${lesson.workload.failures.length} injected failure${lesson.workload.failures.length > 1 ? "s" : ""}` : `One ${lesson.workload.failure} failure`}</span></li>
        <li><MapPin size={13} /><span>{lesson.workload.regions?.length ? lesson.workload.regions.map((region) => `${region.name} (${Math.round(region.share * 100)}%)`).join(", ") : "Single region: primary"}</span></li>
      </ul>
      <div className="requirements-heading"><span>OBJECTIVES</span></div>
      <ul className="objective-list">
        {lesson.objectives.map((objective) => <li key={objective.id}><Circle size={15} /><span>{objective.label}</span></li>)}
      </ul>
    </div>}
  </div>;
}
