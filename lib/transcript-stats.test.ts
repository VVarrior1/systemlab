import { describe, expect, it } from "vitest";
import { transcriptStats, type TranscriptStatsEntry } from "./transcript-stats";

describe("transcriptStats", () => {
  it("returns all-zero stats for an empty transcript", () => {
    const stats = transcriptStats([]);
    expect(stats).toEqual({
      wordsPerMinute: 0,
      fillerRatio: 0,
      numbersStated: 0,
      signposts: 0,
      secondsPerPhase: {},
      candidateShare: 0,
    });
  });

  it("computes words per minute from candidate speech only, over elapsed time", () => {
    const entries: TranscriptStatsEntry[] = [
      { role: "interviewer", text: "Walk me through the design.", at: 0, phase: "clarify" },
      { role: "candidate", text: "one two three four five six seven eight nine ten", at: 0, phase: "clarify" },
      { role: "interviewer", text: "Okay, go on.", at: 60_000, phase: "clarify" },
    ];
    const stats = transcriptStats(entries);
    // 10 candidate words over 1 minute elapsed (0 -> 60s)
    expect(stats.wordsPerMinute).toBeCloseTo(10, 5);
  });

  it("uses a minimum window of one second so a single-instant transcript doesn't divide by zero", () => {
    const entries: TranscriptStatsEntry[] = [{ role: "candidate", text: "hello world", at: 1000, phase: "clarify" }];
    const stats = transcriptStats(entries);
    expect(Number.isFinite(stats.wordsPerMinute)).toBe(true);
    expect(stats.wordsPerMinute).toBeGreaterThan(0);
  });

  it("computes fillerRatio from um/uh/like/you know/sort of, as a share of candidate words", () => {
    const entries: TranscriptStatsEntry[] = [
      { role: "candidate", text: "um so like it is sort of a cache you know", at: 0, phase: "design" },
    ];
    const stats = transcriptStats(entries);
    // filler tokens: um, like, sort of, you know = 4 matches; word count = 11
    expect(stats.fillerRatio).toBeCloseTo(4 / 11, 5);
  });

  it("counts numbers stated only from candidate turns", () => {
    const entries: TranscriptStatsEntry[] = [
      { role: "interviewer", text: "What is your p95 target, say 100ms?", at: 0, phase: "estimate" },
      { role: "candidate", text: "I'd target 200ms p95 with 5000 requests per second and 99.9% uptime.", at: 1000, phase: "estimate" },
    ];
    const stats = transcriptStats(entries);
    expect(stats.numbersStated).toBe(4); // 200, 95 (from p95), 5000, 99.9
  });

  it("counts signpost words (first/then/next/tradeoff/because/alternatively/however) from candidate turns", () => {
    const entries: TranscriptStatsEntry[] = [
      {
        role: "candidate",
        text: "First I'd add a cache, then a queue. The tradeoff is staleness, because writes are rare. However, alternatively we could shard.",
        at: 0,
        phase: "design",
      },
    ];
    const stats = transcriptStats(entries);
    expect(stats.signposts).toBe(6);
  });

  it("buckets seconds per phase using the gap to the next entry", () => {
    const entries: TranscriptStatsEntry[] = [
      { role: "interviewer", text: "Q1", at: 0, phase: "clarify" },
      { role: "candidate", text: "A1", at: 30_000, phase: "clarify" },
      { role: "interviewer", text: "Q2", at: 300_000, phase: "estimate" },
      { role: "candidate", text: "A2", at: 330_000, phase: "estimate" },
    ];
    const stats = transcriptStats(entries);
    expect(stats.secondsPerPhase.clarify).toBeCloseTo(300, 5);
    expect(stats.secondsPerPhase.estimate).toBeCloseTo(30, 5);
  });

  it("computes candidateShare as the candidate's share of total words", () => {
    const entries: TranscriptStatsEntry[] = [
      { role: "interviewer", text: "one two", at: 0, phase: "clarify" },
      { role: "candidate", text: "one two three four five six", at: 1000, phase: "clarify" },
    ];
    const stats = transcriptStats(entries);
    expect(stats.candidateShare).toBeCloseTo(6 / 8, 5);
  });

  it("sorts entries by `at` before computing, regardless of input order", () => {
    const entries: TranscriptStatsEntry[] = [
      { role: "candidate", text: "A2", at: 60_000, phase: "clarify" },
      { role: "interviewer", text: "Q1", at: 0, phase: "clarify" },
    ];
    const stats = transcriptStats(entries);
    expect(stats.wordsPerMinute).toBeCloseTo(1, 5);
  });
});
