import { describe, expect, it } from "vitest";
import { architectureCost, componentCost, costRates, nodeCost, usageCost, usageRates } from "./cost";
import { createSystemNode } from "./templates";

describe("cost 2.0", () => {
  it("prices a component from its kind and capacity only, ignoring imported cost fields", () => {
    const database = createSystemNode("database", "db", { x: 0, y: 0 });
    expect(componentCost({ kind: database.kind, capacity: database.capacity })).toBe(componentCost(database));
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

describe("cost 2.1 usage", () => {
  it("publishes the per-1,000-operation rates the engine meters against", () => {
    expect(usageRates).toEqual({
      database: 0.004,
      cache: 0.0005,
      cdn: 0.001,
      queue: 0.0005,
      server: 0.0005,
      "rate-limiter": 0.0002,
      crossRegion: 0.002,
    });
  });

  it("prices measured operations per 1,000, with writes counted twice", () => {
    expect(usageCost({})).toBe(0);
    expect(usageCost({ database: 1000 })).toBe(usageRates.database);
    expect(usageCost({ database: 1000, databaseWrites: 1000 })).toBe(usageRates.database * 2);
    expect(usageCost({ database: 2000, databaseWrites: 1000 })).toBeCloseTo(usageRates.database * 3, 6);
    expect(usageCost({ server: 1_000_000 })).toBeCloseTo(0.5, 6);
    expect(usageCost({ cache: 1000 })).toBeLessThan(usageCost({ database: 1000 }));
    expect(usageCost({ crossRegion: 1000 })).toBe(usageRates.crossRegion);
    expect(usageCost({ cdn: -5000 })).toBe(0);
  });

  it("scales linearly, so an hour of twice the traffic costs twice as much", () => {
    const counts = { server: 100_000, database: 100_000, databaseWrites: 20_000, cache: 50_000, queue: 10_000 };
    const doubled = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value * 2]));
    expect(usageCost(doubled)).toBeCloseTo(usageCost(counts) * 2, 6);
  });
});
