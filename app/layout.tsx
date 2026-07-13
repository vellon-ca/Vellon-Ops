import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vellon Ops",
  description: "Vellon founder console — internal use only.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
