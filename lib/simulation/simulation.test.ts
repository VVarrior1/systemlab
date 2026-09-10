import { describe, expect, it } from "vitest";
import type { Architecture, NodeKind, SystemNode, Workload } from "../types";
import { runSimulation, validateSimulation } from "./index";

function node(id: string, kind: NodeKind, overrides: Partial<SystemNode> = {}): SystemNode {
  return { id, kind, label: id, position: { x: 0, y: 0 }, capacity: 400, latency: 10, replicas: 1, cacheHitRate: 0.8, enabled: true, cost: 2, ...overrides };
}
function graph(nodes: SystemNode[], connections: [string, string][]): Architecture {
  return { nodes, edges: connections.map(([source, target], i) => ({ id: `e${i}`, source, target })) };
}
const workload: Workload = { requestRate: 100, duration: 10, seed: 42, readRatio: 0.9, failure: "none", pattern: "steady" };
const basic = () => graph([node("traffic", "traffic"), node("api", "server"), node("db", "database")], [["traffic", "api"], ["api", "db"]]);
const balanced = (capacity = 400, replicas = 1) => graph([node("traffic", "traffic"), node("lb", "load-balancer", { capacity: 10000, latency: 1 }), node("api", "server", { capacity, replicas }), node("db", "database")], [["traffic", "lb"], ["lb", "api"], ["api", "db"]]);

