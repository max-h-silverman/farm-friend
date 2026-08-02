import type { ReactNode } from "react";
import { EmbedHeightReporter } from "./embed-height";
import "./globals.css";

export const metadata = {
  title: "Farm Friend — Vashon farm stands",
  description:
    "What Vashon Island farm stands have right now, with the date each farmer last confirmed it.",
};

// The map is read on phones, outdoors, and is embeddable in VIGA's site.
export const viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <EmbedHeightReporter />
        {children}
      </body>
    </html>
  );
}
