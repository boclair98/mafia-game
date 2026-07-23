import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";

import { DevDeployBadge } from "@/components/DevDeployBadge";
import { WarmingBar } from "@/components/WarmingBanner";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata = {
  title: "template-coders-game",
  description: "A realtime multiplayer game starter for coders.kr.",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Fullscreen game chrome: the canvas owns the viewport, so no page
  // scroll, no container, no header — the HUD overlays everything it
  // needs. WarmingBar still floats on top for backend cold starts.
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="h-dvh overflow-hidden bg-[#0b0f1a]">
        <WarmingBar />
        <DevDeployBadge />
        <main className="h-full w-full">{children}</main>
      </body>
    </html>
  );
}
