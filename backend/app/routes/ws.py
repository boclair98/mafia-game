"""The game WebSocket: /api/ws?room=<name>.

Identity on a socket works exactly like it does on HTTP — the platform
gate validates the visitor's cookie on the *handshake* (a GET) and
stamps `X-Coders-User` / `X-Coders-User-Name` before it reaches us —
with two twists (PLATFORM.md §5c):

  - The handshake is a GET, so the gate never forces sign-in. Anonymous
    visitors connect fine → sign-in is naturally OPTIONAL here. Guests
    play under a generated nick; signed-in players keep their coders.kr
    name and get their best score persisted on disconnect.
  - After the upgrade the gate sees no individual messages, so every
    state-changing message must be authorized in this handler. Our
    message surface makes that trivial: an `input` can only ever steer
    the sender's own player (app/game.py keys players by connection).

Wire protocol (JSON text frames, single-letter type key to keep egress
bytes down — WebSockets are billed by bytes, §5b):

  client → server   {"t":"input","dx":<-1..1>,"dy":<-1..1>}   steer
                    {"t":"ping"}                              keepalive
  server → client   {"t":"welcome",...}   once, on join (see game.py)
                    {"t":"state",...}     every tick, whole room
                    {"t":"pong"}          reply to ping
"""

from __future__ import annotations

import json
import secrets
import urllib.parse
from uuid import UUID

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.core.config import settings
from app.game import clean_room_name, rooms, welcome_message
from app.routes.leaderboard import persist_best_score

router = APIRouter()


def _socket_identity(ws: WebSocket) -> tuple[UUID | None, str | None]:
    """(coders_id, platform display name) from the handshake headers.

    Same trust story as app/core/identity.py: the gate strips any
    client-sent X-Coders-User before forwarding, so a value here came
    from a validated session. FastAPI's Header() dependencies don't run
    on WebSocket routes, hence the manual read.
    """
    raw = ws.headers.get("x-coders-user") or settings.dev_fake_user
    try:
        coders_id = UUID(raw) if raw else None
    except ValueError:
        coders_id = None
    name = ws.headers.get("x-coders-user-name")
    # URL-encoded on the wire (headers are ASCII, names may be Unicode).
    display = urllib.parse.unquote(name).strip() if name else ""
    return coders_id, display or None


@router.websocket("/api/ws")
async def game_socket(ws: WebSocket, room: str = Query(default="lobby")) -> None:
    coders_id, platform_name = _socket_identity(ws)
    if coders_id is not None:
        nick = platform_name or f"user-{str(coders_id)[:8]}"
    else:
        nick = f"guest-{secrets.token_hex(2)}"

    await ws.accept()
    arena = rooms.get(clean_room_name(room))
    player = arena.join(ws, nick=nick, coders_id=coders_id)
    await ws.send_text(welcome_message(arena, player))

    try:
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue  # garbage frame — ignore, don't kill the session
            if not isinstance(msg, dict):
                continue
            match msg.get("t"):
                case "input":
                    try:
                        dx, dy = float(msg.get("dx", 0)), float(msg.get("dy", 0))
                    except (TypeError, ValueError):
                        continue
                    arena.set_input(player.id, dx, dy)
                case "ping":
                    # App-level keepalive: helps intermediaries keep a
                    # quiet socket open (PLATFORM.md §5a), and an idle
                    # socket is ~free (billed by bytes, not open-time).
                    await ws.send_text('{"t":"pong"}')
    except WebSocketDisconnect:
        pass
    finally:
        arena.leave(player.id)
        rooms.sweep(arena.name)
        # Dropped sockets are *normal* here (spot preemption, redeploys,
        # idle scale-down) — this finally block is the one reliable
        # "session over" hook, so the best-score persist lives here.
        if coders_id is not None and player.score > 0:
            await persist_best_score(coders_id, platform_name, player.score)
