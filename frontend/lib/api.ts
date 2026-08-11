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

export const NATIVE_API_ORIGIN = "https://black-midnight.coders.kr";

export function apiUrl(path: string): string {
  if (typeof location === "undefined") return path;
  const configured = process.env.NEXT_PUBLIC_API_ORIGIN?.replace(/\/$/, "");
  const nativeShell = process.env.NODE_ENV === "production" && location.hostname === "localhost";
  return `${configured || (nativeShell ? NATIVE_API_ORIGIN : "")}${path}`;
}

export type LeaderboardEntry = {
  name: string;
  best_score: number;
  updated_at: string;
};

export type GameStatus = {
  status: "online";
  players: number;
  rooms: number;
  active_matches: number;
};

export async function fetchLeaderboard(): Promise<LeaderboardEntry[]> {
  return tracked(async () => {
    const r = await fetch(apiUrl("/api/leaderboard"), { credentials: "include" });
    if (!r.ok) return [];
    return r.json();
  });
}

export async function fetchGameStatus(): Promise<GameStatus | null> {
  return tracked(async () => {
    const r = await fetch(apiUrl("/api/status"), { credentials: "include" });
    if (!r.ok) return null;
    return r.json();
  });
}
