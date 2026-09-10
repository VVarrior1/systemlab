import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCloudSnapshot, deleteDesign, getPersistenceWarning, mergeProgress, readAttempts, readCloudSnapshot, readDesigns, readDraft, readGym, readProgress, recordAttempt, saveDesign, saveDraft, saveGym, saveProgress, validateArchitecture, validateDesign, validateProgress, validateWorkload } from "./persistence";
import { ASSESSMENT_VERSION, isCurrentProgress } from "./assessment-version";
import { mergeCloudSnapshots, parseCloudSnapshot } from "./supabase";
import type { ProgressRecord, SavedDesign, SystemNode, Workload } from "./types";

let storage: Map<string, string>;
let setItem: ReturnType<typeof vi.fn>;

function design(id = "design-1"): SavedDesign {
  return {
    id, name: "A small service", lessonId: "first-request", updatedAt: "2026-09-07T12:00:00.000Z",
    architecture: {
      nodes: [
        { id: "traffic", kind: "traffic", label: "Traffic", position: { x: 0, y: 0 }, capacity: 1_000, latency: 0, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0 },
        { id: "app", kind: "server", label: "Application", position: { x: 200, y: 0 }, capacity: 100, latency: 25, replicas: 1, cacheHitRate: 0, enabled: true, cost: 2 },
      ], edges: [{ id: "traffic-app", source: "traffic", target: "app" }],
    },
    workload: { requestRate: 50, readRatio: 0.8, duration: 30, seed: 42, pattern: "steady", failure: "none" },
  };
}

beforeEach(() => {
  storage = new Map();
  setItem = vi.fn((key: string, value: string) => { storage.set(key, value); });
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem }, dispatchEvent: vi.fn() });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("saved designs", () => {
  it("round-trips versioned saves and updates an existing design instead of duplicating it", () => {
    expect(saveDesign(design())).toEqual({ ok: true });
    expect(saveDesign({ ...design(), name: "Revised service" })).toEqual({ ok: true });
    expect(readDesigns()).toEqual([{ ...design(), name: "Revised service" }]);
    expect(JSON.parse(storage.get("system-design-playground:v1:designs")!).version).toBe(1);
  });

  it("rejects unsafe numeric values, dangling edges, duplicate nodes, and unknown component types", () => {
    const invalidNumber = design();
    invalidNumber.architecture.nodes[1].capacity = Infinity;
    expect(() => validateDesign(invalidNumber)).toThrow("capacity");
    const dangling = design();
    dangling.architecture.edges[0].target = "missing";
    expect(() => validateDesign(dangling)).toThrow("connection");
    const duplicate = design();
    duplicate.architecture.nodes.push(duplicate.architecture.nodes[0]);
    expect(() => validateDesign(duplicate)).toThrow("unique");
    expect(() => validateDesign({ ...design(), architecture: { nodes: [{ ...design().architecture.nodes[0], kind: "script" }], edges: [] } })).toThrow("component type");
  });

  it("strips unexpected imported properties instead of carrying them into application state", () => {
    const input = { ...design(), token: "unexpected", workload: { ...design().workload, arbitrary: "value" } };
    expect(validateDesign(input)).toEqual(design());
  });

  it("rejects zero capacity and designs without a single built-in traffic source", () => {
    const zeroCapacity = design();
    zeroCapacity.architecture.nodes[1].capacity = 0;
    expect(() => validateDesign(zeroCapacity)).toThrow("capacity");
    expect(() => validateDesign({ ...design(), architecture: { nodes: [], edges: [] } })).toThrow("traffic source");
    const noTraffic = design();
    noTraffic.architecture = { nodes: [noTraffic.architecture.nodes[1]], edges: [] };
    expect(() => validateDesign(noTraffic)).toThrow("traffic source");
    const duplicatedTraffic = design();
    duplicatedTraffic.architecture.nodes.push({ ...duplicatedTraffic.architecture.nodes[0], id: "traffic-2" });
    expect(() => validateDesign(duplicatedTraffic)).toThrow("traffic source");
  });

  it("recovers valid entries from a partly damaged save without crashing", () => {
    storage.set("system-design-playground:v1:designs", JSON.stringify({ version: 1, data: { designs: [null, design(), { id: "broken" }], deleted: [] } }));
    expect(readDesigns()).toEqual([design()]);
    expect(getPersistenceWarning()).toBeTruthy();
  });

  it("reports corrupted or incompatible storage", () => {
    storage.set("system-design-playground:v1:designs", "{broken");
    expect(readDesigns()).toEqual([]);
    storage.set("system-design-playground:v1:designs", JSON.stringify({ version: 200, data: {} }));
    expect(readDesigns()).toEqual([]);
    expect(getPersistenceWarning()).toBeTruthy();
  });

  it("keeps the previous save intact when browser quota is exhausted", () => {
    saveDesign(design());
    setItem.mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    const result = saveDesign({ ...design(), name: "Unsaved edit" });
    expect(result.ok).toBe(false);
    expect(readDesigns()[0].name).toBe("A small service");
    expect(getPersistenceWarning()).toMatch(/could not save/);
  });

  it("retains a deletion marker for cloud sync and removes it when the design is restored", () => {
    saveDesign(design());
    expect(deleteDesign("design-1")).toEqual({ ok: true });
    expect(readDesigns()).toEqual([]);
    expect(readCloudSnapshot().deleted[0].id).toBe("design-1");
    saveDesign({ ...design(), updatedAt: new Date().toISOString() });
    expect(readCloudSnapshot().deleted).toEqual([]);
  });

  it("enforces the saved design limit without dropping previous work", () => {
    for (let i = 0; i < 100; i++) expect(saveDesign(design(`design-${i}`)).ok).toBe(true);
    expect(saveDesign(design("one-too-many")).ok).toBe(false);
    expect(readDesigns()).toHaveLength(100);
    expect(saveDesign({ ...design("design-0"), name: "Still editable" }).ok).toBe(true);
  });
});

