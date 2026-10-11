"""WebSocket behavior for the social deduction room."""

from __future__ import annotations

import asyncio
import json
from urllib.parse import quote
from uuid import uuid4

import pytest
from app.core.config import settings
from app.game import MAX_PLAYERS, MIN_PLAYERS, Player, RoomManager, rooms
from app.main import app
from app.routes.ws import game_socket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect


@pytest.fixture(autouse=True)
def _really_anonymous(monkeypatch):
    monkeypatch.setattr(settings, "dev_fake_user", None)


def test_guest_can_join_and_receive_lobby_state():
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws?room=night-test&nick=철수&key=abcdefgh1234") as ws:
            welcome = ws.receive_json()
            state = ws.receive_json()
            assert welcome["t"] == "welcome"
            assert welcome["nick"] == "철수"
            assert state["phase"] == "lobby"
            assert state["min_players"] == MIN_PLAYERS
            assert state["me"]["role"] == "citizen"


def test_join_only_rejects_missing_room_without_creating_it():
    room_name = f"missing-{uuid4().hex[:8]}"
    with TestClient(app) as client:
        with client.websocket_connect(f"/api/ws?room={room_name}&join_only=true") as ws:
            with pytest.raises(WebSocketDisconnect) as failure:
                ws.receive_json()
        assert failure.value.code == 4007
        assert rooms.find(room_name) is None


@pytest.mark.parametrize("condition,expected_code", [
    ("room_full", 4004),
    ("solo_room", 4005),
    ("connections_full", 4006),
    ("rooms_full", 4006),
])
def test_room_rejections_accept_handshake_then_send_application_close(monkeypatch, condition, expected_code):
    manager = RoomManager(max_rooms=1 if condition == "rooms_full" else 5)
    monkeypatch.setattr("app.routes.ws.rooms", manager)
    name = "solo-reject" if condition == "solo_room" else "reject-test"
    arena = manager.get(name)
    if condition == "rooms_full":
        name = "another-room"
    else:
        for index in range(MAX_PLAYERS if condition == "room_full" else 1):
            arena.players[str(index)] = Player(
                id=str(index), key=f"existing-key-{index}", nick=f"P{index}",
                coders_id=None, ws=None,
            )
    if condition == "connections_full":
        monkeypatch.setattr(settings, "max_connections", 1)
    with TestClient(app) as client:
        # Entering the context proves the ASGI accept preceded the close.
        with client.websocket_connect(f"/api/ws?room={name}&key=new-player-key") as ws:
            with pytest.raises(WebSocketDisconnect) as failure:
                ws.receive_json()
            assert failure.value.code == expected_code


@pytest.mark.parametrize("condition,expected_code", [
    ("room_full", 4004), ("solo_room", 4005), ("connections_full", 4006),
])
async def test_accept_barrier_cannot_overbook_admission(monkeypatch, condition, expected_code):
    manager = RoomManager()
    monkeypatch.setattr("app.routes.ws.rooms", manager)
    name = "solo-barrier" if condition == "solo_room" else "barrier-room"
    arena = manager.get(name)
    for index in range(MAX_PLAYERS - 1 if condition == "room_full" else 0):
        arena.players[str(index)] = Player(
            id=str(index), key=f"barrier-existing-{index}", nick=f"P{index}",
            coders_id=None, ws=None,
        )
    if condition == "connections_full":
        monkeypatch.setattr(settings, "max_connections", 1)
    both_accepting, release, finish, settled = (asyncio.Event() for _ in range(4))
    arrivals = 0
    outcomes = 0

    class BarrierSocket:
        headers = {}

        def __init__(self):
            self.frames = []
            self.close_code = None

        async def accept(self):
            nonlocal arrivals
            arrivals += 1
            if arrivals == 2:
                both_accepting.set()
            await release.wait()

        def outcome(self):
            nonlocal outcomes
            outcomes += 1
            if outcomes == 2:
                settled.set()

        async def close(self, code, reason):
            self.close_code = code
            self.outcome()

        async def send_text(self, payload):
            self.frames.append(json.loads(payload))

        async def receive_text(self):
            self.outcome()
            await finish.wait()
            raise WebSocketDisconnect(code=1000)

    sockets = [BarrierSocket(), BarrierSocket()]
    tasks = [asyncio.create_task(game_socket(
        socket, room=name, nick=f"참가{index}", key=f"barrier-new-key-{index}", join_only=False,
    )) for index, socket in enumerate(sockets)]
    try:
        await asyncio.wait_for(both_accepting.wait(), 2)
        release.set()
        await asyncio.wait_for(settled.wait(), 2)
        welcomes = [frame for socket in sockets for frame in socket.frames if frame.get("t") == "welcome"]
        assert len(welcomes) == 1
        assert [socket.close_code for socket in sockets].count(expected_code) == 1
        assert len(arena.players) == (MAX_PLAYERS if condition == "room_full" else 1)
        assert all(player.role != "spectator" for player in arena.players.values())
    finally:
        release.set()
        finish.set()
        results = await asyncio.gather(*tasks, return_exceptions=True)
        assert all(result is None for result in results)


