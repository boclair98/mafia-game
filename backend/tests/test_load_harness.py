"""Load-generator guardrails and ACK accounting, without opening any sockets."""

import asyncio
import json
import time

import pytest
from tools.ws_load import (
    MIB,
    LoadFailure,
    Metrics,
    Options,
    Pacer,
    Samples,
    Seat,
    groups_for_users,
    monitor_resources,
    parse_stages,
    require_memory,
    run,
    validate_endpoint,
)


@pytest.mark.parametrize(
    "url",
    [
        "ws://127.0.0.1:8000/api/ws",
        "ws://[::1]:9001/api/ws",
    ],
)
def test_literal_loopback_endpoints_are_accepted(url):
    assert validate_endpoint(url) == url


@pytest.mark.parametrize(
    "url",
    [
        "wss://black-midnight.coders.kr/api/ws",
        "ws://192.168.1.2:8000/api/ws",
        "ws://localhost:8000/api/ws",
        "ws://127.0.0.1.evil.invalid:8000/api/ws",
        "ws://name:secret@127.0.0.1:8000/api/ws",
        "ws://127.0.0.1:8000/api/ws?key=secret",
        "ws://127.0.0.1:8000/api/ws#secret",
        "ws://127.0.0.1/api/ws",
        "ws://127.0.0.1:99999/api/ws",
        "ws://127.0.0.1:0/api/ws",
        "ws://127.0.0.1:8000/not-websocket",
        "wss://127.0.0.1:8000/api/ws",
    ],
)
def test_external_or_credential_bearing_endpoint_is_rejected_without_echo(url):
    with pytest.raises(ValueError) as failure:
        validate_endpoint(url)
    assert "secret" not in str(failure.value)
    assert "coders.kr" not in str(failure.value)


@pytest.mark.parametrize(
    "value", ["0", "-1", "40000", "501", "10,10", "25,10", "", "10,no"]
)
def test_stages_cannot_bypass_safe_ceiling_or_ramp_order(value):
    with pytest.raises(ValueError):
        parse_stages(value)


def test_coverage_counts_requested_humans_not_server_fill_bots():
    assert parse_stages("10,25") == (10, 25)
    assert groups_for_users(10, 4) == [4, 4, 2]
    assert groups_for_users(25, 6) == [6, 6, 6, 6, 1]
    assert sum(groups_for_users(25, 4)) == 25
    assert Options().stages == (10, 25)
    with pytest.raises(ValueError):
        Options(min_free_mib=100)


def test_memory_measurement_is_required_and_floor_cannot_be_disabled():
    require_memory(1024, 1200 * MIB)
    with pytest.raises(LoadFailure, match="insufficient_free_memory"):
        require_memory(1024, 1023 * MIB)
    with pytest.raises(LoadFailure, match="memory_measurement_unavailable"):
        require_memory(1024, None)
    with pytest.raises(ValueError):
        require_memory(1, 5000 * MIB)


def test_percentiles_are_nearest_rank_and_empty_is_not_zero_latency():
    samples = Samples()
    assert samples.summary()["p95_ms"] is None
    for number in range(1, 101):
        samples.add(number)
    result = samples.summary()
    assert result["p50_ms"] == 50
    assert result["p95_ms"] == 95
    assert result["p99_ms"] == 99
    assert result["count"] == 100


async def test_preflight_memory_stop_creates_no_connections(monkeypatch):
    monkeypatch.setattr("tools.ws_load.available_memory_bytes", lambda: 500 * MIB)
    report = await run(Options(stages=(10,), duration=10))
    assert report["passed"] is False
    assert report["stopped_reason"] == "insufficient_free_memory"
    assert report["stages"] == []
    assert report["target_40000_validated"] is False


async def test_resource_monitor_stops_fail_closed(monkeypatch):
    monkeypatch.setattr("tools.ws_load.available_memory_bytes", lambda: 900 * MIB)
    metrics, stop = Metrics(), asyncio.Event()
    reason = await monitor_resources(Options(duration=10), metrics, stop)
    assert stop.is_set()
    assert reason == "insufficient_free_memory"
    assert metrics.errors[reason] == 1
    assert metrics.minimum_free_memory == 900 * MIB


