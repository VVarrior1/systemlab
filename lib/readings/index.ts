import type { Reading } from "../types";
import { readings as foundations } from "./foundations";
import { readings as cachingReliability } from "./caching-reliability";
import { readings as dataAndTraffic } from "./data-and-traffic";
import { readings as toolkitAndBriefs } from "./toolkit-and-briefs";
import { readings as dataSystems } from "./data-systems";

/** Verified deep-dive readings keyed by lesson id. Each URL was fetched and checked when curated. */
export const readings: Record<string, Reading[]> = {
  ...foundations,
  ...cachingReliability,
  ...dataAndTraffic,
  ...toolkitAndBriefs,
  ...dataSystems,
};
