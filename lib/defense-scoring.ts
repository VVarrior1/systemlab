export interface PenaltyInput {
  hintsUsed: number;
  reflectionAttempts: number;
  overtimeSeconds: number;
}
export interface Deduction { reason: string; points: number }
export interface PenaltyResult { total: number; deductions: Deduction[] }

const HINT_PENALTY = 5;
const REFLECTION_PENALTY = 5;
const OVERTIME_POINTS_PER_15S = 1;
const OVERTIME_CAP = 10;

/**
 * Applies interview-mode penalties to a defense total:
 * -5 per hint beyond the first, -5 per wrong reflection attempt, and up to
 * -10 for overtime at 1 point per 15s over the per-stage clocks. Floored at 0.
 */
export function applyPenalties(total: number, { hintsUsed, reflectionAttempts, overtimeSeconds }: PenaltyInput): PenaltyResult {
  const deductions: Deduction[] = [];

  const extraHints = Math.max(0, hintsUsed - 1);
  if (extraHints > 0) {
    deductions.push({ reason: `${extraHints} hint${extraHints === 1 ? "" : "s"} beyond the first`, points: extraHints * HINT_PENALTY });
  }

  const wrongAttempts = Math.max(0, reflectionAttempts - 1);
  if (wrongAttempts > 0) {
    deductions.push({ reason: `${wrongAttempts} wrong reflection attempt${wrongAttempts === 1 ? "" : "s"}`, points: wrongAttempts * REFLECTION_PENALTY });
  }

  if (overtimeSeconds > 0) {
    const overtimePoints = Math.min(OVERTIME_CAP, Math.floor(overtimeSeconds / 15) * OVERTIME_POINTS_PER_15S);
    if (overtimePoints > 0) {
      deductions.push({ reason: `${Math.round(overtimeSeconds)}s overtime on the interview clock`, points: overtimePoints });
    }
  }

  const deducted = deductions.reduce((sum, item) => sum + item.points, 0);
  return { total: Math.max(0, total - deducted), deductions };
}
