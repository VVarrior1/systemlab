import { Suspense } from "react";
import { MockInterview } from "@/components/mock-interview";

export const metadata = { title: "Mock interview" };

export default function MockPage() {
  return (
    <Suspense fallback={<div className="page-loading">Opening the interview room...</div>}>
      <MockInterview />
    </Suspense>
  );
}
