"use client";

/**
 * Everything overlaid on the canvas: connection status, your score,
 * the optional sign-in corner, and the leaderboard panel.
 *
 * The container is pointer-events-none so the canvas keeps receiving
 * game input; only the genuinely interactive bits opt back in.
 *
 * The sign-in corner is the "optional login" pattern in one place:
 * guests play instantly (the WS handshake is a GET, so the gate never
 * forces sign-in), and the pitch for signing in is a *benefit* — a
 * persistent best score — not a wall.
 */

import { Trophy, X } from "lucide-react";
import { useEffect, useState } from "react";

import { fetchLeaderboard, type LeaderboardEntry } from "@/lib/api";
import { useMe } from "@/lib/identity";
import { signInHref, signOutHref } from "@/lib/identity";
import type { ConnStatus } from "@/lib/ws";

const STATUS_LABEL: Record<ConnStatus, string> = {
  connecting: "connecting…",
  open: "online",
  reconnecting: "reconnecting…",
};

const STATUS_DOT: Record<ConnStatus, string> = {
  connecting: "bg-amber-400",
  open: "bg-emerald-400",
  reconnecting: "bg-amber-400 animate-pulse",
};

type Props = {
  status: ConnStatus;
  score: number;
  online: number;
  room: string;
};

export function Hud({ status, score, online, room }: Props) {
  const me = useMe();
  const [boardOpen, setBoardOpen] = useState(false);
  const [board, setBoard] = useState<LeaderboardEntry[] | null>(null);

  useEffect(() => {
    if (!boardOpen) return;
    let alive = true;
    fetchLeaderboard().then((rows) => {
      if (alive) setBoard(rows);
    });
    return () => {
      alive = false;
    };
  }, [boardOpen]);

  return (
    <div className="pointer-events-none absolute inset-0 z-10 p-4 text-white">
      {/* top-left: status + score */}
      <div className="absolute left-4 top-4 rounded-lg border border-white/10 bg-black/40 px-3.5 py-2.5 backdrop-blur">
        <div className="flex items-center gap-2 text-[12px] text-white/70">
          <span className={`size-2 rounded-full ${STATUS_DOT[status]}`} />
          {STATUS_LABEL[status]}
          <span className="text-white/40">·</span>
          <span>
            {room} — {online} online
          </span>
        </div>
        <div className="mt-1 font-mono text-2xl font-semibold tabular-nums">
          {score}
        </div>
      </div>

      {/* top-right: optional sign-in */}
      <div className="pointer-events-auto absolute right-4 top-4 rounded-lg border border-white/10 bg-black/40 px-3.5 py-2.5 text-right backdrop-blur">
        {me === undefined ? null : me ? (
          <>
            <div className="text-[13px] font-medium">{me.display_name}</div>
            <a
              href={signOutHref()}
              className="text-[11px] text-white/50 hover:text-white/80"
            >
              Sign out
            </a>
          </>
        ) : (
          <>
            <a
              href={signInHref()}
              className="text-[13px] font-medium text-sky-300 hover:text-sky-200"
            >
              Sign in with coders.kr
            </a>
            <div className="text-[11px] text-white/50">
              guests play free — sign in to keep your best score
            </div>
          </>
        )}
      </div>

      {/* bottom-right: leaderboard */}
      <div className="pointer-events-auto absolute bottom-4 right-4 flex flex-col items-end gap-2">
        {boardOpen && (
          <div className="w-64 rounded-lg border border-white/10 bg-black/60 p-3 backdrop-blur">
            <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-white/60">
              Best scores
            </div>
            {board === null ? (
              <div className="text-[13px] text-white/50">loading…</div>
            ) : board.length === 0 ? (
              <div className="text-[13px] text-white/50">
                No scores yet — sign in and set one.
              </div>
            ) : (
              <ol className="space-y-1">
                {board.map((e, i) => (
                  <li
                    key={`${e.name}-${i}`}
                    className="flex items-baseline justify-between text-[13px]"
                  >
                    <span className="truncate">
                      <span className="mr-1.5 font-mono text-white/40">
                        {i + 1}.
                      </span>
                      {e.name}
                    </span>
                    <span className="font-mono tabular-nums text-white/80">
                      {e.best_score}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => setBoardOpen((v) => !v)}
          className="flex items-center gap-1.5 rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-[12px] font-medium backdrop-blur hover:bg-black/60"
        >
          {boardOpen ? <X className="size-3.5" /> : <Trophy className="size-3.5" />}
          {boardOpen ? "Close" : "Leaderboard"}
        </button>
      </div>

      {/* bottom-left: controls hint + host credit */}
      <div className="absolute bottom-4 left-4 text-[11px] leading-relaxed text-white/40">
        <div>WASD / arrows · touch: hold &amp; drag</div>
        <div>
          hosted on{" "}
          <a
            href="https://coders.kr"
            className="pointer-events-auto text-white/60 hover:text-white/90"
          >
            coders.kr
          </a>
        </div>
      </div>
    </div>
  );
}
