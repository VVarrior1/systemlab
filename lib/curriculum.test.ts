import { describe, expect, it } from "vitest";
import { validateMissionArchitecture } from "./assessment";
import { lessons } from "./curriculum";
import { runSimulation } from "./simulation";
import { createSystemNode, templates } from "./templates";
import type { Architecture, Lesson, SimulationResult } from "./types";

function resize(architecture: Architecture, id: string, capacity: number) {
  const node = architecture.nodes.find((item) => item.id === id)!;
  node.cost *= capacity / node.capacity;
  node.capacity = capacity;
}

function addCache(architecture: Architecture) {
  architecture.nodes.push(createSystemNode("cache", "cache", { x: 600, y: 140 }));
  architecture.edges = architecture.edges.filter((edge) => !(edge.source === "server" && edge.target === "database"));
  architecture.edges.push(
    { id: "server-cache", source: "server", target: "cache" },
    { id: "cache-database", source: "cache", target: "database" },
  );
}

function hintedSolution(lesson: Lesson): Architecture {
  const architecture = structuredClone(lesson.architecture);
  const replicas = (id: string, count: number) => { architecture.nodes.find((node) => node.id === id)!.replicas = count; };
  switch (lesson.number) {
    case 2: resize(architecture, "server", 300); break;
    case 3: replicas("server", 2); break;
    case 4: addCache(architecture); break;
    case 5: replicas("server", 2); break;
    case 6:
      addCache(architecture);
      resize(architecture, "server", 400);
      resize(architecture, "database", 150);
      break;
    case 7: resize(architecture, "worker", 240); break;
    case 8: replicas("worker", 2); break;
    case 9: resize(architecture, "database", 350); break;
    case 10: replicas("server", 2); break;
    case 11: replicas("database", 2); break;
    case 12:
      replicas("server", 3);
      resize(architecture, "database", 300);
      break;
  }
  return architecture;
}

function failedObjectives(lesson: Lesson, result: SimulationResult) {
  return lesson.objectives.filter((objective) => objective.operator === "lte"
    ? result[objective.metric] > objective.target
    : result[objective.metric] < objective.target)
    .map((objective) => `${objective.metric}: actual ${result[objective.metric]}, target ${objective.operator} ${objective.target}`);
}

describe("authored curriculum", () => {
  it("Share the load requires actual routing to use two application replicas", () => {
    const lesson = lessons.find((item) => item.id === "share-the-load")!;
    const balanced = hintedSolution(lesson);
    const direct = structuredClone(balanced);
    direct.nodes = direct.nodes.filter((node) => node.kind !== "load-balancer");
    direct.edges = [
      { id: "traffic-server", source: "traffic", target: "server" },
      { id: "server-database", source: "server", target: "database" },
    ];

    for (const seed of [42, 123, 2026]) {
      const workload = { ...lesson.workload, seed };
      const unroutedResult = runSimulation(direct, workload);
      const balancedResult = runSimulation(balanced, workload);

      expect(unroutedResult.throughput, `direct connection, seed ${seed}`).toBeLessThan(340);
      expect(unroutedResult.p95, `direct connection, seed ${seed}`).toBeGreaterThan(180);
      expect(failedObjectives(lesson, balancedResult), `load-balanced, seed ${seed}`).toEqual([]);
      expect(balancedResult.throughput).toBeGreaterThan(unroutedResult.throughput * 1.6);
    }
  });

  for (const lesson of lessons) {
    it(`${lesson.number}. ${lesson.title} has an achievable hinted solution across assessment seeds`, () => {
      const architecture = hintedSolution(lesson);
      expect(validateMissionArchitecture(lesson, architecture)).toBeNull();
      for (const seed of [42, 123, 2026]) {
        const result = runSimulation(architecture, { ...lesson.workload, seed });
        expect(failedObjectives(lesson, result), `seed ${seed}`).toEqual([]);
      }
    });

    it(`${lesson.number}. ${lesson.title} starts with the intended challenge`, () => {
      const result = runSimulation(lesson.architecture, lesson.workload);
      if (lesson.number === 1) expect(failedObjectives(lesson, result)).toEqual([]);
      else expect(failedObjectives(lesson, result).length).toBeGreaterThan(0);
    });
  }

  for (const template of templates) {
    it(`${template.name} template is runnable`, () => {
      const result = runSimulation(template.architecture, template.workload);
      expect(result.completed).toBeGreaterThan(0);
      expect(result.errorRate).toBeLessThanOrEqual(0.01);
    });
  }
});