describe("deterministic simulation", () => {
  it("reproduces every metric and trace for the same seed without mutating inputs", () => {
    const architecture = basic();
    const original = structuredClone(architecture);
    const first = runSimulation(architecture, workload);
    expect(runSimulation(architecture, workload)).toEqual(first);
    expect(architecture).toEqual(original);
    expect(first.requestCount).toBe(1000);
    expect(first.completed).toBe(1000);
    expect(first.failed).toBe(0);
    expect(first.p95).toBeGreaterThan(20);
    expect(first.p95).toBeLessThan(35);
    expect(first.traces[0].steps.map((step) => step.nodeId)).toEqual(["api", "db"]);
    expect(runSimulation(architecture, { ...workload, seed: 9 }).traces).not.toEqual(first.traces);
  });

  it("exposes a bottleneck and improves after increasing its capacity", () => {
    const architecture = basic();
    architecture.nodes[2].capacity = 50;
    const overloaded = runSimulation(architecture, workload);
    architecture.nodes[2].capacity = 200;
    const improved = runSimulation(architecture, workload);
    expect(overloaded.maxQueueDepth).toBeGreaterThan(100);
    expect(overloaded.failed).toBeGreaterThan(0);
    expect(overloaded.p95).toBeGreaterThan(1000);
    expect(improved.failed).toBe(0);
    expect(improved.p95).toBeLessThan(100);
    expect(improved.throughput).toBeGreaterThan(overloaded.throughput);
    expect(overloaded.nodes.find((metric) => metric.nodeId === "db")!.utilization).toBeGreaterThan(0.99);
  });

  it("only lets read cache hits skip the database", () => {
    const architecture = graph([node("traffic", "traffic"), node("api", "server"), node("cache", "cache", { cacheHitRate: 1 }), node("db", "database", { latency: 100 })], [["traffic", "api"], ["api", "cache"], ["cache", "db"]]);
    const reads = runSimulation(architecture, { ...workload, readRatio: 1 });
    const writes = runSimulation(architecture, { ...workload, readRatio: 0 });
    expect(reads.nodes.find((metric) => metric.nodeId === "db")!.processed).toBe(0);
    expect(writes.nodes.find((metric) => metric.nodeId === "db")!.processed).toBe(workload.requestRate * workload.duration);
    expect(reads.p95).toBeLessThan(writes.p95 - 90);
    expect(reads.traces[0].steps[1].status).toBe("hit");
    expect(writes.traces[0].steps[1].status).toBe("bypass");
  });

  it("preserves the workload's read and cache-hit decisions when architecture timing changes", () => {
    const architecture = graph([node("traffic", "traffic"), node("api", "server"), node("cache", "cache"), node("db", "database")], [["traffic", "api"], ["api", "cache"], ["cache", "db"]]);
    const first = runSimulation(architecture, workload);
    architecture.nodes[1].capacity = 250;
    architecture.nodes[1].latency = 50;
    architecture.nodes[3].replicas = 2;
    const second = runSimulation(architecture, workload);
    expect(first.nodes.find((metric) => metric.nodeId === "db")!.processed).toBe(second.nodes.find((metric) => metric.nodeId === "db")!.processed);
    expect(first.traces.map((trace) => trace.steps.find((step) => step.nodeId === "cache")?.status)).toEqual(second.traces.map((trace) => trace.steps.find((step) => step.nodeId === "cache")?.status));
  });

  it("routes across load-balanced branches and avoids a failed server", () => {
    const architecture = graph([node("traffic", "traffic"), node("lb", "load-balancer", { capacity: 10000, latency: 1 }), node("a", "server", { capacity: 200 }), node("b", "server", { capacity: 200 }), node("db", "database")], [["traffic", "lb"], ["lb", "a"], ["lb", "b"], ["a", "db"], ["b", "db"]]);
    const result = runSimulation(architecture, { ...workload, failure: "server" });
    const a = result.nodes.find((metric) => metric.nodeId === "a")!;
    const b = result.nodes.find((metric) => metric.nodeId === "b")!;
    expect(a.processed).toBeGreaterThan(200);
    expect(b.processed).toBeGreaterThan(700);
    expect(result.errorRate).toBeLessThan(0.01);
    for (const trace of result.traces) {
      expect(trace.steps.filter((step) => ["a", "b"].includes(step.nodeId))).toHaveLength(1);
    }
  });

  it("models capacity and failure tolerance per replica behind a load balancer", () => {
    const architecture = balanced(60);
    const single = runSimulation(architecture, { ...workload, failure: "server" });
    architecture.nodes.find((item) => item.id === "api")!.replicas = 3;
    const replicated = runSimulation(architecture, { ...workload, failure: "server" });
    expect(single.failed).toBeGreaterThan(400);
    expect(replicated.errorRate).toBeLessThan(0.01);
    expect(replicated.p95).toBeLessThan(single.p95);
    expect(replicated.cost - single.cost).toBeCloseTo(1.8);
  });

  it("requires explicit load balancing to use additional application replicas", () => {
    const direct = basic();
    direct.nodes[1].capacity = 60;
    direct.nodes[1].replicas = 2;
    const unrouted = runSimulation(direct, workload);
    const routed = runSimulation(balanced(60, 2), workload);
    const directMetric = unrouted.nodes.find((metric) => metric.nodeId === "api")!;
    expect(unrouted.throughput).toBeLessThan(61);
    expect(unrouted.p95).toBeGreaterThan(1000);
    expect(directMetric.replicas![0].utilization).toBeGreaterThan(0.99);
    expect(directMetric.replicas![1]).toMatchObject({ index: 2, processed: 0, errors: 0, utilization: 0 });
    expect(directMetric.utilization).toBeLessThan(0.51);
    expect(unrouted.insights.some((insight) => insight.title.includes("idle replicas"))).toBe(true);
    expect(unrouted.insights.some((insight) => insight.title.includes("individual replica load"))).toBe(true);
    expect(routed.failed).toBe(0);
    expect(routed.p95).toBeLessThan(100);
    expect(routed.throughput).toBeGreaterThan(99);
    expect(routed.nodes.find((metric) => metric.nodeId === "api")!.replicas!.map((replica) => replica.processed)).toEqual([500, 500]);
  });

  it("pins direct requests to failed replica 1 while a balancer uses healthy endpoints", () => {
    const direct = basic();
    direct.nodes[1].replicas = 2;
    const unrouted = runSimulation(direct, { ...workload, failure: "server" });
    const routed = runSimulation(balanced(400, 2), { ...workload, failure: "server" });
    expect(unrouted.errorRate).toBeGreaterThanOrEqual(0.49);
    expect(unrouted.nodes.find((metric) => metric.nodeId === "api")!.healthyReplicas).toBe(1);
    expect(unrouted.nodes.find((metric) => metric.nodeId === "api")!.replicas![1].processed).toBe(0);
    expect(unrouted.traces.every((trace) => trace.steps.find((step) => step.nodeId === "api")?.replica === 1)).toBe(true);
    expect(routed.errorRate).toBeLessThan(0.01);
    expect(new Set(routed.traces.flatMap((trace) => trace.steps.filter((step) => step.nodeId === "api").map((step) => step.replica)))).toEqual(new Set([1, 2]));
    expect(routed.traces.filter((trace) => trace.id > 600).every((trace) => trace.steps.find((step) => step.nodeId === "api")?.replica === 2)).toBe(true);
  });

  it("distributes equally across replica endpoints rather than equally across backend nodes", () => {
    const architecture = graph([node("traffic", "traffic"), node("lb", "load-balancer", { capacity: 10000, latency: 1 }), node("a", "server", { capacity: 200, replicas: 2 }), node("b", "server", { capacity: 200 }), node("db", "database")], [["traffic", "lb"], ["lb", "a"], ["lb", "b"], ["a", "db"], ["b", "db"]]);
    const result = runSimulation(architecture, { ...workload, requestRate: 300 });
    expect(result.failed).toBe(0);
    expect(result.nodes.find((metric) => metric.nodeId === "a")!.replicas!.map((replica) => replica.processed)).toEqual([1000, 1000]);
    expect(result.nodes.find((metric) => metric.nodeId === "b")!.replicas!.map((replica) => replica.processed)).toEqual([1000]);
  });

  it("fails queued work pinned to the failed application replica without migrating it", () => {
    const result = runSimulation(balanced(30, 2), { ...workload, failure: "server" });
    const api = result.nodes.find((metric) => metric.nodeId === "api")!;
    expect(api.replicas![0].errors).toBeGreaterThan(90);
    expect(api.replicas![0].processed).toBeLessThan(155);
    expect(result.traces.some((trace) => !trace.success && trace.latency > 100 && trace.latency < 4900 && trace.steps.some((step) => step.nodeId === "api" && step.replica === 1 && step.status === "error"))).toBe(true);
    expect(result.completed + result.failed).toBe(result.requestCount);
    expect(api.replicas!.reduce((count, replica) => count + replica.processed + replica.errors, 0)).toBe(api.processed + api.errors);
  });

  it("does not implicitly balance a direct application dependency", () => {
    const architecture = graph([node("traffic", "traffic"), node("gateway", "server"), node("api", "server", { capacity: 60, replicas: 2 }), node("db", "database")], [["traffic", "gateway"], ["gateway", "api"], ["api", "db"]]);
    const result = runSimulation(architecture, workload);
    expect(result.throughput).toBeLessThan(61);
    expect(result.nodes.find((metric) => metric.nodeId === "api")!.replicas![1].processed).toBe(0);
  });

  it("keeps worker replicas as a shared FIFO pull pool without an application load balancer", () => {
    const architecture = graph([node("traffic", "traffic"), node("api", "server"), node("queue", "queue", { capacity: 10000 }), node("worker", "server", { role: "worker", capacity: 40, replicas: 3 }), node("db", "database")], [["traffic", "api"], ["api", "queue"], ["queue", "worker"], ["worker", "db"]]);
    const result = runSimulation(architecture, workload);
    expect(result.failed).toBe(0);
    expect(result.p95).toBeLessThan(150);
    expect(result.nodes.find((metric) => metric.nodeId === "worker")!.replicas!.every((replica) => replica.processed > 0)).toBe(true);
  });

  it("derives canonical infrastructure cost instead of trusting imported cost fields", () => {
    const architecture = balanced();
    const original = runSimulation(architecture, workload).cost;
    for (const component of architecture.nodes) component.cost = 0;
    expect(runSimulation(architecture, workload).cost).toBe(original);
    const balancer = architecture.nodes.find((component) => component.id === "lb")!;
    balancer.capacity = 10;
    runSimulation(architecture, workload);
    balancer.capacity = 10000;
    expect(runSimulation(architecture, workload).cost).toBe(original);
  });

  it("does not fabricate successful zero-latency results when every request times out", () => {
    const architecture = basic();
    architecture.nodes[1].latency = 7000;
    const result = runSimulation(architecture, workload);
    expect(result.completed).toBe(0);
    expect(result.failed).toBe(result.requestCount);
    expect(result.errorRate).toBe(1);
    expect(result.throughput).toBe(0);
    expect(result.p95).toBe(0);
    expect(result.traces.every((trace) => trace.latency === 5000 && !trace.success)).toBe(true);
    expect(result.traces[0].steps[0].status).toBe("error");
    expect(result.insights.some((insight) => insight.title.includes("timed out"))).toBe(true);
    expect(result.samples.reduce((count, sample) => count + sample.throughput, 0)).toBe(0);
  });

  it("attributes worker backlog to a queue and counts job completion, not acceptance", () => {
    const architecture = graph([node("traffic", "traffic"), node("api", "server"), node("queue", "queue", { capacity: 10000 }), node("worker", "server", { role: "worker", capacity: 40 }), node("db", "database")], [["traffic", "api"], ["api", "queue"], ["queue", "worker"], ["worker", "db"]]);
    const result = runSimulation(architecture, workload);
    expect(result.nodes.find((metric) => metric.nodeId === "queue")!.queueDepth).toBeGreaterThan(100);
    expect(result.throughput).toBeLessThan(41);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.completed + result.failed).toBe(result.requestCount);
    expect(result.traces.find((trace) => trace.success)!.steps.map((step) => step.nodeId)).toEqual(["api", "queue", "worker", "db"]);
  });

  it("reports the configured database failure even when earlier stages have headroom", () => {
    const result = runSimulation(basic(), { ...workload, failure: "database" });
    expect(result.errorRate).toBeGreaterThan(0.49);
    expect(result.errorRate).toBeLessThan(0.52);
    expect(result.nodes.find((metric) => metric.nodeId === "db")!.errors).toBeGreaterThan(490);
    expect(result.nodes.find((metric) => metric.nodeId === "db")!.healthyReplicas).toBe(0);
    expect(result.completed + result.failed).toBe(1000);
  });

  it("counts drain completions honestly without inflating the reported traffic-window throughput", () => {
    const architecture = basic();
    architecture.nodes[1].latency = 1500;
    const result = runSimulation(architecture, { ...workload, duration: 2 });
    expect(result.completed).toBe(200);
    expect(result.throughput).toBeLessThan(30);
    expect(result.samples.some((sample) => sample.time > 2 && sample.throughput > 0)).toBe(true);
    expect(result.samples.reduce((count, sample) => count + sample.throughput, 0)).toBe(200);
  });

  it("simulates a full 60-second, 500-rps workload without sampling requests", () => {
    const architecture = basic();
    architecture.nodes[1].capacity = 1000;
    architecture.nodes[2].capacity = 1000;
    const result = runSimulation(architecture, { ...workload, requestRate: 500, duration: 60 });
    expect(result.requestCount).toBe(30000);
    expect(result.completed).toBe(30000);
    expect(result.failed).toBe(0);
    expect(result.throughput).toBeGreaterThan(499);
    expect(result.traces.length).toBeLessThanOrEqual(36);
    expect(result.samples.length).toBeLessThanOrEqual(65);
  });
});

