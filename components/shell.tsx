"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, BookOpen, Check, ChevronRight, FlaskConical, FolderOpen, Layers3, Menu, Network, UserRound, X } from "lucide-react";
import { lessons, chapters } from "@/lib/curriculum";
import { readProgress } from "@/lib/persistence";
import { isCurrentProgress } from "@/lib/assessment-version";
import { AccountDialog } from "@/components/account-dialog";

export function Shell({ children, currentLessonId }: { children: ReactNode; currentLessonId?: string }) {
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  const [account, setAccount] = useState(false);
  const [completed, setCompleted] = useState<string[]>([]);
  useEffect(() => {
    const update = () => setCompleted(readProgress().filter(isCurrentProgress).map((p) => p.lessonId));
    update(); window.addEventListener("progress-updated", update); window.addEventListener("playground:storage", update); window.addEventListener("storage", update);
    return () => { window.removeEventListener("progress-updated", update); window.removeEventListener("playground:storage", update); window.removeEventListener("storage", update); };
  }, []);
  const current = lessons.find((l) => l.id === currentLessonId);
  return <div className="app-shell">
    <div className="mobile-top"><Link className="brand" href="/learn"><span className="brand-symbol"><Network size={21} /></span>system<span className="brand-light">lab</span><span className="brand-dot">.</span></Link><button className="icon-button" aria-label="Open navigation" onClick={() => setMenu(true)}><Menu size={20} /></button></div>
    {menu && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMenu(false)} />}
    <aside className={`sidebar ${menu ? "sidebar-open" : ""}`}>
      <Link className="brand" href="/learn"><span className="brand-symbol"><Network size={21} /></span>system<span className="brand-light">lab</span><span className="brand-dot">.</span></Link>
      <button className="mobile-close icon-button" aria-label="Close navigation" onClick={() => setMenu(false)}><X size={19} /></button>
      <div className="workspace-label"><span className="tiny-dot" /> PERSONAL WORKSPACE</div>
      <nav className="main-nav" aria-label="Main navigation">
        <Link className={path.startsWith("/learn") ? "nav-item active" : "nav-item"} href="/learn"><BookOpen size={17} />Learning path<ChevronRight size={14} className="nav-arrow" /></Link>
        <Link className={path === "/sandbox" ? "nav-item active" : "nav-item"} href="/sandbox"><FlaskConical size={17} />Sandbox</Link>
        <Link className={path === "/designs" ? "nav-item active" : "nav-item"} href="/designs"><FolderOpen size={17} />My designs</Link>
      </nav>
      <div className="sidebar-section-label">THE CURRICULUM <span>{lessons.length}</span></div>
      <div className="chapter-nav">{chapters.map((chapter, index) => <div key={chapter} className="chapter-group"><Link href={`/learn#chapter-${index}`} className={`chapter-title ${current?.chapter === chapter ? "chapter-current" : ""}`}><span className="chapter-number">0{index + 1}</span>{chapter}</Link>{(current?.chapter === chapter || !current && index === 0) && <div className="chapter-lessons">{lessons.filter((l) => l.chapter === chapter).map((lesson) => <Link className={`chapter-lesson ${currentLessonId === lesson.id ? "lesson-current" : ""}`} href={`/learn/${lesson.id}`} key={lesson.id}><span className={`lesson-dot ${completed.includes(lesson.id) ? "done" : ""}`}>{completed.includes(lesson.id) ? <Check size={10} /> : currentLessonId === lesson.id ? <span /> : null}</span>{lesson.title}</Link>)}</div>}</div>)}</div>
      <div className="sidebar-bottom"><div className="progress-caption"><span>Your progress</span><span>{completed.length}/{lessons.length}</span></div><div className="progress-track"><div style={{ width: `${completed.length / lessons.length * 100}%` }} /></div><p>One experiment at a time.</p><button className="profile-button" onClick={() => setAccount(true)}><span className="avatar"><UserRound size={17} /></span><span><strong>Your workspace</strong><small>Account & storage</small></span><ArrowUpRight size={14} /></button></div>
      <div className="sidebar-version"><Layers3 size={12} /> SYSTEM DESIGN PLAYGROUND</div>
    </aside>
    <main className="main-content">{children}</main>
    <AccountDialog open={account} onOpenChange={setAccount} />
  </div>;
}
