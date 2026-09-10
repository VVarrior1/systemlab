import type { Metadata } from "next";
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@xyflow/react/dist/style.css";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "System Lab | System Design Playground", template: "%s | System Lab" },
  description: "Learn system design by building architectures, testing traffic, and exploring the tradeoffs. Twelve hands-on missions and an open simulation sandbox.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