class FakeTransport:
    """A frame queue, not an ASGI server or network proxy."""

    def __init__(self, ident="seat-a", resumed=False, ready=False, emit_ack=True):
        self.close_code = None
        self.emit_ack = emit_ack
        self.queue = asyncio.Queue()
        self.state = {
            "t": "state",
            "phase": "night",
            "me": {"id": ident},
            "players": [{"id": ident, "ready": ready}],
        }
        self.queue.put_nowait(
            json.dumps({"t": "welcome", "id": ident, "resumed": resumed})
        )
        self.queue.put_nowait(json.dumps(self.state))

    def __aiter__(self):
        return self

    async def __anext__(self):
        value = await self.queue.get()
        if value is None:
            raise StopAsyncIteration
        return value

    async def send(self, raw):
        packet = json.loads(raw)
        if packet["t"] == "ping":
            self.queue.put_nowait('{"t":"pong"}')
        elif packet["t"] == "ready" and self.emit_ack:
            self.state["players"][0]["ready"] = True
            self.queue.put_nowait(json.dumps(self.state))
        elif packet["t"] == "invalid":
            self.queue.put_nowait(
                json.dumps({"t": "error", "message": "private key=DO-NOT-LOG"})
            )

    async def close(self):
        self.close_code = 1000
        self.queue.put_nowait(None)


def seat_for_test(timeout=0.1):
    metrics, stop = Metrics(), asyncio.Event()
    return Seat(
        "ws://127.0.0.1:8000/api/ws",
        "load-fake",
        0,
        metrics,
        Pacer(10, stop),
        stop,
        timeout,
    )


async def test_confirmed_command_ping_and_planned_resume_keep_identity(monkeypatch):
    transports = [FakeTransport(), FakeTransport(resumed=True)]

    async def fake_connect(uri, **kwargs):
        assert kwargs["proxy"] is None
        assert kwargs["logger"].disabled
        return transports.pop(0)

    monkeypatch.setattr("websockets.asyncio.client.connect", fake_connect)
    seat = seat_for_test()
    await seat.connect()
    await seat.command(
        {"t": "ready"}, lambda: seat.state["players"][0]["ready"], "ready"
    )
    await seat.ping()
    await seat.close()
    await seat.connect(resume=True)
    await seat.close()
    assert seat.id == "seat-a"
    assert seat.metrics.counts["connection_successes"] == 1
    assert seat.metrics.counts["resume_successes"] == 1
    assert seat.metrics.acknowledgements["ready"] == 1
    assert seat.metrics.ping.total_count == 1
    assert seat.metrics.current_online == 0
    assert seat.metrics.peak_online == 1
    assert not seat.metrics.errors


async def test_old_state_cannot_be_miscounted_as_a_new_command_ack(monkeypatch):
    async def fake_connect(uri, **kwargs):
        return FakeTransport(ready=True, emit_ack=False)

    monkeypatch.setattr("websockets.asyncio.client.connect", fake_connect)
    seat = seat_for_test(timeout=0.02)
    await seat.connect()
    try:
        with pytest.raises(LoadFailure, match="command_timeout"):
            await seat.command(
                {"t": "ready"}, lambda: seat.state["players"][0]["ready"], "ready"
            )
        assert not seat.metrics.acknowledgements
        assert seat.metrics.errors["command_timeout"] == 1
    finally:
        await seat.close()


async def test_replacement_identity_fails_resume_and_cleans_up(monkeypatch):
    transports = [FakeTransport(), FakeTransport(ident="new-seat", resumed=False)]

    async def fake_connect(uri, **kwargs):
        return transports.pop(0)

    monkeypatch.setattr("websockets.asyncio.client.connect", fake_connect)
    seat = seat_for_test()
    await seat.connect()
    await seat.close()
    with pytest.raises(LoadFailure, match="connection_failed"):
        await seat.connect(resume=True)
    assert seat.metrics.counts["resume_successes"] == 0
    assert seat.metrics.errors["resume_failed"] == 1
    assert seat.metrics.current_online == 0


