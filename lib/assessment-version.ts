import type { ProgressRecord } from "./types";

export const ASSESSMENT_VERSION = 2;

export function isCurrentProgress(record: ProgressRecord): boolean {
  return record.assessmentVersion === ASSESSMENT_VERSION;
}
