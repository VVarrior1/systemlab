import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { applyCloudSnapshot, mergeProgress, readCloudSnapshot, validateDeletion, validateDesign, validateProgress, type CloudSnapshot, type DesignDeletion } from "./persistence";
import type { ProgressRecord, SavedDesign } from "./types";

let client: SupabaseClient | null = null;
let syncInFlight: Promise<{ designs: number; progress: number }> | null = null;

export function isCloudConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key || key.includes("your-") || key.length < 20) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname));
  } catch { return false; }
}

export function getSupabaseClient(): SupabaseClient | null {
  if (!isCloudConfigured() || typeof window === "undefined") return null;
  if (!client) client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
  });
  return client;
}

export function parseCloudSnapshot(value: unknown): CloudSnapshot {
  if (!value || typeof value !== "object") throw new Error("Cloud returned an unreadable response.");
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.designs) || !Array.isArray(data.progress) || !Array.isArray(data.deleted) || data.designs.length > 100 || data.progress.length > 1_000 || data.deleted.length > 10_000) {
    throw new Error("Cloud data exceeds the supported save limit.");
  }
  return { designs: data.designs.map(validateDesign), progress: data.progress.map(validateProgress), deleted: data.deleted.map(validateDeletion) };
}

export function mergeCloudSnapshots(local: CloudSnapshot, remote: CloudSnapshot): CloudSnapshot {
  const designs = new Map<string, SavedDesign>();
  const deleted = new Map<string, DesignDeletion>();
  const progress = new Map<string, ProgressRecord>();
  for (const item of [...remote.designs, ...local.designs]) {
    const previous = designs.get(item.id);
    if (!previous || item.updatedAt >= previous.updatedAt) designs.set(item.id, item);
  }
  for (const item of [...remote.deleted, ...local.deleted]) {
    const previous = deleted.get(item.id);
    if (!previous || item.updatedAt >= previous.updatedAt) deleted.set(item.id, item);
  }
  for (const [id, deletion] of deleted) {
    const design = designs.get(id);
    if (design && design.updatedAt > deletion.updatedAt) deleted.delete(id);
    else designs.delete(id);
  }
  for (const item of [...remote.progress, ...local.progress]) {
    const previous = progress.get(item.lessonId);
    progress.set(item.lessonId, previous ? mergeProgress(previous, item) : item);
  }
  return { designs: [...designs.values()], deleted: [...deleted.values()], progress: [...progress.values()] };
}

async function performSync(): Promise<{ designs: number; progress: number }> {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Cloud saves are not available right now. Your browser saves are still available.");
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) throw new Error("Sign in again to sync your progress.");
  const snapshot = readCloudSnapshot();
  const { data, error } = await supabase.rpc("sync_playground", {
    p_designs: snapshot.designs, p_deleted: snapshot.deleted, p_progress: snapshot.progress,
  });
  if (error) throw new Error("Cloud sync could not finish. Your browser saves are intact. Try again shortly.");
  const { data: currentAuth } = await supabase.auth.getSession();
  if (currentAuth.session?.user.id !== auth.user.id) throw new Error("Your account changed during sync. Please try again.");
  // Re-read after the request so edits made while syncing are preserved.
  const merged = mergeCloudSnapshots(readCloudSnapshot(), parseCloudSnapshot(data));
  const result = applyCloudSnapshot(merged);
  if (!result.ok) throw new Error(result.error);
  return { designs: merged.designs.length, progress: merged.progress.length };
}

export function syncCloudData(): Promise<{ designs: number; progress: number }> {
  if (!syncInFlight) syncInFlight = performSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}
