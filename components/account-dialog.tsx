"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { User } from "@supabase/supabase-js";
import { Check, Cloud, HardDrive, LoaderCircle, LogOut, Mail, RefreshCw } from "lucide-react";
import { Modal } from "./ui";
import { getPersistenceWarning, readDesigns, readProgress } from "@/lib/persistence";
import { getSupabaseClient, isCloudConfigured, syncCloudData } from "@/lib/supabase";

export function AccountDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (value: boolean) => void }) {
  const [user, setUser] = useState<User | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<"email" | "sync" | "signout" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [counts, setCounts] = useState({ designs: 0, progress: 0 });
  const configured = isCloudConfigured();

  useEffect(() => {
    const client = getSupabaseClient();
    if (!client) return;
    let active = true;
    client.auth.getSession().then(({ data, error }) => {
      if (active) {
        setUser(data.session?.user ?? null);
        if (error) setError("Your session could not be restored. Please sign in again.");
      }
    }).catch(() => { if (active) setError("Your session could not be restored. Please sign in again."); });
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      if (active) { setUser(session?.user ?? null); setMessage(""); setSent(false); }
    });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const refresh = () => {
      setCounts({ designs: readDesigns().length, progress: readProgress().length });
      const warning = getPersistenceWarning();
      if (warning) setError(warning);
    };
    refresh();
    window.addEventListener("playground:storage", refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener("playground:storage", refresh); window.removeEventListener("storage", refresh); };
  }, [open]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const client = getSupabaseClient();
    if (!client || busy) return;
    setBusy("email"); setError(""); setMessage("");
    try {
      const { error } = await client.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: window.location.origin + "/learn" } });
      if (error) throw new Error(error.status === 429 ? "Please wait a minute before requesting another link." : "We could not send your sign-in link. Please try again.");
      setSent(true); setMessage(`A sign-in link has been sent to ${email.trim()}.`);
    } catch (error) { setError(error instanceof Error ? error.message : "Sign-in is unavailable. Please try again."); }
    finally { setBusy(null); }
  }

  async function sync() {
    if (busy) return;
    setBusy("sync"); setError(""); setMessage("");
    try {
      const result = await syncCloudData();
      setMessage(`Synced ${result.designs} ${result.designs === 1 ? "design" : "designs"} and ${result.progress} completed ${result.progress === 1 ? "lesson" : "lessons"}.`);
      window.dispatchEvent(new Event("progress-updated"));
      window.dispatchEvent(new Event("designs-updated"));
    } catch (error) { setError(error instanceof Error ? error.message : "Sync could not finish. Please try again."); }
    finally { setBusy(null); }
  }

  async function signOut() {
    const client = getSupabaseClient();
    if (!client || busy) return;
    setBusy("signout"); setError(""); setMessage("");
    try {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) throw error;
      setUser(null); setMessage("Signed out. Your browser saves are still on this device.");
    } catch { setError("Sign-out could not finish. Please try again."); }
    finally { setBusy(null); }
  }

  return <Modal open={open} onOpenChange={onOpenChange} title="Your workspace" description={user ? "Manage your saved work and account." : "Your learning progress, right where you left it."}>
    <div className="account-content">
      <div className="account-identity"><span className="account-storage-icon">{user ? <Cloud size={22} /> : <HardDrive size={22} />}</span><div><strong>{user?.email || "Personal workspace"}</strong><span>{user ? "Connected account" : "Saved in this browser"}</span></div><span className="account-status"><span />{user ? "Connected" : "Local"}</span></div>
      <dl className="account-counts"><div><dt>Saved designs</dt><dd>{counts.designs}</dd></div><div><dt>Completed lessons</dt><dd>{counts.progress}</dd></div></dl>
      {user ? <div className="account-cloud"><p>Sync to merge saved designs and completed lessons across your devices. Drafts stay in this browser.</p><div className="account-actions"><button type="button" className="button button-primary" disabled={!!busy} onClick={sync}>{busy === "sync" ? <LoaderCircle size={16} className="account-spin" /> : <RefreshCw size={16} />}Sync saved work</button><button type="button" className="button button-secondary" disabled={!!busy} onClick={signOut}><LogOut size={15} />Sign out</button></div></div> : configured ? <form className="account-signin" onSubmit={signIn}><label htmlFor="account-email">Email address</label><input id="account-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => { setEmail(event.target.value); setSent(false); }} placeholder="you@example.com" disabled={!!busy} /><button className="button button-primary" type="submit" disabled={!!busy || sent}>{busy === "email" ? <LoaderCircle size={16} className="account-spin" /> : sent ? <Check size={16} /> : <Mail size={16} />}{sent ? "Link sent" : "Send sign-in link"}</button><p>Sign in to sync saved work across devices.</p></form> : <p className="account-local-note">Your designs and progress are kept on this device. Clearing browser data removes these saves. Export individual designs from My designs to keep a copy.</p>}
      {message && <p className="account-message" role="status">{message}</p>}
      {error && <p className="account-error" role="alert">{error}</p>}
    </div>
    <style jsx>{`
      .account-content { color: #343943; }
      .account-identity { display: flex; align-items: center; gap: 12px; padding: 6px 0 24px; min-width: 0; }
      .account-storage-icon { display: grid; place-items: center; width: 46px; height: 46px; background: #edf5f2; color: #25846b; border-radius: 8px; flex-shrink: 0; }
      .account-identity > div { flex: 1; min-width: 0; }
      .account-identity strong { display: block; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
      .account-identity > div > span { display: block; margin-top: 3px; color: #737780; font-size: 12px; }
      .account-status { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: #4c6960; flex-shrink: 0; }
      .account-status > span { width: 5px; height: 5px; border-radius: 50%; background: #3c9479; }
      .account-counts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 19px 0; margin: 0; border-top: 1px solid #e9eaed; border-bottom: 1px solid #e9eaed; }
      .account-counts > div + div { border-left: 1px solid #e9eaed; padding-left: 25px; }
      .account-counts dt { font-size: 12px; color: #737780; }
      .account-counts dd { margin: 7px 0 0; font-size: 26px; font-weight: 600; }
      .account-cloud p, .account-local-note, .account-signin p { color: #737780; font-size: 13px; line-height: 1.7; margin: 20px 0 0; }
      .account-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
      .account-actions button, .account-signin button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 10px 14px; border: 1px solid #dee2e5; border-radius: 6px; background: #fff; color: #30343b; font: inherit; font-size: 13px; cursor: pointer; }
      .account-content .button-primary { background: #24866b; color: #fff; border-color: #24866b; }
      .account-content button:disabled { opacity: .55; cursor: default; }
      .account-signin { display: flex; flex-direction: column; gap: 10px; margin-top: 23px; }
      .account-signin label { font-size: 12px; font-weight: 600; }
      .account-signin input { box-sizing: border-box; width: 100%; border: 1px solid #dce0e3; border-radius: 6px; padding: 12px; background: #fff; color: #30343b; font: inherit; font-size: 14px; }
      .account-signin input:focus-visible { outline: 2px solid #24866b; outline-offset: 2px; }
      .account-signin p { margin: 0; text-align: center; font-size: 12px; }
      .account-message, .account-error { margin: 16px 0 0; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
      .account-message { color: #22765e; }
      .account-error { color: #a63c42; }
      .account-spin { animation: account-spin 1s linear infinite; }
      @keyframes account-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .account-spin { animation: none; } }
      @media (max-width: 400px) { .account-status { display: none; } }
    `}</style>
  </Modal>;
}
