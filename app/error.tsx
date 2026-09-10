"use client";
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) { return <main className="error-page"><span className="eyebrow">WORKSPACE INTERRUPTED</span><h1>Let&apos;s try that again.</h1><p>Your saved designs are still stored in this browser.</p><button className="button primary" onClick={reset}>Reload workspace</button></main>; }