async def test_join_only_rechecks_room_removed_during_accept(monkeypatch):
    manager = RoomManager()
    monkeypatch.setattr("app.routes.ws.rooms", manager)
    manager.get("vanishing-room")

    class VanishingSocket:
        headers = {}
        close_code = None

        async def accept(self):
            manager.sweep("vanishing-room")

        async def close(self, code, reason):
            self.close_code = code

    socket = VanishingSocket()
    await game_socket(socket, room="vanishing-room", nick="참가", key="vanishing-test-key", join_only=True)
    assert socket.close_code == 4007
    assert manager.find("vanishing-room") is None


def test_join_only_enters_existing_room_and_can_resume_same_seat():
    room_name = f"invite-{uuid4().hex[:8]}"
    with TestClient(app) as client:
        with client.websocket_connect(f"/api/ws?room={room_name}&key=invite-host-1234") as host:
            host.receive_json()
            host.receive_json()
            url = f"/api/ws?room={room_name}&key=invite-guest-1234&join_only=true"
            with client.websocket_connect(url) as guest:
                original = guest.receive_json()
                guest.receive_json()
                with client.websocket_connect(url) as resumed:
                    welcome = resumed.receive_json()
                    assert welcome["id"] == original["id"]
                    assert welcome["resumed"] is True
                    assert resumed.receive_json()["phase"] == "lobby"


@pytest.mark.parametrize("command,phase,storage,fields", [
    ("action", "night", "actions", {"target": "target"}),
    ("vote", "vote", "votes", {"target": "target"}),
    ("vote", "vote", "votes", {"target": "skip"}),
    ("judge", "verdict", "judgements", {"execute": True}),
])
@pytest.mark.parametrize("missing", [False, True])
def test_decisions_require_current_phase_id_even_when_phase_name_repeats(command, phase, storage, fields, missing):
    room_name = f"phase-test-{uuid4().hex[:8]}"
    with TestClient(app) as client:
        with client.websocket_connect(f"/api/ws?room={room_name}&key=phase-test-key") as ws:
            welcome = ws.receive_json()
            ws.receive_json()
            arena = rooms.get(room_name)
            actor = arena.players[welcome["id"]]
            actor.role = "mafia"
            arena.players["target"] = Player(
                id="target", key="target-seat-key", nick="대상",
                coders_id=None, ws=None,
            )
            arena.accused_id = "target"
            arena._set_phase(phase, 30)
            old_phase_id = arena.phase_id
            arena._set_phase("day", 30)
            arena._set_phase(phase, 30)
            packet = {"t": command, **fields}
            if not missing:
                packet["phase_id"] = old_phase_id
            ws.send_json(packet)
            for _ in range(5):
                rejected = ws.receive_json()
                if rejected["t"] == "error":
                    assert rejected["code"] == "stale_phase"
                    break
            else:
                pytest.fail("obsolete decision was not rejected")
            assert getattr(arena, storage) == {}
            while True:
                refreshed = ws.receive_json()
                if refreshed["t"] == "state" and refreshed["phase_id"] == arena.phase_id:
                    break
            assert isinstance(refreshed["server_now"], int)
            actor.last_command_at = 0
            current_packet = {"t": command, **fields, "phase_id": arena.phase_id}
            ws.send_json(current_packet)
            while True:
                accepted = ws.receive_json()
                if accepted["t"] == "state" and getattr(arena, storage):
                    break
            expected = dict(getattr(arena, storage))
            # A duplicate delivery changes neither the selected value nor the
            # game log. Ping acknowledges that the queued replay was consumed.
            original_log = list(arena.case_log)
            actor.last_command_at = 0
            ws.send_json(current_packet)
            ws.send_json({"t": "ping"})
            while ws.receive_json()["t"] != "pong":
                pass
            assert getattr(arena, storage) == expected
            assert list(arena.case_log) == original_log


