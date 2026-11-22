"""Crash recovery contracts: JSON secrecy, commit-before-state and fencing."""

from __future__ import annotations

import asyncio
import copy
import json
from datetime import timedelta
from uuid import uuid4

import pytest
import pytest_asyncio
from app.game import Player, Room, RoomManager
from app.main import app
from app.models import CaseRun, RoomCheckpoint, RuntimeLease
from app.routes.leaderboard import persist_best_score
from app.services.passport import CaseResult
from app.services.room_checkpoint import (
    DEQUES,
    ROOM_FIELDS,
    SETS,
    InvalidCheckpoint,
    decode_room,
    encode_room,
)
from app.services.room_store import RoomRecoveringError, RoomStore
from fastapi.testclient import TestClient
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker
from starlette.websockets import WebSocketDisconnect


class Socket:
    def __init__(self):
        self.frames = []
        self.closes = []

    async def send_text(self, text):
        self.frames.append(json.loads(text))

    async def close(self, *, code, reason):
        self.closes.append((code, reason))


class MemoryStore:
    epoch = 1

    def __init__(self):
        self.snapshots = []
        self.fail = False

    async def save(self, payload, revision):
        if self.fail:
            raise ConnectionError("synthetic unavailable storage")
        self.snapshots.append(copy.deepcopy(payload))
        return revision + 1

    async def remove(self, name, revision):
        if self.fail:
            raise ConnectionError("synthetic unavailable storage")


def case_room():
    room = Room("durable-case")
    room.phase, room.round = "night", 2
    room.phase_started_at, room.deadline = 1000.0, 1045.0
    for index, role in enumerate(("mafia", "doctor", "detective", "citizen")):
        pid = f"p{index}"
        room.players[pid] = Player(pid, f"private-key-{index}", f"참가{index}", None, None, role=role)
    room.host_id = "p0"
    room.actions["p0"] = "p3"
    room.claims.append({"id": "claim-one", "speaker_id": "p1", "text": "치료했다", "round": 2})
    room.detective_results = {"p2": {"p0": True}}
    room._bot_marks.add("already-spoke")
    return room


def test_every_room_field_has_an_explicit_durable_or_ephemeral_decision():
    ephemeral = {
        "players", "_task", "_broadcast_lock", "_last_broadcast_payloads", "_voice_generation",
        "mutation_lock", "_store", "_manager", "_durable_checkpoint", "_durable_revision",
        "_recovery_paused", "_clock_saved_at", "_score_task", "_last_score_attempt", "_deferred_closes",
        "_voice_notices",
        "_last_clock_checkpoint_at",
    }
    assert set(vars(Room("codec-fields"))) == set(ROOM_FIELDS) | set(DEQUES) | set(SETS) | ephemeral


def test_codec_restores_private_truth_without_transport_or_public_leaks():
    room = case_room()
    room.players["p0"].ws = object()
    room.players["p0"].socket_owner = object()
    room.players["p0"].voice = True
    room.players["p0"].last_command_at = 98765
    encoded = encode_room(room, saved_at=1010.0)
    assert "private-key-0" in json.dumps(encoded)  # Private DB state, not a DTO.
    assert "ws" not in encoded["players"][0]
    restored = decode_room(encoded)
    assert restored.match_id == room.match_id
    assert restored.phase_id == room.phase_id
    assert restored.actions == room.actions
    assert list(restored.claims) == list(room.claims)
    assert restored.detective_results == room.detective_results
    assert restored.players["p0"].role == "mafia"
    assert restored.players["p0"].key == "private-key-0"
    assert restored.players["p0"].ws is None
    assert restored.players["p0"].socket_owner is None
    assert restored.players["p0"].last_command_at == 0
    assert not restored.players["p0"].voice
    assert not restored.players["p0"].connected
    assert restored._task is None
    assert restored._recovery_paused
    citizen_state = restored._state_for(restored.players["p3"])
    assert citizen_state["night_summary"] is None
    assert citizen_state["night_replay"] == []
    public_bytes = json.dumps(citizen_state)
    assert "private-key-0" not in public_bytes
    assert "detective_results" not in public_bytes
    assert next(p for p in citizen_state["players"] if p["id"] == "p0")["role"] is None


