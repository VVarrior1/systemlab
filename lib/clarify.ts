import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Clarification, Lesson } from "./types";

/**
 * Result of matching a free-text question against a lesson's authored
 * clarifications.
 */
export interface ClarificationMatch {
  index: number;
  score: number;
}

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "do", "does", "did",
  "what", "whats", "how", "why", "when", "where", "who", "which",
  "will", "would", "could", "should", "can", "may", "might",
  "of", "in", "on", "for", "to", "at", "with", "by", "from", "into",
  "and", "or", "if", "but", "so", "than", "as",
  "we", "you", "your", "i", "it", "its", "this", "that", "these", "those",
  "be", "been", "being", "have", "has", "had",
  "about", "many", "much", "going", "happen", "happens", "there", "here",
  "any", "some", "our", "my", "me", "us", "them", "they",
]);

/** Very small, order-sensitive suffix stripper — not a real stemmer, just
 * enough to fold plurals/gerunds together for keyword overlap. */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** Groups of interview-jargon synonyms that should count as the same concept. */
const SYNONYM_GROUPS: string[][] = [
  ["qps", "rps", "traffic", "load", "throughput", "volume", "request", "requests"],
  ["latency", "slo", "sla", "p95", "p99", "response", "responsetime", "speed", "fast", "slow"],
  ["consistency", "consistent", "stale", "staleness", "fresh", "freshness"],
  ["budget", "cost", "costs", "pricing", "price", "expensive", "cheap"],
  ["region", "regions", "geo", "geography", "where", "location", "datacenter", "global"],
  ["retention", "long", "duration", "keep", "store", "storage", "history", "expire", "expiry", "ttl"],
  ["peak", "burst", "bursty", "spike", "spiky", "surge"],
];

const SYNONYM_LOOKUP: Map<string, string> = new Map();
for (const group of SYNONYM_GROUPS) {
  const canonical = group[0]!;
  for (const word of group) {
    SYNONYM_LOOKUP.set(word, canonical);
  }
}

function canonicalize(word: string): string {
  const stemmed = stem(word);
  return SYNONYM_LOOKUP.get(word) ?? SYNONYM_LOOKUP.get(stemmed) ?? stemmed;
}

function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOPWORDS.has(word));

  const tokens = new Set<string>();
  for (const word of words) {
    tokens.add(canonicalize(word));
  }
  return tokens;
}

/** Minimum Dice-coefficient overlap between the asked question and an
 * authored clarification's question before we treat them as a match. */
const MATCH_THRESHOLD = 0.34;

/**
 * Matches a free-text question against a lesson's authored clarifications
 * using normalised keyword overlap (stopwords removed, light stemming,
 * synonym groups for common interview vocabulary). Returns the best match
 * above threshold, or null if nothing is close enough.
 */
export function matchClarification(
  question: string,
  clarifications: Clarification[]
): ClarificationMatch | null {
  const questionTokens = tokenize(question);
  if (questionTokens.size === 0) return null;

  let best: ClarificationMatch | null = null;

  clarifications.forEach((clarification, index) => {
    const candidateTokens = tokenize(clarification.question);
    if (candidateTokens.size === 0) return;

    let overlap = 0;
    for (const token of questionTokens) {
      if (candidateTokens.has(token)) overlap += 1;
    }
    const score = (2 * overlap) / (questionTokens.size + candidateTokens.size);

    if (score >= MATCH_THRESHOLD && (best === null || score > best.score)) {
      best = { index, score };
    }
  });

  return best;
}

/**
 * Fallback reply used when there is no API key configured: a neutral,
 * in-character non-answer that never reveals authored clarification facts.
 */
export function neutralReply(question: string): string {
  void question;
  return "I don't have a strong requirement there — use your best judgment, the way a careful engineer would, and state the assumption you're making.";
}

export const ClarifyAnswerSchema = z.object({
  answer: z.string(),
});

export type ClarifyAnswer = z.infer<typeof ClarifyAnswerSchema>;

const CLARIFY_SYSTEM_PROMPT = `You are the interviewer in a system design interview. The candidate has asked a clarifying question about the brief.

You are given the brief and a list of hidden facts (requirements the interviewer knows but has not volunteered). Answer the candidate's question in character, in 1 to 2 sentences, using only those hidden facts. If the hidden facts do not cover what they asked, say exactly: "I don't have a strong requirement there; assume what a careful engineer would."

Never mention "hidden facts", "clarifications", or that any answer is flagged as relevant or not — just answer as the interviewer would. Do not volunteer facts the question did not ask about.`;

/**
 * Builds the system + user messages sent to Claude to answer a candidate's
 * clarifying question in character, using the lesson brief and every
 * authored clarification as hidden facts. The 'relevant' flags are never
 * included in what's sent, so they can never leak into the answer.
 */
export function buildClarifyMessages(
  lesson: Lesson,
  question: string
): { system: string; messages: Anthropic.MessageParam[] } {
  const facts = (lesson.clarifications ?? [])
    .map((c) => `Q: ${c.question}\nA: ${c.answer}`)
    .join("\n\n");

  const userContent = `Lesson: ${lesson.title}
Brief: ${lesson.brief}

Hidden facts (things you know as the interviewer but have not volunteered):
${facts || "(none authored for this lesson)"}

Candidate's clarifying question:
${question}`;

  return {
    system: CLARIFY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
  };
}

export interface ClarifyClient {
  messages: {
    parse: (params: {
      model: string;
      max_tokens: number;
      system: string;
      messages: Anthropic.MessageParam[];
      output_config: { effort: "medium"; format: ReturnType<typeof zodOutputFormat> };
    }) => Promise<{ parsed_output: ClarifyAnswer | null }>;
  };
}

/**
 * Answers a candidate's clarifying question in character as the interviewer,
 * using the brief and all authored clarifications as hidden facts. `client`
 * defaults to a new Anthropic() (reads ANTHROPIC_API_KEY from the
 * environment) but accepts a fake for unit testing.
 */
export async function answerAsInterviewer(
  lesson: Lesson,
  question: string,
  client: ClarifyClient = new Anthropic() as unknown as ClarifyClient
): Promise<string> {
  const { system, messages } = buildClarifyMessages(lesson, question);
  const model = process.env.GRADER_MODEL ?? "claude-opus-5";

  const response = await client.messages.parse({
    model,
    max_tokens: 500,
    system,
    messages,
    output_config: { effort: "medium", format: zodOutputFormat(ClarifyAnswerSchema) },
  });

  if (!response.parsed_output) {
    throw new Error("The interviewer failed to produce an answer.");
  }

  return response.parsed_output.answer;
}