def test_ghost_chat_socket_permissions_and_private_delivery():
    room_name = f"ghost-chat-{uuid4().hex[:8]}"
    with TestClient(app) as client:
        with client.websocket_connect(f"/api/ws?room={room_name}&key=ghost-host-key") as first:
            first_id = first.receive_json()["id"]
            first.receive_json()
            with client.websocket_connect(f"/api/ws?room={room_name}&key=ghost-living-key") as second:
                second.receive_json()
                second.receive_json()
                arena = rooms.get(room_name)
                first.send_json({"t": "ghost_chat", "text": "생존자의 접근 시도"})
                for _ in range(5):
                    rejected = first.receive_json()
                    if rejected["t"] == "error":
                        assert "사망자와 관전자만" in rejected["message"]
                        break
                else:
                    pytest.fail("living socket was allowed to post ghost chat")
                assert list(arena.ghost_chat) == []
                arena._set_phase("day", 30)
                arena.players[first_id].alive = False
                arena.players[first_id].last_command_at = 0
                first.send_json({"t": "ghost_chat", "text": "사후 수사실 비밀"})
                for _ in range(5):
                    private_state = first.receive_json()
                    if private_state["t"] == "state" and private_state["ghost_chat"]:
                        assert private_state["ghost_chat"][-1]["text"] == "사후 수사실 비밀"
                        break
                else:
                    pytest.fail("ghost socket did not receive private chat")
                living_state = second.receive_json()
                assert living_state["ghost_chat"] == []
                assert living_state["chat"] == []
                with client.websocket_connect(f"/api/ws?room={room_name}&key=ghost-observer-key") as observer:
                    observer.receive_json()
                    state = observer.receive_json()
                    assert state["me"]["role"] == "spectator"
                    assert state["ghost_chat"][-1]["text"] == "사후 수사실 비밀"


def test_signed_in_name_is_trusted_from_gate_header():
    headers = {
        "X-Coders-User": str(uuid4()),
        "X-Coders-User-Name": quote("김탐정"),
    }
    with TestClient(app) as client:
        with client.websocket_connect(
            "/api/ws?room=auth-test&nick=가짜이름&key=abcdefgh5678", headers=headers
        ) as ws:
            assert ws.receive_json()["nick"] == "김탐정"


def test_same_player_key_resumes_seat():
    url = "/api/ws?room=resume-test&nick=재접속&key=resume-key-1234"
    with TestClient(app) as client:
        with client.websocket_connect(url) as first:
            original = first.receive_json()
            first.receive_json()
        with client.websocket_connect(url) as second:
            resumed = second.receive_json()
            # Lobby departures release their seat; active matches retain it.
            assert resumed["t"] == "welcome"
            assert resumed["nick"] == original["nick"]


def test_gameover_reconnect_restores_host_and_accepts_rematch():
    room_name = f"rematch-resume-{uuid4().hex[:8]}"
    url = f"/api/ws?room={room_name}&key=rematch-resume-key"
    with TestClient(app) as client:
        with client.websocket_connect(url) as original:
            original_id = original.receive_json()["id"]
            original.receive_json()
            arena = rooms.get(room_name)
            assert arena.fill_bots(original_id, 4) is None
            arena._set_phase("gameover", 0)
        assert arena.host_id is None
        with client.websocket_connect(url) as resumed:
            assert resumed.receive_json()["id"] == original_id
            state = resumed.receive_json()
            assert state["host"] == original_id
            assert state["phase"] == "gameover"
            resumed.send_json({"t": "rematch"})
            for _ in range(5):
                state = resumed.receive_json()
                if state["t"] == "state" and state["phase"] == "lobby":
                    assert state["host"] == original_id
                    break
            else:
                pytest.fail("resumed host could not start a rematch lobby")


@pytest.mark.parametrize("phase", ["lobby", "day"])
def test_overlapping_reconnect_closes_old_socket_and_keeps_new_seat(phase):
    room_name = f"overlap-{phase}-{uuid4().hex[:8]}"
    url = f"/api/ws?room={room_name}&nick=재접속&key=overlap-key-1234"
    with TestClient(app) as client:
        with client.websocket_connect(url) as first:
            original = first.receive_json()
            first.receive_json()
            rooms.get(room_name).phase = phase
            with client.websocket_connect(url) as second:
                resumed = second.receive_json()
                state = second.receive_json()
                assert resumed["resumed"] is True
                assert resumed["id"] == original["id"]
                assert state["host"] == original["id"]
                assert state["players"][0]["connected"] is True
                assert first.receive()["code"] == 4001
                second.send_json({"t": "ping"})
                for _ in range(4):
                    if second.receive_json()["t"] == "pong":
                        break
                else:
                    pytest.fail("resumed socket stopped after old connection closed")


def test_only_host_can_start_and_minimum_is_enforced():
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws?room=start-test&nick=방장&key=host-key-1234") as ws:
            ws.receive_json()
            ws.receive_json()
            ws.send_json({"t": "start"})
            for _ in range(5):
                msg = ws.receive_json()
                if msg["t"] == "error":
                    assert "최소" in msg["message"]
                    return
            pytest.fail("minimum-player error was not returned")


def test_ping_gets_pong():
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws?nick=핑&key=ping-key-12345") as ws:
            ws.receive_json()
            ws.receive_json()
            ws.send_json({"t": "ping"})
            # The one-second room snapshot can already be queued ahead of
            # the direct pong; ordering between the ticker and this client
            # frame is intentionally not guaranteed.
            for _ in range(4):
                if ws.receive_json()["t"] == "pong":
                    return
            pytest.fail("pong was not returned")
