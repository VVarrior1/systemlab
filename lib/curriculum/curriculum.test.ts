import { describe, expect, it } from "vitest";
import { chapters, lessons } from "./index";
import { chapterTitles } from "./shared";
import { runSimulation, validateSimulation } from "../simulation";
import { assessmentSeeds, objectivePasses, validateMissionArchitecture } from "../assessment";
import { remixLesson, deriveRemixObjectives } from "../remix";

/** Set LESSON_FILTER=hot-keys,cold-start (ids or chapter titles, comma separated) to iterate on a subset. */
const filter = (process.env.LESSON_FILTER ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
const selected = filter.length ? lessons.filter((item) => filter.includes(item.id) || filter.includes(item.chapter.toLowerCase())) : lessons;
const hintNumberRule = /\d+(\.\d+)?\s*(req\/s|requests per second|jobs per second|ms\b|milliseconds|credits?|%|percent|replicas?|shards?|entries)/i;
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

describe("curriculum structure", () => {
  it("has unique ids, contiguous numbers, and chapters in the declared order", () => {
    expect(new Set(lessons.map((item) => item.id)).size).toBe(lessons.length);
    lessons.forEach((item, index) => expect(item.number).toBe(index + 1));
    expect(chapters).toEqual([...chapterTitles]);
    let last = -1;
    for (const item of lessons) {
      const index = chapters.indexOf(item.chapter);
      expect(index).toBeGreaterThanOrEqual(last);
      last = index;
    }
  });

  it.skipIf(filter.length > 0)("covers every chapter with at least three lessons", () => {
    for (const chapter of chapters) expect(lessons.filter((item) => item.chapter === chapter).length).toBeGreaterThanOrEqual(3);
  });

  it.skipIf(selected.length === 0).each(selected.map((item) => [item.id, item] as const))("%s follows the authoring rules", (_, item) => {
    for (const hint of item.hints) expect(hint, `hint reveals a number: ${hint}`).not.toMatch(hintNumberRule);
    expect(item.learning.length).toBeGreaterThanOrEqual(3);
    expect(item.readings.length, "readings").toBeGreaterThanOrEqual(2);
    for (const reading of item.readings) {
      expect(reading.url).toMatch(/^https:\/\//);
      expect(words(reading.why)).toBeGreaterThanOrEqual(6);
    }
    expect(item.defense.followUps.length, "follow-ups").toBeGreaterThanOrEqual(2);
    expect(item.defense.rubric.reduce((sum, row) => sum + row.weight, 0), "rubric weights").toBe(100);
    expect(item.defense.rubric.length).toBeGreaterThanOrEqual(3);
    expect(words(item.defense.modelAnswer), "model answer length").toBeGreaterThanOrEqual(80);
    expect(item.reflection.options.length).toBeGreaterThanOrEqual(3);
    expect(item.reflection.answer).toBeGreaterThanOrEqual(0);
    expect(item.reflection.answer).toBeLessThan(item.reflection.options.length);
    expect(words(item.brief)).toBeGreaterThanOrEqual(25);
    if (item.kind === "written") {
      expect(item.objectives).toEqual([]);
      expect(item.remixable).toBe(false);
    } else {
      expect(item.objectives.length).toBeGreaterThanOrEqual(2);
      expect(item.hints.length).toBeGreaterThanOrEqual(2);
      if (item.kind === "sim") expect(item.estimation.length).toBeGreaterThanOrEqual(2);
      for (const used of new Set(item.reference.nodes.filter((n) => n.kind !== "traffic").map((n) => n.kind))) {
        expect(item.allowedKinds, `reference uses ${used} which is not allowed`).toContain(used);
      }
    }
    if (item.kind === "brief") {
      expect(item.clarifications?.length ?? 0).toBeGreaterThanOrEqual(4);
      expect(item.clarifications?.filter((c) => c.relevant).length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });
});

const graded = selected.filter((item) => item.kind !== "written");
describe.skipIf(graded.length === 0)("references and starters", () => {
  it.each(graded.map((item) => [item.id, item] as const))("%s: the reference passes every objective on all assessment seeds", (_, item) => {
    expect(validateMissionArchitecture(item, item.reference)).toBeNull();
    validateSimulation(item.reference, item.workload);
    for (const seed of assessmentSeeds(item)) {
      const result = runSimulation(item.reference, { ...item.workload, seed });
      for (const objective of item.objectives) {
        expect(objectivePasses(result, objective), `${objective.label} (seed ${seed}): ${objective.metric}=${result[objective.metric]}`).toBe(true);
      }
    }
  });

  it.each(graded.filter((item) => item.number !== 1).map((item) => [item.id, item] as const))("%s: the starter fails at least one objective, so there is something to fix", (_, item) => {
    validateSimulation(item.architecture, item.workload);
    const result = runSimulation(item.architecture, item.workload);
    expect(item.objectives.some((objective) => !objectivePasses(result, objective))).toBe(true);
  });
});

const remixable = selected.filter((item) => item.remixable);
describe.skipIf(remixable.length === 0)("remix", () => {
  it.each(remixable.map((item) => [item.id, item] as const))("%s: the scaled reference satisfies the derived objectives", (_, item) => {
    const remix = remixLesson(item, 7);
    const results = assessmentSeeds({ ...item, workload: remix.workload }).map((seed) => runSimulation(remix.reference, { ...remix.workload, seed }));
    const objectives = deriveRemixObjectives(item, remix.workload, results);
    expect(objectives.length).toBeGreaterThanOrEqual(3);
    for (const result of results) for (const objective of objectives) expect(objectivePasses(result, objective), `${objective.label}: ${result[objective.metric]}`).toBe(true);
  });
});
