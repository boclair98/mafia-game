"""Realtime room protocol for Black Midnight."""

from __future__ import annotations

import json
import secrets
import urllib.parse
from uuid import UUID

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.core.config import settings
from app.game import (
    MAX_PLAYERS,
    clean_nick,
    clean_player_key,
    clean_room_name,
    rooms,
    welcome_message,
)
from app.routes.leaderboard import persist_best_score

router = APIRouter()


def _socket_identity(ws: WebSocket) -> tuple[UUID | None, str | None]:
    raw = ws.headers.get("x-coders-user") or settings.dev_fake_user
    try:
        coders_id = UUID(raw) if raw else None
    except ValueError:
        coders_id = None
    name = ws.headers.get("x-coders-user-name")
    display = urllib.parse.unquote(name).strip() if name else ""
    return coders_id, display or None


@router.websocket("/api/ws")
async def game_socket(
    ws: WebSocket,
    room: str = Query(default="lobby"),
    nick: str | None = Query(default=None),
    key: str | None = Query(default=None),
) -> None:
    coders_id, platform_name = _socket_identity(ws)
    fallback = platform_name or f"익명-{secrets.token_hex(2)}"
    chosen_nick = clean_nick(platform_name or nick, fallback)
    player_key = clean_player_key(key)
    arena = rooms.get(clean_room_name(room))

    if arena.phase == "lobby" and len(arena.players) >= MAX_PLAYERS and not any(
        p.key == player_key for p in arena.players.values()
    ):
        await ws.close(code=4004, reason="room_full")
        return

    await ws.accept()
    player, resumed = arena.join(ws, chosen_nick, coders_id, player_key)
    await ws.send_text(welcome_message(arena, player, resumed))
    await arena.broadcast()

    try:
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if not isinstance(msg, dict):
                continue
            error: str | None = None
            match msg.get("t"):
                case "ready":
                    arena.toggle_ready(player.id)
                case "pace":
                    error = arena.set_pace(player.id, str(msg.get("pace", "")))
                case "fill_bots":
                    try:
                        target = int(msg.get("target", 6))
                    except (TypeError, ValueError):
                        target = 6
                    error = arena.fill_bots(player.id, target)
                case "start":
                    error = arena.start(player.id)
                case "rematch":
                    error = arena.rematch(player.id)
                case "action":
                    error = arena.act(player.id, str(msg.get("target", "")))
                case "vote":
                    error = arena.vote(player.id, str(msg.get("target", "")))
                case "chat":
                    error = arena.add_chat(player.id, str(msg.get("text", "")))
                case "ping":
                    await ws.send_text('{"t":"pong"}')
                    continue
                case _:
                    continue
            if error:
                await ws.send_text(json.dumps({"t": "error", "message": error}, ensure_ascii=False))
            await arena.broadcast()
    except WebSocketDisconnect:
        pass
    finally:
        arena.leave(player.id)
        rooms.sweep(arena.name)
        await arena.broadcast()
        if coders_id is not None and player.score > 0:
            await persist_best_score(coders_id, platform_name, player.score)