@pytest.mark.parametrize("corrupt", ["schema", "extra", "phase", "player", "nan", "buffer", "missing"])
def test_corrupt_or_unknown_schema_is_rejected_not_reset(corrupt):
    payload = encode_room(case_room(), saved_at=1010.0)
    if corrupt == "schema":
        payload["schema_version"] = 999
    elif corrupt == "extra":
        payload["room"]["_task"] = "not executable"
    elif corrupt == "phase":
        payload["room"]["phase"] = "unknown"
    elif corrupt == "player":
        payload["players"][0]["role"] = "admin"
    elif corrupt == "nan":
        payload["saved_at"] = float("nan")
    elif corrupt == "buffer":
        payload["room"]["claims"] = [{}] * 100
    else:
        del payload["room"]["actions"]
    with pytest.raises(InvalidCheckpoint):
        decode_room(payload)


async def test_recovery_preserves_remaining_time_and_restarts_existing_seat_ticker(monkeypatch):
    room = case_room()
    room.speaker_deadline = 1020.0
    restored = decode_room(encode_room(room, saved_at=1010.0))
    monkeypatch.setattr("app.game.time.time", lambda: 2000.0)
    player, resumed = restored.join(Socket(), "복구된 이름", None, "private-key-0")
    assert resumed and player.id == "p0"
    assert restored.deadline == 2035.0
    assert restored.phase_started_at == 1990.0
    assert restored.speaker_deadline == 2010.0
    assert restored._bot_marks == {"already-spoke"}
    assert restored.phase_id == room.phase_id
    assert restored._task is not None
    restored._task.cancel()
    await asyncio.gather(restored._task, return_exceptions=True)


async def test_storage_failure_rolls_back_before_any_successful_state():
    room, store, socket = case_room(), MemoryStore(), Socket()
    room._store = store
    room.players["p0"].ws = room.players["p0"].socket_owner = socket
    async with room.mutation_lock:
        await room.commit()
    accepted = copy.deepcopy(room.actions)
    room.actions["p0"] = "p1"
    store.fail = True
    with pytest.raises(RoomRecoveringError):
        await room.broadcast()
    assert room.actions == accepted
    assert not socket.frames
    assert socket.closes == [(4008, "room_recovering")]
    assert not room.players["p0"].connected
    assert room._recovery_paused


async def test_room_mutation_lock_does_not_publish_later_unsaved_changes():
    room, store, socket = case_room(), MemoryStore(), Socket()
    room._store = store
    room.players["p0"].ws = room.players["p0"].socket_owner = socket
    started, release = asyncio.Event(), asyncio.Event()
    original_save = store.save

    async def slow_save(payload, revision):
        started.set()
        await release.wait()
        return await original_save(payload, revision)

    store.save = slow_save

    async def change(target):
        async with room.mutation_lock:
            room.actions["p0"] = target
            await room.commit()
            await room._broadcast_committed()

    first = asyncio.create_task(change("p1"))
    await started.wait()
    second = asyncio.create_task(change("p2"))
    await asyncio.sleep(0)
    assert room.actions["p0"] == "p1"
    release.set()
    await asyncio.gather(first, second)
    assert [state["me"]["action_target"] for state in socket.frames] == ["p1", "p2"]
    assert [payload["room"]["actions"]["p0"] for payload in store.snapshots] == ["p1", "p2"]


