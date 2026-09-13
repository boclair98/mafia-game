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

export type PassportMission = {
  id: string;
  title: string;
  copy: string;
  progress: number;
  target: number;
  complete: boolean;
};

export type PassportBadge = {
  id: string;
  title: string;
  copy: string;
  unlocked: boolean;
};

export type PassportCase = {
  id: string;
  case_code: string;
  case_title: string;
  mode: "solo" | "party" | string;
  winner: string;
  score: number;
  grade: string;
  xp_earned: number;
  timeline_score: number;
  social_actions: number;
  badges: string[];
  completed_at: string;
};

export type Passport = {
  investigator: {
    display_name: string;
    level: number;
    xp: number;
    level_xp: number;
    next_level_xp: number;
    cases_played: number;
    cases_won: number;
    solo_cases: number;
    party_cases: number;
    best_score: number;
    current_streak: number;
    best_streak: number;
  };
  daily_missions: PassportMission[];
  badges: PassportBadge[];
  recent_cases: PassportCase[];
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

export async function fetchPassport(): Promise<Passport | null> {
  return tracked(async () => {
    const r = await fetch(apiUrl("/api/passport"), { credentials: "include" });
    if (!r.ok) return null;
    return r.json();
  });
}
