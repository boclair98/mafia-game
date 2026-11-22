"""Realtime rooms with persistence-before-confirmation semantics."""
from __future__ import annotations

import asyncio
import json
import secrets
import time
import urllib.parse
from uuid import UUID

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from app.core.config import settings
from app.core.voice_ice import voice_configuration
from app.game import (
    MAX_PLAYERS,
    Player,
    Room,
    RoomCapacityError,
    RoomRecoveringError,
    clean_nick,
    clean_player_key,
    clean_room_name,
    rooms,
    welcome_message,
)
from app.routes.leaderboard import persist_best_score

router = APIRouter()


async def _reject_socket(ws: WebSocket, code: int, reason: str) -> None:
    await ws.accept()
    await ws.close(code=code, reason=reason)


def _socket_identity(ws: WebSocket) -> tuple[UUID | None, str | None]:
    raw = ws.headers.get("x-coders-user") or settings.dev_fake_user
    try:
        coders_id = UUID(raw) if raw else None
    except ValueError:
        coders_id = None
    name = ws.headers.get("x-coders-user-name")
    display = urllib.parse.unquote(name).strip() if name else ""
    return coders_id, display or None


def _admission(arena: Room, player_key: str, coders_id: UUID | None):
    existing = next((p for p in arena.players.values() if p.key == player_key), None)
    if existing is not None and existing.coders_id is not None and existing.coders_id != coders_id:
        return 4009, "seat_unauthorized"
    if existing is None and rooms.online >= settings.max_connections:
        return 4006, "server_busy"
    if existing is None and arena.phase == "lobby":
        if sum(p.role != "spectator" for p in arena.players.values()) >= MAX_PLAYERS:
            return 4004, "room_full"
        if arena.lobby_mode in {"solo", "first"} and arena.connected_players:
            return 4005, "solo_room"
    if existing is None and arena.phase != "lobby":
        if sum(p.role == "spectator" for p in arena.players.values()) >= settings.max_spectators_per_room:
            return 4004, "room_full"
    return None


def _apply_game_command(arena: Room, player: Player, msg: dict) -> tuple[str | None, str | None]:
    command = msg.get("t")
    error = notice = None
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
        case "ghost_chat":
            error = arena.add_ghost_chat(player.id, str(msg.get("text", "")))
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
        case "theory":
            error = arena.submit_theory(
                player.id,
                str(msg.get("target", "")),
                str(msg.get("clue_id", "")),
                str(msg.get("fragment_id", "")),
                msg.get("stake"),
            )
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
                notice = "신고가 접수되었습니다. 해당 사용자는 즉시 차단할 수도 있습니다."
        case "question":
            error = arena.add_question(player.id, str(msg.get("text", "")))
        case "claim":
            error = arena.add_claim(player.id, str(msg.get("text", "")))
        case "challenge":
            if not all(isinstance(msg.get(field), str) for field in ("claim_id", "clue_id", "text")):
                error = "공식 진술·공개 기록·질문 형식을 확인해 주세요."
            else:
                error = arena.challenge_claim(
                    player.id, msg["claim_id"], msg["clue_id"], msg["text"],
                )
        case "challenge_reply":
            if not all(isinstance(msg.get(field), str) for field in ("challenge_id", "text", "kind")):
                error = "답변할 질문과 설명 형식을 확인해 주세요."
            else:
                error = arena.reply_challenge(
                    player.id, msg["challenge_id"], msg["text"], msg["kind"],
                )
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
        case _:
            return None, None
    return error, notice