async def test_finish_intent_is_frozen_and_not_sent_before_checkpoint(monkeypatch):
    room, store = case_room(), MemoryStore()
    room._store = store
    room.players["p0"].coders_id = uuid4()
    sent = []

    async def persist(*args, case_result=None, **kwargs):
        sent.append(case_result)

    monkeypatch.setattr("app.routes.leaderboard.persist_best_score", persist)
    room._finish("mafia")
    match_id = room.match_id
    assert room._pending_score_results and room._score_task is None
    async with room.mutation_lock:
        await room.commit()
    assert store.snapshots[-1]["room"]["_pending_score_results"][0]["result"]["match_id"] == match_id
    room.case_profile = {**room.case_profile, "code": "changed", "title": "new game"}
    await room._score_task
    assert len(sent) == 1 and sent[0].match_id == match_id
    assert sent[0].case_code != "changed"
    assert room._pending_score_results == []


@pytest_asyncio.fixture
async def durable_db(_engine):
    async with _engine.begin() as connection:
        await connection.execute(delete(RoomCheckpoint))
        await connection.execute(delete(RuntimeLease))
    yield async_sessionmaker(_engine, expire_on_commit=False)
    async with _engine.begin() as connection:
        await connection.execute(delete(RoomCheckpoint))
        await connection.execute(delete(RuntimeLease))


async def test_real_postgres_fences_expired_owner_and_guards_revisions(durable_db):
    first, second = RoomStore(session_factory=durable_db), RoomStore(session_factory=durable_db)
    assert await first.acquire()
    assert not await second.acquire()
    payload = encode_room(case_room())
    assert await first.save(payload, 0) == 1
    with pytest.raises(RoomRecoveringError):
        await first.save(payload, 0)
    async with durable_db() as session, session.begin():
        await session.execute(update(RuntimeLease).values(lease_until=func.clock_timestamp() - timedelta(seconds=1)))
    assert await second.acquire()
    assert second.epoch > first.epoch
    with pytest.raises(RoomRecoveringError):
        await first.save(payload, 1)
    assert not await first.renew()
    assert await second.save(payload, 1) == 2
    assert (await second.load_all(10))[0][1] == 2
    await second.release()


async def test_concurrent_runtime_acquisition_has_exactly_one_owner(durable_db):
    stores = [RoomStore(session_factory=durable_db), RoomStore(session_factory=durable_db)]
    outcomes = await asyncio.gather(*(store.acquire() for store in stores))
    assert sorted(outcomes) == [False, True]
    await asyncio.gather(*(store.release() for store in stores))


async def test_corrupt_durable_row_does_not_become_an_empty_lobby(durable_db):
    writer = RoomStore(session_factory=durable_db)
    assert await writer.acquire()
    payload = encode_room(case_room())
    payload["schema_version"] = 999
    await writer.save(payload, 0)
    await writer.release()
    manager = RoomManager()
    await manager.start_persistence(RoomStore(session_factory=durable_db))
    try:
        assert not manager.persistence_ready
        assert manager.find("durable-case") is None
        async with durable_db() as session:
            assert await session.scalar(select(func.count()).select_from(RoomCheckpoint)) == 1
    finally:
        await manager.stop_persistence()


async def test_documented_expiry_is_not_recovered_as_an_active_game(durable_db):
    store = RoomStore(session_factory=durable_db)
    assert await store.acquire()
    await store.save(encode_room(case_room()), 0)
    async with durable_db() as session, session.begin():
        await session.execute(update(RoomCheckpoint).values(expires_at=func.clock_timestamp() - timedelta(seconds=1)))
    assert await store.load_all(10) == []
    await store.release()


