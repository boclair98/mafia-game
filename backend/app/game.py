"""In-memory realtime game: rooms, players, orbs, and the tick loop.

The example game is deliberately tiny — an "orb arena" where every
connected player steers a circle and eats orbs for points — but the
*shape* is the one almost every realtime game on this platform wants:

  - **Server-authoritative state.** Clients send *intent* (a normalized
    direction vector); the server integrates positions, detects orb
    pickups, and owns every score. Never trust a client-reported score
    (PLATFORM.md §5c: the gate can't see inside a socket, so message-
    level authorization is entirely on you — here that means inputs can
    only ever move the sender's own player).
  - **A fixed-rate tick per room** (asyncio task) that steps the world
    and broadcasts one snapshot to everyone. The task starts when the
    first player joins and stops when the room empties, so an idle
    deployment does zero work and can scale to zero.
  - **Compact snapshots.** WebSocket traffic is billed by egress bytes
    (PLATFORM.md §5b), so we keep the tick at 15 Hz, round coordinates
    to ints, and send single-letter message keys. If your state grows,
    switch to delta snapshots before you raise the tick rate.

State lives in process memory, which on this platform means: one pod
(rooms are per-process; don't scale the api service out without moving
room state to redis), and state evaporates on redeploy/preemption —
clients must treat a dropped socket as normal and reconnect (the
frontend's lib/ws.ts does).
"""

from __future__ import annotations

import asyncio
import json
import math
import random
import re
import secrets
from dataclasses import dataclass
from uuid import UUID

from fastapi import WebSocket

# ---------------------------------------------------------------- tuning

WORLD_SIZE = 1600  # square world, px
PLAYER_RADIUS = 14
PLAYER_SPEED = 240.0  # px/s
ORB_RADIUS = 7
ORB_COUNT = 30
TICK_HZ = 15  # egress is billed by bytes — raise with care (§5b)

_ROOM_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")

# Distinguishable on the dark arena background.
_PALETTE = [
    "#5eead4", "#93c5fd", "#f9a8d4", "#fcd34d", "#a5b4fc",
    "#86efac", "#fdba74", "#f0abfc", "#7dd3fc", "#fca5a5",
]


def clean_room_name(raw: str | None) -> str:
    """Rooms come from a client-controlled query param — normalize junk
    to the default room instead of 4xx-ing the handshake."""
    if raw and _ROOM_RE.match(raw):
        return raw
    return "lobby"


@dataclass
class Player:
    id: str
    nick: str
    color: str
    ws: WebSocket
    # None ⇒ guest. Sign-in is optional; only signed-in players get
    # their best score persisted at disconnect (routes/ws.py).
    coders_id: UUID | None
    x: float
    y: float
    dx: float = 0.0  # normalized intent, set by the last input message
    dy: float = 0.0
    score: int = 0


@dataclass
class Orb:
    x: float
    y: float


def _rand_pos(margin: float) -> tuple[float, float]:
    return (
        random.uniform(margin, WORLD_SIZE - margin),
        random.uniform(margin, WORLD_SIZE - margin),
    )


class Room:
    """One arena: its players, its orbs, and its tick task."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.players: dict[str, Player] = {}
        self.orbs: list[Orb] = [Orb(*_rand_pos(ORB_RADIUS * 2)) for _ in range(ORB_COUNT)]
        self._task: asyncio.Task | None = None

    # -------------------------------------------------- join/leave/input

    def join(self, ws: WebSocket, nick: str, coders_id: UUID | None) -> Player:
        pid = secrets.token_urlsafe(6)
        x, y = _rand_pos(PLAYER_RADIUS * 4)
        player = Player(
            id=pid,
            nick=nick,
            color=_PALETTE[len(self.players) % len(_PALETTE)],
            ws=ws,
            coders_id=coders_id,
            x=x,
            y=y,
        )
        self.players[pid] = player
        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(self._run())
        return player

    def leave(self, pid: str) -> None:
        self.players.pop(pid, None)
        # The tick loop notices the room is empty and exits on its own.

    def set_input(self, pid: str, dx: float, dy: float) -> None:
        """Clamp the client's intent to a unit vector — the *only* thing
        a message is allowed to change, and only for the sender."""
        p = self.players.get(pid)
        if p is None:
            return
        mag = math.hypot(dx, dy)
        if mag > 1e-6:
            scale = min(mag, 1.0) / mag
            p.dx, p.dy = dx * scale, dy * scale
        else:
            p.dx = p.dy = 0.0

    # ------------------------------------------------------- tick loop

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        tick = 1.0 / TICK_HZ
        next_at = loop.time()
        while self.players:
            self._step(tick)
            await self._broadcast(self._snapshot())
            next_at += tick
            await asyncio.sleep(max(0.0, next_at - loop.time()))

    def _step(self, dt: float) -> None:
        for p in self.players.values():
            p.x = min(max(p.x + p.dx * PLAYER_SPEED * dt, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS)
            p.y = min(max(p.y + p.dy * PLAYER_SPEED * dt, PLAYER_RADIUS), WORLD_SIZE - PLAYER_RADIUS)
            # Orb pickup: server-side collision is what makes the score
            # authoritative.
            reach = PLAYER_RADIUS + ORB_RADIUS
            for orb in self.orbs:
                if abs(orb.x - p.x) < reach and abs(orb.y - p.y) < reach:
                    if math.hypot(orb.x - p.x, orb.y - p.y) < reach:
                        p.score += 1
                        orb.x, orb.y = _rand_pos(ORB_RADIUS * 2)

    def _snapshot(self) -> str:
        """One state frame, JSON-encoded once and fanned out to everyone.
        Ints only — snapshot bytes are the game's whole egress bill."""
        return json.dumps(
            {
                "t": "state",
                "players": [
                    {
                        "id": p.id,
                        "n": p.nick,
                        "c": p.color,
                        "x": round(p.x),
                        "y": round(p.y),
                        "s": p.score,
                    }
                    for p in self.players.values()
                ],
                "orbs": [[round(o.x), round(o.y)] for o in self.orbs],
            },
            separators=(",", ":"),
        )

    async def _broadcast(self, text: str) -> None:
        # A send to a half-closed socket raises — swallow it here and let
        # that connection's own receive loop run the disconnect path.
        await asyncio.gather(
            *(p.ws.send_text(text) for p in list(self.players.values())),
            return_exceptions=True,
        )


class RoomManager:
    def __init__(self) -> None:
        self._rooms: dict[str, Room] = {}

    def get(self, name: str) -> Room:
        room = self._rooms.get(name)
        if room is None:
            room = self._rooms[name] = Room(name)
        return room

    def sweep(self, name: str) -> None:
        """Drop a room once its last player left so memory doesn't grow
        with every room name ever visited."""
        room = self._rooms.get(name)
        if room is not None and not room.players:
            self._rooms.pop(name, None)

    @property
    def online(self) -> int:
        return sum(len(r.players) for r in self._rooms.values())


rooms = RoomManager()


def welcome_message(room: Room, player: Player) -> str:
    """Everything the client needs to draw before the first snapshot."""
    return json.dumps(
        {
            "t": "welcome",
            "id": player.id,
            "nick": player.nick,
            "signed_in": player.coders_id is not None,
            "room": room.name,
            "world": {
                "size": WORLD_SIZE,
                "player_r": PLAYER_RADIUS,
                "orb_r": ORB_RADIUS,
                "tick_hz": TICK_HZ,
            },
        },
        separators=(",", ":"),
    )
