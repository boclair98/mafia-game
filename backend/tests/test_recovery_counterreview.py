"""Independent recovery race regressions; no database or real network."""

import asyncio
import json

import pytest
from app.core.config import settings
from app.game import Player, Room, RoomManager, RoomRecoveringError
from app.routes.ws import game_socket
from app.services.room_checkpoint import decode_room, encode_room


class MemoryStore:
    def __init__(self):
        self.epoch = 1
        self.locally_valid = True
        self.expiries = {}
        self.save_calls = 0

    async def save(self, payload, revision):
        self.save_calls += 1
        return revision + 1

    async def remove(self, name, revision):
        return None


async def test_expired_runtime_does_not_reopen_readiness_before_checkpoint_reload():
    entered_load, release_load = asyncio.Event(), asyncio.Event()

    class ReloadStore(MemoryStore):
        async def acquire(self):
            self.locally_valid = True
            self.epoch += 1
            return True

        async def load_all(self, limit):
            entered_load.set()
            await release_load.wait()
            return []

        async def release(self):
            self.epoch = None
            self.locally_valid = False

    manager, store = RoomManager(), ReloadStore()
    manager._store = store
    manager._persistence_ready = True
    store.locally_valid = False  # long process/event-loop pause, not a failed renewal
    task = asyncio.create_task(manager._try_acquire())
    try:
        await asyncio.wait_for(entered_load.wait(), 1)
        assert not manager.persistence_ready, (
            "new lease alone must not admit old Room objects"
        )
    finally:
        release_load.set()
        await task
    assert manager.persistence_ready


async def test_retired_room_cannot_commit_with_a_new_runtime_epoch():
    manager, store = RoomManager(), MemoryStore()
    manager._store = store
    manager._persistence_ready = True
    retired = manager.get("retired-counterreview")
    retired.players["old-seat"] = Player(
        id="old-seat",
        key="counterreview-old-key",
        nick="Old",
        coders_id=None,
        ws=None,
    )
    retired._durable_checkpoint = encode_room(retired)
    retired._durable_revision = 1
    retired.case_log.append("uncommitted stale callback")
    current = Room(retired.name)
    current._store, current._manager = store, manager
    manager._rooms[current.name] = current
    with pytest.raises(RoomRecoveringError):
        await retired.commit()
    assert store.save_calls == 0
    assert manager._rooms[current.name] is current
    assert list(current.case_log) == []


async def test_queued_socket_command_rechecks_authority_inside_room_lock(monkeypatch):
    manager, store = RoomManager(), MemoryStore()
    manager._store = store
    manager._persistence_ready = True
    monkeypatch.setattr("app.routes.ws.rooms", manager)
    monkeypatch.setattr(settings, "dev_fake_user", None)
    arena = manager.get("queued-counterreview")
    first_state = asyncio.Event()

    class Socket:
        headers = {}

        def __init__(self):
            self.incoming = asyncio.Queue()
            self.frames = []
            self.close_codes = []

        async def accept(self):
            return None

        async def send_text(self, text):
            packet = json.loads(text)
            self.frames.append(packet)
            if packet.get("t") == "state":
                first_state.set()

        async def receive_text(self):
            return await self.incoming.get()

        async def close(self, code, reason):
            self.close_codes.append(code)

    socket = Socket()
    task = asyncio.create_task(
        game_socket(
            socket,
            room=arena.name,
            nick="Counterreview",
            key="counterreview-queued-key",
            join_only=False,
        )
    )
    locked = False
    try:
        await asyncio.wait_for(first_state.wait(), 1)
        await arena.mutation_lock.acquire()
        locked = True
        await socket.incoming.put(
            '{"t":"chat","text":"must not mutate a retired room"}'
        )
        for _ in range(100):
            if arena.mutation_lock._waiters:
                break
            await asyncio.sleep(0.001)
        else:
            pytest.fail("command did not reach the held mutation lock")
        # Simulate recovery after the handler passed its outer readiness check.
        manager._persistence_ready = False
        replacement = Room(arena.name)
        replacement._manager, replacement._store = manager, store
        manager._rooms[arena.name] = replacement
        confirmed_before = len(socket.frames)
        saved_before = store.save_calls
        arena.mutation_lock.release()
        locked = False
        await asyncio.wait_for(task, 1)
        assert not arena.chat, "a queued old handler must fail before domain mutation"
        assert store.save_calls == saved_before
        assert len(socket.frames) == confirmed_before
        assert 4008 in socket.close_codes
    finally:
        if locked:
            arena.mutation_lock.release()
        task.cancel()
        ticker = arena._task
        if ticker:
            ticker.cancel()
        await asyncio.gather(
            task, *(item for item in [ticker] if item), return_exceptions=True
        )


