import type { Metadata } from "next";
import type { ReactNode } from "react";

import { WarmingBar } from "@/components/WarmingBanner";
import "./globals.css";

export const metadata: Metadata = {
  title: "검은 자정 | 실시간 마피아 게임",
  description: "친구들과 링크 하나로 시작하는 시네마틱 실시간 마피아 게임",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "검은 자정" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
  themeColor: "#080a0d",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <WarmingBar />
        {children}
      </body>
    </html>
  );
}