describe("lesson progress and drafts", () => {
  it("preserves first completion and the cost belonging to the best latency result", () => {
    const initial = { lessonId: "first-request", completedAt: "2026-09-01T12:00:00Z", bestP95: 80, cost: 2 };
    saveProgress(initial);
    saveProgress({ ...initial, completedAt: "2026-09-02T12:00:00Z", bestP95: 60, cost: 5 });
    saveProgress({ ...initial, completedAt: "2026-09-03T12:00:00Z", bestP95: 90, cost: 1 });
    expect(readProgress()).toEqual([{ ...initial, completedAt: "2026-09-01T12:00:00.000Z", bestP95: 60, cost: 5 }]);
  });

  it("keeps lesson and sandbox drafts separate", () => {
    const sample = design();
    saveDraft("first-request", sample.architecture, sample.workload);
    saveDraft("sandbox", sample.architecture, { ...sample.workload, requestRate: 250 });
    expect(readDraft("first-request")?.workload.requestRate).toBe(50);
    expect(readDraft("sandbox")?.workload.requestRate).toBe(250);
    expect(readDraft("unstarted-lesson")).toBeNull();
  });

  it("supports draft keys scoped to the longest accepted saved design ID", () => {
    const sample = design("a".repeat(128));
    const key = `design:${sample.id}`;
    expect(saveDraft(key, sample.architecture, sample.workload)).toEqual({ ok: true });
    expect(readDraft(key)?.architecture).toEqual(sample.architecture);
    expect(readDraft("sandbox")).toBeNull();
  });

  it("recovers gracefully from invalid draft data", () => {
    storage.set("system-design-playground:v1:draft:sandbox", JSON.stringify({ version: 1, data: { architecture: {}, workload: {} } }));
    expect(readDraft("sandbox")).toBeNull();
    expect(getPersistenceWarning()).toMatch(/draft/);
  });

  it("can render without a browser and reports that writes are unavailable", () => {
    vi.stubGlobal("window", undefined);
    expect(readDesigns()).toEqual([]);
    expect(readProgress()).toEqual([]);
    expect(saveDesign(design())).toEqual({ ok: false, error: "Browser storage is unavailable." });
  });
});