async def test_real_postgres_crash_reload_retains_identity_truth_and_pauses_clock(durable_db):
    first, second = RoomManager(), RoomManager()
    await first.start_persistence(RoomStore(session_factory=durable_db))
    room = first.get("durable-crash")
    socket = Socket()
    async with room.mutation_lock:
        player, _ = room.join(socket, "수사관", None, "durable-crash-key")
        room.players["bot"] = Player("bot", "durable-bot-key", "봇", None, None, is_bot=True)
        player.role = "mafia"
        room._set_phase("night", 45)
        room.round = 2
        room.actions[player.id] = "bot"
        room.claims.append({"id": "frozen", "round": 1, "speaker_id": player.id, "text": "기억"})
        await room.commit()
    phase_id, player_id = room.phase_id, player.id
    # Simulate process death: no stop(), no final checkpoint, no lease release.
    first._maintenance_task.cancel()
    room._task.cancel()
    await asyncio.gather(first._maintenance_task, room._task, return_exceptions=True)
    async with durable_db() as session, session.begin():
        await session.execute(update(RuntimeLease).values(lease_until=func.clock_timestamp() - timedelta(seconds=1)))
    await second.start_persistence(RoomStore(session_factory=durable_db))
    try:
        assert second.persistence_ready
        restored = second.find(room.name)
        assert restored is not None and restored._recovery_paused
        assert restored.phase_id == phase_id
        assert restored.players[player_id].role == "mafia"
        assert restored.actions == {player_id: "bot"}
        assert restored.claims[-1]["text"] == "기억"
        assert not restored.players[player_id].connected
        assert restored._voice_generation != room._voice_generation
        async with restored.mutation_lock:
            resumed, matched = restored.join(Socket(), "수사관", None, "durable-crash-key")
            await restored.commit()
        assert matched and resumed.id == player_id
        assert 40 <= restored.deadline - __import__("time").time() <= 46
        room.actions[player_id] = player_id
        with pytest.raises(RoomRecoveringError):
            async with room.mutation_lock:
                await room.commit()
    finally:
        await second.stop_persistence()
        await first.stop_persistence()


async def test_recovered_match_results_are_idempotent_in_real_postgres(client, fake_user_id, durable_db):
    result = CaseResult("BM-TEST", "복구 사건", "solo", "citizen", 140, "A", match_id=str(uuid4()))
    await asyncio.gather(*(
        persist_best_score(fake_user_id, "복구 수사관", 140, case_result=result) for _ in range(3)
    ))
    response = await client.get("/api/passport", headers={"X-Coders-User": str(fake_user_id)})
    body = response.json()
    assert body["investigator"]["cases_played"] == 1
    assert body["investigator"]["xp"] == result.xp_earned
    async with durable_db() as session:
        assert await session.scalar(select(func.count()).select_from(CaseRun).where(CaseRun.match_id == result.match_id)) == 1


def test_signed_seat_key_cannot_be_rebound_to_another_identity(monkeypatch):
    manager = RoomManager()
    monkeypatch.setattr("app.routes.ws.rooms", manager)
    owner = str(uuid4())
    url = "/api/ws?room=identity-recovery&key=owner-resume-key"
    with TestClient(app) as client:
        with client.websocket_connect(url, headers={"X-Coders-User": owner}) as first:
            original = first.receive_json()
            first.receive_json()
            for headers in ({}, {"X-Coders-User": str(uuid4())}):
                with client.websocket_connect(url, headers=headers) as attacker:
                    with pytest.raises(WebSocketDisconnect) as error:
                        attacker.receive_json()
                    assert error.value.code == 4009
            first.send_json({"t": "ping"})
            assert first.receive_json()["t"] == "pong"
            with client.websocket_connect(url, headers={"X-Coders-User": owner}) as resumed:
                assert resumed.receive_json()["id"] == original["id"]
                assert resumed.receive_json()["me"]["id"] == original["id"]


def test_ice_config_does_not_throttle_adjacent_voice_presence_or_persist_pings(monkeypatch):
    manager, store = RoomManager(), MemoryStore()
    monkeypatch.setattr("app.routes.ws.rooms", manager)
    room = manager.get("voice-config-race")
    room._store = store
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws?room=voice-config-race&key=voice-config-key") as ws:
            player_id = ws.receive_json()["id"]
            ws.receive_json()
            saves = len(store.snapshots)
            ws.send_json({"t": "voice_config"})
            assert ws.receive_json()["t"] == "voice_config"
            ws.send_json({"t": "voice_presence", "enabled": True})
            while True:
                state = ws.receive_json()
                if state["t"] == "state":
                    break
            assert next(p for p in state["players"] if p["id"] == player_id)["voice"] is True
            for _ in range(3):
                ws.send_json({"t": "ping"})
                assert ws.receive_json()["t"] == "pong"
            assert len(store.snapshots) <= saves + 1


