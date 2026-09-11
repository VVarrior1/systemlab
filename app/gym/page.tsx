import { Suspense } from "react";
import { Gym } from "@/components/gym";

export const metadata = { title: "Estimation gym" };

export default function GymPage() {
  return (
    <Suspense fallback={<div className="page-loading">Opening the gym...</div>}>
      <Gym />
    </Suspense>
  );
}
