import { describe, expect, it } from "vitest";
import type { Architecture, NodeKind, SimulationResult, SystemNode, Workload } from "../types";
import { lessons } from "../curriculum";
import { HOURS_PER_MONTH, storageRates } from "../cost";
import { ENGINE_VERSION, REQUEST_DEADLINE_MS, runSimulation, streamProbe, validateSimulation } from "./index";
import { lognormalMultiplier, powerLawKey, createRandom } from "./distributions";
import { KeyedCache } from "./cache";

function node(id: string, kind: NodeKind, overrides: Partial<SystemNode> = {}): SystemNode {
  return { id, kind, label: id, position: { x: 0, y: 0 }, capacity: 400, latency: 10, replicas: 1, cacheHitRate: 0.8, enabled: true, cost: 2, ...overrides };
}
function graph(nodes: SystemNode[], connections: [string, string][]): Architecture {
  return { nodes, edges: connections.map(([source, target], i) => ({ id: `e${i}`, source, target })) };
}
const workload: Workload = { requestRate: 100, duration: 10, seed: 42, readRatio: 0.9, failure: "none", pattern: "steady" };
const basic = () => graph([node("traffic", "traffic"), node("api", "server"), node("db", "database")], [["traffic", "api"], ["api", "db"]]);
const balanced = (capacity = 400, replicas = 1) =>
  graph(
    [node("traffic", "traffic"), node("lb", "load-balancer", { capacity: 10000, latency: 1 }), node("api", "server", { capacity, replicas }), node("db", "database")],
    [["traffic", "lb"], ["lb", "api"], ["api", "db"]],
  );
const metric = (result: SimulationResult, id: string) => result.nodes.find((item) => item.nodeId === id)!;
const titles = (result: SimulationResult) => result.insights.map((insight) => insight.title);
const insight = (result: SimulationResult, needle: string) => result.insights.find((item) => item.title.includes(needle));
const tail = (result: SimulationResult) => result.p99 / (result.p50 || 1);

// ---------------------------------------------------------------------------------------------
// Distributions
// ---------------------------------------------------------------------------------------------

describe("distributions", () => {
  it("keeps the lognormal service multiplier at mean 1 while the tail grows with sigma", () => {
    for (const sigma of [0.2, 0.4, 0.8]) {
      const random = createRandom(11);
      const draws = Array.from({ length: 40000 }, () => lognormalMultiplier(random, sigma));
      const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
      draws.sort((a, b) => a - b);
      expect(mean).toBeGreaterThan(0.97);
      expect(mean).toBeLessThan(1.03);
      // p99/p50 of a lognormal is exp(2.326 * sigma), independent of the mean correction.
      expect(draws[Math.floor(draws.length * 0.99)] / draws[Math.floor(draws.length * 0.5)]).toBeCloseTo(Math.exp(2.326 * sigma), 0);
    }
  });

  it("samples keys from a power law that concentrates as the skew rises", () => {
    const share = (skew: number) => {
      const random = createRandom(5);
      let hot = 0;
      for (let index = 0; index < 20000; index++) if (powerLawKey(random(), 10000, skew) < 1000) hot++;
      return hot / 20000;
    };
    expect(share(0)).toBeGreaterThan(0.09);
    expect(share(0)).toBeLessThan(0.11);
    expect(share(0.6)).toBeGreaterThan(share(0));
    expect(share(0.9)).toBeGreaterThan(share(0.6));
    expect(share(0.9)).toBeGreaterThan(0.5);
    expect(powerLawKey(0.999999, 10, 0.9)).toBeLessThanOrEqual(9);
    expect(powerLawKey(0, 10, 0.9)).toBe(0);
  });

  it("keeps the keyed LRU bounded, expiring on TTL and flagging reads behind a write", () => {
    const cache = new KeyedCache(2, 100);
    cache.set(1, 0);
    cache.set(2, 0);
    expect(cache.lookup(1, 10)).toBe("hit");
    cache.set(3, 10); // key 2 is now the least recently used
    expect(cache.size).toBe(2);
    expect(cache.lookup(2, 10)).toBe("miss");
    expect(cache.lookup(1, 200)).toBe("miss"); // TTL expiry
    cache.set(4, 0);
    cache.noteWrite(4, 5);
    expect(cache.lookup(4, 10)).toBe("stale");
  });
});

// ---------------------------------------------------------------------------------------------
// Determinism and the v1 routing model, preserved
// ---------------------------------------------------------------------------------------------

