"use client";

/**
 * Browser-side REST helpers. All calls hit /api/* on this same origin;
 * in production the nginx in front of us proxies that to the backend
 * KSvc, and in `next dev` a dev-only rewrite does (next.config.ts).
 * The realtime path doesn't live here — that's the WebSocket (lib/ws.ts).
 *
 * Every fetch is wrapped in `tracked()` so the global WarmingBar can
 * react when the backend is cold-starting (lib/warming).
 */

import { tracked } from "./warming";

export type LeaderboardEntry = {
  name: string;
  best_score: number;
  updated_at: string;
};

export async function fetchLeaderboard(): Promise<LeaderboardEntry[]> {
  return tracked(async () => {
    const r = await fetch("/api/leaderboard", { credentials: "include" });
    if (!r.ok) return [];
    return r.json();
  });
}