describe("assessment versions", () => {
  const legacy: ProgressRecord = { lessonId: "first-request", completedAt: "2026-09-01T12:00:00.000Z", bestP95: 10, cost: 1 };
  const current: ProgressRecord = { lessonId: "first-request", completedAt: "2026-09-09T12:00:00.000Z", bestP95: 100, cost: 8, assessmentVersion: ASSESSMENT_VERSION };

  it("preserves historical completions but counts only the current assessment", () => {
    saveProgress(legacy);
    expect(readProgress()).toEqual([legacy]);
    expect(isCurrentProgress(readProgress()[0])).toBe(false);
    expect(isCurrentProgress({ ...legacy, assessmentVersion: 1 })).toBe(false);
    expect(isCurrentProgress(current)).toBe(true);
    expect(isCurrentProgress({ ...current, assessmentVersion: ASSESSMENT_VERSION + 1 })).toBe(false);
  });

  it("round-trips the explicit assessment version through browser storage", () => {
    expect(saveProgress(current)).toEqual({ ok: true });
    expect(readProgress()).toEqual([current]);
    expect(readCloudSnapshot().progress).toEqual([current]);
  });

  it("replaces earlier assessment results entirely without comparing their easier metrics", () => {
    expect(mergeProgress(legacy, current)).toEqual(current);
    expect(mergeProgress(current, legacy)).toEqual(current);
    saveProgress(legacy);
    saveProgress(current);
    expect(readProgress()).toEqual([current]);
    saveProgress({ ...legacy, completedAt: "2026-09-10T12:00:00.000Z" });
    expect(readProgress()).toEqual([current]);
  });

  it("still selects the best result and first completion within the same assessment", () => {
    const improvement = { ...current, completedAt: "2026-09-10T12:00:00.000Z", bestP95: 80, cost: 12 };
    expect(mergeProgress(current, improvement)).toEqual({ ...improvement, completedAt: current.completedAt });
    const cheaperTie = { ...improvement, cost: 9 };
    expect(mergeProgress(improvement, cheaperTie)).toEqual(cheaperTie);
  });

  it.each([0, -1, 1.5, "2", null, Infinity, 2_147_483_648])("rejects an invalid imported assessment version: %s", (assessmentVersion) => {
    expect(() => validateProgress({ ...legacy, assessmentVersion })).toThrow("assessment version");
  });

  it("accepts legacy cloud responses without silently promoting their assessment version", () => {
    const snapshot = parseCloudSnapshot({ designs: [], deleted: [], progress: [legacy] });
    expect(snapshot.progress).toEqual([legacy]);
    expect(applyCloudSnapshot(snapshot)).toEqual({ ok: true });
    expect(readProgress()).toEqual([legacy]);
    expect(readProgress().filter(isCurrentProgress)).toEqual([]);
  });

  it("preserves current cloud versions and prevents older cloud results downgrading local progress", () => {
    const remoteLegacy = parseCloudSnapshot({ designs: [], deleted: [], progress: [legacy] });
    const localCurrent = parseCloudSnapshot({ designs: [], deleted: [], progress: [current] });
    expect(mergeCloudSnapshots(localCurrent, remoteLegacy).progress).toEqual([current]);
    expect(mergeCloudSnapshots(remoteLegacy, localCurrent).progress).toEqual([current]);
    expect(applyCloudSnapshot(mergeCloudSnapshots(localCurrent, remoteLegacy))).toEqual({ ok: true });
    expect(readProgress()).toEqual([current]);
  });

  it("retains legacy completion records for other lessons during cloud synchronization", () => {
    const anotherLegacy = { ...legacy, lessonId: "find-the-bottleneck" };
    const merged = mergeCloudSnapshots(
      { designs: [], deleted: [], progress: [current] },
      parseCloudSnapshot({ designs: [], deleted: [], progress: [anotherLegacy] }),
    );
    expect(applyCloudSnapshot(merged)).toEqual({ ok: true });
    expect(readProgress()).toHaveLength(2);
    expect(readProgress().filter(isCurrentProgress)).toEqual([current]);
  });
});

describe("v1 backward compatibility", () => {
  it("loads a literal v1 saved design unchanged, without inventing any v2 fields", () => {
    const v1Design = {
      id: "design-1", name: "A small service", lessonId: "first-request", updatedAt: "2026-09-07T12:00:00.000Z",
      architecture: {
        nodes: [
          { id: "traffic", kind: "traffic", label: "Traffic", position: { x: 0, y: 0 }, capacity: 1000, latency: 0, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0 },
          { id: "app", kind: "server", label: "Application", position: { x: 200, y: 0 }, capacity: 100, latency: 25, replicas: 1, cacheHitRate: 0, enabled: true, cost: 2 },
        ],
        edges: [{ id: "traffic-app", source: "traffic", target: "app" }],
      },
      workload: { requestRate: 50, readRatio: 0.8, duration: 30, seed: 42, pattern: "steady", failure: "none" },
    };
    const parsed = JSON.parse(JSON.stringify(v1Design));
    const validated = validateDesign(parsed);
    expect(validated).toEqual(v1Design);
    expect(validated.architecture.nodes[1]).not.toHaveProperty("region");
    expect(validated.architecture.nodes[1]).not.toHaveProperty("timeoutMs");
    expect(validated.workload).not.toHaveProperty("failures");
    expect(validated.workload).not.toHaveProperty("regions");
    storage.set("system-design-playground:v1:designs", JSON.stringify({ version: 1, data: { designs: [v1Design], deleted: [] } }));
    expect(readDesigns()).toEqual([v1Design]);
  });

  it("loads a literal v1 progress record unchanged", () => {
    const v1Progress = { lessonId: "first-request", completedAt: "2026-09-01T12:00:00.000Z", bestP95: 80, cost: 2 };
    const parsed = JSON.parse(JSON.stringify(v1Progress));
    expect(validateProgress(parsed)).toEqual(v1Progress);
    storage.set("system-design-playground:v1:progress", JSON.stringify({ version: 1, data: [v1Progress] }));
    expect(readProgress()).toEqual([v1Progress]);
  });
});

