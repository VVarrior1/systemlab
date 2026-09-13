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

describe("applyPenalties wall-clock overtime", () => {
  it("is free when the wall clock is not passed", () => {
    const result = applyPenalties(90, { hintsUsed: 1, reflectionAttempts: 1, overtimeSeconds: 0, wallClockOvertime: 0 });
    expect(result).toEqual({ total: 90, deductions: [] });
  });

  it("treats an absent wall clock as no overtime", () => {
    const result = applyPenalties(90, { hintsUsed: 1, reflectionAttempts: 1, overtimeSeconds: 0 });
    expect(result).toEqual({ total: 90, deductions: [] });
  });

  it("deducts 1 point per 30s over, floored to whole 30s chunks", () => {
    const result = applyPenalties(90, { hintsUsed: 1, reflectionAttempts: 1, overtimeSeconds: 0, wallClockOvertime: 89 });
    expect(result.total).toBe(88);
    expect(result.deductions).toEqual([{ reason: "89s over the lesson wall clock", points: 2 }]);
  });

  it("does not deduct below the first full 30s chunk", () => {
    const result = applyPenalties(90, { hintsUsed: 1, reflectionAttempts: 1, overtimeSeconds: 0, wallClockOvertime: 29 });
    expect(result).toEqual({ total: 90, deductions: [] });
  });

  it("caps the wall-clock deduction at 10 points", () => {
    const result = applyPenalties(90, { hintsUsed: 1, reflectionAttempts: 1, overtimeSeconds: 0, wallClockOvertime: 3600 });
    expect(result.total).toBe(80);
    expect(result.deductions).toEqual([{ reason: "3600s over the lesson wall clock", points: 10 }]);
  });

  it("stacks with the interview clock and the other deductions, each capped separately", () => {
    const result = applyPenalties(100, { hintsUsed: 2, reflectionAttempts: 2, overtimeSeconds: 600, wallClockOvertime: 600 });
    expect(result.deductions).toEqual([
      { reason: "1 hint beyond the first", points: 5 },
      { reason: "1 wrong reflection attempt", points: 5 },
      { reason: "600s overtime on the interview clock", points: 10 },
      { reason: "600s over the lesson wall clock", points: 10 },
    ]);
    expect(result.total).toBe(70);
  });

  it("rounds the reported seconds but not the chunk arithmetic", () => {
    const result = applyPenalties(90, { hintsUsed: 1, reflectionAttempts: 1, overtimeSeconds: 0, wallClockOvertime: 59.6 });
    expect(result.deductions).toEqual([{ reason: "60s over the lesson wall clock", points: 1 }]);
    expect(result.total).toBe(89);
  });

  it("still floors the total at 0 with every penalty maxed", () => {
    const result = applyPenalties(8, { hintsUsed: 10, reflectionAttempts: 10, overtimeSeconds: 900, wallClockOvertime: 900 });
    expect(result.total).toBe(0);
  });
});
