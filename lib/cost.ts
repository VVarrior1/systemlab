import { nodeDefaults } from "./templates";
import type { SystemNode } from "./types";

export function componentCost(node: SystemNode): number {
  const base = nodeDefaults[node.kind];
  return base.cost * node.capacity / base.capacity;
}