@router.websocket("/api/ws")
async def game_socket(
    ws: WebSocket,
    room: str = Query(default="lobby"),
    nick: str | None = Query(default=None),
    key: str | None = Query(default=None),
    join_only: bool = Query(default=False),
) -> None:
    if not rooms.persistence_ready:
        await _reject_socket(ws, 4008, "room_recovering")
        return
    coders_id, platform_name = _socket_identity(ws)
    chosen_nick = clean_nick(platform_name or nick, platform_name or f"익명-{secrets.token_hex(2)}")
    player_key, room_name = clean_player_key(key), clean_room_name(room)
    try:
        arena = rooms.find(room_name) if join_only else rooms.get(room_name)
    except RoomCapacityError:
        await _reject_socket(ws, 4006, "server_busy")
        return
    if arena is None:
        await _reject_socket(ws, 4007, "room_not_found")
        return
    rejection = _admission(arena, player_key, coders_id)
    if rejection:
        await _reject_socket(ws, *rejection)
        return
    await ws.accept()
    player = None
    voice_config_at = float("-inf")
    try:
        if not rooms.persistence_ready:
            raise RoomRecoveringError("room_recovering")
        try:
            arena = rooms.find(room_name) if join_only else rooms.get(room_name)
        except RoomCapacityError:
            await ws.close(code=4006, reason="server_busy")
            return
        if arena is None:
            await ws.close(code=4007, reason="room_not_found")
            return
        async with arena.mutation_lock:
            if not rooms.persistence_ready or rooms.find(room_name) is not arena:
                raise RoomRecoveringError("room_recovering")
            rejection = _admission(arena, player_key, coders_id)
            if rejection:
                await ws.close(code=rejection[0], reason=rejection[1])
                return
            previous_socket = next((p.ws for p in arena.players.values() if p.key == player_key), None)
            player, resumed = arena.join(ws, chosen_nick, coders_id, player_key)
            await arena.commit()
            if previous_socket is not None and previous_socket is not ws:
                try:
                    await previous_socket.close(code=4001, reason="session_replaced")
                except (RuntimeError, WebSocketDisconnect):
                    pass
            await ws.send_text(welcome_message(arena, player, resumed))
            await arena._broadcast_committed()
        while True:
            try:
                raw_message = await ws.receive_text()
                if player.ws is not ws or not player.connected:
                    break
                if len(raw_message.encode("utf-8")) > 8192:
                    continue
                msg = json.loads(raw_message)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if not isinstance(msg, dict):
                continue
            if not rooms.persistence_ready:
                raise RoomRecoveringError("room_recovering")
            command, now = msg.get("t"), time.monotonic()
            # Transient traffic never consumes the gameplay throttle or writes
            # checkpoints. ICE configuration has its own per-socket rate limit.
            if command == "ping":
                await ws.send_text('{"t":"pong"}')
                continue
            if command == "voice_config":
                if now - voice_config_at >= 1.0:
                    voice_config_at = now
                    await ws.send_text(json.dumps(voice_configuration(), ensure_ascii=False))
                continue
            if command == "voice_signal":
                async with arena.mutation_lock:
                    if not rooms.persistence_ready or rooms.find(room_name) is not arena:
                        raise RoomRecoveringError("room_recovering")
                    error = await asyncio.wait_for(
                        arena.relay_voice(player.id, str(msg.get("target", "")), msg.get("data"), msg.get("scope")),
                        timeout=settings.broadcast_timeout,
                    )
                    if error:
                        await ws.send_text(json.dumps({"t": "error", "message": error}, ensure_ascii=False))
                continue
            if now - player.last_command_at < 0.12:
                continue
            async with arena.mutation_lock:
                if not rooms.persistence_ready or rooms.find(room_name) is not arena:
                    raise RoomRecoveringError("room_recovering")
                if player.ws is not ws or not player.connected:
                    break
                player.last_command_at = now
                if command in {"action", "vote", "judge", "challenge", "challenge_reply"} and msg.get("phase_id") != arena.phase_id:
                    await ws.send_text(json.dumps({
                        "t": "error", "code": "stale_phase",
                        "message": "진행 단계가 바뀌었습니다. 최신 화면에서 다시 선택하세요. 계속되면 새로고침해 주세요.",
                    }, ensure_ascii=False))
                    await ws.send_text(json.dumps(arena._state_for(player), ensure_ascii=False, separators=(",", ":")))
                    continue
                arena.touch()
                error, notice = _apply_game_command(arena, player, msg)
                await arena.commit()
                if error:
                    await ws.send_text(json.dumps({"t": "error", "message": error}, ensure_ascii=False))
                if notice:
                    await ws.send_text(json.dumps({"t": "notice", "message": notice}, ensure_ascii=False))
                await arena._broadcast_committed()
    except (TimeoutError, WebSocketDisconnect, asyncio.CancelledError):
        pass
    except RoomRecoveringError:
        try:
            await ws.close(code=4008, reason="room_recovering")
        except (RuntimeError, WebSocketDisconnect):
            pass
    finally:
        if player is not None and arena is not None:
            try:
                async with arena.mutation_lock:
                    if not rooms.persistence_ready or rooms.find(room_name) is not arena:
                        raise RoomRecoveringError("room_recovering")
                    released = arena.leave(player.id, ws)
                    if released:
                        await arena.commit()
                        await arena._broadcast_committed()
                rooms.sweep(arena.name)
                if released and coders_id is not None and player.score > 0:
                    await persist_best_score(coders_id, platform_name, player.score)
            except (RoomRecoveringError, asyncio.CancelledError):
                pass
