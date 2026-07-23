"use client";

/**
 * The game page: one fullscreen canvas + a HUD, glued to the server by
 * a reconnecting WebSocket.
 *
 * Data flow, one direction each way:
 *   input   GameCanvas → onInput → GameSocket → server
 *   state   server → GameSocket → StateBuffer → GameCanvas (via rAF)
 *
 * Only slow-changing scalars (status, score, player count) go through
 * React state — the 15 Hz world snapshots bypass React entirely via
 * the StateBuffer so nothing re-renders per tick.
 *
 * Rooms: /?room=<name> picks an arena; everyone with the same link
 * shares a world. The server sanitizes junk names to "lobby".
 */

import { useEffect, useRef, useState } from "react";

import { GameCanvas } from "@/components/GameCanvas";
import { Hud } from "@/components/Hud";
import { StateBuffer, type StateMsg, type WelcomeMsg, type WorldMeta } from "@/lib/game";
import { type ConnStatus, GameSocket, gameSocketUrl } from "@/lib/ws";

export default function GamePage() {
  // One StateBuffer for the page's lifetime (lazy state, not a ref —
  // reading/writing a ref during render trips react-hooks/refs).
  const [buffer] = useState(() => new StateBuffer());
  const socketRef = useRef<GameSocket | null>(null);

  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [meta, setMeta] = useState<WorldMeta | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [room, setRoom] = useState("lobby");
  const [score, setScore] = useState(0);
  const [online, setOnline] = useState(0);

  useEffect(() => {
    // Read the room from the URL on the client — this page is a static
    // export, so there's no server to do it for us.
    const roomParam =
      new URLSearchParams(window.location.search).get("room") ?? "lobby";

    let myId: string | null = null;

    const socket = new GameSocket(gameSocketUrl(roomParam), {
      onStatus: setStatus,
      onMessage: (raw) => {
        const msg = raw as WelcomeMsg | StateMsg | { t: string };
        if (msg.t === "welcome") {
          const w = msg as WelcomeMsg;
          // A reconnect is a fresh join: new player id, same world.
          myId = w.id;
          setSelfId(w.id);
          setMeta(w.world);
          setRoom(w.room);
        } else if (msg.t === "state") {
          const s = msg as StateMsg;
          buffer.push(s);
          // React bails out when these don't actually change, so
          // setting them at tick rate is fine.
          setOnline(s.players.length);
          const mine = s.players.find((p) => p.id === myId);
          if (mine) setScore(mine.s);
        }
      },
    });
    socketRef.current = socket;
    return () => socket.close();
  }, [buffer]);

  return (
    <div className="relative h-full w-full">
      <GameCanvas
        buffer={buffer}
        meta={meta}
        selfId={selfId}
        onInput={(dx, dy) => socketRef.current?.send({ t: "input", dx, dy })}
      />
      <Hud status={status} score={score} online={online} room={room} />
    </div>
  );
}
