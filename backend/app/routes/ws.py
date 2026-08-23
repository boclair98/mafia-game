"""Realtime room protocol for Black Midnight."""

from __future__ import annotations

import json
import secrets
import time
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
    if arena.phase == "lobby" and arena.lobby_mode in {"solo", "first"} and arena.connected_players and not any(
        p.key == player_key for p in arena.players.values()
    ):
        await ws.close(code=4005, reason="solo_room")
        return

    await ws.accept()
    player, resumed = arena.join(ws, chosen_nick, coders_id, player_key)
    await ws.send_text(welcome_message(arena, player, resumed))
    await arena.broadcast()

    try:
        while True:
            try:
                raw_message = await ws.receive_text()
                if len(raw_message) > 8192:
                    continue
                msg = json.loads(raw_message)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if not isinstance(msg, dict):
                continue
            command = msg.get("t")
            now = time.monotonic()
            if command not in {"ping", "voice_signal"} and now - player.last_command_at < 0.12:
                continue
            if command not in {"ping", "voice_signal"}:
                player.last_command_at = now
            arena.touch()
            error: str | None = None
            match command:
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
                case "solo_start":
                    error = arena.solo_start(player.id)
                case "first_start":
                    error = arena.first_start(player.id)
                case "remove_seat":
                    error = arena.remove_lobby_seat(player.id, str(msg.get("target", "")))
                case "start":
                    error = arena.start(player.id)
                case "rematch":
                    error = arena.rematch(player.id)
                case "action":
                    error = arena.act(player.id, str(msg.get("target", "")))
                case "vote":
                    error = arena.vote(player.id, str(msg.get("target", "")))
                case "judge":
                    if not isinstance(msg.get("execute"), bool):
                        error = "잘못된 판결입니다."
                    else:
                        error = arena.judge(player.id, msg["execute"])
                case "react":
                    error = arena.add_reaction(player.id, str(msg.get("emoji", "")))
                case "chat":
                    error = arena.add_chat(player.id, str(msg.get("text", "")))
                case "reveal_lead":
                    error = arena.reveal_private_lead(
                        player.id, str(msg.get("lead_id", ""))
                    )
                case "ghost_predict":
                    error = arena.ghost_predict(
                        player.id, str(msg.get("target", ""))
                    )
                case "memory_seal":
                    error = arena.seal_memory(player.id, str(msg.get("text", "")))
                case "reconstruct":
                    error = arena.reconstruct_scene(player.id, msg.get("order"))
                case "oath":
                    error = arena.make_oath(
                        player.id,
                        str(msg.get("target", "")),
                        str(msg.get("text", "")),
                    )
                case "contract":
                    error = arena.make_contract(
                        player.id,
                        str(msg.get("target", "")),
                        str(msg.get("text", "")),
                    )
                case "contract_response":
                    error = arena.respond_contract(
                        player.id,
                        str(msg.get("contract_id", "")),
                        bool(msg.get("accepted", False)),
                    )
                case "ghost_echo":
                    error = arena.ghost_echo(player.id, str(msg.get("text", "")))
                case "report":
                    error = arena.report_player(
                        player.id,
                        str(msg.get("target", "")),
                        str(msg.get("reason", "")),
                    )
                    if not error:
                        await ws.send_text(json.dumps(
                            {"t": "notice", "message": "신고가 접수되었습니다. 해당 사용자는 즉시 차단할 수도 있습니다."},
                            ensure_ascii=False,
                        ))
                case "question":
                    error = arena.add_question(player.id, str(msg.get("text", "")))
                case "claim":
                    error = arena.add_claim(player.id, str(msg.get("text", "")))
                case "tip":
                    error = arena.add_tip(player.id, str(msg.get("text", "")))
                case "read":
                    error = arena.submit_read(
                        player.id,
                        str(msg.get("target", "")),
                        str(msg.get("stance", "")),
                    )
                case "pressure":
                    error = arena.apply_pressure(
                        player.id, str(msg.get("target", ""))
                    )
                case "will":
                    error = arena.leave_will(player.id, str(msg.get("text", "")))
                case "voice_presence":
                    if not isinstance(msg.get("enabled"), bool):
                        error = "잘못된 음성 채팅 상태입니다."
                    else:
                        error = arena.set_voice_presence(player.id, msg["enabled"])
                case "voice_signal":
                    error = await arena.relay_voice(
                        player.id,
                        str(msg.get("target", "")),
                        msg.get("data"),
                    )
                    if error:
                        await ws.send_text(json.dumps(
                            {"t": "error", "message": error}, ensure_ascii=False
                        ))
                    continue
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
