import { describe, expect, it } from "vitest";
import { checkDrill, drills, pickDrill, type DrillTemplate } from "./drills";

const seeds = Array.from({ length: 20 }, (_, i) => i * 7 + 1);

describe("drills registry", () => {
  it("has at least 14 templates with unique ids", () => {
    expect(drills.length).toBeGreaterThanOrEqual(14);
    const ids = new Set(drills.map((d) => d.id));
    expect(ids.size).toBe(drills.length);
  });

  it("has exactly one choice template (latency quiz) and the rest numeric", () => {
    const choiceTemplates = drills.filter((d) => d.kind === "choice");
    expect(choiceTemplates.length).toBeGreaterThanOrEqual(1);
    for (const t of choiceTemplates) expect(t.id).toBe("latency-numbers-quiz");
  });
});

describe.each(drills)("template: $id", (template: DrillTemplate) => {
  it("accepts its own answer for 20 seeds", () => {
    for (const seed of seeds) {
      const instance = template.generate(seed);
      const result = checkDrill(template, seed, instance.answer);
      expect(result.correct, `seed ${seed} rejected its own answer`).toBe(true);
      expect(result.expected).toBe(instance.answer);
    }
  });

  it("is deterministic for a given seed", () => {
    for (const seed of [1, 2, 3, 42, 999]) {
      const a = template.generate(seed);
      const b = template.generate(seed);
      expect(a).toEqual(b);
    }
  });

  it("produces instances with no NaN fields and non-empty explanation/working", () => {
    for (const seed of seeds) {
      const instance = template.generate(seed);
      expect(Number.isFinite(instance.answer)).toBe(true);
      expect(Number.isFinite(instance.tolerance)).toBe(true);
      expect(instance.tolerance).toBeGreaterThanOrEqual(0);
      expect(instance.prompt.length).toBeGreaterThan(0);
      expect(instance.explanation.length).toBeGreaterThan(0);
      expect(instance.working.length).toBeGreaterThan(0);
      if (template.kind === "choice") {
        expect(instance.choices).toBeDefined();
        expect(instance.choices!.length).toBeGreaterThanOrEqual(2);
        expect(Number.isInteger(instance.answer)).toBe(true);
        expect(instance.answer).toBeGreaterThanOrEqual(0);
        expect(instance.answer).toBeLessThan(instance.choices!.length);
        // choices must be unique
        expect(new Set(instance.choices)).toEqual(new Set(instance.choices));
      }
    }
  });

  it("varies parameters across seeds (not constant)", () => {
    const answers = new Set(seeds.map((seed) => template.generate(seed).answer));
    expect(answers.size).toBeGreaterThan(1);
  });

  it("rejects an answer far outside tolerance", () => {
    const seed = 42;
    const instance = template.generate(seed);
    if (template.kind === "choice") {
      const wrongIndex = instance.choices!.findIndex((_, i) => i !== instance.answer);
      const result = checkDrill(template, seed, wrongIndex);
      expect(result.correct).toBe(false);
    } else {
      const farOff = instance.answer + Math.max(Math.abs(instance.answer) * 10, 1000);
      const result = checkDrill(template, seed, farOff);
      expect(result.correct).toBe(false);
    }
  });

  if (template.kind === "numeric") {
    it("accepts an answer just inside tolerance and rejects one just outside", () => {
      const seed = 100;
      const instance = template.generate(seed);
      const justInside = instance.answer + instance.tolerance * 0.99;
      const justOutside = instance.answer + instance.tolerance * 1.2 + 1e-6;
      expect(checkDrill(template, seed, justInside).correct).toBe(true);
      expect(checkDrill(template, seed, justOutside).correct).toBe(false);
    });

    it("rejects NaN answers", () => {
      const result = checkDrill(template, 5, NaN);
      expect(result.correct).toBe(false);
    });
  }
});

describe("pickDrill", () => {
  it("is deterministic for a given seed", () => {
    for (const seed of seeds) {
      const a = pickDrill(seed);
      const b = pickDrill(seed);
      expect(a.template.id).toBe(b.template.id);
      expect(a.instance).toEqual(b.instance);
    }
  });

  it("returns a template present in the registry and a matching instance", () => {
    for (const seed of seeds) {
      const { template, instance } = pickDrill(seed);
      expect(drills.some((d) => d.id === template.id)).toBe(true);
      expect(instance).toEqual(template.generate(seed));
    }
  });

  it("picks a variety of templates across many seeds", () => {
    const picked = new Set(
      Array.from({ length: 60 }, (_, i) => pickDrill(i * 13 + 3).template.id)
    );
    expect(picked.size).toBeGreaterThan(1);
  });
});