describe("v2 node and workload fields", () => {
  function baseArchitecture(nodeOverride: Partial<SystemNode> = {}) {
    return {
      nodes: [
        { id: "traffic", kind: "traffic", label: "Traffic", position: { x: 0, y: 0 }, capacity: 1000, latency: 0, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0 },
        { id: "app", kind: "server", label: "Application", position: { x: 200, y: 0 }, capacity: 100, latency: 25, replicas: 1, cacheHitRate: 0, enabled: true, cost: 2, ...nodeOverride },
      ],
      edges: [{ id: "traffic-app", source: "traffic", target: "app" }],
    };
  }

  it("accepts every optional v2 node field within bounds", () => {
    const architecture = validateArchitecture(baseArchitecture({
      region: "us-east", variance: "high", timeoutMs: 800, retries: 3, retryBackoffMs: 200, circuitBreaker: true,
      maxQueue: 50, fanout: "sequential",
    }));
    const app = architecture.nodes[1] as SystemNode;
    expect(app.region).toBe("us-east");
    expect(app.variance).toBe("high");
    expect(app.timeoutMs).toBe(800);
    expect(app.retries).toBe(3);
    expect(app.retryBackoffMs).toBe(200);
    expect(app.circuitBreaker).toBe(true);
    expect(app.maxQueue).toBe(50);
    expect(app.fanout).toBe("sequential");
  });

  it("accepts new component kinds (cdn, rate-limiter) with their fields", () => {
    const architecture = validateArchitecture({
      nodes: [
        { id: "traffic", kind: "traffic", label: "Traffic", position: { x: 0, y: 0 }, capacity: 1000, latency: 0, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0 },
        { id: "cdn", kind: "cdn", label: "CDN", position: { x: 200, y: 0 }, capacity: 5000, latency: 3, replicas: 1, cacheHitRate: 0.7, enabled: true, cost: 0.6 },
        { id: "limiter", kind: "rate-limiter", label: "Limiter", position: { x: 400, y: 0 }, capacity: 5000, latency: 1, replicas: 1, cacheHitRate: 0, enabled: true, cost: 0.3, limit: 400, burst: 800 },
      ],
      edges: [{ id: "traffic-cdn", source: "traffic", target: "cdn" }, { id: "cdn-limiter", source: "cdn", target: "limiter" }],
    });
    expect(architecture.nodes[1].kind).toBe("cdn");
    expect(architecture.nodes[2]).toMatchObject({ kind: "rate-limiter", limit: 400, burst: 800 });
  });

  it.each([
    ["timeoutMs", -1], ["timeoutMs", 60001], ["retries", 4], ["retries", -1], ["retryBackoffMs", 10001],
    ["maxQueue", 100001], ["healthCheckMs", 60001], ["shards", 0], ["shards", 17], ["replicationLagMs", 60001],
    ["failoverMs", 60001], ["cacheEntries", 0], ["cacheEntries", 1000001], ["ttlMs", 3600001],
    ["warmupSeconds", 61], ["limit", 0], ["limit", 100001], ["burst", 0], ["burst", 1000001],
  ])("rejects an out-of-range %s value", (field, value) => {
    expect(() => validateArchitecture(baseArchitecture({ [field]: value } as Partial<SystemNode>))).toThrow();
  });

  it.each([
    ["variance", "extreme"], ["fanout", "concurrent"], ["algorithm", "sticky"], ["dbMode", "clustered"],
    ["shardStrategy", "consistent-hash"], ["consistency", "strong"], ["cacheModel", "write-through"],
  ])("rejects an invalid %s enum value", (field, value) => {
    expect(() => validateArchitecture(baseArchitecture({ [field]: value } as unknown as Partial<SystemNode>))).toThrow();
  });

  it("rejects a region longer than 32 characters", () => {
    expect(() => validateArchitecture(baseArchitecture({ region: "a".repeat(33) }))).toThrow("region");
  });

  it("rejects non-boolean circuitBreaker and coalesce values", () => {
    expect(() => validateArchitecture(baseArchitecture({ circuitBreaker: "yes" as unknown as boolean }))).toThrow();
    expect(() => validateArchitecture(baseArchitecture({ coalesce: 1 as unknown as boolean }))).toThrow();
  });

  function baseWorkload(overrides: Partial<Workload> = {}): Workload {
    return { requestRate: 100, readRatio: 0.85, duration: 30, seed: 1, pattern: "steady", failure: "none", ...overrides };
  }

  it("accepts the flash pattern and a bounded failures array", () => {
    const workload = validateWorkload(baseWorkload({
      pattern: "flash",
      failures: [
        { kind: "server", at: 0.4 },
        { kind: "slow-database", at: 0.6, duration: 5, factor: 8, target: "database", region: "us-east" },
      ],
    }));
    expect(workload.pattern).toBe("flash");
    expect(workload.failures).toHaveLength(2);
    expect(workload.failures?.[1]).toEqual({ kind: "slow-database", at: 0.6, duration: 5, factor: 8, target: "database", region: "us-east" });
  });

  it("rejects more than 6 failure events", () => {
    const failures = Array.from({ length: 7 }, (_, i) => ({ kind: "server", at: i / 10 }));
    expect(() => validateWorkload(baseWorkload({ failures } as unknown as Partial<Workload>))).toThrow("failure events");
  });

  it("rejects an unknown failure kind and out-of-range failure fields", () => {
    expect(() => validateWorkload(baseWorkload({ failures: [{ kind: "meteor", at: 0.5 }] } as unknown as Partial<Workload>))).toThrow();
    expect(() => validateWorkload(baseWorkload({ failures: [{ kind: "server", at: 1.5 }] } as unknown as Partial<Workload>))).toThrow();
    expect(() => validateWorkload(baseWorkload({ failures: [{ kind: "slow-database", at: 0.5, factor: 101 }] } as unknown as Partial<Workload>))).toThrow();
    expect(() => validateWorkload(baseWorkload({ failures: [{ kind: "server", at: 0.5, duration: 601 }] } as unknown as Partial<Workload>))).toThrow();
  });

  it("accepts key space, key skew, regions and cross-region latency within bounds", () => {
    const workload = validateWorkload(baseWorkload({
      keySpace: 5000, keySkew: 0.9, crossRegionLatencyMs: 150,
      regions: [{ name: "us-east", share: 0.6 }, { name: "eu-west", share: 0.4 }],
    }));
    expect(workload.keySpace).toBe(5000);
    expect(workload.keySkew).toBe(0.9);
    expect(workload.crossRegionLatencyMs).toBe(150);
    expect(workload.regions).toEqual([{ name: "us-east", share: 0.6 }, { name: "eu-west", share: 0.4 }]);
  });

  it("rejects more than 8 traffic regions and out-of-range key skew", () => {
    const regions = Array.from({ length: 9 }, (_, i) => ({ name: `region-${i}`, share: 0.1 }));
    expect(() => validateWorkload(baseWorkload({ regions } as unknown as Partial<Workload>))).toThrow("regions");
    expect(() => validateWorkload(baseWorkload({ keySkew: 0.96 }))).toThrow();
    expect(() => validateWorkload(baseWorkload({ crossRegionLatencyMs: 5001 }))).toThrow();
  });

  it("strips unexpected v2 properties from an otherwise valid design instead of carrying them forward", () => {
    const architecture = baseArchitecture({});
    (architecture.nodes[1] as unknown as Record<string, unknown>).madeUpField = "nope";
    const validated = validateArchitecture(architecture);
    expect(validated.nodes[1]).not.toHaveProperty("madeUpField");
  });
});

