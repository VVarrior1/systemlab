import type { ProgressRecord } from "./types";

/** Bumped to 3 for Systemlab v2: engine 2.0, cost 2.0, estimation and defense stages. */
export const ASSESSMENT_VERSION = 3;

export function isCurrentProgress(record: ProgressRecord): boolean {
  return record.assessmentVersion === ASSESSMENT_VERSION;
}
