import { Suspense } from "react";
import { Playground } from "@/components/playground";
export const metadata = { title: "Sandbox" };
export default function SandboxPage() { return <Suspense fallback={<div className="page-loading">Opening workspace...</div>}><Playground /></Suspense>; }
