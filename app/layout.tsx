import type { Metadata } from "next";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@xyflow/react/dist/style.css";
import "./globals.css";
import "@/components/architecture-canvas.css";
import "@/components/results.css";
import "@/components/library.css";
import "@/components/mission-panel.css";
import "@/components/playground.css";
import "@/components/defense-stage.css";
import "@/components/clarification-stage.css";
import "@/components/gym.css";

export const metadata: Metadata = {
  title: { default: "System Lab | System Design Playground", template: "%s | System Lab" },
  description: "Learn system design by building architectures, testing traffic, and defending the tradeoffs. Fifty hands-on lessons, open design briefs, an estimation gym, and a simulation sandbox.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
