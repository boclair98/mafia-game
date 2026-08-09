import type { Metadata } from "next";
import type { ReactNode } from "react";

import { WarmingBar } from "@/components/WarmingBanner";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://black-midnight.coders.kr"),
  title: "검은 자정 | 실시간 마피아 게임",
  description: "친구들과 링크 하나로 시작하는 시네마틱 실시간 마피아 게임",
  applicationName: "검은 자정",
  keywords: ["마피아 게임", "온라인 마피아", "소셜 추리", "친구 게임", "Black Midnight"],
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "검은 자정" },
  openGraph: {
    type: "website",
    locale: "ko_KR",
    url: "/",
    siteName: "검은 자정",
    title: "검은 자정 — 이 도시의 누군가는 마피아다",
    description: "설치 없이 링크 하나로 시작하는 시네마틱 실시간 마피아 게임",
    images: [{ url: "/share-card.jpg", width: 1200, height: 630, alt: "검은 자정의 밤 도시" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "검은 자정 — 실시간 마피아 게임",
    description: "친구를 자정의 테이블로 초대하세요.",
    images: ["/share-card.jpg"],
  },
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