describe("architecture validation", () => {
  it("rejects disconnected infrastructure, loops, ambiguous fan-out, and missing dependencies", () => {
    const disconnected = basic();
    disconnected.nodes.push(node("orphan", "cache"));
    expect(() => runSimulation(disconnected, workload)).toThrow(/Connect every component/);
    const cycle = basic();
    cycle.edges.push({ id: "loop", source: "db", target: "api" });
    expect(() => runSimulation(cycle, workload)).toThrow(/loop/);
    const fanout = basic();
    fanout.nodes.push(node("extra", "database"));
    fanout.edges.push({ id: "extra", source: "api", target: "extra" });
    expect(() => runSimulation(fanout, workload)).toThrow(/outgoing dependency/);
    const cache = graph([node("traffic", "traffic"), node("api", "server"), node("cache", "cache")], [["traffic", "api"], ["api", "cache"]]);
    expect(() => runSimulation(cache, workload)).toThrow(/cache to exactly one database/);
  });

  it("rejects invalid workloads and numeric settings before creating events", () => {
    expect(() => validateSimulation(basic(), { ...workload, requestRate: Infinity })).toThrow(/traffic/);
    expect(() => validateSimulation(basic(), { ...workload, duration: 61 })).toThrow(/duration/);
    const architecture = basic();
    architecture.nodes[1].capacity = 0;
    expect(() => validateSimulation(architecture, workload)).toThrow(/capacity/);
  });
});
