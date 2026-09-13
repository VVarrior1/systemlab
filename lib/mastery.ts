import type { EstimationId, Lesson, ProgressRecord } from "./types";
import { isCurrentProgress } from "./assessment-version";

const SPACED_INTERVAL_DAYS = [1, 3, 7, 14];
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ConceptStats {
  concept: string;
  lessons: number;
  completed: number;
  avgDefense: number | null;
  avgEstimation: number | null;
  weakConcepts: string[];
}

export type ReviewReason = "low-defense" | "weak-concept" | "spaced-review" | "blank-canvas-next";
export interface ReviewQueueItem {
  lessonId: string;
  reason: ReviewReason;
  due: Date;
}

export interface MasterySummary {
  score: number;
  strongest: string[];
  weakest: string[];
}

const estimationLabels: Record<EstimationId, string> = {
  p95: "p95 latency",
  throughput: "throughput",
  cost: "infrastructure cost",
  dbLoad: "database load",
  bottleneckCapacity: "bottleneck capacity",
  queueDepth: "queue depth",
};

function currentRecords(records: ProgressRecord[]): ProgressRecord[] {
  return records.filter(isCurrentProgress);
}

function lessonById(lessons: Lesson[]): Map<string, Lesson> {
  return new Map(lessons.map((lesson) => [lesson.id, lesson] as const));
}

export function conceptStats(records: ProgressRecord[], lessons: Lesson[]): ConceptStats[] {
  const byConcept = new Map<string, Lesson[]>();
  for (const lesson of lessons) {
    const list = byConcept.get(lesson.concept) ?? [];
    list.push(lesson);
    byConcept.set(lesson.concept, list);
  }
  const current = currentRecords(records);
  const recordsByLesson = new Map<string, ProgressRecord>();
  for (const item of current) recordsByLesson.set(item.lessonId, item);

  return [...byConcept.entries()].map(([concept, conceptLessons]) => {
    const conceptRecords = conceptLessons.map((lesson) => recordsByLesson.get(lesson.id)).filter((item): item is ProgressRecord => !!item);
    const defenseScores = conceptRecords.map((item) => item.defenseScore).filter((item): item is number => item !== undefined);
    const estimationScores = conceptRecords.map((item) => item.estimationScore).filter((item): item is number => item !== undefined);
    const weakConcepts = [...new Set(conceptRecords.flatMap((item) => item.weakConcepts ?? []))];
    return {
      concept,
      lessons: conceptLessons.length,
      completed: conceptRecords.length,
      avgDefense: defenseScores.length ? defenseScores.reduce((sum, item) => sum + item, 0) / defenseScores.length : null,
      avgEstimation: estimationScores.length ? estimationScores.reduce((sum, item) => sum + item, 0) / estimationScores.length : null,
      weakConcepts,
    };
  });
}

export function reviewQueue(records: ProgressRecord[], lessons: Lesson[], now: Date): ReviewQueueItem[] {
  const lessonsById = lessonById(lessons);
  const current = currentRecords(records);
  const items: ReviewQueueItem[] = [];

  for (const record of current) {
    const lesson = lessonsById.get(record.lessonId);
    if (!lesson) continue;
    const completedAt = new Date(record.completedAt);

    if (record.defenseScore !== undefined && record.defenseScore < 60) {
      items.push({ lessonId: record.lessonId, reason: "low-defense", due: completedAt });
    }
    if (record.weakConcepts && record.weakConcepts.length > 0) {
      items.push({ lessonId: record.lessonId, reason: "weak-concept", due: completedAt });
    }
    const intervalIndex = Math.min((record.remixes ?? 0) + 1, SPACED_INTERVAL_DAYS.length) - 1;
    const intervalDays = SPACED_INTERVAL_DAYS[intervalIndex];
    const due = new Date(completedAt.getTime() + intervalDays * DAY_MS);
    if (due <= now) {
      items.push({ lessonId: record.lessonId, reason: "spaced-review", due });
    }
    if (lesson.kind === "sim" && !record.blankCanvas) {
      items.push({ lessonId: record.lessonId, reason: "blank-canvas-next", due: completedAt });
    }
  }

  return items.sort((a, b) => a.due.getTime() - b.due.getTime());
}

export function estimationDiagnosis(records: ProgressRecord[]): string[] {
  const current = currentRecords(records);
  const byPrompt = new Map<EstimationId, number[]>();
  for (const record of current) {
    if (!record.estimationBias) continue;
    for (const [id, bias] of Object.entries(record.estimationBias) as [EstimationId, number][]) {
      const list = byPrompt.get(id) ?? [];
      list.push(bias);
      byPrompt.set(id, list);
    }
  }
  const lines: string[] = [];
  for (const [id, biases] of byPrompt.entries()) {
    if (biases.length < 3) continue;
    const avg = biases.reduce((sum, item) => sum + item, 0) / biases.length;
    if (Math.abs(avg) < 0.15) continue;
    const direction = avg < 0 ? "under-estimate" : "over-estimate";
    const pct = Math.round(Math.abs(avg) * 100);
    lines.push(`You ${direction} ${estimationLabels[id]} by ${pct}% on average across ${biases.length} lessons.`);
  }
  return lines;
}

export function masterySummary(records: ProgressRecord[], lessons: Lesson[], now: Date): MasterySummary {
  const current = currentRecords(records);
  const completed = new Set(current.map((item) => item.lessonId));

  const completionScore = lessons.length ? (completed.size / lessons.length) * 100 : 0;

  const defenseScores = current.map((item) => item.defenseScore).filter((item): item is number => item !== undefined);
  const defenseScoreAvg = defenseScores.length ? defenseScores.reduce((sum, item) => sum + item, 0) / defenseScores.length : 0;

  const estimationScores = current.map((item) => item.estimationScore).filter((item): item is number => item !== undefined);
  const estimationScoreAvg = estimationScores.length ? (estimationScores.reduce((sum, item) => sum + item, 0) / estimationScores.length) * 100 : 0;

  const chapters = new Set(lessons.map((lesson) => lesson.chapter));
  const completedChapters = new Set(lessons.filter((lesson) => completed.has(lesson.id)).map((lesson) => lesson.chapter));
  const breadthScore = chapters.size ? (completedChapters.size / chapters.size) * 100 : 0;

  const score = Math.round(completionScore * 0.4 + defenseScoreAvg * 0.3 + estimationScoreAvg * 0.2 + breadthScore * 0.1);

  const stats = conceptStats(records, lessons).filter((item) => item.completed > 0 && item.avgDefense !== null);
  const sorted = [...stats].sort((a, b) => (b.avgDefense as number) - (a.avgDefense as number));
  const strongest = sorted.slice(0, 3).map((item) => item.concept);
  const weakest = sorted.slice(-3).reverse().map((item) => item.concept);

  void now;
  return { score: Math.max(0, Math.min(100, score)), strongest, weakest };
}
