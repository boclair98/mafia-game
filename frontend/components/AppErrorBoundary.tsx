"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { failed: boolean };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Black Midnight client error", error, info.componentStack);
  }

  private recover = async () => {
    try {
      if ("caches" in window) {
        const keys = await window.caches.keys();
        await Promise.all(keys.filter((key) => key.startsWith("black-midnight-")).map((key) => window.caches.delete(key)));
      }
      if ("serviceWorker" in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.update().catch(() => undefined)));
      }
    } finally {
      const url = new URL(window.location.href);
      url.searchParams.set("recover", Date.now().toString());
      window.location.replace(url.toString());
    }
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="fatal-recovery" role="alert">
        <div>
          <span>CASE SYSTEM RECOVERY</span>
          <h1>게임 화면을 복구할게요</h1>
          <p>배포 전 화면 정보가 남아 충돌했습니다. 방 코드와 닉네임은 유지되며 최신 버전만 다시 불러옵니다.</p>
          <button type="button" onClick={() => void this.recover()}>최신 버전으로 다시 시작</button>
        </div>
      </main>
    );
  }
}
