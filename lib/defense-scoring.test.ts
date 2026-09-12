import { describe, expect, it } from "vitest";
import { applyPenalties } from "./defense-scoring";

describe("applyPenalties", () => {
  it("applies no deductions for a clean run (one hint, one reflection attempt, no overtime)", () => {
    const result = applyPenalties(90, { hintsUsed: 1, reflectionAttempts: 1, overtimeSeconds: 0 });
    expect(result).toEqual({ total: 90, deductions: [] });
  });

  it("applies no deductions when nothing was used at all", () => {
    const result = applyPenalties(90, { hintsUsed: 0, reflectionAttempts: 0, overtimeSeconds: 0 });
    expect(result.total).toBe(90);
    expect(result.deductions).toEqual([]);
  });

  it("deducts 5 per hint beyond the first", () => {
    const result = applyPenalties(90, { hintsUsed: 3, reflectionAttempts: 1, overtimeSeconds: 0 });
    expect(result.total).toBe(80);
    expect(result.deductions).toEqual([{ reason: "2 hints beyond the first", points: 10 }]);
  });

  it("deducts 5 per wrong reflection attempt", () => {
    const result = applyPenalties(90, { hintsUsed: 1, reflectionAttempts: 3, overtimeSeconds: 0 });
    expect(result.total).toBe(80);
    expect(result.deductions).toEqual([{ reason: "2 wrong reflection attempts", points: 10 }]);
  });

  it("deducts 1 point per 15s overtime, floored to whole 15s chunks", () => {
    const result = applyPenalties(90, { hintsUsed: 1, reflectionAttempts: 1, overtimeSeconds: 44 });
    expect(result.total).toBe(88);
    expect(result.deductions).toEqual([{ reason: "44s overtime on the interview clock", points: 2 }]);
  });

  it("caps overtime deduction at 10 points", () => {
    const result = applyPenalties(90, { hintsUsed: 1, reflectionAttempts: 1, overtimeSeconds: 600 });
    expect(result.total).toBe(80);
    expect(result.deductions).toEqual([{ reason: "600s overtime on the interview clock", points: 10 }]);
  });

  it("combines all three deduction types", () => {
    const result = applyPenalties(90, { hintsUsed: 2, reflectionAttempts: 2, overtimeSeconds: 30 });
    expect(result.deductions).toEqual([
      { reason: "1 hint beyond the first", points: 5 },
      { reason: "1 wrong reflection attempt", points: 5 },
      { reason: "30s overtime on the interview clock", points: 2 },
    ]);
    expect(result.total).toBe(78);
  });

  it("floors the total at 0 and never goes negative", () => {
    const result = applyPenalties(5, { hintsUsed: 10, reflectionAttempts: 10, overtimeSeconds: 600 });
    expect(result.total).toBe(0);
  });

  it("treats a single hint or single reflection attempt as free", () => {
    const result = applyPenalties(100, { hintsUsed: 1, reflectionAttempts: 1, overtimeSeconds: 14 });
    expect(result.total).toBe(100);
    expect(result.deductions).toEqual([]);
  });
});
