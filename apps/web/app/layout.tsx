import type { ReactNode } from "react";

export const metadata = {
  title: "Farm Friend",
  description: "Vashon Island farm-stand map — kept fresh.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
