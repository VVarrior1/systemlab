import type { Architecture, ProgressRecord, SavedDesign, SystemNode, Workload } from "./types";

export type SaveStatus = { ok: true } | { ok: false; error: string };
export type DesignDeletion = { id: string; updatedAt: string };
export type CloudSnapshot = { designs: SavedDesign[]; progress: ProgressRecord[]; deleted: DesignDeletion[] };

const PREFIX = "system-design-playground:v1:";
const MAX_DESIGNS = 100;
const MAX_JSON_LENGTH = 5_000_000;
const KINDS = ["traffic", "server", "load-balancer", "database", "cache", "queue"];
let warning: string | null = null;

function fail(message: string): never { throw new Error(message); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Expected an object.");
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) fail(`Invalid ${label}.`);
  return value.trim();
}
function number(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) fail(`Invalid ${label}.`);
  return value;
}
function timestamp(value: unknown): string {
  const text = string(value, "date", 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !Number.isFinite(Date.parse(text))) fail("Invalid date.");
  return new Date(text).toISOString();
}
function node(value: unknown): SystemNode {
  const data = record(value);
  if (typeof data.kind !== "string" || !KINDS.includes(data.kind)) fail("Unknown component type.");
  if (typeof data.enabled !== "boolean") fail("Invalid component state.");
  if (data.role !== undefined && data.role !== "application" && data.role !== "worker") fail("Invalid server role.");
  const position = record(data.position);
  return {
    id: string(data.id, "component ID"), kind: data.kind as SystemNode["kind"], label: string(data.label, "component label", 100),
    position: { x: number(position.x, "position", -100_000, 100_000), y: number(position.y, "position", -100_000, 100_000) },
    capacity: number(data.capacity, "capacity", 1, 1_000_000), latency: number(data.latency, "latency", 0, 60_000),
    replicas: number(data.replicas, "replicas", 1, 100, true), cacheHitRate: number(data.cacheHitRate, "cache hit rate", 0, 1),
    enabled: data.enabled, cost: number(data.cost, "cost", 0, 1_000_000),
    ...(data.role ? { role: data.role as SystemNode["role"] } : {}),
  };
}
export function validateArchitecture(value: unknown): Architecture {
  const data = record(value);
  if (!Array.isArray(data.nodes) || data.nodes.length > 100 || !Array.isArray(data.edges) || data.edges.length > 300) fail("Design exceeds the component or connection limit.");
  const nodes = data.nodes.map(node);
  const ids = new Set(nodes.map((item) => item.id));
  if (ids.size !== nodes.length) fail("Component IDs must be unique.");
  const edgeIds = new Set<string>();
  const edges = data.edges.map((value) => {
    const edge = record(value);
    const result = { id: string(edge.id, "connection ID"), source: string(edge.source, "connection source"), target: string(edge.target, "connection target") };
    if (edgeIds.has(result.id) || !ids.has(result.source) || !ids.has(result.target)) fail("Invalid or duplicate connection.");
    edgeIds.add(result.id);
    return result;
  });
  return { nodes, edges };
}
export function validateWorkload(value: unknown): Workload {
  const data = record(value);
  if (data.pattern !== "steady" && data.pattern !== "spike" && data.pattern !== "ramp") fail("Invalid traffic pattern.");
  if (data.failure !== "none" && data.failure !== "server" && data.failure !== "database") fail("Invalid failure scenario.");
  return {
    requestRate: number(data.requestRate, "request rate", 0, 100_000), readRatio: number(data.readRatio, "read ratio", 0, 1),
    duration: number(data.duration, "duration", 1, 600, true), seed: number(data.seed, "seed", 0, 4_294_967_295, true),
    pattern: data.pattern, failure: data.failure,
  };
}
export function validateDesign(value: unknown): SavedDesign {
  const data = record(value);
  const architecture = validateArchitecture(data.architecture);
  if (architecture.nodes.filter((item) => item.kind === "traffic").length !== 1) fail("A saved design must contain exactly one traffic source.");
  return {
    id: string(data.id, "design ID"), name: string(data.name, "design name", 120),
    lessonId: data.lessonId === null ? null : string(data.lessonId, "lesson ID"),
    architecture, workload: validateWorkload(data.workload), updatedAt: timestamp(data.updatedAt),
  };
}
export function validateProgress(value: unknown): ProgressRecord {
  const data = record(value);
  return {
    lessonId: string(data.lessonId, "lesson ID"), completedAt: timestamp(data.completedAt),
    bestP95: number(data.bestP95, "latency", 0, 1_000_000_000), cost: number(data.cost, "cost", 0, 1_000_000_000),
    ...(data.assessmentVersion === undefined ? {} : { assessmentVersion: number(data.assessmentVersion, "assessment version", 1, 2_147_483_647, true) }),
  };
}
export function validateDeletion(value: unknown): DesignDeletion {
  const data = record(value);
  return { id: string(data.id, "design ID"), updatedAt: timestamp(data.updatedAt) };
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Your changes could not be saved."; }
function announce(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("playground:storage"));
}
function read(key: string): unknown | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    if (raw.length > MAX_JSON_LENGTH) fail("Saved data is too large to open.");
    const envelope = record(JSON.parse(raw));
    if (envelope.version !== 1) fail("This saved data uses an unsupported version.");
    return envelope.data;
  } catch {
    warning = "Some saved data could not be read. Export any designs you can still open before clearing browser data.";
    return null;
  }
}
function write(key: string, data: unknown): SaveStatus {
  if (typeof window === "undefined") return { ok: false, error: "Browser storage is unavailable." };
  try {
    const serialized = JSON.stringify({ version: 1, data });
    if (serialized.length > MAX_JSON_LENGTH) fail("Storage is full. Export and remove an older design first.");
    window.localStorage.setItem(PREFIX + key, serialized);
    announce();
    return { ok: true };
  } catch (error) {
    warning = error instanceof DOMException ? "Your browser could not save changes. Storage may be full or disabled. Export your design to keep a copy." : errorMessage(error);
    return { ok: false, error: warning };
  }
}
function recover<T>(value: unknown, validate: (value: unknown) => T, limit: number): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) { warning = "Some saved entries could not be read."; return []; }
  const items: T[] = [];
  for (const entry of value.slice(0, limit)) {
    try { items.push(validate(entry)); } catch { warning = "Some damaged saved entries were skipped."; }
  }
  return items;
}
function designStore(): { designs: SavedDesign[]; deleted: DesignDeletion[] } {
  const value = read("designs");
  if (!value) return { designs: [], deleted: [] };
  try {
    const data = record(value);
    return { designs: recover(data.designs, validateDesign, MAX_DESIGNS), deleted: recover(data.deleted, validateDeletion, 10_000) };
  } catch { warning = "Saved designs could not be read."; return { designs: [], deleted: [] }; }
}
export function getPersistenceWarning(): string | null { return warning; }
export function readDesigns(): SavedDesign[] { return designStore().designs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
export function saveDesign(design: SavedDesign): SaveStatus {
  try {
    const validated = validateDesign(design);
    const current = designStore();
    const others = current.designs.filter((item) => item.id !== validated.id);
    if (others.length >= MAX_DESIGNS) fail("You have reached 100 saved designs. Export and remove an older design first.");
    return write("designs", { designs: [validated, ...others], deleted: current.deleted.filter((item) => item.id !== validated.id) });
  } catch (error) { return { ok: false, error: errorMessage(error) }; }
}
export function deleteDesign(id: string): SaveStatus {
  try {
    string(id, "design ID");
    const current = designStore();
    const deleted = current.deleted.filter((item) => item.id !== id);
    if (deleted.length >= 10_000) fail("Deletion history is full. Export your designs before resetting browser storage.");
    return write("designs", { designs: current.designs.filter((item) => item.id !== id), deleted: [...deleted, { id, updatedAt: new Date().toISOString() }] });
  } catch (error) { return { ok: false, error: errorMessage(error) }; }
}
export function readProgress(): ProgressRecord[] { return recover(read("progress"), validateProgress, 1_000); }
export function mergeProgress(first: ProgressRecord, second: ProgressRecord): ProgressRecord {
  const firstVersion = first.assessmentVersion ?? 1;
  const secondVersion = second.assessmentVersion ?? 1;
  if (firstVersion !== secondVersion) return { ...(firstVersion > secondVersion ? first : second) };
  const best = first.bestP95 < second.bestP95 || (first.bestP95 === second.bestP95 && first.cost <= second.cost) ? first : second;
  return { ...best, completedAt: first.completedAt < second.completedAt ? first.completedAt : second.completedAt };
}
export function saveProgress(progress: ProgressRecord): SaveStatus {
  try {
    const validated = validateProgress(progress);
    const current = readProgress();
    const previous = current.find((item) => item.lessonId === validated.lessonId);
    if (!previous && current.length >= 1_000) fail("Progress storage is full.");
    return write("progress", [...current.filter((item) => item.lessonId !== validated.lessonId), previous ? mergeProgress(previous, validated) : validated]);
  } catch (error) { return { ok: false, error: errorMessage(error) }; }
}
export function readDraft(key: string): { architecture: Architecture; workload: Workload } | null {
  try {
    const value = read("draft:" + string(key, "draft key", 256));
    if (!value) return null;
    const draft = record(value);
    return { architecture: validateArchitecture(draft.architecture), workload: validateWorkload(draft.workload) };
  } catch { warning = "This draft could not be restored. The original lesson is still available."; return null; }
}
export function saveDraft(key: string, architecture: Architecture, workload: Workload): SaveStatus {
  try { return write("draft:" + string(key, "draft key", 256), { architecture: validateArchitecture(architecture), workload: validateWorkload(workload) }); }
  catch (error) { return { ok: false, error: errorMessage(error) }; }
}
export function readCloudSnapshot(): CloudSnapshot { return { ...designStore(), progress: readProgress() }; }
export function applyCloudSnapshot(snapshot: CloudSnapshot): SaveStatus {
  try {
    if (snapshot.designs.length > MAX_DESIGNS || snapshot.deleted.length > 10_000 || snapshot.progress.length > 1_000) fail("Cloud data exceeds this browser's save limit. Remove an older design and try again.");
    const designs = snapshot.designs.map(validateDesign);
    const deleted = snapshot.deleted.map(validateDeletion);
    const progress = snapshot.progress.map(validateProgress);
    const result = write("designs", { designs, deleted });
    return result.ok ? write("progress", progress) : result;
  } catch (error) { return { ok: false, error: errorMessage(error) }; }
}
