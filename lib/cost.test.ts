import { describe, expect, it } from "vitest";
import { architectureCost, componentCost, costRates, nodeCost } from "./cost";
import { createSystemNode } from "./templates";

describe("cost 2.0", () => {
  it("prices a component from its kind and capacity only, ignoring imported cost fields", () => {
    const database = createSystemNode("database", "db", { x: 0, y: 0 });
    expect(componentCost({ ...database, cost: 0 })).toBe(componentCost(database));
    expect(componentCost({ kind: "database", capacity: 150 })).toBe(costRates.database.fixed + costRates.database.base);
  });

  it("makes database write capacity more expensive to scale than cache capacity", () => {
    const dbDouble = componentCost({ kind: "database", capacity: 300 }) / componentCost({ kind: "database", capacity: 150 });
    const cacheDouble = componentCost({ kind: "cache", capacity: 5000 }) / componentCost({ kind: "cache", capacity: 2500 });
    expect(dbDouble).toBeGreaterThan(2);
    expect(cacheDouble).toBeLessThan(2);
  });

  it("multiplies by replicas, shards and the follower premium", () => {
    const database = createSystemNode("database", "db", { x: 0, y: 0 });
    const single = nodeCost({ ...database, replicas: 2 });
    expect(single).toBeCloseTo(componentCost(database) * 2, 3);
    expect(nodeCost({ ...database, replicas: 2, dbMode: "leader-follower" })).toBeCloseTo(single * 1.15, 3);
    expect(nodeCost({ ...database, dbMode: "sharded", shards: 4 })).toBeCloseTo(componentCost(database) * 4, 3);
    expect(nodeCost({ ...database, enabled: false })).toBe(0);
  });

  it("sums enabled non-traffic nodes", () => {
    const traffic = createSystemNode("traffic", "t", { x: 0, y: 0 });
    const server = createSystemNode("server", "s", { x: 0, y: 0 });
    expect(architectureCost([traffic, server])).toBe(nodeCost(server));
  });
});