describe("deterministic simulation", () => {
  it("reproduces every metric and trace for the same seed without mutating inputs", () => {
    const architecture = basic();
    const original = structuredClone(architecture);
    const first = runSimulation(architecture, workload);
    expect(runSimulation(architecture, workload)).toEqual(first);
    expect(architecture).toEqual(original);
    expect(first.engineVersion).toBe("2.3.0");
    expect(ENGINE_VERSION).toBe("2.3.0");
    expect(first.requestCount).toBe(1000);
    expect(first.completed).toBe(1000);
    expect(first.failed).toBe(0);
    expect(first.rejected).toBe(0);
    expect(first.errorRate).toBe(0);
    expect(first.rejectedRate).toBe(0);
    expect(first.successRate).toBe(1);
    expect(first.p50).toBeLessThanOrEqual(first.p95);
    expect(first.p95).toBeLessThanOrEqual(first.p99);
    expect(first.p95).toBeGreaterThan(20);
    expect(first.p95).toBeLessThan(35);
    expect(first.amplification).toBe(1);
    expect(first.assumptions.length).toBeGreaterThanOrEqual(12);
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
    expect(metric(overloaded, "db").utilization).toBeGreaterThan(0.99);
    expect(insight(overloaded, "busiest stage")!.nodeId).toBe("db");
  });

  it("only lets read cache hits skip the database", () => {
    const architecture = graph(
      [node("traffic", "traffic"), node("api", "server"), node("cache", "cache", { cacheHitRate: 1 }), node("db", "database", { latency: 100 })],
      [["traffic", "api"], ["api", "cache"], ["cache", "db"]],
    );
    const reads = runSimulation(architecture, { ...workload, readRatio: 1 });
    const writes = runSimulation(architecture, { ...workload, readRatio: 0 });
    expect(metric(reads, "db").processed).toBe(0);
    expect(metric(writes, "db").processed).toBe(workload.requestRate * workload.duration);
    expect(reads.p95).toBeLessThan(writes.p95 - 90);
    expect(reads.traces[0].steps[1].status).toBe("hit");
    expect(writes.traces[0].steps[1].status).toBe("bypass");
  });

  it("preserves the workload's read and cache-hit decisions when architecture timing changes", () => {
    const architecture = graph(
      [node("traffic", "traffic"), node("api", "server"), node("cache", "cache"), node("db", "database")],
      [["traffic", "api"], ["api", "cache"], ["cache", "db"]],
    );
    const first = runSimulation(architecture, workload);
    architecture.nodes[1].capacity = 250;
    architecture.nodes[1].latency = 50;
    architecture.nodes[3].replicas = 2;
    const second = runSimulation(architecture, workload);
    expect(metric(first, "db").processed).toBe(metric(second, "db").processed);
    expect(first.traces.map((trace) => trace.steps.find((step) => step.nodeId === "cache")?.status)).toEqual(
      second.traces.map((trace) => trace.steps.find((step) => step.nodeId === "cache")?.status),
    );
  });

  it("routes across load-balanced branches and avoids a failed server", () => {
    const architecture = graph(
      [node("traffic", "traffic"), node("lb", "load-balancer", { capacity: 10000, latency: 1 }), node("a", "server", { capacity: 200 }), node("b", "server", { capacity: 200 }), node("db", "database")],
      [["traffic", "lb"], ["lb", "a"], ["lb", "b"], ["a", "db"], ["b", "db"]],
    );
    const result = runSimulation(architecture, { ...workload, failure: "server" });
    expect(metric(result, "a").processed).toBeGreaterThan(200);
    expect(metric(result, "b").processed).toBeGreaterThan(700);
    expect(result.errorRate).toBeLessThan(0.01);
    for (const trace of result.traces) expect(trace.steps.filter((step) => ["a", "b"].includes(step.nodeId))).toHaveLength(1);
  });

  it("models capacity and failure tolerance per replica behind a load balancer", () => {
    const architecture = balanced(60);
    const single = runSimulation(architecture, { ...workload, failure: "server" });
    architecture.nodes.find((item) => item.id === "api")!.replicas = 3;
    const replicated = runSimulation(architecture, { ...workload, failure: "server" });
    expect(single.failed).toBeGreaterThan(400);
    expect(replicated.errorRate).toBeLessThan(0.01);
    expect(replicated.p95).toBeLessThan(single.p95);
    // Cost 2.0: two more server replicas at capacity 60 = 2 * (0.4 + 3 * 60/200).
    // Cost 2.1 splits the bill, so the provisioned half is what replica count moves.
    expect(replicated.provisionedCost - single.provisionedCost).toBeCloseTo(2.6, 5);
  });

  it("requires explicit load balancing to use additional application replicas", () => {
    const direct = basic();
    direct.nodes[1].capacity = 60;
    direct.nodes[1].replicas = 2;
    const unrouted = runSimulation(direct, workload);
    const routed = runSimulation(balanced(60, 2), workload);
    const directMetric = metric(unrouted, "api");
    expect(unrouted.throughput).toBeLessThan(66);
    expect(unrouted.p95).toBeGreaterThan(1000);
    expect(directMetric.replicas![0].utilization).toBeGreaterThan(0.99);
    expect(directMetric.replicas![1]).toMatchObject({ index: 2, processed: 0, errors: 0, utilization: 0 });
    expect(directMetric.utilization).toBeLessThan(0.51);
    expect(titles(unrouted).some((title) => title.includes("idle replicas"))).toBe(true);
    expect(titles(unrouted).some((title) => title.includes("individual replica load"))).toBe(true);
    expect(routed.failed).toBe(0);
    expect(routed.p95).toBeLessThan(100);
    expect(routed.throughput).toBeGreaterThan(99);
    expect(metric(routed, "api").replicas!.map((replica) => replica.processed)).toEqual([500, 500]);
  });

  it("pins direct requests to failed replica 1 while a balancer uses healthy endpoints", () => {
    const direct = basic();
    direct.nodes[1].replicas = 2;
    const unrouted = runSimulation(direct, { ...workload, failure: "server" });
    const routed = runSimulation(balanced(400, 2), { ...workload, failure: "server" });
    expect(unrouted.errorRate).toBeGreaterThanOrEqual(0.49);
    expect(metric(unrouted, "api").healthyReplicas).toBe(1);
    expect(metric(unrouted, "api").replicas![1].processed).toBe(0);
    expect(unrouted.traces.every((trace) => trace.steps.find((step) => step.nodeId === "api")?.replica === 1)).toBe(true);
    expect(routed.errorRate).toBeLessThan(0.01);
    expect(new Set(routed.traces.flatMap((trace) => trace.steps.filter((step) => step.nodeId === "api").map((step) => step.replica)))).toEqual(new Set([1, 2]));
    expect(routed.traces.filter((trace) => trace.id > 600).every((trace) => trace.steps.find((step) => step.nodeId === "api")?.replica === 2)).toBe(true);
  });

  it("distributes equally across replica endpoints rather than equally across backend nodes", () => {
    const architecture = graph(
      [node("traffic", "traffic"), node("lb", "load-balancer", { capacity: 10000, latency: 1 }), node("a", "server", { capacity: 200, replicas: 2 }), node("b", "server", { capacity: 200 }), node("db", "database")],
      [["traffic", "lb"], ["lb", "a"], ["lb", "b"], ["a", "db"], ["b", "db"]],
    );
    const result = runSimulation(architecture, { ...workload, requestRate: 300 });
    expect(result.failed).toBe(0);
    expect(metric(result, "a").replicas!.map((replica) => replica.processed)).toEqual([1000, 1000]);
    expect(metric(result, "b").replicas!.map((replica) => replica.processed)).toEqual([1000]);
  });

  it("fails queued work pinned to the failed application replica without migrating it", () => {
    const result = runSimulation(balanced(30, 2), { ...workload, failure: "server" });
    const api = metric(result, "api");
    expect(api.replicas![0].errors).toBeGreaterThan(90);
    expect(api.replicas![0].processed).toBeLessThan(155);
    expect(
      result.traces.some(
        (trace) => !trace.success && trace.latency > 100 && trace.latency < 4900 && trace.steps.some((step) => step.nodeId === "api" && step.replica === 1 && step.status === "error"),
      ),
    ).toBe(true);
    expect(result.completed + result.failed).toBe(result.requestCount);
    expect(api.replicas!.reduce((count, replica) => count + replica.processed + replica.errors, 0)).toBe(api.processed + api.errors);
  });

  it("does not implicitly balance a direct application dependency", () => {
    const architecture = graph(
      [node("traffic", "traffic"), node("gateway", "server"), node("api", "server", { capacity: 60, replicas: 2 }), node("db", "database")],
      [["traffic", "gateway"], ["gateway", "api"], ["api", "db"]],
    );
    const result = runSimulation(architecture, workload);
    // One lane of capacity 60 sets the ceiling; the lognormal draws let it drift a few percent.
    expect(result.throughput).toBeLessThan(66);
    expect(metric(result, "api").replicas![1].processed).toBe(0);
  });

  it("keeps worker replicas as a shared FIFO pull pool without an application load balancer", () => {
    const architecture = graph(
      [node("traffic", "traffic"), node("api", "server"), node("queue", "queue", { capacity: 10000 }), node("worker", "server", { role: "worker", capacity: 40, replicas: 3 }), node("db", "database")],
      [["traffic", "api"], ["api", "queue"], ["queue", "worker"], ["worker", "db"]],
    );
    const result = runSimulation(architecture, workload);
    expect(result.failed).toBe(0);
    expect(result.p95).toBeLessThan(150);
    expect(metric(result, "worker").replicas!.every((replica) => replica.processed > 0)).toBe(true);
  });

  it("does not fabricate successful zero-latency results when every request times out", () => {
    const architecture = basic();
    architecture.nodes[1].latency = 7000;
    const result = runSimulation(architecture, workload);
    expect(result.completed).toBe(0);
    expect(result.failed).toBe(result.requestCount);
    expect(result.rejected).toBe(0);
    expect(result.errorRate).toBe(1);
    expect(result.successRate).toBe(0);
    expect(result.throughput).toBe(0);
    expect(result.p95).toBe(0);
    expect(result.traces.every((trace) => trace.latency === 5000 && !trace.success)).toBe(true);
    expect(result.traces[0].steps[0].status).toBe("error");
    expect(titles(result).some((title) => title.includes("5,000 ms deadline"))).toBe(true);
    expect(result.samples.reduce((count, sample) => count + sample.throughput, 0)).toBe(0);
  });

  it("attributes worker backlog to a queue and counts job completion, not acceptance", () => {
    const architecture = graph(
      [node("traffic", "traffic"), node("api", "server"), node("queue", "queue", { capacity: 10000 }), node("worker", "server", { role: "worker", capacity: 40 }), node("db", "database")],
      [["traffic", "api"], ["api", "queue"], ["queue", "worker"], ["worker", "db"]],
    );
    const result = runSimulation(architecture, workload);
    expect(metric(result, "queue").queueDepth).toBeGreaterThan(100);
    expect(result.throughput).toBeLessThan(41);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.completed + result.failed).toBe(result.requestCount);
    expect(result.traces.find((trace) => trace.success)!.steps.map((step) => step.nodeId)).toEqual(["api", "queue", "worker", "db"]);
    expect(titles(result).some((title) => title.includes("Queued work"))).toBe(true);
  });

  it("reports the configured database failure even when earlier stages have headroom", () => {
    const result = runSimulation(basic(), { ...workload, failure: "database" });
    expect(result.errorRate).toBeGreaterThan(0.49);
    expect(result.errorRate).toBeLessThan(0.52);
    expect(metric(result, "db").errors).toBeGreaterThan(490);
    expect(metric(result, "db").healthyReplicas).toBe(0);
    expect(result.completed + result.failed).toBe(1000);
    expect(result.events.some((event) => event.title.includes("replica 1 failed"))).toBe(true);
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

// ---------------------------------------------------------------------------------------------
// Heavy-tailed service times
// ---------------------------------------------------------------------------------------------

describe("service-time distribution", () => {
  const solo = (variance: SystemNode["variance"]) =>
    runSimulation(graph([node("traffic", "traffic"), node("api", "server", { capacity: 400, latency: 0, variance })], [["traffic", "api"]]), {
      ...workload,
      requestRate: 40,
      duration: 20,
    });

  it("keeps a heavy right tail at low utilization instead of a flat band around the mean", () => {
    const low = solo("low");
    const medium = solo("medium");
    const high = solo("high");
    for (const result of [low, medium, high]) {
      expect(result.completed).toBe(800);
      expect(result.throughput).toBeCloseTo(40, 0);
      expect(metric(result, "api").utilization).toBeLessThan(0.15);
    }
    expect(tail(medium)).toBeGreaterThan(1.8);
    expect(tail(high)).toBeGreaterThan(4);
    expect(tail(high)).toBeGreaterThan(tail(medium));
    expect(tail(medium)).toBeGreaterThan(tail(low));
    expect(tail(low)).toBeLessThan(2);
  });

  it("multiplies service time during a slow-database event and restores it afterwards", () => {
    const architecture = graph(
      [node("traffic", "traffic"), node("api", "server", { capacity: 2000, latency: 2 }), node("db", "database", { capacity: 400, latency: 5 })],
      [["traffic", "api"], ["api", "db"]],
    );
    const calm = runSimulation(architecture, { ...workload, requestRate: 200, duration: 20 });
    const slowed = runSimulation(architecture, { ...workload, requestRate: 200, duration: 20, failures: [{ kind: "slow-database", at: 0.3, duration: 8, factor: 20 }] });
    expect(calm.failed).toBe(0);
    expect(slowed.p95).toBeGreaterThan(calm.p95 * 10);
    expect(slowed.events.map((event) => event.title)).toEqual(["db slowed down 20x", "db recovered its normal speed"]);
    const during = slowed.samples.slice(7, 13).reduce((worst, sample) => Math.max(worst, sample.p95), 0);
    const after = slowed.samples[19].p95;
    expect(during).toBeGreaterThan(1000);
    expect(after).toBeLessThan(during / 5);
  });
});

// ---------------------------------------------------------------------------------------------
// Shedding: bounded queues and rate limiters
// ---------------------------------------------------------------------------------------------

describe("shedding", () => {
  const overloaded = (overrides: Partial<SystemNode>) =>
    runSimulation(
      graph(
        [node("traffic", "traffic"), node("lb", "load-balancer", { capacity: 20000, latency: 1 }), node("api", "server", { capacity: 100, latency: 5, ...overrides }), node("db", "database", { capacity: 5000, latency: 2 })],
        [["traffic", "lb"], ["lb", "api"], ["api", "db"]],
      ),
      { ...workload, requestRate: 200, duration: 20 },
    );

  it("rejects arrivals past a bounded server queue and keeps accepted p95 low under 2x overload", () => {
    const unbounded = overloaded({});
    const bounded = overloaded({ maxQueue: 20 });
    expect(unbounded.rejected).toBe(0);
    expect(unbounded.errorRate).toBeGreaterThan(0.7);
    expect(unbounded.p95).toBeGreaterThan(4000);
    expect(bounded.rejected).toBeGreaterThan(1000);
    expect(bounded.rejectedRate).toBeGreaterThan(0.4);
    expect(bounded.errorRate).toBe(0);
    expect(bounded.p95).toBeLessThan(400);
    expect(bounded.p95).toBeLessThan(unbounded.p95 / 10);
    expect(bounded.completed).toBeGreaterThan(unbounded.completed);
    expect(bounded.maxQueueDepth).toBeLessThanOrEqual(20);
    expect(metric(bounded, "api").rejected).toBe(bounded.rejected);
    expect(bounded.samples.some((sample) => (sample.rejected ?? 0) > 0)).toBe(true);
    const shed = insight(bounded, "shed on purpose")!;
    expect(shed.detail).toContain("accepted requests kept a p95");
    expect(shed.detail).toContain(`${bounded.p95}`);
    expect(bounded.traces.some((trace) => trace.steps.some((step) => step.status === "rejected"))).toBe(true);
  });

  it("bounds a queue so the backlog cannot grow past its limit", () => {
    const jobs = (maxQueue: number) =>
      runSimulation(
        graph(
          [node("traffic", "traffic"), node("api", "server", { capacity: 5000, latency: 1 }), node("queue", "queue", { capacity: 20000, latency: 1, maxQueue }), node("worker", "server", { role: "worker", capacity: 60, latency: 5 }), node("db", "database", { capacity: 5000, latency: 2 })],
          [["traffic", "api"], ["api", "queue"], ["queue", "worker"], ["worker", "db"]],
        ),
        { ...workload, requestRate: 120, readRatio: 0, duration: 15 },
      );
    const unbounded = jobs(0);
    const bounded = jobs(40);
    expect(unbounded.rejected).toBe(0);
    expect(metric(unbounded, "queue").queueDepth).toBeGreaterThan(400);
    expect(metric(bounded, "queue").queueDepth).toBeLessThanOrEqual(40);
    expect(bounded.rejected).toBeGreaterThan(500);
    expect(bounded.completed).toBeGreaterThan(unbounded.completed);
    expect(bounded.p95).toBeLessThan(unbounded.p95 / 5);
  });

  it("lets a token bucket pass at most limit + burst in the first second and limit per second after", () => {
    const result = runSimulation(
      graph(
        [node("traffic", "traffic"), node("limit", "rate-limiter", { capacity: 20000, latency: 1, limit: 100, burst: 100 }), node("api", "server", { capacity: 5000, latency: 2 })],
        [["traffic", "limit"], ["limit", "api"]],
      ),
      { ...workload, requestRate: 500, duration: 10 },
    );
    expect(result.requestCount).toBe(5000);
    expect(result.errorRate).toBe(0);
    expect(result.rejected).toBeGreaterThan(3800);
    expect(result.rejected + result.completed).toBe(result.requestCount);
    expect(result.completed).toBeLessThanOrEqual(100 * 10 + 100);
    expect(metric(result, "api").processed).toBe(result.completed);
    expect(result.samples[0].throughput).toBeLessThanOrEqual(200);
    expect(result.samples[0].throughput).toBeGreaterThan(150);
    for (const sample of result.samples.slice(1)) expect(sample.throughput).toBeLessThanOrEqual(101);
    expect(result.p95).toBeLessThan(10);
    expect(result.traces.some((trace) => trace.steps.some((step) => step.nodeId === "limit" && step.status === "rejected"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Timeouts, retries and circuit breakers
// ---------------------------------------------------------------------------------------------

describe("timeouts, retries and circuit breakers", () => {
  const caller = (overrides: Partial<SystemNode>) =>
    graph(
      [node("traffic", "traffic"), node("api", "server", { capacity: 2000, latency: 2, ...overrides }), node("db", "database", { capacity: 400, latency: 5 })],
      [["traffic", "api"], ["api", "db"]],
    );
  const deadDatabase: Workload = { ...workload, requestRate: 200, duration: 20, failures: [{ kind: "database", at: 0.3, duration: 8 }] };
  const slowDatabase: Workload = { ...workload, requestRate: 200, duration: 20, failures: [{ kind: "slow-database", at: 0.3, duration: 8, factor: 20 }] };

  it("amplifies dependency load when retries hit a failing dependency", () => {
    const plain = runSimulation(caller({}), deadDatabase);
    const retrying = runSimulation(caller({ retries: 3, retryBackoffMs: 40 }), deadDatabase);
    expect(plain.retriesIssued).toBe(0);
    expect(plain.amplification).toBe(1);
    expect(retrying.retriesIssued).toBeGreaterThan(3000);
    expect(retrying.amplification).toBeGreaterThan(1.5);
    expect(metric(retrying, "db").errors).toBeGreaterThan(metric(plain, "db").errors * 1.5);
    const amplified = insight(retrying, "amplified")!;
    expect(amplified.severity).toBe("critical");
    expect(amplified.nodeId).toBe("db");
    expect(retrying.traces.some((trace) => trace.steps.some((step) => step.status === "retry"))).toBe(true);
  });

  it("turns a systematic failure into cheap rejections once a breaker opens", () => {
    const retrying = runSimulation(caller({ retries: 3, retryBackoffMs: 40 }), deadDatabase);
    const broken = runSimulation(caller({ retries: 3, retryBackoffMs: 40, circuitBreaker: true }), deadDatabase);
    expect(broken.errorRate).toBeLessThan(retrying.errorRate / 10);
    expect(broken.rejected).toBeGreaterThan(1500);
    expect(broken.rejectedRate + broken.errorRate + broken.successRate).toBeCloseTo(1, 3);
    expect(broken.amplification).toBeLessThan(retrying.amplification);
    expect(broken.retriesIssued).toBeLessThan(retrying.retriesIssued / 10);
    expect(broken.events.some((event) => event.title.includes("opened its circuit breaker"))).toBe(true);
    expect(broken.events.some((event) => event.title.includes("closed its circuit breaker"))).toBe(true);
    const opened = broken.events.find((event) => event.title.includes("opened"))!;
    const failedAt = broken.events.find((event) => event.title.includes("replica 1 failed"))!;
    expect(opened.time).toBeGreaterThanOrEqual(failedAt.time);
    expect(opened.time).toBeLessThan(failedAt.time + 1);
    expect(insight(broken, "Circuit breakers opened")!.nodeId).toBe("api");
    // Open-circuit failures are booked against the caller that refused to make the call.
    expect(metric(broken, "api").rejected).toBe(broken.rejected);
    expect(metric(broken, "db").errors).toBeLessThan(metric(retrying, "db").errors / 5);
  });

  it("abandons a slow dependency at the timeout while the downstream work keeps running", () => {
    const patient = runSimulation(caller({}), slowDatabase);
    const impatient = runSimulation(caller({ timeoutMs: 150, retries: 2, retryBackoffMs: 30 }), slowDatabase);
    const protectedRun = runSimulation(caller({ timeoutMs: 150, retries: 2, retryBackoffMs: 30, circuitBreaker: true }), slowDatabase);
    expect(patient.p50).toBeGreaterThan(300);
    expect(impatient.p50).toBeLessThan(20);
    expect(impatient.amplification).toBeGreaterThan(1.5);
    expect(impatient.errorRate).toBeGreaterThan(patient.errorRate);
    const zombies = insight(impatient, "abandoned at their timeout")!;
    expect(zombies.detail).toContain("finished downstream anyway");
    expect(protectedRun.errorRate).toBeLessThan(impatient.errorRate / 5);
    expect(protectedRun.rejected).toBeGreaterThan(1000);
    expect(protectedRun.p99).toBeLessThan(impatient.p99);
  });
});

// ---------------------------------------------------------------------------------------------
// Databases: leader-follower and sharding
// ---------------------------------------------------------------------------------------------

describe("leader-follower databases", () => {
  const readScale = (replicas: number) =>
    runSimulation(
      graph(
        [node("traffic", "traffic"), node("api", "server", { capacity: 5000, latency: 2 }), node("db", "database", { capacity: 100, latency: 5, replicas, dbMode: "leader-follower" })],
        [["traffic", "api"], ["api", "db"]],
      ),
      { ...workload, requestRate: 200, readRatio: 0.9, duration: 15 },
    );

  it("scales reads across followers while writes stay on the leader", () => {
    const one = readScale(1);
    const two = readScale(2);
    const four = readScale(4);
    expect(one.completed).toBeLessThan(1500);
    expect(two.completed).toBeGreaterThan(one.completed);
    expect(four.completed).toBe(four.requestCount);
    expect(four.failed).toBe(0);
    expect(four.p95).toBeLessThan(one.p95 / 20);
    expect(metric(four, "db").replicas!.every((replica) => replica.processed > 0)).toBe(true);
    // Writes are pinned to lane 0, reads round robin over the followers, so the leader is the odd one out.
    const lanes = metric(four, "db").replicas!.map((replica) => replica.processed);
    expect(lanes[0]).toBeLessThan(lanes[1]);
  });

  it("fails writes for the failover window and then promotes a follower", () => {
    const result = runSimulation(
      graph(
        [node("traffic", "traffic"), node("api", "server", { capacity: 5000, latency: 2 }), node("db", "database", { capacity: 1000, latency: 5, replicas: 3, dbMode: "leader-follower", failoverMs: 3000 })],
        [["traffic", "api"], ["api", "db"]],
      ),
      { ...workload, requestRate: 200, readRatio: 0.5, duration: 20, failures: [{ kind: "database", at: 0.25, duration: 10 }] },
    );
    const titlesInOrder = result.events.map((event) => event.title);
    expect(titlesInOrder).toContain("db lost its leader");
    expect(titlesInOrder.some((title) => title.startsWith("db promoted replica"))).toBe(true);
    const lost = result.events.find((event) => event.title === "db lost its leader")!;
    const promoted = result.events.find((event) => event.title.startsWith("db promoted"))!;
    expect(promoted.time - lost.time).toBeCloseTo(3, 1);
    // Only the three seconds of failover produce errors; reads keep flowing from the followers.
    const failing = result.samples.filter((sample) => sample.errorRate > 0.1);
    expect(failing.length).toBeGreaterThanOrEqual(3);
    expect(failing.length).toBeLessThanOrEqual(4);
    expect(failing.every((sample) => sample.errorRate < 0.6)).toBe(true);
    expect(result.samples[19].errorRate).toBe(0);
    expect(result.errorRate).toBeLessThan(0.1);
  });

  it("serves stale follower reads under replication lag unless read-your-writes routes them to the leader", () => {
    const lagged = (consistency: "eventual" | "read-your-writes") =>
      runSimulation(
        graph(
          [node("traffic", "traffic"), node("api", "server", { capacity: 5000, latency: 2 }), node("db", "database", { capacity: 2000, latency: 3, replicas: 3, dbMode: "leader-follower", replicationLagMs: 2000, consistency })],
          [["traffic", "api"], ["api", "db"]],
        ),
        { ...workload, requestRate: 200, readRatio: 0.5, duration: 15, keySpace: 50, keySkew: 0.2 },
      );
    const eventual = lagged("eventual");
    const readYourWrites = lagged("read-your-writes");
    expect(eventual.staleReads).toBeGreaterThan(1000);
    expect(eventual.staleReadRate).toBeGreaterThan(0.5);
    expect(eventual.staleReadRate).toBeCloseTo(eventual.staleReads / Math.round(eventual.requestCount * 0.5), 1);
    expect(readYourWrites.staleReads).toBe(0);
    expect(readYourWrites.staleReadRate).toBe(0);
    expect(readYourWrites.completed).toBe(eventual.completed);
    expect(insight(eventual, "returned stale data")).toBeDefined();
    expect(insight(readYourWrites, "returned stale data")).toBeUndefined();
    expect(eventual.traces.some((trace) => trace.steps.some((step) => step.status === "stale"))).toBe(true);
  });
});

describe("sharded databases", () => {
  const sharded = (shardStrategy: "hash" | "range", keySkew: number) =>
    runSimulation(
      graph(
        [node("traffic", "traffic"), node("api", "server", { capacity: 5000, latency: 2 }), node("db", "database", { capacity: 300, latency: 4, dbMode: "sharded", shards: 4, shardStrategy })],
        [["traffic", "api"], ["api", "db"]],
      ),
      { ...workload, requestRate: 350, readRatio: 0.5, duration: 15, keySpace: 10000, keySkew },
    );
  const skewOf = (result: SimulationResult) => {
    const shards = metric(result, "db").shards!;
    return Math.max(...shards) / (shards.reduce((sum, value) => sum + value, 0) / shards.length);
  };

  it("piles skewed keys onto one range shard while hashing spreads them", () => {
    const range = sharded("range", 0.6);
    const hash = sharded("hash", 0.6);
    expect(metric(range, "db").shards).toHaveLength(4);
    expect(skewOf(range)).toBeGreaterThan(2);
    expect(skewOf(hash)).toBeLessThan(1.3);
    expect(metric(range, "db").shards![0]).toBeGreaterThan(metric(range, "db").shards![3] * 4);
    expect(range.p95).toBeGreaterThan(hash.p95);
    expect(insight(range, "hottest shard")!.severity).toBe("critical");
    expect(insight(hash, "hottest shard")!.severity).toBe("good");
    expect(metric(range, "db").replicas).toHaveLength(4);
  });

  it("keeps hashing even as the skew rises and range partitioning worse", () => {
    expect(skewOf(sharded("range", 0.7))).toBeGreaterThan(skewOf(sharded("range", 0.4)));
    expect(skewOf(sharded("hash", 0.7))).toBeLessThan(1.3);
  });
});

// ---------------------------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------------------------

describe("caches", () => {
  const keyed = (overrides: Partial<SystemNode>, extra: Partial<Workload> = {}) =>
    runSimulation(
      graph(
        [node("traffic", "traffic"), node("api", "server", { capacity: 20000, latency: 1 }), node("cache", "cache", { capacity: 20000, latency: 1, cacheModel: "keyed", ...overrides }), node("db", "database", { capacity: 20000, latency: 40 })],
        [["traffic", "api"], ["api", "cache"], ["cache", "db"]],
      ),
      { ...workload, requestRate: 300, readRatio: 1, duration: 15, keySpace: 5000, keySkew: 0.7, ...extra },
    );

  it("raises the keyed hit rate as the cache holds more of the working set", () => {
    const tiny = keyed({ cacheEntries: 50 });
    const small = keyed({ cacheEntries: 500 });
    const large = keyed({ cacheEntries: 5000 });
    expect(metric(tiny, "db").processed).toBeGreaterThan(metric(small, "db").processed);
    expect(metric(small, "db").processed).toBeGreaterThan(metric(large, "db").processed);
    expect(metric(large, "db").processed).toBeLessThan(tiny.requestCount * 0.5);
    expect(metric(tiny, "cache").processed).toBe(tiny.requestCount);
    expect(large.traces.some((trace) => trace.steps.some((step) => step.nodeId === "cache" && step.status === "hit"))).toBe(true);
    expect(large.traces.some((trace) => trace.steps.some((step) => step.nodeId === "cache" && step.status === "miss"))).toBe(true);
  });

  it("trades hit rate for freshness when a TTL expires entries", () => {
    const fresh = keyed({ cacheEntries: 5000, ttlMs: 300 }, { readRatio: 0.7, requestRate: 600, keySpace: 200, keySkew: 0.5 });
    const forever = keyed({ cacheEntries: 5000, ttlMs: 0 }, { readRatio: 0.7, requestRate: 600, keySpace: 200, keySkew: 0.5 });
    expect(metric(fresh, "db").processed).toBeGreaterThan(metric(forever, "db").processed * 1.5);
    expect(fresh.staleReads).toBeLessThan(forever.staleReads);
    expect(forever.staleReads).toBeGreaterThan(0);
    expect(insight(forever, "cache reads were hits")!.detail).toContain("writes + read misses");
  });

  it("collapses concurrent misses onto one origin fetch after a cache flush", () => {
    const stampede = (coalesce: boolean) =>
      runSimulation(
        graph(
          [node("traffic", "traffic"), node("api", "server", { capacity: 40000, latency: 0 }), node("cache", "cache", { capacity: 40000, latency: 0, cacheModel: "keyed", cacheEntries: 2000, coalesce }), node("db", "database", { capacity: 40000, latency: 150 })],
          [["traffic", "api"], ["api", "cache"], ["cache", "db"]],
        ),
        { ...workload, requestRate: 1200, readRatio: 1, duration: 20, keySpace: 300, keySkew: 0.9, failures: [{ kind: "cache-flush", at: 0.5 }] },
      );
    const alone = stampede(false);
    const coalesced = stampede(true);
    expect(alone.events.map((event) => event.title)).toEqual(["cache was flushed"]);
    expect(metric(coalesced, "db").processed).toBeLessThan(metric(alone, "db").processed * 0.75);
    expect(insight(alone, "after a cache flush")!.severity).toBe("critical");
    expect(insight(coalesced, "cache reads were hits")!.detail).toContain("coalesced");
    expect(coalesced.traces.some((trace) => trace.steps.some((step) => step.status === "coalesced"))).toBe(true);
    expect(coalesced.completed).toBe(coalesced.requestCount);
  });

  it("ramps a probabilistic cache from cold over its warm-up window", () => {
    const ramped = (warmupSeconds: number) =>
      runSimulation(
        graph(
          [node("traffic", "traffic"), node("api", "server", { capacity: 5000, latency: 2 }), node("cache", "cache", { capacity: 20000, latency: 1, cacheHitRate: 0.9, warmupSeconds }), node("db", "database", { capacity: 5000, latency: 5 })],
          [["traffic", "api"], ["api", "cache"], ["cache", "db"]],
        ),
        { ...workload, requestRate: 200, readRatio: 1, duration: 20 },
      );
    const warm = ramped(0);
    const cold = ramped(8);
    expect(metric(warm, "db").processed).toBeGreaterThan(300);
    expect(metric(warm, "db").processed).toBeLessThan(500);
    expect(metric(cold, "db").processed).toBeGreaterThan(metric(warm, "db").processed * 2);
  });

  it("serves reads at a CDN edge in the reader's own region and forwards misses to the origin", () => {
    const result = runSimulation(
      graph(
        [node("traffic", "traffic"), node("edge", "cdn", { capacity: 20000, latency: 3, cacheHitRate: 0.7, region: "eu" }), node("api", "server", { capacity: 5000, latency: 3, region: "us" }), node("db", "database", { capacity: 20000, latency: 2, region: "us" })],
        [["traffic", "edge"], ["edge", "api"], ["api", "db"]],
      ),
      { ...workload, requestRate: 200, readRatio: 1, duration: 15, regions: [{ name: "eu", share: 1 }], crossRegionLatencyMs: 120 },
    );
    expect(metric(result, "edge").processed).toBe(result.requestCount);
    expect(metric(result, "api").processed / result.requestCount).toBeGreaterThan(0.25);
    expect(metric(result, "api").processed / result.requestCount).toBeLessThan(0.35);
    // An edge hit never leaves the reader's region; a miss pays the crossing to the origin.
    expect(result.p50).toBeLessThan(10);
    expect(result.p95).toBeGreaterThan(120);
    expect(insight(result, "cache reads were hits")).toBeDefined();
    expect(insight(result, "crossed a region")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Load balancing
// ---------------------------------------------------------------------------------------------

describe("load balancing", () => {
  const detection = (healthCheckMs: number) =>
    runSimulation(
      graph(
        [node("traffic", "traffic"), node("lb", "load-balancer", { capacity: 20000, latency: 1, healthCheckMs }), node("api", "server", { capacity: 2000, latency: 3, replicas: 2 }), node("db", "database", { capacity: 20000, latency: 2 })],
        [["traffic", "lb"], ["lb", "api"], ["api", "db"]],
      ),
      { ...workload, requestRate: 200, duration: 20, failures: [{ kind: "server", at: 0.25 }] },
    );

  it("loses requests in proportion to the health-check interval", () => {
    const immediate = detection(0);
    const quick = detection(500);
    const slow = detection(2000);
    expect(immediate.failed).toBe(0);
    expect(quick.failed).toBeGreaterThan(0);
    expect(slow.failed).toBeGreaterThan(quick.failed * 4);
    // 100 req/s reach the dead endpoint, so the loss is roughly rate x time-to-next-check.
    expect(slow.failed).toBeLessThan(100 * 2 + 1);
    expect(insight(immediate, "dead endpoint")).toBeUndefined();
    expect(insight(slow, "dead endpoint")!.title).toContain("2,000 ms");
    expect(insight(slow, "dead endpoint")!.nodeId).toBe("lb");
  });

  it("keeps the tail shorter with least-connections than with round-robin over variable replicas", () => {
    const byAlgorithm = (algorithm: "round-robin" | "least-connections") =>
      runSimulation(
        graph(
          [node("traffic", "traffic"), node("lb", "load-balancer", { capacity: 20000, latency: 1, algorithm }), node("a", "server", { capacity: 120, latency: 2, variance: "high" }), node("b", "server", { capacity: 120, latency: 2, variance: "high" })],
          [["traffic", "lb"], ["lb", "a"], ["lb", "b"]],
        ),
        { ...workload, requestRate: 200, duration: 15 },
      );
    const roundRobin = byAlgorithm("round-robin");
    const leastConnections = byAlgorithm("least-connections");
    expect(metric(roundRobin, "a").processed).toBe(metric(roundRobin, "b").processed);
    expect(metric(leastConnections, "a").processed).not.toBe(metric(leastConnections, "b").processed);
    expect(leastConnections.p95).toBeLessThan(roundRobin.p95 * 0.8);
    expect(leastConnections.p99).toBeLessThan(roundRobin.p99 * 0.8);
    expect(leastConnections.completed).toBe(roundRobin.completed);
  });
});

// ---------------------------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------------------------

describe("regions", () => {
  const stack = (withUs: boolean) => {
    const nodes = [
      node("traffic", "traffic"),
      node("lb-eu", "load-balancer", { capacity: 20000, latency: 1, region: "eu" }),
      node("api-eu", "server", { capacity: 4000, latency: 3, region: "eu" }),
      node("db", "database", { capacity: 20000, latency: 2, region: "us" }),
    ];
    const links: [string, string][] = [["traffic", "lb-eu"], ["lb-eu", "api-eu"], ["api-eu", "db"]];
    if (withUs) {
      nodes.push(node("lb-us", "load-balancer", { capacity: 20000, latency: 1, region: "us" }), node("api-us", "server", { capacity: 4000, latency: 3, region: "us" }));
      links.push(["traffic", "lb-us"], ["lb-us", "api-us"], ["api-us", "db"]);
    }
    return graph(nodes, links);
  };
  const outage: Workload = {
    ...workload,
    requestRate: 200,
    duration: 20,
    regions: [{ name: "eu", share: 1 }],
    crossRegionLatencyMs: 80,
    failures: [{ kind: "region", at: 0.3, duration: 6, region: "eu" }],
  };

  it("adds the cross-region latency to every hop that leaves the source region", () => {
    const local = runSimulation(stack(false), { ...workload, requestRate: 200, duration: 10, regions: [{ name: "eu", share: 1 }], crossRegionLatencyMs: 0 });
    const remote = runSimulation(stack(false), { ...workload, requestRate: 200, duration: 10, regions: [{ name: "eu", share: 1 }], crossRegionLatencyMs: 80 });
    // One eu -> us crossing on the way to the database, and no crossing on the way back in this model.
    expect(remote.p50 - local.p50).toBeGreaterThan(70);
    expect(remote.p50 - local.p50).toBeLessThan(90);
    expect(insight(remote, "crossed a region")!.detail).toContain("80 ms per crossing");
  });

  it("takes every replica in a region down and brings them back after the outage", () => {
    const result = runSimulation(stack(false), outage);
    expect(result.events.map((event) => event.title)).toEqual(["Region eu went down", "Region eu came back"]);
    expect(result.events[1].time - result.events[0].time).toBeCloseTo(6, 1);
    expect(result.failed).toBeGreaterThan(1000);
    expect(result.errorRate).toBeGreaterThan(0.25);
    expect(metric(result, "api-eu").healthyReplicas).toBe(1);
    expect(result.samples[3].errorRate).toBe(0);
    expect(result.samples[8].errorRate).toBeGreaterThan(0.9);
    expect(result.samples[15].errorRate).toBe(0);
  });

  it("fails traffic over to a healthy region when the preferred one is down", () => {
    const result = runSimulation(stack(true), outage);
    expect(result.failed).toBe(0);
    expect(result.errorRate).toBe(0);
    expect(metric(result, "api-us").processed).toBeGreaterThan(0);
    expect(metric(result, "api-eu").processed).toBeGreaterThan(0);
    expect(metric(result, "api-us").processed + metric(result, "api-eu").processed).toBe(result.requestCount);
    // The outage lasts 6 of 20 seconds, so roughly a third of the traffic is diverted.
    expect(metric(result, "api-us").processed / result.requestCount).toBeGreaterThan(0.25);
    expect(metric(result, "api-us").processed / result.requestCount).toBeLessThan(0.4);
  });

  it("routes each request to the target in its own region", () => {
    const result = runSimulation(stack(true), {
      ...workload,
      requestRate: 200,
      duration: 10,
      regions: [{ name: "eu", share: 0.75 }, { name: "us", share: 0.25 }],
      crossRegionLatencyMs: 80,
    });
    expect(result.failed).toBe(0);
    expect(metric(result, "api-eu").processed / result.requestCount).toBeGreaterThan(0.7);
    expect(metric(result, "api-us").processed / result.requestCount).toBeLessThan(0.3);
  });
});

// ---------------------------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------------------------

describe("fan-out", () => {
  const dependency = (id: string) => node(id, "server", { capacity: 300, latency: 5, variance: "high" });
  const fanout = (ids: string[], mode: "parallel" | "sequential") =>
    runSimulation(
      graph(
        [node("traffic", "traffic"), node("gw", "server", { capacity: 20000, latency: 1, fanout: mode }), ...ids.map(dependency)],
        [["traffic", "gw"], ...ids.map((id) => ["gw", id] as [string, string])],
      ),
      { ...workload, requestRate: 200, duration: 15 },
    );

  it("makes the slowest of several parallel dependencies set the tail", () => {
    const one = fanout(["a"], "parallel");
    const two = fanout(["a", "b"], "parallel");
    const three = fanout(["a", "b", "c"], "parallel");
    expect(one.failed).toBe(0);
    expect(three.failed).toBe(0);
    expect(two.p95).toBeGreaterThan(one.p95);
    expect(three.p95).toBeGreaterThan(two.p95);
    expect(three.p95).toBeGreaterThan(one.p95 * 1.3);
    // Every extra branch is another draw from the same heavy tail, so the whole distribution shifts.
    expect(three.p50).toBeGreaterThan(one.p50);
    expect(three.p99).toBeGreaterThan(one.p95);
    expect(three.amplification).toBe(1);
    expect(metric(three, "a").processed).toBe(three.requestCount);
    expect(metric(three, "c").processed).toBe(three.requestCount);
  });

  it("adds sequential dependency latencies instead of overlapping them", () => {
    const parallel = fanout(["a", "b", "c"], "parallel");
    const sequential = fanout(["a", "b", "c"], "sequential");
    expect(sequential.p50).toBeGreaterThan(parallel.p50 * 2);
    expect(sequential.p95).toBeGreaterThan(parallel.p95 * 1.5);
    expect(sequential.completed).toBe(parallel.completed);
  });
});

// ---------------------------------------------------------------------------------------------
// Arrival patterns
// ---------------------------------------------------------------------------------------------

describe("arrival patterns", () => {
  const pattern = (name: Workload["pattern"]) =>
    runSimulation(graph([node("traffic", "traffic"), node("api", "server", { capacity: 5000, latency: 2 })], [["traffic", "api"]]), {
      ...workload,
      requestRate: 100,
      duration: 20,
      pattern: name,
    });

  it("shapes arrivals per pattern", () => {
    const steady = pattern("steady");
    const spike = pattern("spike");
    const ramp = pattern("ramp");
    const flash = pattern("flash");
    expect(steady.requestCount).toBe(2000);
    expect(steady.samples.slice(0, 20).every((sample) => Math.abs(sample.throughput - 100) <= 2)).toBe(true);

    // Spike: 2x for the middle 30% of the run.
    expect(spike.requestCount).toBe(2600);
    expect(spike.samples[2].throughput).toBeCloseTo(100, -1);
    expect(spike.samples[9].throughput).toBeGreaterThan(180);
    expect(spike.samples[17].throughput).toBeCloseTo(100, -1);

    // Ramp: 30% to 170% of the rate.
    expect(ramp.samples[0].throughput).toBeLessThan(45);
    expect(ramp.samples[19].throughput).toBeGreaterThan(155);
    expect(ramp.requestCount).toBeGreaterThan(1950);
    expect(ramp.requestCount).toBeLessThan(2050);

    // Flash: 6x for 8% of the run starting at 40%.
    expect(flash.requestCount).toBe(3000);
    expect(flash.samples[8].throughput).toBeGreaterThan(500);
    expect(flash.samples[9].throughput).toBeGreaterThan(500);
    expect(flash.samples[11].throughput).toBeLessThan(150);
    expect(flash.samples.filter((sample) => sample.throughput > 300)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Reported metrics
// ---------------------------------------------------------------------------------------------

describe("reported metrics", () => {
  it("breaks the cost down per enabled component and ignores imported cost fields", () => {
    const architecture = graph(
      [node("traffic", "traffic"), node("lb", "load-balancer", { capacity: 5000 }), node("api", "server", { capacity: 400, replicas: 2 }), node("db", "database", { capacity: 150, replicas: 3, dbMode: "leader-follower" })],
      [["traffic", "lb"], ["lb", "api"], ["api", "db"]],
    );
    const result = runSimulation(architecture, workload);
    expect(result.costBreakdown.map((item) => item.nodeId)).toEqual(["lb", "api", "db"]);
    expect(result.costBreakdown.find((item) => item.nodeId === "lb")!.cost).toBeCloseTo(1.5, 3);
    expect(result.costBreakdown.find((item) => item.nodeId === "api")!.cost).toBeCloseTo(12.8, 3);
    // Leader plus two followers: 3 x (1 + 4) x (1 + 0.15 x 2).
    expect(result.costBreakdown.find((item) => item.nodeId === "db")!.cost).toBeCloseTo(19.5, 3);
    expect(result.costBreakdown.reduce((sum, item) => sum + item.cost, 0)).toBeCloseTo(result.provisionedCost, 3);
    expect(result.costBreakdown.reduce((sum, item) => sum + item.usage!, 0)).toBeCloseTo(result.usageCost, 2);
    expect(result.cost).toBeCloseTo(result.provisionedCost + result.usageCost, 2);
    for (const component of architecture.nodes) component.cost = 999;
    expect(runSimulation(architecture, workload).cost).toBe(result.cost);
  });

  it("keeps amplification at 1 when nothing calls a dependency more than once", () => {
    const result = runSimulation(basic(), workload);
    expect(result.amplification).toBe(1);
    expect(result.retriesIssued).toBe(0);
    expect(result.staleReads).toBe(0);
    expect(result.staleReadRate).toBe(0);
  });

  it("separates deliberate rejections from unexpected errors in every rate", () => {
    const result = runSimulation(
      graph(
        [node("traffic", "traffic"), node("limit", "rate-limiter", { capacity: 20000, latency: 1, limit: 60, burst: 60 }), node("api", "server", { capacity: 5000, latency: 2 })],
        [["traffic", "limit"], ["limit", "api"]],
      ),
      { ...workload, requestRate: 200, duration: 10 },
    );
    expect(result.failed).toBe(result.rejected);
    expect(result.errorRate).toBe(0);
    expect(result.rejectedRate).toBeCloseTo(result.rejected / result.requestCount, 5);
    expect(result.successRate).toBeCloseTo(result.completed / result.requestCount, 5);
    expect(result.successRate + result.rejectedRate).toBeCloseTo(1, 5);
  });

  it("reports a healthy design as good without pretending headroom is resilience", () => {
    const result = runSimulation(basic(), workload);
    const allGood = insight(result, "Every request completed inside the deadline")!;
    expect(allGood.severity).toBe("good");
    expect(allGood.detail).toContain("Headroom at a steady rate is not resilience");
    expect(result.insights.every((item) => item.detail.length > 60)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

describe("architecture validation", () => {
  it("rejects disconnected infrastructure, loops and missing dependencies", () => {
    const disconnected = basic();
    disconnected.nodes.push(node("orphan", "cache"));
    expect(() => runSimulation(disconnected, workload)).toThrow(/Connect every component/);
    const cycle = basic();
    cycle.edges.push({ id: "loop", source: "db", target: "api" });
    expect(() => runSimulation(cycle, workload)).toThrow(/loop/);
    const cache = graph([node("traffic", "traffic"), node("api", "server"), node("cache", "cache")], [["traffic", "api"], ["api", "cache"]]);
    expect(() => runSimulation(cache, workload)).toThrow(/cache to exactly one database/);
  });

  it("lets a server call up to four dependencies and no more", () => {
    const four = basic();
    for (const id of ["d1", "d2", "d3"]) {
      four.nodes.push(node(id, "database"));
      four.edges.push({ id: `x${id}`, source: "api", target: id });
    }
    expect(() => runSimulation(four, workload)).not.toThrow();
    four.nodes.push(node("d4", "database"));
    four.edges.push({ id: "xd4", source: "api", target: "d4" });
    expect(() => runSimulation(four, workload)).toThrow(/at most 4 dependencies/);
  });

  it("enforces the topology rules for every kind", () => {
    const terminal = basic();
    terminal.nodes.push(node("c", "cache"), node("db2", "database"));
    terminal.edges.push({ id: "x1", source: "db", target: "c" }, { id: "x2", source: "c", target: "db2" });
    expect(() => runSimulation(terminal, workload)).toThrow(/databases are the end/);

    const cdn = graph([node("traffic", "traffic"), node("edge", "cdn"), node("a", "server"), node("b", "server")], [["traffic", "edge"], ["edge", "a"], ["edge", "b"]]);
    expect(() => runSimulation(cdn, workload)).toThrow(/exactly one application server, load balancer, CDN or rate limiter/);

    const queue = graph([node("traffic", "traffic"), node("api", "server"), node("q", "queue"), node("s2", "server")], [["traffic", "api"], ["api", "q"], ["q", "s2"]]);
    expect(() => runSimulation(queue, workload)).toThrow(/queue to one server with the Worker role/);

    const entry = graph([node("traffic", "traffic"), node("db", "database")], [["traffic", "db"]]);
    expect(() => runSimulation(entry, workload)).toThrow(/Connect traffic to one or more application servers/);

    const twoEntries = graph(
      [node("traffic", "traffic"), node("a", "server"), node("b", "server"), node("db", "database")],
      [["traffic", "a"], ["traffic", "b"], ["a", "db"], ["b", "db"]],
    );
    expect(() => runSimulation(twoEntries, workload)).not.toThrow();
  });

  it("rejects invalid workloads and numeric settings before creating events", () => {
    expect(() => validateSimulation(basic(), { ...workload, requestRate: Infinity })).toThrow(/traffic/);
    expect(() => validateSimulation(basic(), { ...workload, requestRate: 4000 })).toThrow(/3,000 requests/);
    expect(() => validateSimulation(basic(), { ...workload, duration: 61 })).toThrow(/duration/);
    expect(() => validateSimulation(basic(), { ...workload, keySpace: 200000 })).toThrow(/key space/);
    expect(() => validateSimulation(basic(), { ...workload, keySkew: 1 })).toThrow(/Key skew/);
    expect(() => validateSimulation(basic(), { ...workload, failures: Array.from({ length: 7 }, () => ({ kind: "server" as const, at: 0.5 })) })).toThrow(/at most 6 failure events/);
    expect(() => validateSimulation(basic(), { ...workload, failures: [{ kind: "region", at: 0.5 }] })).toThrow(/needs the name of the region/);
    expect(() => validateSimulation(basic(), { ...workload, failures: [{ kind: "server", at: 1.5 }] })).toThrow(/between 0% and 100%/);
    const architecture = basic();
    architecture.nodes[1].capacity = 0;
    expect(() => validateSimulation(architecture, workload)).toThrow(/capacity/);
    const shards = basic();
    shards.nodes[2].dbMode = "sharded";
    shards.nodes[2].shards = 20;
    expect(() => validateSimulation(shards, workload)).toThrow(/between 1 and 16 shards/);
    const retries = basic();
    retries.nodes[1].retries = 5;
    expect(() => validateSimulation(retries, workload)).toThrow(/between 0 and 3 retries/);
    const size = basic();
    size.nodes.push(...Array.from({ length: 48 }, (_, index) => node(`n${index}`, "database")));
    expect(() => validateSimulation(size, workload)).toThrow(/at most 48 components/);
  });

  it("explains what is wrong with the v2.1 settings in a learner's words", () => {
    const quorum = basic();
    quorum.nodes[2].dbMode = "quorum";
    quorum.nodes[2].replicas = 3;
    quorum.nodes[2].quorumWrite = 4;
    expect(() => validateSimulation(quorum, workload)).toThrow(/write quorum W must be a whole number between 1 and the 3 replicas/);
    quorum.nodes[2].quorumWrite = 2;
    quorum.nodes[2].quorumRead = 0;
    expect(() => validateSimulation(quorum, workload)).toThrow(/read quorum R/);
    quorum.nodes[2].quorumRead = 2;
    expect(() => validateSimulation(quorum, workload)).not.toThrow();

    const pool = basic();
    pool.nodes[1].poolSize = -1;
    expect(() => validateSimulation(pool, workload)).toThrow(/connection pool must hold between 0 \(unlimited\)/);
    pool.nodes[1].poolSize = 4;
    pool.nodes[1].breakerFailureRatio = 0;
    expect(() => validateSimulation(pool, workload)).toThrow(/failure ratio must be above 0%/);
    pool.nodes[1].breakerFailureRatio = 0.5;
    pool.nodes[1].breakerMinCalls = 0;
    expect(() => validateSimulation(pool, workload)).toThrow(/between 1 and 10,000 calls/);

    const queued = graph(
      [node("traffic", "traffic"), node("api", "server"), node("q", "queue"), node("w", "server", { role: "worker" })],
      [["traffic", "api"], ["api", "q"], ["q", "w"]],
    );
    queued.nodes[2].maxDeliveries = 0;
    expect(() => validateSimulation(queued, workload)).toThrow(/between 1 and 10 times before dead-lettering/);
    queued.nodes[2].maxDeliveries = 3;
    queued.nodes[2].visibilityTimeoutMs = -1;
    expect(() => validateSimulation(queued, workload)).toThrow(/visibility timeout/);

    expect(() => validateSimulation(basic(), { ...workload, deadlineMs: 50 })).toThrow(/request deadline must be between 100 and 60,000 ms/);
    expect(() => validateSimulation(basic(), { ...workload, failures: [{ kind: "flapping", at: 0.5, intervalMs: 10 }] })).toThrow(/every 50 to 60,000 ms/);
    expect(() => validateSimulation(basic(), { ...workload, failures: [{ kind: "error-burst", at: 0.5, ratio: 2 }] })).toThrow(/error burst must fail/);
    expect(() => validateSimulation(basic(), { ...workload, failures: [{ kind: "slow-server", at: 0.5, factor: 200 }] })).toThrow(/factor must be between 1 and 100/);
  });
});

// ---------------------------------------------------------------------------------------------
// Engine 2.1: delivery semantics
// ---------------------------------------------------------------------------------------------

describe("queue delivery semantics", () => {
  const jobs = (queue: Partial<SystemNode>, worker: Partial<SystemNode> = {}) =>
    graph(
      [
        node("traffic", "traffic"),
        node("api", "server", { capacity: 2000, latency: 1 }),
        node("queue", "queue", { capacity: 10000, latency: 1, ...queue }),
        node("worker", "server", { role: "worker", capacity: 30, latency: 5, replicas: 2, ...worker }),
        node("db", "database", { capacity: 2000, latency: 2 }),
      ],
      [["traffic", "api"], ["api", "queue"], ["queue", "worker"], ["worker", "db"]],
    );
  const atLeastOnce = { ackMode: "at-least-once" as const, visibilityTimeoutMs: 2000, maxDeliveries: 3 };
  const flow: Workload = { ...workload, requestRate: 40, readRatio: 0, failures: [{ kind: "server", at: 0.5, target: "worker" }] };

  it("loses a job at-most-once and redelivers it at-least-once, counting the reprocessing as a duplicate", () => {
    const lost = runSimulation(jobs({}), flow);
    const redelivered = runSimulation(jobs(atLeastOnce), flow);
    expect(lost.failed).toBeGreaterThan(0);
    expect(lost.duplicates).toBe(0);
    expect(lost.deadLettered).toBe(0);
    expect(redelivered.failed).toBe(0);
    expect(redelivered.duplicates).toBeGreaterThan(0);
    expect(redelivered.duplicateRate).toBeCloseTo(redelivered.duplicates / redelivered.requestCount, 6);
    expect(redelivered.completed + redelivered.failed).toBe(redelivered.requestCount);
    expect(titles(redelivered).some((title) => title.includes("redelivered"))).toBe(true);
  });

  it("does no duplicate work when the worker deduplicates redeliveries by key", () => {
    const duplicating = runSimulation(jobs(atLeastOnce), flow);
    const idempotent = runSimulation(jobs(atLeastOnce, { idempotent: true }), flow);
    expect(duplicating.duplicates).toBeGreaterThan(0);
    expect(idempotent.duplicates).toBe(0);
    expect(idempotent.duplicateRate).toBe(0);
    expect(idempotent.failed).toBe(0);
    // The deduplicated redelivery does no downstream work, so the database sees fewer writes.
    expect(metric(idempotent, "db").processed).toBeLessThan(metric(duplicating, "db").processed);
  });

  it("redelivers every job whose delivery outlives the visibility timeout", () => {
    const patient = runSimulation(jobs({ ...atLeastOnce, visibilityTimeoutMs: 2000 }), { ...workload, requestRate: 40, readRatio: 0 });
    const impatient = runSimulation(jobs({ ...atLeastOnce, visibilityTimeoutMs: 60 }), { ...workload, requestRate: 40, readRatio: 0 });
    expect(patient.duplicates).toBe(0);
    expect(impatient.duplicates).toBeGreaterThan(20);
    expect(impatient.deadLettered).toBe(0);
    expect(impatient.completed).toBe(impatient.requestCount);
    // Every timed-out delivery is processed again, so the worker does more work than there are jobs.
    expect(metric(impatient, "worker").processed).toBeGreaterThan(impatient.requestCount);
    expect(metric(impatient, "worker").processed).toBeGreaterThan(metric(patient, "worker").processed);
  });

  it("dead-letters a message once it has been delivered maxDeliveries times", () => {
    const overloaded = jobs({ ackMode: "at-least-once", visibilityTimeoutMs: 300, maxDeliveries: 2 }, { capacity: 4 });
    const result = runSimulation(overloaded, { ...workload, requestRate: 40, readRatio: 0 });
    expect(result.deadLettered).toBeGreaterThan(0);
    expect(result.deadLetterRate).toBeCloseTo(result.deadLettered / result.requestCount, 6);
    expect(result.failed).toBeGreaterThanOrEqual(result.deadLettered);
    expect(result.rejected).toBe(0);
    expect(result.completed + result.failed).toBe(result.requestCount);
    expect(result.events.some((event) => event.title.includes("dead-lettered a message"))).toBe(true);
    const patient = runSimulation(jobs({ ackMode: "at-least-once", visibilityTimeoutMs: 300, maxDeliveries: 10 }, { capacity: 4 }), { ...workload, requestRate: 40, readRatio: 0 });
    expect(patient.deadLettered).toBeLessThan(result.deadLettered);
  });
});

// ---------------------------------------------------------------------------------------------
// Engine 2.1: quorum databases and lost writes
// ---------------------------------------------------------------------------------------------

describe("quorum databases", () => {
  const quorum = (over: Partial<SystemNode>) =>
    graph(
      [node("traffic", "traffic"), node("api", "server", { capacity: 2000, latency: 1 }), node("db", "database", { capacity: 300, latency: 5, replicas: 3, dbMode: "quorum", ...over })],
      [["traffic", "api"], ["api", "db"]],
    );
  const mixed: Workload = { ...workload, requestRate: 200, readRatio: 0.5 };
  const oneDies: Workload = { ...mixed, failures: [{ kind: "database", at: 0.5, target: "db" }] };

  it("survives one replica death at W=2 and R=2 over N=3, and loses writes at W=3", () => {
    const majority = runSimulation(quorum({ quorumWrite: 2, quorumRead: 2 }), oneDies);
    const everyone = runSimulation(quorum({ quorumWrite: 3, quorumRead: 1 }), oneDies);
    expect(metric(majority, "db").healthyReplicas).toBe(2);
    expect(majority.errorRate).toBeLessThan(0.01);
    expect(majority.successRate).toBeGreaterThan(0.99);
    expect(everyone.errorRate).toBeGreaterThan(0.15);
    expect(titles(everyone).some((title) => title.includes("could not assemble a quorum"))).toBe(true);
    expect(titles(majority).some((title) => title.includes("could not assemble a quorum"))).toBe(false);
    // A quorum operation occupies W lanes, so it costs more lane time than a single-replica write.
    const single = runSimulation(quorum({ quorumWrite: 1, quorumRead: 1 }), mixed);
    expect(metric(runSimulation(quorum({ quorumWrite: 2, quorumRead: 2 }), mixed), "db").utilization).toBeGreaterThan(metric(single, "db").utilization);
  });

  it("never reads stale data when R + W > N, and does when R + W <= N", () => {
    const lagging: Workload = { ...workload, requestRate: 200, readRatio: 0.8, keySpace: 50 };
    const consistent = runSimulation(quorum({ quorumWrite: 2, quorumRead: 2, replicationLagMs: 300 }), lagging);
    const fast = runSimulation(quorum({ quorumWrite: 1, quorumRead: 1, replicationLagMs: 300 }), lagging);
    expect(consistent.staleReads).toBe(0);
    expect(consistent.staleReadRate).toBe(0);
    expect(fast.staleReads).toBeGreaterThan(0);
    expect(fast.staleReadRate).toBeGreaterThan(0.05);
    expect(fast.p95).toBeLessThan(consistent.p95);
  });

  it("counts the writes a dying leader acknowledged inside the replication lag as lost", () => {
    const leader = (over: Partial<SystemNode> = {}) =>
      graph(
        [node("traffic", "traffic"), node("api", "server", { capacity: 2000, latency: 1 }), node("db", "database", { capacity: 400, latency: 5, replicas: 3, dbMode: "leader-follower", replicationLagMs: 300, ...over })],
        [["traffic", "api"], ["api", "db"]],
      );
    const failure: Workload = { ...workload, requestRate: 200, readRatio: 0.5, failures: [{ kind: "database", at: 0.5, target: "db" }] };
    const lossy = runSimulation(leader(), failure);
    const tight = runSimulation(leader({ replicationLagMs: 0 }), failure);
    expect(lossy.lostWrites).toBeGreaterThan(0);
    expect(tight.lostWrites).toBe(0);
    expect(runSimulation(leader(), { ...workload, requestRate: 200, readRatio: 0.5 }).lostWrites).toBe(0);
    // The clients were told the write succeeded: those requests stay successful.
    expect(lossy.completed + lossy.failed).toBe(lossy.requestCount);
    expect(lossy.completed).toBeGreaterThan(lossy.requestCount * 0.8);
    expect(lossy.events.some((event) => event.title.includes("acknowledged write"))).toBe(true);
    expect(titles(lossy).some((title) => title.includes("lost on failover"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Engine 2.1: gray failures
// ---------------------------------------------------------------------------------------------

describe("gray failures", () => {
  const stack = (over: Partial<SystemNode> = {}) =>
    graph(
      [node("traffic", "traffic"), node("lb", "load-balancer", { capacity: 10000, latency: 1, ...over }), node("api", "server", { capacity: 200, latency: 5, replicas: 2 }), node("db", "database", { capacity: 2000, latency: 2 })],
      [["traffic", "lb"], ["lb", "api"], ["api", "db"]],
    );
  const base: Workload = { ...workload, requestRate: 200 };

  it("fails requests in bursts while a replica flaps between dead and alive", () => {
    const flapping = runSimulation(stack({ healthCheckMs: 1000 }), { ...base, failures: [{ kind: "flapping", at: 0.3, duration: 4, intervalMs: 400, target: "api" }] });
    expect(flapping.errorRate).toBeGreaterThan(0.01);
    const failingSeconds = flapping.samples.filter((sample) => sample.errorRate > 0);
    expect(failingSeconds.length).toBeGreaterThanOrEqual(3);
    // The failures are confined to the flapping window, not spread over the run.
    expect(flapping.samples.slice(0, 3).every((sample) => sample.errorRate === 0)).toBe(true);
    expect(flapping.samples.slice(8).every((sample) => sample.errorRate === 0)).toBe(true);
    expect(metric(flapping, "api").healthyReplicas).toBe(2);
    expect(titles(flapping).some((title) => title.includes("flapped between dead and alive"))).toBe(true);
    expect(flapping.events.some((event) => event.title.includes("started flapping"))).toBe(true);
  });

  it("raises the error rate during an error burst without changing a single health check", () => {
    const healthy = runSimulation(stack(), base);
    const burst = runSimulation(stack(), { ...base, failures: [{ kind: "error-burst", at: 0.3, duration: 4, ratio: 0.5, target: "api" }] });
    expect(healthy.errorRate).toBe(0);
    expect(burst.errorRate).toBeGreaterThan(0.05);
    expect(burst.rejected).toBe(0);
    expect(metric(burst, "api").healthyReplicas).toBe(metric(healthy, "api").healthyReplicas);
    expect(metric(burst, "api").healthyReplicas).toBe(2);
    expect(metric(burst, "lb").errors).toBe(0);
    expect(titles(burst).some((title) => title.includes("still reporting healthy"))).toBe(true);
  });

  it("multiplies a server's service time for a slow-server event, as it does for a database", () => {
    const healthy = runSimulation(stack(), base);
    const slow = runSimulation(stack(), { ...base, failures: [{ kind: "slow-server", at: 0.3, duration: 4, factor: 8, target: "api" }] });
    expect(slow.p95).toBeGreaterThan(healthy.p95 * 5);
    expect(slow.events.some((event) => event.title.includes("slowed down 8x"))).toBe(true);
    expect(slow.events.some((event) => event.title.includes("recovered its normal speed"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Engine 2.1: connection pools, breaker tunables, deadline and usage cost
// ---------------------------------------------------------------------------------------------

describe("connection pools", () => {
  const pooled = (poolSize: number, maxQueue = 0) =>
    graph(
      [node("traffic", "traffic"), node("api", "server", { capacity: 5000, latency: 1, poolSize, maxQueue }), node("db", "database", { capacity: 20, latency: 100, replicas: 8 })],
      [["traffic", "api"], ["api", "db"]],
    );
  const load: Workload = { ...workload, requestRate: 60 };

  it("starves an idle server when a slow dependency holds every connection", () => {
    const unbounded = runSimulation(pooled(0), load);
    const starved = runSimulation(pooled(4), load);
    const bounded = runSimulation(pooled(4, 8), load);
    expect(unbounded.poolRejections).toBe(0);
    expect(unbounded.failed).toBe(0);
    expect(starved.p95).toBeGreaterThan(unbounded.p95 * 5);
    // The lane is idle the whole time: the wait is for a connection, not for CPU.
    expect(metric(starved, "api").utilization).toBeLessThan(0.1);
    expect(metric(bounded, "api").utilization).toBeLessThan(0.1);
    expect(bounded.poolRejections).toBeGreaterThan(0);
    expect(bounded.rejected).toBe(bounded.poolRejections);
    expect(bounded.p95).toBeLessThan(starved.p95);
    expect(titles(starved).some((title) => title.includes("connection pool slot"))).toBe(true);
    expect(insight(bounded, "connection pool slot")!.detail).toContain("pool-exhausted");
  });
});

describe("tunable breakers and deadlines", () => {
  const fragile = (over: Partial<SystemNode>) =>
    graph(
      [node("traffic", "traffic"), node("api", "server", { capacity: 2000, latency: 1, circuitBreaker: true, timeoutMs: 200, ...over }), node("db", "database", { capacity: 400, latency: 5 })],
      [["traffic", "api"], ["api", "db"]],
    );
  const dying: Workload = { ...workload, requestRate: 200, failures: [{ kind: "database", at: 0.3, target: "db" }] };
  const opens = (result: SimulationResult) => result.events.filter((event) => event.title.includes("opened its circuit breaker")).length;

  it("opens the breaker sooner with a tighter window, minimum and ratio", () => {
    const standard = runSimulation(fragile({}), dying);
    const sensitive = runSimulation(fragile({ breakerWindowMs: 500, breakerMinCalls: 3, breakerFailureRatio: 0.2, breakerOpenMs: 1000 }), dying);
    const stubborn = runSimulation(fragile({ breakerMinCalls: 500, breakerFailureRatio: 0.99 }), dying);
    expect(opens(standard)).toBeGreaterThan(0);
    expect(opens(sensitive)).toBeGreaterThan(opens(standard));
    expect(sensitive.errorRate).toBeLessThan(standard.errorRate);
    expect(opens(stubborn)).toBe(0);
    expect(stubborn.rejected).toBe(0);
    expect(stubborn.errorRate).toBeGreaterThan(0.5);
    expect(insight(sensitive, "Circuit breakers opened")!.detail).toContain("window");
  });

  it("times requests out at the workload deadline instead of the five-second default", () => {
    expect(REQUEST_DEADLINE_MS).toBe(5000);
    const slow = graph([node("traffic", "traffic"), node("api", "server", { capacity: 2000, latency: 800 })], [["traffic", "api"]]);
    const patient = runSimulation(slow, { ...workload, requestRate: 50, duration: 5 });
    const impatient = runSimulation(slow, { ...workload, requestRate: 50, duration: 5, deadlineMs: 400 });
    expect(patient.failed).toBe(0);
    expect(impatient.completed).toBe(0);
    expect(impatient.failed).toBe(impatient.requestCount);
    expect(titles(impatient).some((title) => title.includes("400 ms deadline"))).toBe(true);
    expect(patient.assumptions.some((line) => line.includes("5,000 ms end-to-end deadline"))).toBe(true);
    expect(impatient.assumptions.some((line) => line.includes("400 ms end-to-end deadline"))).toBe(true);
  });
});

describe("usage cost", () => {
  const shape = () =>
    graph(
      [node("traffic", "traffic"), node("api", "server", { capacity: 3000, latency: 1 }), node("db", "database", { capacity: 3000, latency: 2 })],
      [["traffic", "api"], ["api", "db"]],
    );

  it("bills provisioned capacity plus the operations the run actually performed", () => {
    const light = runSimulation(shape(), { ...workload, requestRate: 100, readRatio: 0.5 });
    const heavy = runSimulation(shape(), { ...workload, requestRate: 400, readRatio: 0.5 });
    expect(light.provisionedCost).toBe(heavy.provisionedCost);
    expect(light.usageCost).toBeGreaterThan(0);
    expect(heavy.usageCost).toBeGreaterThan(light.usageCost * 3.5);
    expect(heavy.usageCost).toBeLessThan(light.usageCost * 4.5);
    expect(light.cost).toBeCloseTo(light.provisionedCost + light.usageCost, 2);
    expect(heavy.cost).toBeCloseTo(heavy.provisionedCost + heavy.usageCost, 2);
    expect(light.cost).toBeLessThan(heavy.cost);
    expect(light.costBreakdown.every((row) => row.usage !== undefined)).toBe(true);
    expect(light.costBreakdown.reduce((sum, row) => sum + row.usage!, 0)).toBeCloseTo(light.usageCost, 2);
  });

  it("charges twice as much for a write as for a read and nothing for idle capacity", () => {
    const reads = runSimulation(shape(), { ...workload, requestRate: 200, readRatio: 1 });
    const writes = runSimulation(shape(), { ...workload, requestRate: 200, readRatio: 0 });
    const dbUsage = (result: SimulationResult) => result.costBreakdown.find((row) => row.nodeId === "db")!.usage!;
    expect(dbUsage(writes)).toBeCloseTo(dbUsage(reads) * 2, 2);
    const idle = runSimulation(shape(), { ...workload, requestRate: 1, duration: 1 });
    expect(idle.usageCost).toBeLessThan(idle.provisionedCost * 0.05);
    expect(idle.cost).toBeGreaterThan(idle.provisionedCost);
  });
});

// ---------------------------------------------------------------------------------------------
// v2.3 - object stores: transfer time, egress and storage
// ---------------------------------------------------------------------------------------------

/** A store with enough lanes that the payload, not a queue behind one lane, is what costs time. */
const objectStack = (store: Partial<SystemNode> = {}) =>
  graph(
    [
      node("traffic", "traffic"),
      node("api", "server", { capacity: 4000, latency: 1 }),
      node("store", "object-store", { capacity: 3000, latency: 5, replicas: 4, storedGb: 200, ...store }),
    ],
    [["traffic", "api"], ["api", "store"]],
  );
const objectWorkload: Workload = { ...workload, requestRate: 20, duration: 10, readRatio: 1 };
/** Traffic that is all objects, served mostly from the edge: the shape where bytes outweigh compute. */
const mediaStack = () =>
  graph(
    [
      node("traffic", "traffic"),
      node("edge", "cdn", { capacity: 8000, latency: 2, cacheHitRate: 0.9 }),
      node("api", "server", { capacity: 400, latency: 2 }),
      node("store", "object-store", { capacity: 3000, latency: 5, replicas: 6, storedGb: 500 }),
    ],
    [["traffic", "edge"], ["edge", "api"], ["api", "store"]],
  );
const mediaWorkload: Workload = { ...workload, requestRate: 100, duration: 10, readRatio: 1, objectShare: 1 };

describe("object stores, egress and storage", () => {
  it("charges an object request for moving its bytes and leaves a small request alone", () => {
    const none = runSimulation(objectStack(), { ...objectWorkload, objectShare: 0 });
    const objects = runSimulation(objectStack(), { ...objectWorkload, objectShare: 1, payloadKb: 2048 });
    // 2,048 KB down a 12,500 KB/s lane is 163.8 ms of transfer on top of the store's own service time.
    expect(objects.p50 - none.p50).toBeGreaterThan(155);
    expect(objects.p50 - none.p50).toBeLessThan(175);
    expect(none.p50).toBeLessThan(15);
    // Bytes hold the lane, so the same request rate leaves the store hundreds of times busier.
    expect(metric(none, "store").utilization).toBeLessThan(0.02);
    expect(metric(objects, "store").utilization).toBeGreaterThan(0.6);
    // A megabyte costs half of what two megabytes cost, in time as well as in money.
    const halfSize = runSimulation(objectStack(), { ...objectWorkload, objectShare: 1, payloadKb: 1024 });
    expect(halfSize.p50 - none.p50).toBeGreaterThan((objects.p50 - none.p50) * 0.45);
    expect(halfSize.p50 - none.p50).toBeLessThan((objects.p50 - none.p50) * 0.55);
  });

  it("scales egress with objectShare x payloadKb and prices it per GB served", () => {
    const full = runSimulation(objectStack(), { ...objectWorkload, objectShare: 1, payloadKb: 2048 });
    const half = runSimulation(objectStack(), { ...objectWorkload, objectShare: 0.5, payloadKb: 2048 });
    const small = runSimulation(objectStack(), { ...objectWorkload, objectShare: 1, payloadKb: 1024 });
    const none = runSimulation(objectStack(), { ...objectWorkload, objectShare: 0, payloadKb: 2048 });
    // 20 reads/s x 3,600 x 2,048 KB = 140.6 GB an hour, and every one of them is measured, not assumed.
    expect(full.egressGb).toBeCloseTo((objectWorkload.requestRate * 3600 * 2048) / 1048576, 1);
    expect(half.egressGb / full.egressGb).toBeGreaterThan(0.42);
    expect(half.egressGb / full.egressGb).toBeLessThan(0.58);
    expect(small.egressGb / full.egressGb).toBeGreaterThan(0.47);
    expect(small.egressGb / full.egressGb).toBeLessThan(0.53);
    expect(none.egressGb).toBe(0);
    expect(none.egressCost).toBe(0);
    for (const result of [full, half, small]) expect(result.egressCost).toBeCloseTo(result.egressGb * storageRates.egressGb, 2);
  });

  it("bills storage for every GB kept even when nothing reads it", () => {
    const idle = runSimulation(objectStack({ storedGb: 4000 }), { ...objectWorkload, requestRate: 1, duration: 2, objectShare: 0 });
    expect(idle.egressGb).toBe(0);
    expect(idle.storageCost).toBeCloseTo((4000 * storageRates.storageGbMonth) / HOURS_PER_MONTH, 3);
    expect(idle.storageCost).toBeGreaterThan(0);
    expect(idle.costBreakdown.find((row) => row.nodeId === "store")!.usage).toBeCloseTo(idle.storageCost, 3);
    expect(titles(idle).some((title) => title.includes("Storage for 4,000 GB"))).toBe(true);
  });

  it("lets egress dominate the bill once the payloads are large", () => {
    const media = runSimulation(mediaStack(), { ...mediaWorkload, payloadKb: 4096 });
    const text = runSimulation(mediaStack(), { ...mediaWorkload, payloadKb: 8 });
    expect(media.egressCost / media.cost).toBeGreaterThan(0.5);
    expect(media.egressCost).toBeGreaterThan(media.provisionedCost * 3);
    expect(text.egressCost / text.cost).toBeLessThan(0.1);
    expect(media.egressCost / text.egressCost).toBeCloseTo(4096 / 8, 0);
    // The edge serves most of the bytes, so the origin store never sees most of the egress.
    expect(metric(media, "edge").processed).toBeGreaterThan(metric(media, "store").processed * 5);
    const dominant = insight(media, "Egress is");
    expect(dominant?.severity).toBe("critical");
    expect(insight(text, "Egress is")?.severity).toBe("good");
  });

  it("adds the bill up: provisioned plus measured usage plus storage plus egress", () => {
    const media = runSimulation(mediaStack(), { ...mediaWorkload, payloadKb: 4096 });
    expect(media.cost).toBeCloseTo(media.provisionedCost + media.usageCost, 2);
    const rows = media.costBreakdown;
    const egressRow = rows.find((row) => row.nodeId === "egress")!;
    expect(egressRow.usage).toBeCloseTo(media.egressCost, 3);
    const operations = rows.filter((row) => row.nodeId !== "egress" && row.nodeId !== "store").reduce((sum, row) => sum + row.usage!, 0);
    expect(media.usageCost).toBeCloseTo(operations + media.storageCost + media.egressCost, 2);
    expect(rows.reduce((sum, row) => sum + row.cost + row.usage!, 0)).toBeCloseTo(media.cost, 2);
    expect(media.storageCost).toBeCloseTo((500 * storageRates.storageGbMonth) / HOURS_PER_MONTH, 3);
    expect(media.egressCost).toBeCloseTo(media.egressGb * storageRates.egressGb, 2);
  });
});

// ---------------------------------------------------------------------------------------------
// v2.3 - partitioned streams
// ---------------------------------------------------------------------------------------------

const streamStack = (stream: Partial<SystemNode> = {}, worker: Partial<SystemNode> = {}) =>
  graph(
    [
      node("traffic", "traffic"),
      node("api", "server", { capacity: 4000, latency: 1 }),
      node("log", "stream", { capacity: 20000, latency: 1, partitions: 4, consumerGroups: 1, ...stream }),
      node("w", "server", { role: "worker", capacity: 400, latency: 1, replicas: 4, ...worker }),
    ],
    [["traffic", "api"], ["api", "log"], ["log", "w"]],
  );
/** Runs with the delivery probe armed and always disarms it, so one failure cannot leak into the next test. */
function withStreamProbe(architecture: Architecture, plan: Workload) {
  streamProbe.records = [];
  try {
    const result = runSimulation(architecture, plan);
    return { result, records: streamProbe.records! };
  } finally {
    streamProbe.records = null;
  }
}

describe("partitioned streams", () => {
  it("keeps each partition in order on a single replica per consumer group", () => {
    const { result, records } = withStreamProbe(streamStack({ partitions: 4, consumerGroups: 2 }, { replicas: 2 }), {
      ...workload,
      requestRate: 60,
      keySpace: 200,
    });
    expect(result.failed).toBe(0);
    expect(records.length).toBe(result.completed * 2);
    const lanes = new Map<string, Set<number>>();
    const order = new Map<string, number[]>();
    for (const record of records) {
      const key = `${record.group}:${record.partition}`;
      if (!lanes.has(key)) lanes.set(key, new Set());
      if (!order.has(key)) order.set(key, []);
      lanes.get(key)!.add(record.replica);
      order.get(key)!.push(record.requestId);
    }
    expect(lanes.size).toBe(8);
    for (const [key, ids] of order) {
      // A partition is a FIFO lane: its messages leave in the order they arrived, one at a time.
      expect(ids, `${key} is out of order`).toEqual([...ids].sort((a, b) => a - b));
      expect(ids.length).toBeGreaterThan(20);
      expect(lanes.get(key)!.size, `${key} was consumed by more than one replica`).toBe(1);
    }
    // Both replicas do work, and a group's partitions are spread across them.
    expect(new Set(records.map((record) => record.replica)).size).toBe(2);
  });

  it("multiplies consumer work by the number of consumer groups", () => {
    const plan: Workload = { ...workload, requestRate: 60 };
    const one = runSimulation(streamStack({ consumerGroups: 1 }, { capacity: 600, replicas: 2 }), plan);
    const three = runSimulation(streamStack({ consumerGroups: 3 }, { capacity: 600, replicas: 2 }), plan);
    expect(one.failed + three.failed).toBe(0);
    expect(metric(three, "w").processed).toBe(metric(one, "w").processed * 3);
    expect(metric(three, "log").processed).toBe(metric(one, "log").processed);
    // Three readers of the same log is three times the delivery bill, not three times the messages.
    const usage = (result: SimulationResult) => result.costBreakdown.find((row) => row.nodeId === "log")!.usage!;
    expect(usage(three)).toBeCloseTo(usage(one) * 3, 3);
    expect(titles(three).some((title) => title.includes("fans every message out to 3 consumer groups"))).toBe(true);
    expect(titles(one).some((title) => title.includes("consumer groups"))).toBe(false);
  });

  it("backs up only the partition whose consumer slowed down", () => {
    const plan: Workload = { ...workload, requestRate: 100 };
    const healthy = runSimulation(streamStack(), plan);
    const { result, records } = withStreamProbe(streamStack(), {
      ...plan,
      failures: [{ kind: "slow-partition", at: 0.3, duration: 4, factor: 20 }],
    });
    const waits = new Map<number, number[]>();
    for (const record of records) {
      if (!waits.has(record.partition)) waits.set(record.partition, []);
      waits.get(record.partition)!.push(record.waitMs);
    }
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(waits.size).toBe(4);
    expect(mean(waits.get(0)!)).toBeGreaterThan(100);
    for (const partition of [1, 2, 3]) {
      expect(mean(waits.get(partition)!), `partition ${partition} backed up too`).toBeLessThan(5);
      expect(waits.get(partition)!.length).toBeGreaterThan(100);
    }
    // The backlog is real - the run's tail blows out - but it is one lane's backlog, not the system's.
    expect(result.p95).toBeGreaterThan(healthy.p95 * 10);
    expect(result.failed).toBe(0);
    expect(insight(result, "partition 0 waits")?.severity).toBe("critical");
  });

  it("replays a parked partition when the consumer returns, duplicating work unless it is idempotent", () => {
    const plan = (failures: Workload["failures"]): Workload => ({ ...workload, requestRate: 100, failures });
    const stack = (idempotent: boolean) => streamStack({ partitions: 4 }, { capacity: 200, replicas: 2, idempotent });
    const oneDeath: Workload["failures"] = [{ kind: "server", at: 0.3, duration: 3, target: "w" }];
    const flapping: Workload["failures"] = [{ kind: "flapping", at: 0.2, duration: 5, target: "w", intervalMs: 600 }];
    const replayed = runSimulation(stack(false), plan(oneDeath));
    const deduped = runSimulation(stack(true), plan(oneDeath));
    const flapped = runSimulation(stack(false), plan(flapping));
    expect(replayed.duplicates).toBeGreaterThanOrEqual(1);
    expect(replayed.duplicateRate).toBeGreaterThan(0);
    // Every death replays the message the dead replica had started, so more deaths mean more duplicates.
    expect(flapped.duplicates).toBeGreaterThan(replayed.duplicates);
    // An idempotent consumer still receives the replay; it just refuses to do the work twice.
    expect(deduped.duplicates).toBe(0);
    expect(deduped.completed).toBe(replayed.completed);
    // The log never drops the parked messages: nothing is lost while the consumer is away.
    expect(replayed.completed).toBe(replayed.requestCount);
    expect(replayed.events.some((event) => event.title.includes("replayed partition"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// v2.3 - leader election under a network partition
// ---------------------------------------------------------------------------------------------

const electionStack = (election: "heartbeat" | "consensus") =>
  graph(
    [
      node("traffic", "traffic"),
      node("api", "server", { capacity: 4000, latency: 1 }),
      node("db", "database", { capacity: 4000, latency: 2, dbMode: "leader-follower", replicas: 3, election, electionMs: 1000 }),
    ],
    [["traffic", "api"], ["api", "db"]],
  );
const splitWorkload: Workload = { ...workload, requestRate: 200, readRatio: 0.5, failures: [{ kind: "partition", at: 0.3, duration: 4 }] };

describe("leader election under a network partition", () => {
  it("elects two leaders with heartbeats and throws the minority's writes away when the split heals", () => {
    const result = runSimulation(electionStack("heartbeat"), splitWorkload);
    const quiet = runSimulation(electionStack("heartbeat"), { ...splitWorkload, failures: [] });
    expect(quiet.conflictingWrites).toBe(0);
    expect(result.conflictingWrites).toBeGreaterThan(50);
    // The isolated side keeps answering, so most of its clients never see an error...
    expect(result.errorRate).toBeLessThan(0.05);
    // ...and every write it acknowledged is discarded on the merge, which is what makes it dangerous.
    expect(result.lostWrites).toBeGreaterThanOrEqual(result.conflictingWrites);
    expect(insight(result, "accepted by a second leader")?.severity).toBe("critical");
    expect(result.events.some((event) => event.title.includes("discarded"))).toBe(true);
  });

  it("keeps one leader with consensus by failing the writes it cannot commit", () => {
    const heartbeat = runSimulation(electionStack("heartbeat"), splitWorkload);
    const consensus = runSimulation(electionStack("consensus"), splitWorkload);
    expect(consensus.conflictingWrites).toBe(0);
    expect(consensus.lostWrites).toBe(0);
    // The same writes exist in both runs: consensus turns them into errors instead of into lost data.
    expect(consensus.failed - heartbeat.failed).toBeGreaterThan(heartbeat.conflictingWrites * 0.7);
    expect(consensus.errorRate).toBeGreaterThan(heartbeat.errorRate * 2);
    expect(insight(consensus, "refused")?.severity).toBe("good");
    expect(insight(consensus, "accepted by a second leader")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// v2.3 - validation of the new kinds
// ---------------------------------------------------------------------------------------------

describe("v2.3 validation", () => {
  it("lets a server call an object store and ends the route there", () => {
    expect(() => runSimulation(objectStack(), { ...objectWorkload, objectShare: 1 })).not.toThrow();
    const onwards = objectStack();
    onwards.nodes.push(node("db", "database"));
    onwards.edges.push({ id: "x", source: "store", target: "db" });
    expect(() => runSimulation(onwards, objectWorkload)).toThrow(/object stores are the end/);
  });

  it("requires a stream to feed exactly one worker", () => {
    expect(() => runSimulation(streamStack(), workload)).not.toThrow();
    const application = streamStack({}, { role: "application" });
    expect(() => runSimulation(application, workload)).toThrow(/Worker role/);
    const twoWorkers = streamStack();
    twoWorkers.nodes.push(node("w2", "server", { role: "worker" }));
    twoWorkers.edges.push({ id: "x", source: "log", target: "w2" });
    expect(() => runSimulation(twoWorkers, workload)).toThrow(/one server with the Worker role/);
  });

  it("bounds the new fields with a message that says what the field is for", () => {
    expect(() => runSimulation(streamStack({ partitions: 0 }), workload)).toThrow(/between 1 and 64 partitions/);
    expect(() => runSimulation(streamStack({ consumerGroups: 99 }), workload)).toThrow(/consumer groups/);
    expect(() => runSimulation(streamStack({ retentionSeconds: -1 }), workload)).toThrow(/retention/);
    expect(() => runSimulation(objectStack({ storedGb: -5 }), objectWorkload)).toThrow(/GB\. You pay for every GB kept/);
    expect(() => runSimulation(electionStack("heartbeat"), { ...splitWorkload, failures: [] })).not.toThrow();
    expect(() => runSimulation(objectStack(), { ...objectWorkload, objectShare: 1.5 })).toThrow(/between 0 and 100%/);
    expect(() => runSimulation(objectStack(), { ...objectWorkload, payloadKb: 0 })).toThrow(/payload must be between/);
    const noLeader = basic();
    expect(() => runSimulation(noLeader, { ...workload, failures: [{ kind: "partition", at: 0.5, duration: 2 }] })).toThrow(/leader-follower/);
    expect(() => runSimulation(noLeader, { ...workload, failures: [{ kind: "slow-partition", at: 0.5, duration: 2 }] })).toThrow(/needs an enabled stream/);
  });

  it("tells the learner what the engine assumed about bytes, partitions and elections", () => {
    const media = runSimulation(mediaStack(), { ...mediaWorkload, payloadKb: 4096 });
    const text = media.assumptions.join(" ");
    expect(text).toContain("12,500");
    expect(text).toContain("egress");
    expect(text).toContain("partitioned log");
    expect(text).toContain("conflictingWrites");
    expect(text).toContain("usageCost includes storage and egress");
    expect(text).not.toContain("ignores data size");
  });
});

// ---------------------------------------------------------------------------------------------
// Curriculum smoke test
// ---------------------------------------------------------------------------------------------

describe("curriculum smoke test", () => {
  it("simulates every lesson's starter and reference architecture", () => {
    expect(lessons.length).toBeGreaterThan(0);
    for (const lesson of lessons) {
      for (const [name, architecture] of [["architecture", lesson.architecture], ["reference", lesson.reference]] as const) {
        if (!architecture?.nodes?.length) continue;
        // Blank-canvas briefs start with a traffic source only; that starter is deliberately not runnable.
        if (name === "architecture" && lesson.blankCanvas) continue;
        const result = runSimulation(architecture, lesson.workload);
        expect(result.requestCount, `${lesson.id} ${name} produced no requests`).toBeGreaterThan(0);
        expect(result.completed + result.failed, `${lesson.id} ${name} lost requests`).toBe(result.requestCount);
        expect(result.engineVersion).toBe(ENGINE_VERSION);
        expect(result.insights.length, `${lesson.id} ${name} produced no insights`).toBeGreaterThan(0);
      }
    }
  }, 120_000);
});