def test_active_spectator_capacity_is_bounded_but_known_seats_resume(monkeypatch):
    from app.core.config import settings
    manager = RoomManager()
    monkeypatch.setattr("app.routes.ws.rooms", manager)
    monkeypatch.setattr(settings, "max_spectators_per_room", 1)
    room = manager.get("spectator-capacity")
    room.phase = "day"
    room.players["watcher"] = Player("watcher", "existing-watcher-key", "관전자", None, None, role="spectator", alive=False)
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws?room=spectator-capacity&key=new-watcher-key") as rejected:
            with pytest.raises(WebSocketDisconnect) as error:
                rejected.receive_json()
            assert error.value.code == 4004
        with client.websocket_connect("/api/ws?room=spectator-capacity&key=existing-watcher-key") as resumed:
            assert resumed.receive_json()["id"] == "watcher"
            assert resumed.receive_json()["me"]["role"] == "spectator"


async def test_spectator_admission_is_rechecked_after_accept_barrier(monkeypatch):
    from app.core.config import settings
    from app.routes.ws import game_socket
    manager = RoomManager()
    monkeypatch.setattr("app.routes.ws.rooms", manager)
    monkeypatch.setattr(settings, "max_spectators_per_room", 1)
    room = manager.get("spectator-race")
    room.phase = "day"
    accepted, release, finish, settled = (asyncio.Event() for _ in range(4))
    arrivals = outcomes = 0

    class Barrier(Socket):
        headers = {}

        async def accept(self):
            nonlocal arrivals
            arrivals += 1
            if arrivals == 2:
                accepted.set()
            await release.wait()

        def done(self):
            nonlocal outcomes
            outcomes += 1
            if outcomes == 2:
                settled.set()

        async def close(self, *, code, reason):
            await super().close(code=code, reason=reason)
            self.done()

        async def receive_text(self):
            self.done()
            await finish.wait()
            raise WebSocketDisconnect(code=1000)

    sockets = [Barrier(), Barrier()]
    tasks = [asyncio.create_task(game_socket(socket, room=room.name, nick="관전자", key=f"spectator-race-{index}", join_only=False)) for index, socket in enumerate(sockets)]
    try:
        await asyncio.wait_for(accepted.wait(), 2)
        release.set()
        await asyncio.wait_for(settled.wait(), 2)
        assert sum(frame["t"] == "welcome" for socket in sockets for frame in socket.frames) == 1
        assert sum((4004, "room_full") in socket.closes for socket in sockets) == 1
        assert len(room.players) == 1
    finally:
        finish.set()
        release.set()
        await asyncio.gather(*tasks)


def test_voice_capacity_and_existing_enabled_participant():
    room = Room("voice-cap")
    for index in range(13):
        pid = str(index)
        room.players[pid] = Player(pid, f"voice-cap-key-{index}", pid, None, None, role="spectator")
    for index in range(12):
        assert room.set_voice_presence(str(index), True) is None
    assert "최대 12명" in room.set_voice_presence("12", True)
    assert room.set_voice_presence("0", True) is None
    assert not room.players["12"].voice
    assert room.set_voice_presence("0", False) is None
    assert room.set_voice_presence("12", True) is None


async def test_merged_voice_channels_enforce_capacity_and_explain_excess():
    room = Room("voice-merge")
    room.phase = "day"
    for index in range(24):
        pid = str(index)
        role = "citizen" if index < 12 else "spectator"
        room.players[pid] = Player(pid, f"voice-merge-key-{index}", pid, None, None, role=role, alive=index < 12)
        assert room.set_voice_presence(pid, True) is None
    socket = Socket()
    room.players["23"].ws = socket
    room._set_phase("gameover", 0)
    assert sum(player.voice for player in room.players.values()) == 12
    await room.broadcast()
    assert socket.frames[0]["t"] == "notice"
    assert "정원 12명" in socket.frames[0]["message"]
    assert next(p for p in socket.frames[-1]["players"] if p["id"] == "23")["voice"] is False


