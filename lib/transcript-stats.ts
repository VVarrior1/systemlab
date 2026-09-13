/**
 * Pure, client-usable transcript analytics for the mock interview (spec
 * section 15 item 1). Computed from the raw session transcript so the same
 * numbers can be shown live in the UI and sent to the grader as
 * `context.stats`.
 */

export type TranscriptStatsRole = "interviewer" | "candidate";

export interface TranscriptStatsEntry {
  role: TranscriptStatsRole;
  text: string;
  /** Timestamp (ms) the turn started at. Entries need not be pre-sorted. */
  at: number;
  /** Mock-interview phase this turn happened in, e.g. "clarify" | "estimate" | "design" | "deep-dive" | "wrap". */
  phase: string;
}

export interface TranscriptStats {
  wordsPerMinute: number;
  fillerRatio: number;
  numbersStated: number;
  signposts: number;
  secondsPerPhase: Record<string, number>;
  candidateShare: number;
}

const FILLER_PATTERNS: RegExp[] = [/\bum\b/gi, /\buh\b/gi, /\blike\b/gi, /\byou know\b/gi, /\bsort of\b/gi];
const SIGNPOST_WORDS = ["first", "then", "next", "tradeoff", "because", "alternatively", "however"];
const SIGNPOST_PATTERN = new RegExp(`\\b(${SIGNPOST_WORDS.join("|")})\\b`, "gi");
const NUMBER_PATTERN = /\d+(\.\d+)?%?/g;

function wordsIn(text: string): string[] {
  const trimmed = text.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

const EMPTY_STATS: TranscriptStats = {
  wordsPerMinute: 0,
  fillerRatio: 0,
  numbersStated: 0,
  signposts: 0,
  secondsPerPhase: {},
  candidateShare: 0,
};

/**
 * Computes verbal-performance proxies from a mock-interview transcript.
 * Entries are sorted by `at` internally, so callers may pass them in any order.
 */
export function transcriptStats(entries: TranscriptStatsEntry[]): TranscriptStats {
  if (entries.length === 0) {
    return { ...EMPTY_STATS };
  }

  const sorted = [...entries].sort((a, b) => a.at - b.at);
  const candidateEntries = sorted.filter((e) => e.role === "candidate");
  const interviewerEntries = sorted.filter((e) => e.role === "interviewer");

  const candidateWordCount = candidateEntries.reduce((sum, e) => sum + wordsIn(e.text).length, 0);
  const interviewerWordCount = interviewerEntries.reduce((sum, e) => sum + wordsIn(e.text).length, 0);

  const firstAt = sorted[0]!.at;
  const lastAt = sorted[sorted.length - 1]!.at;
  const totalMinutes = Math.max((lastAt - firstAt) / 60_000, 1 / 60);
  const wordsPerMinute = candidateWordCount / totalMinutes;

  let fillerCount = 0;
  for (const entry of candidateEntries) {
    for (const pattern of FILLER_PATTERNS) {
      fillerCount += countMatches(entry.text, pattern);
    }
  }
  const fillerRatio = candidateWordCount === 0 ? 0 : fillerCount / candidateWordCount;

  const numbersStated = candidateEntries.reduce((sum, e) => sum + countMatches(e.text, NUMBER_PATTERN), 0);
  const signposts = candidateEntries.reduce((sum, e) => sum + countMatches(e.text, SIGNPOST_PATTERN), 0);

  const secondsPerPhase: Record<string, number> = {};
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i]!;
    const next = sorted[i + 1];
    const durationSeconds = next ? Math.max((next.at - entry.at) / 1000, 0) : 0;
    secondsPerPhase[entry.phase] = (secondsPerPhase[entry.phase] ?? 0) + durationSeconds;
  }

  const totalWords = candidateWordCount + interviewerWordCount;
  const candidateShare = totalWords === 0 ? 0 : candidateWordCount / totalWords;

  return { wordsPerMinute, fillerRatio, numbersStated, signposts, secondsPerPhase, candidateShare };
}
