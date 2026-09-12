"use client";
import { useState } from "react";
import { Circle, HelpCircle, MapPin, MessageCircle, Send, ShieldCheck, Sparkles } from "lucide-react";
import type { Lesson } from "@/lib/types";

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "to", "of", "in", "on", "for",
  "and", "or", "but", "with", "at", "by", "from", "as", "it", "this", "that", "what", "how", "do",
  "does", "did", "will", "would", "should", "can", "could", "have", "has", "had", "we", "you", "i",
  "our", "your", "their", "its", "there", "here", "which", "who", "when", "where", "why", "so",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** Local fallback: keyword overlap of at least 2 tokens or 40% of the question's tokens. */
function keywordMatch(question: string, clarifications: Lesson["clarifications"]): number {
  const askedTokens = new Set(tokenize(question));
  if (askedTokens.size === 0 || !clarifications) return -1;
  let bestIndex = -1;
  let bestScore = 0;
  clarifications.forEach((item, index) => {
    const itemTokens = new Set(tokenize(item.question));
    if (itemTokens.size === 0) return;
    let overlap = 0;
    for (const token of itemTokens) if (askedTokens.has(token)) overlap++;
    const ratio = overlap / itemTokens.size;
    if (overlap >= 2 || ratio >= 0.4) {
      if (overlap > bestScore) { bestScore = overlap; bestIndex = index; }
    }
  });
  return bestIndex;
}

type TranscriptEntry = { question: string; answer: string; matched: boolean };

export function ClarificationStage({ lesson, asked, onAsk, revealed, onHint }: {
  lesson: Lesson;
  asked: string[];
  onAsk: (question: string) => void;
  revealed: boolean;
  onHint?: () => void;
}) {
  const clarifications = lesson.clarifications ?? [];
  const relevantTotal = clarifications.filter((item) => item.relevant).length;
  const relevantAsked = clarifications.filter((item) => item.relevant && asked.includes(item.question)).length;
  const needed = Math.ceil(relevantTotal / 2);
  const [draft, setDraft] = useState("");
  const [asking, setAsking] = useState(false);
  const [showSuggested, setShowSuggested] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);

  const submit = async () => {
    const question = draft.trim();
    if (!question || asking) return;
    setDraft("");
    setAsking(true);
    try {
      const response = await fetch("/api/clarify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lessonId: lesson.id, question }),
      });
      if (!response.ok) throw new Error("clarify request failed");
      const data: { mode: "matched" | "answered" | "neutral"; index?: number; answer: string } = await response.json();
      if (data.mode === "matched" && typeof data.index === "number" && clarifications[data.index]) {
        const matched = clarifications[data.index];
        onAsk(matched.question);
        setTranscript((prev) => [...prev, { question, answer: matched.answer, matched: true }]);
      } else {
        setTranscript((prev) => [...prev, { question, answer: data.answer, matched: false }]);
      }
    } catch {
      const index = keywordMatch(question, clarifications);
      if (index >= 0) {
        const matched = clarifications[index];
        onAsk(matched.question);
        setTranscript((prev) => [...prev, { question, answer: matched.answer, matched: true }]);
      } else {
        setTranscript((prev) => [...prev, { question, answer: "The interviewer has no opinion on that.", matched: false }]);
      }
    } finally {
      setAsking(false);
    }
  };

  const revealSuggested = () => {
    setShowSuggested(true);
    onHint?.();
  };

  return <div className="clarification-stage">
    <div className="requirements-heading"><span>CLARIFY THE BRIEF</span><span>{relevantAsked}/{relevantTotal}</span></div>
    <p className="clarification-progress">{relevantAsked} of {relevantTotal} relevant questions asked; ask at least {needed} to reveal the workload.</p>

    <form
      className="clarify-ask-form"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
    >
      <input
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Ask the interviewer a question…"
        disabled={asking}
        aria-label="Ask a clarifying question"
      />
      <button type="submit" className="button small primary" disabled={asking || !draft.trim()}>
        <Send size={13} /><span>Ask</span>
      </button>
    </form>

    {transcript.length > 0 && <ul className="clarify-transcript">
      {transcript.map((entry, index) => <li key={index} className={entry.matched ? "matched" : "unmatched"}>
        <div className="clarify-transcript-q"><MessageCircle size={13} /><span>{entry.question}</span></div>
        <p className="clarify-transcript-a">{entry.answer}</p>
      </li>)}
    </ul>}

    {!showSuggested && <button type="button" className="text-button clarify-show-suggested" onClick={revealSuggested}>
      Show suggested questions
    </button>}

    {showSuggested && <ul className="clarification-list">
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
    </ul>}

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