def test_spectators_do_not_become_extra_players_on_rematch():
    room = case_room()
    room.phase = "gameover"
    for index in range(2):
        pid = f"watch{index}"
        room.players[pid] = Player(pid, f"watcher-key-{index}", pid, None, None, role="spectator", alive=False)
    assert room.rematch("p0") is None
    assert len(room.lobby_seats) == 4
    for player in room.lobby_seats:
        player.ready = True
    assert room.start("p0") is None
    assert len(room.players) == 6
    assert all(room.players[f"watch{index}"].role == "spectator" for index in range(2))


async def test_expired_checkpoint_replacement_does_not_reuse_old_revision(durable_db):
    store = RoomStore(session_factory=durable_db)
    assert await store.acquire()
    payload = encode_room(case_room())
    assert await store.save(payload, 0) == 1
    async with durable_db() as session, session.begin():
        await session.execute(update(RoomCheckpoint).values(expires_at=func.clock_timestamp() - timedelta(seconds=1)))
    with pytest.raises(RoomRecoveringError):
        await store.save(payload, 1)
    replacement = encode_room(Room("durable-case"))
    assert await store.save(replacement, 0) == 2
    with pytest.raises(RoomRecoveringError):
        await store.save(payload, 1)
    await store.release()


@pytest.mark.parametrize("nested", ["question", "result_intent"])
def test_nested_projection_and_result_intent_corruption_is_rejected(nested):
    payload = encode_room(case_room(), saved_at=1010.0)
    if nested == "question":
        payload["room"]["questions"] = [{}]
    else:
        payload["room"]["_pending_score_results"] = [{
            "coders_id": str(uuid4()), "name": "수사관", "score": 140, "result": {},
        }]
    with pytest.raises(InvalidCheckpoint):
        decode_room(payload)


async def test_quiet_active_clock_checkpoint_interval_and_last_committed_restore(monkeypatch):
    from app.core.config import settings
    clock = [1010.0]
    monkeypatch.setattr("app.game.time.time", lambda: clock[0])
    monkeypatch.setattr(settings, "room_clock_checkpoint_seconds", 5)
    room, store = case_room(), MemoryStore()
    room._store = store
    async with room.mutation_lock:
        await room.commit()
    assert len(store.snapshots) == 1
    clock[0] = 1014.9
    async with room.mutation_lock:
        await room.commit()
    assert len(store.snapshots) == 1
    clock[0] = 1015.0
    async with room.mutation_lock:
        await room.commit()
    assert len(store.snapshots) == 2
    assert store.snapshots[-1]["saved_at"] == 1015.0
    assert store.snapshots[-1]["room"]["deadline"] == 1045.0
    # The crash time is not a committed watermark: use the last saved clock,
    # then pause the missed outage until the real participant returns.
    clock[0] = 1040.0
    restored = decode_room(store.snapshots[-1])
    restored.join(Socket(), "수사관", None, "private-key-0")
    assert restored.deadline - clock[0] == 30.0
    restored._task.cancel()
    await asyncio.gather(restored._task, return_exceptions=True)


@pytest.mark.parametrize("inactive", ["paused", "lobby", "gameover", "only_observers"])
async def test_clock_checkpoint_does_not_rewrite_inactive_rooms(monkeypatch, inactive):
    clock = [1010.0]
    monkeypatch.setattr("app.game.time.time", lambda: clock[0])
    room, store = case_room(), MemoryStore()
    room._store = store
    if inactive == "paused":
        room._pause_clock()
    elif inactive == "only_observers":
        for player in room.players.values():
            player.connected = False
        room.players["watcher"] = Player("watcher", "only-watcher-key", "관전자", None, None, role="spectator", alive=False)
    else:
        room.phase = inactive
    async with room.mutation_lock:
        await room.commit()
    clock[0] += 60
    async with room.mutation_lock:
        await room.commit()
    assert len(store.snapshots) == 1