describe("v2 progress fields", () => {
  const base: ProgressRecord = { lessonId: "first-request", completedAt: "2026-09-09T12:00:00.000Z", bestP95: 100, cost: 8, assessmentVersion: ASSESSMENT_VERSION };

  it("accepts every optional v2 progress field within bounds", () => {
    const validated = validateProgress({ ...base, attempts: 5, hintsUsed: 2, estimationScore: 0.75, defenseScore: 90, defenseMode: "self", remixes: 3 });
    expect(validated).toMatchObject({ attempts: 5, hintsUsed: 2, estimationScore: 0.75, defenseScore: 90, defenseMode: "self", remixes: 3 });
  });

  it.each([
    ["attempts", -1], ["attempts", 1.5], ["attempts", 100001],
    ["hintsUsed", -1], ["hintsUsed", 1.5], ["hintsUsed", 101],
    ["estimationScore", -0.01], ["estimationScore", 1.01],
    ["defenseScore", -1], ["defenseScore", 101],
    ["remixes", -1], ["remixes", 1.5], ["remixes", 100001],
  ])("rejects an out-of-range %s value", (field, value) => {
    expect(() => validateProgress({ ...base, [field]: value })).toThrow();
  });

  it("rejects an invalid defenseMode", () => {
    expect(() => validateProgress({ ...base, defenseMode: "auto" })).toThrow("defense mode");
  });

  it("keeps the earliest completion and best latency, but takes the max of attempts/remixes/estimationScore/defenseScore", () => {
    const first: ProgressRecord = { ...base, completedAt: "2026-09-09T12:00:00.000Z", bestP95: 100, cost: 8, attempts: 2, remixes: 1, estimationScore: 0.5, defenseScore: 60, defenseMode: "self" };
    const second: ProgressRecord = { ...base, completedAt: "2026-09-10T12:00:00.000Z", bestP95: 90, cost: 9, attempts: 5, remixes: 4, estimationScore: 0.8, defenseScore: 85, defenseMode: "graded" };
    const merged = mergeProgress(first, second);
    expect(merged.completedAt).toBe(first.completedAt);
    expect(merged.bestP95).toBe(second.bestP95);
    expect(merged.attempts).toBe(5);
    expect(merged.remixes).toBe(4);
    expect(merged.estimationScore).toBe(0.8);
    expect(merged.defenseScore).toBe(85);
    expect(merged.defenseMode).toBe("graded");
  });

  it("takes the defenseMode from whichever record has the higher defenseScore, independent of merge order", () => {
    const lowScore: ProgressRecord = { ...base, defenseScore: 40, defenseMode: "graded" };
    const highScore: ProgressRecord = { ...base, defenseScore: 95, defenseMode: "self" };
    expect(mergeProgress(lowScore, highScore).defenseMode).toBe("self");
    expect(mergeProgress(highScore, lowScore).defenseMode).toBe("self");
  });

  it("falls back to whichever side actually has a defenseMode when only one side does", () => {
    const withMode: ProgressRecord = { ...base, defenseScore: 50, defenseMode: "self" };
    const withoutMode: ProgressRecord = { ...base, defenseScore: 80 };
    expect(mergeProgress(withMode, withoutMode).defenseMode).toBe("self");
    expect(mergeProgress(withoutMode, withMode).defenseMode).toBe("self");
  });

  it("leaves v2 fields undefined when neither record has them", () => {
    const merged = mergeProgress({ ...base }, { ...base, bestP95: 50 });
    expect(merged.attempts).toBeUndefined();
    expect(merged.remixes).toBeUndefined();
    expect(merged.estimationScore).toBeUndefined();
    expect(merged.defenseScore).toBeUndefined();
    expect(merged.defenseMode).toBeUndefined();
  });
});

describe("attempts and estimation gym", () => {
  it("counts attempts per lesson, starting from zero", () => {
    expect(readAttempts("first-request")).toBe(0);
    expect(recordAttempt("first-request")).toBe(1);
    expect(recordAttempt("first-request")).toBe(2);
    expect(readAttempts("first-request")).toBe(2);
    expect(readAttempts("other-lesson")).toBe(0);
  });

  it("persists gym state across reads and validates it back", () => {
    expect(readGym()).toEqual({ solved: {}, streak: 0, best: 0 });
    expect(saveGym({ solved: { p95: 4, throughput: 2 }, streak: 3, best: 5 })).toEqual({ ok: true });
    expect(readGym()).toEqual({ solved: { p95: 4, throughput: 2 }, streak: 3, best: 5 });
  });

  it("rejects invalid gym state", () => {
    expect(saveGym({ solved: {}, streak: -1, best: 0 })).toEqual({ ok: false, error: expect.stringContaining("streak") });
  });
});
