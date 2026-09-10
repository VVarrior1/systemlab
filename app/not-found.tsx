import Link from "next/link";
export default function NotFound() { return <main className="error-page"><span className="eyebrow">404 / ROUTE NOT FOUND</span><h1>This path ends here.</h1><p>The lesson or workspace could not be found.</p><Link className="button primary" href="/learn">Back to learning path</Link></main>; }
