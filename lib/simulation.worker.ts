import { runSimulation } from "./simulation";
import type { Architecture, Workload } from "./types";

self.onmessage = (event: MessageEvent<{ id: string | number; architecture: Architecture; workload: Workload }>) => {
  const { id, architecture, workload } = event.data;
  try {
    self.postMessage({ id, result: runSimulation(architecture, workload) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : "The simulation could not complete." });
  }
};
