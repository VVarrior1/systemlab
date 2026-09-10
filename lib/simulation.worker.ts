import { ENGINE_VERSION, runSimulation } from "./simulation";
import type { Architecture, SimulationResult, Workload } from "./types";

export interface SimulationRequestMessage {
  id: string | number;
  architecture: Architecture;
  workload: Workload;
}
export type SimulationResponseMessage =
  | { id: string | number; engineVersion: string; result: SimulationResult }
  | { id: string | number; engineVersion: string; error: string };

/**
 * Runs the engine off the main thread. One message in, one message out; the engine is pure, so a
 * worker instance can serve any number of runs (the alternatives and remix flows send several).
 */
self.onmessage = (event: MessageEvent<SimulationRequestMessage>) => {
  const { id, architecture, workload } = event.data;
  try {
    const result = runSimulation(architecture, workload);
    self.postMessage({ id, engineVersion: ENGINE_VERSION, result } satisfies SimulationResponseMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The simulation could not complete.";
    self.postMessage({ id, engineVersion: ENGINE_VERSION, error: message } satisfies SimulationResponseMessage);
  }
};
