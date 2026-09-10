import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCloudSnapshot, deleteDesign, getPersistenceWarning, mergeProgress, readCloudSnapshot, readDesigns, readDraft, readProgress, saveDesign, saveDraft, saveProgress, validateDesign, validateProgress } from "./persistence";
import { ASSESSMENT_VERSION, isCurrentProgress } from "./assessment-version";
import { mergeCloudSnapshots, parseCloudSnapshot } from "./supabase";
import type { ProgressRecord, SavedDesign } from "./types";

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