def recovered_night():
    room = Room("observer-counterreview")
    for index, role in enumerate(("mafia", "doctor", "detective", "citizen")):
        ident = f"p{index}"
        room.players[ident] = Player(
            id=ident,
            key=f"counterreview-p{index}-key",
            nick=f"P{index}",
            coders_id=None,
            ws=None,
            role=role,
        )
    room.host_id, room.phase, room.round = "p0", "night", 1
    room.phase_started_at, room.deadline = 90.0, 160.0
    room.actions["p0"] = "p3"
    restored = decode_room(encode_room(room, saved_at=100.0))
    restored._store = MemoryStore()
    return restored


async def test_new_observer_cannot_resume_recovered_participants_clock(monkeypatch):
    monkeypatch.setattr("app.game.time.time", lambda: 1000.0)
    room = recovered_night()
    try:
        observer, resumed = room.join(
            object(), "Observer", None, "counterreview-observer-key"
        )
        assert not resumed and observer.role == "spectator"
        assert room._recovery_paused is True
        assert room.deadline == 160.0
        assert room.actions == {"p0": "p3"}
    finally:
        if room._task:
            room._task.cancel()
            await asyncio.gather(room._task, return_exceptions=True)


async def test_real_participant_rejoin_resumes_clock_and_confirmed_action(monkeypatch):
    monkeypatch.setattr("app.game.time.time", lambda: 1000.0)
    room = recovered_night()
    try:
        participant, resumed = room.join(object(), "P0", None, "counterreview-p0-key")
        assert resumed and participant.role == "mafia"
        assert room._recovery_paused is False
        assert room.deadline == 1060.0
        assert room.actions == {"p0": "p3"}
    finally:
        if room._task:
            room._task.cancel()
            await asyncio.gather(room._task, return_exceptions=True)


def test_observer_presence_does_not_prevent_last_participant_disconnect_pause():
    room = recovered_night()
    room._recovery_paused = False
    real_socket = object()
    room.players["p0"].connected = True
    room.players["p0"].ws = room.players["p0"].socket_owner = real_socket
    room.players["observer"] = Player(
        id="observer",
        key="counterreview-watching-key",
        nick="Observer",
        coders_id=None,
        ws=object(),
        connected=True,
        alive=False,
        role="spectator",
    )
    assert room.leave("p0", real_socket)
    assert room.players["observer"].connected
    assert room._recovery_paused is True


async def test_malformed_nested_checkpoint_never_becomes_ready():
    room = Room("nested-codec-counterreview")
    room.players["p"] = Player(
        id="p",
        key="counterreview-codec-key",
        nick="P",
        coders_id=None,
        ws=None,
    )
    payload = encode_room(room)
    payload["room"]["questions"] = [{}]

    class CorruptStore(MemoryStore):
        async def acquire(self):
            return True

        async def load_all(self, limit):
            return [(payload, 1)]

        async def release(self):
            self.locally_valid = False
            self.epoch = None

    manager, store = RoomManager(), CorruptStore()
    manager._store = store
    await manager._try_acquire()
    assert not manager.persistence_ready
    assert manager.find(room.name) is None
