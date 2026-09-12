import { describe, it } from "vitest";
import { lessons } from "./lib/curriculum/index";
import { runSimulation } from "./lib/simulation";
import { objectivePasses } from "./lib/assessment";

const ids = [
  "make-reads-cheaper","spend-your-budget","when-caches-cannot-help","bounded-queues",
  "hot-keys","cold-start-and-stampede","ttl-and-staleness","protect-the-database",
  "shard-the-writes","rate-limit-the-api","burst-allowance","backpressure-end-to-end",
];

describe("probe2", () => {
  it("prints starter objective status", () => {
    for (const id of ids) {
      const item = lessons.find((l) => l.id === id)!;
      const result = runSimulation(item.architecture, item.workload);
      const statuses = item.objectives.map((o) => `${o.metric}:${o.operator}${o.target}=>actual${result[o.metric]}=>${objectivePasses(result, o) ? "PASS" : "FAIL"}`);
      console.log(id, statuses.join(" | "));
    }
  });
});
