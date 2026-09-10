import { describe, expect, it } from "vitest";
import { componentCost } from "./cost";
import { createSystemNode } from "./templates";

describe("canonical infrastructure credits", () => {
  it("does not lose the unit price after reducing and restoring capacity", () => {
    const balancer = createSystemNode("load-balancer", "lb", { x: 0, y: 0 });
    expect(componentCost({ ...balancer, capacity: 10 })).toBe(0.002);
    expect(componentCost({ ...balancer, capacity: 2000, cost: 0 })).toBe(0.4);
    expect(componentCost({ ...balancer, cost: 0 })).toBe(1);
  });

  it("does not trust prices from imported designs", () => {
    const database = createSystemNode("database", "db", { x: 0, y: 0 });
    expect(componentCost({ ...database, cost: 0 })).toBe(componentCost(database));
    expect(componentCost({ ...database, capacity: 300 })).toBe(8);
  });
});