async def test_server_error_text_and_resume_keys_never_enter_metrics(monkeypatch):
    async def fake_connect(uri, **kwargs):
        return FakeTransport()

    monkeypatch.setattr("websockets.asyncio.client.connect", fake_connect)
    seat = seat_for_test()
    await seat.connect()
    try:
        with pytest.raises(LoadFailure, match="command_rejected"):
            await seat.command({"t": "invalid"}, lambda: False, "invalid")
        serialized = json.dumps(dict(seat.metrics.errors))
        assert serialized == '{"server_error": 1}'
        assert "DO-NOT-LOG" not in serialized
        assert seat.key not in serialized
    finally:
        await seat.close()


async def test_stopped_pacer_does_not_attempt_another_join():
    stop = asyncio.Event()
    pacer = Pacer(10, stop)
    stop.set()
    with pytest.raises(LoadFailure, match="safety_stop"):
        await pacer.acquire()


def test_latency_retention_is_bounded():
    samples = Samples()
    for number in range(12_000):
        samples.add(number)
    summary = samples.summary()
    assert summary["count"] == 12_000
    assert summary["retained_samples"] == 10_000
    assert summary["sample_policy"] == "latest_10000"


def test_peak_count_is_distinct_from_time_at_requested_concurrency(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr("tools.ws_load.time.monotonic", lambda: clock[0])
    metrics = Metrics()
    metrics.online(10)
    metrics.begin_hold(10)
    clock[0] = 105.0
    metrics.online(-1)
    clock[0] = 107.0
    metrics.online(1)
    clock[0] = 112.0
    metrics.finish_hold()
    metrics.online(-10)
    assert metrics.peak_online == 10
    assert metrics.hold_minimum_online == 9
    assert metrics.at_target_seconds == 10.0
    assert metrics.current_online == 0


async def test_command_deadline_uses_elapsed_local_time(monkeypatch):
    from tools.ws_load import RoomExercise

    seat = seat_for_test()
    seat.id = "me"
    seat.state_received_at = time.monotonic() - 20
    seat.state = {
        "phase": "vote",
        "phase_id": "old-snapshot",
        "server_now": 1000,
        "deadline": 10000,
        "me": {"alive": True},
        "players": [{"id": "other", "alive": True}],
    }

    async def should_not_send(*args, **kwargs):
        pytest.fail("locally elapsed deadline must not send a stale command")

    monkeypatch.setattr(seat, "command", should_not_send)
    await RoomExercise([seat], Options(duration=10), seat.metrics).step(seat)


async def test_setup_failure_cancels_other_room_setup_and_closes_seats(monkeypatch):
    from tools.ws_load import run_stage

    cancelled = asyncio.Event()
    constructed = []

    class FakeRoom:
        def __init__(self, seats, options, metrics):
            self.seats = seats
            self.index = len(constructed)
            constructed.append(self)

        async def setup(self):
            if self.index == 0:
                await asyncio.sleep(0)
                raise LoadFailure("synthetic_setup_failure")
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

    monkeypatch.setattr("tools.ws_load.RoomExercise", FakeRoom)
    monkeypatch.setattr("tools.ws_load.available_memory_bytes", lambda: 2048 * MIB)
    result = await run_stage(Options(stages=(5,), duration=10), 5, "fake", 1)
    assert not result["passed"]
    assert cancelled.is_set()
    assert result["stopped_reason"] == "synthetic_setup_failure"
    assert all(
        seat.ws is None and seat.reader is None
        for room in constructed
        for seat in room.seats
    )


async def test_programmatic_stage_cannot_bypass_safe_ceiling():
    from tools.ws_load import run_stage

    with pytest.raises(ValueError, match="stage_user_count_exceeds_safe_ceiling"):
        await run_stage(Options(duration=10), 40000, "fake", 1)
