"""Bounded, loopback-only protocol load exercise. Not a 40,000-user certificate.

Run from backend: python -m tools.ws_load --help
This tool never provisions infrastructure, changes OS limits, or targets a
public deployment. Only synthetic room/seat identifiers are generated; neither
frames nor credential-bearing WebSocket URIs are logged.
"""

from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import logging
import math
import os
import platform
import secrets
import sys
import time
from collections import Counter, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

MIB = 1024 * 1024
HARD_MAX_USERS = 500
TRANSPORT_LOGGER = logging.getLogger("black_midnight_load_transport")
TRANSPORT_LOGGER.disabled = True


class LoadFailure(RuntimeError):
    """Contains a fixed code, never an exception string or a request URI."""


def validate_endpoint(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise ValueError("invalid_endpoint") from error
    if (
        parsed.scheme != "ws"
        or parsed.hostname not in {"127.0.0.1", "::1"}
        or port is None
        or port < 1
        or parsed.path != "/api/ws"
        or parsed.query
        or parsed.fragment
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise ValueError("literal_loopback_ws_endpoint_required")
    return value


def parse_stages(value: str) -> tuple[int, ...]:
    try:
        stages = tuple(int(part) for part in value.split(","))
    except ValueError as error:
        raise ValueError("invalid_stages") from error
    if (
        not stages
        or len(stages) > 8
        or any(item < 1 or item > HARD_MAX_USERS for item in stages)
        or any(right <= left for left, right in zip(stages, stages[1:], strict=False))
    ):
        raise ValueError("stages_must_increase_between_1_and_500")
    return stages


def groups_for_users(users: int, room_size: int) -> list[int]:
    if users < 1 or room_size not in {4, 6}:
        raise ValueError("invalid_room_distribution")
    return [min(room_size, users - offset) for offset in range(0, users, room_size)]


def available_memory_bytes() -> int | None:
    if sys.platform == "win32":

        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("length", ctypes.c_uint32),
                ("load", ctypes.c_uint32),
                ("total_physical", ctypes.c_uint64),
                ("available_physical", ctypes.c_uint64),
                ("total_page_file", ctypes.c_uint64),
                ("available_page_file", ctypes.c_uint64),
                ("total_virtual", ctypes.c_uint64),
                ("available_virtual", ctypes.c_uint64),
                ("available_extended_virtual", ctypes.c_uint64),
            ]

        value = MemoryStatus()
        value.length = ctypes.sizeof(value)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(value)):
            return None
        return int(value.available_physical)
    if sys.platform.startswith("linux"):
        candidates: list[int] = []
        try:
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemAvailable:"):
                    candidates.append(int(line.split()[1]) * 1024)
                    break
        except (OSError, ValueError):
            pass
        # Respect a cgroup v2 limit instead of reporting the host's free RAM.
        try:
            ceiling = Path("/sys/fs/cgroup/memory.max").read_text().strip()
            if ceiling != "max":
                used = int(Path("/sys/fs/cgroup/memory.current").read_text())
                candidates.append(max(0, int(ceiling) - used))
        except (OSError, ValueError):
            pass
        return min(candidates) if candidates else None
    return None


def require_memory(minimum_mib: int, measured: int | None) -> None:
    if minimum_mib < 1024:
        raise ValueError("minimum_free_memory_cannot_be_below_1024_mib")
    if measured is None:
        raise LoadFailure("memory_measurement_unavailable")
    if measured < minimum_mib * MIB:
        raise LoadFailure("insufficient_free_memory")


@dataclass
class Samples:
    # Bounded storage: exact percentiles within the latest 10,000 observations.
    values: deque[float] = field(default_factory=lambda: deque(maxlen=10_000))
    total_count: int = 0

    def add(self, value: float) -> None:
        self.total_count += 1
        self.values.append(max(0.0, value))

    def summary(self) -> dict[str, Any]:
        ordered = sorted(self.values)

        def percentile(quantile: float) -> float | None:
            if not ordered:
                return None
            return round(ordered[max(0, math.ceil(len(ordered) * quantile) - 1)], 3)

        return {
            "count": self.total_count,
            "retained_samples": len(ordered),
            "sample_policy": "latest_10000",
            "p50_ms": percentile(0.5),
            "p95_ms": percentile(0.95),
            "p99_ms": percentile(0.99),
            "max_retained_ms": ordered[-1] if ordered else None,
        }


@dataclass(frozen=True)
class Options:
    url: str = "ws://127.0.0.1:8000/api/ws"
    stages: tuple[int, ...] = (10, 25)
    room_size: int = 4
    duration: float = 420
    join_rate: float = 2
    ack_timeout: float = 10
    min_free_mib: int = 1024

    def __post_init__(self) -> None:
        validate_endpoint(self.url)
        parse_stages(",".join(str(item) for item in self.stages))
        if self.room_size not in {4, 6} or not 10 <= self.duration <= 3600:
            raise ValueError("invalid_room_size_or_duration")
        if not 0.1 <= self.join_rate <= 10 or not 1 <= self.ack_timeout <= 30:
            raise ValueError("invalid_join_rate_or_timeout")
        if self.min_free_mib < 1024:
            raise ValueError("minimum_free_memory_cannot_be_below_1024_mib")


@dataclass
class Metrics:
    counts: Counter = field(default_factory=Counter)
    errors: Counter = field(default_factory=Counter)
    phases: Counter = field(default_factory=Counter)
    acknowledgements: Counter = field(default_factory=Counter)
    handshake: Samples = field(default_factory=Samples)
    command_ack: Samples = field(default_factory=Samples)
    ping: Samples = field(default_factory=Samples)
    resume: Samples = field(default_factory=Samples)
    planned_resume_outage: Samples = field(default_factory=Samples)
    generator_lag: Samples = field(default_factory=Samples)
    current_online: int = 0
    peak_online: int = 0
    minimum_free_memory: int | None = None
    hold_target: int = 0
    hold_minimum_online: int | None = None
    at_target_seconds: float = 0.0
    _hold_last_at: float = 0.0

    def online(self, change: int) -> None:
        now = time.monotonic()
        if self.hold_target:
            if self.current_online >= self.hold_target:
                self.at_target_seconds += now - self._hold_last_at
            self._hold_last_at = now
        self.current_online += change
        self.peak_online = max(self.peak_online, self.current_online)
        if self.hold_target:
            self.hold_minimum_online = min(
                self.hold_minimum_online
                if self.hold_minimum_online is not None
                else self.current_online,
                self.current_online,
            )

    def begin_hold(self, users: int) -> None:
        self.hold_target = users
        self.hold_minimum_online = self.current_online
        self._hold_last_at = time.monotonic()

    def finish_hold(self) -> None:
        self.online(0)
        self.hold_target = 0


class Pacer:
    def __init__(self, rate: float, stop: asyncio.Event) -> None:
        self.interval = 1 / rate
        self.stop = stop
        self.lock = asyncio.Lock()
        self.next_at = 0.0

    async def acquire(self) -> None:
        async with self.lock:
            delay = max(0, self.next_at - time.monotonic())
            if delay:
                try:
                    await asyncio.wait_for(self.stop.wait(), delay)
                except TimeoutError:
                    pass
            if self.stop.is_set():
                raise LoadFailure("safety_stop")
            self.next_at = time.monotonic() + self.interval


class Seat:
    def __init__(
        self,
        endpoint: str,
        room: str,
        index: int,
        metrics: Metrics,
        pacer: Pacer,
        stop: asyncio.Event,
        timeout: float,
    ) -> None:
        self.endpoint, self.room, self.index = endpoint, room, index
        self.metrics, self.pacer, self.stop, self.timeout = (
            metrics,
            pacer,
            stop,
            timeout,
        )
        self.key = secrets.token_urlsafe(18)
        self.id: str | None = None
        self.state: dict[str, Any] = {}
        self.welcome: dict[str, Any] = {}
        self.state_sequence = self.error_sequence = self.pong_sequence = 0
        self.state_received_at = time.monotonic()
        self.condition = asyncio.Condition()
        self.send_lock = asyncio.Lock()
        self.ws: Any = None
        self.reader: asyncio.Task | None = None
        self.closing = False
        self.counted = False
        self.last_send = self.last_ping = 0.0

    async def connect(self, resume: bool = False) -> None:
        from websockets.asyncio.client import connect

        await self.pacer.acquire()
        self.metrics.counts["resume_attempts" if resume else "connection_attempts"] += 1
        original_id = self.id
        started = time.perf_counter()
        self.welcome = {}
        self.state = {}
        self.closing = False
        uri = (
            self.endpoint
            + "?"
            + urlencode(
                {
                    "room": self.room,
                    "nick": f"Load {self.index}",
                    "key": self.key,
                    "join_only": "true" if resume else "false",
                }
            )
        )
        try:
            self.ws = await connect(
                uri,
                proxy=None,
                compression=None,
                open_timeout=self.timeout,
                close_timeout=1,
                ping_interval=None,
                max_queue=4,
                max_size=2 * MIB,
                logger=TRANSPORT_LOGGER,
                user_agent_header="BlackMidnight-LocalLoad/1.0",
            )
            self.reader = asyncio.create_task(self._receive())
            await self.wait(lambda: bool(self.welcome and self.state))
            if self.reader.done() or self.ws.close_code is not None:
                raise LoadFailure("closed_before_first_state")
            self.id = self.welcome.get("id")
            if not isinstance(self.id, str):
                raise LoadFailure("missing_seat_identity")
            if resume and (
                self.id != original_id or self.welcome.get("resumed") is not True
            ):
                raise LoadFailure("resume_identity_changed")
            self.counted = True
            self.metrics.online(1)
            self.metrics.counts[
                "resume_successes" if resume else "connection_successes"
            ] += 1
            sample = self.metrics.resume if resume else self.metrics.handshake
            sample.add((time.perf_counter() - started) * 1000)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.metrics.errors["resume_failed" if resume else "connection_failed"] += 1
            await self.close()
            raise LoadFailure("connection_failed") from error

    async def _receive(self) -> None:
        try:
            async for raw in self.ws:
                self.metrics.counts["frames_received"] += 1
                self.metrics.counts["bytes_received"] += len(
                    raw.encode() if isinstance(raw, str) else raw
                )
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise LoadFailure("non_object_frame")
                async with self.condition:
                    kind = message.get("t")
                    if kind == "welcome":
                        self.welcome = message
                    elif kind == "state":
                        self.state = message
                        self.state_received_at = time.monotonic()
                        self.state_sequence += 1
                        self.metrics.phases[str(message.get("phase", "unknown"))] += 1
                    elif kind == "pong":
                        self.pong_sequence += 1
                    elif kind == "error":
                        self.error_sequence += 1
                        self.metrics.errors[
                            "stale_phase"
                            if message.get("code") == "stale_phase"
                            else "server_error"
                        ] += 1
                    self.condition.notify_all()
        except asyncio.CancelledError:
            raise
        except Exception:
            if not self.closing:
                self.metrics.errors["receive_failed"] += 1
        finally:
            if self.counted:
                self.counted = False
                self.metrics.online(-1)
            if not self.closing and not self.stop.is_set():
                self.metrics.errors["unexpected_disconnect"] += 1
            async with self.condition:
                self.condition.notify_all()

    async def wait(self, predicate: Callable[[], bool]) -> None:
        async with self.condition:
            await asyncio.wait_for(self.condition.wait_for(predicate), self.timeout)

    async def command(
        self, packet: dict[str, Any], accepted: Callable[[], bool], label: str
    ) -> None:
        async with self.send_lock:
            await asyncio.sleep(max(0, 0.16 - (time.monotonic() - self.last_send)))
            if self.stop.is_set():
                raise LoadFailure("safety_stop")
            before_state, before_error = self.state_sequence, self.error_sequence
            started = time.perf_counter()
            await self.ws.send(json.dumps(packet, separators=(",", ":")))
            self.last_send = time.monotonic()
            self.metrics.counts["commands_sent"] += 1
            try:
                await self.wait(
                    lambda: (
                        self.error_sequence > before_error
                        or (self.state_sequence > before_state and accepted())
                    )
                )
            except TimeoutError as error:
                self.metrics.errors["command_timeout"] += 1
                raise LoadFailure("command_timeout") from error
            if self.error_sequence > before_error:
                raise LoadFailure("command_rejected")
            self.metrics.acknowledgements[label] += 1
            self.metrics.command_ack.add((time.perf_counter() - started) * 1000)

    async def ping(self) -> None:
        before = self.pong_sequence
        started = time.perf_counter()
        await self.ws.send('{"t":"ping"}')
        self.last_ping = time.monotonic()
        try:
            await self.wait(lambda: self.pong_sequence > before)
        except TimeoutError as error:
            self.metrics.errors["ping_timeout"] += 1
            raise LoadFailure("ping_timeout") from error
        self.metrics.ping.add((time.perf_counter() - started) * 1000)

    async def close(self) -> None:
        self.closing = True
        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:
                pass
        if self.reader is not None:
            self.reader.cancel()
            await asyncio.gather(self.reader, return_exceptions=True)
        self.reader = self.ws = None
        if self.counted:
            self.counted = False
            self.metrics.online(-1)


class RoomExercise:
    def __init__(self, seats: list[Seat], options: Options, metrics: Metrics) -> None:
        self.seats, self.options, self.metrics = seats, options, metrics
        self.done: set[tuple[str, str, str]] = set()
        self.chat_at: dict[str, float] = {}
        self.resumed = False

    async def setup(self) -> None:
        # The first acknowledged join owns the room; don't assume task order.
        await self.seats[0].connect()
        await asyncio.gather(*(seat.connect() for seat in self.seats[1:]))
        host = self.seats[0]
        if len(self.seats) < self.options.room_size:
            target = self.options.room_size
            await host.command(
                {"t": "fill_bots", "target": target},
                lambda: len(host.state.get("players", [])) == target,
                "fill_bots",
            )
            self.metrics.counts["bot_seats"] += target - len(self.seats)
        await self.start_round()
        self.metrics.counts["rooms_started"] += 1

    async def start_round(self) -> None:
        host = self.seats[0]
        for seat in self.seats[1:]:
            if not any(
                item.get("id") == seat.id and item.get("ready")
                for item in seat.state.get("players", [])
            ):
                await seat.command(
                    {"t": "ready"},
                    lambda seat=seat: any(
                        item.get("id") == seat.id and item.get("ready")
                        for item in seat.state.get("players", [])
                    ),
                    "ready",
                )
        await host.command(
            {"t": "start"}, lambda: host.state.get("phase") == "reveal", "start"
        )

    async def run(self) -> None:
        started = time.monotonic()
        while not self.seats[0].stop.is_set():
            host = self.seats[0]
            if (
                not self.resumed
                and time.monotonic() - started >= 5
                and host.state.get("phase") not in {"lobby", "gameover"}
            ):
                seat = self.seats[-1]
                disconnected_at = time.perf_counter()
                await seat.close()
                await asyncio.sleep(0.25)
                await seat.connect(resume=True)
                self.metrics.planned_resume_outage.add(
                    (time.perf_counter() - disconnected_at) * 1000
                )
                self.resumed = True
            if host.state.get("phase") == "gameover":
                self.metrics.counts["matches_completed"] += 1
                await host.command(
                    {"t": "rematch"},
                    lambda host=host: host.state.get("phase") == "lobby",
                    "rematch",
                )
                await self.start_round()
            for seat in self.seats:
                if time.monotonic() - seat.last_ping >= 5:
                    await seat.ping()
                await self.step(seat)
            await asyncio.sleep(0.2)

    async def step(self, seat: Seat) -> None:
        state = seat.state
        me, phase, phase_id = (
            state.get("me", {}),
            state.get("phase"),
            state.get("phase_id"),
        )
        if not me.get("alive") or not phase_id:
            return
        # Avoid manufacturing stale-phase failures at a known closing boundary.
        calibrated_now = (
            state.get("server_now", 0)
            + (time.monotonic() - seat.state_received_at) * 1000
        )
        if state.get("deadline", 0) - calibrated_now < 3000:
            return
        targets = [
            item
            for item in state.get("players", [])
            if item.get("alive") and item.get("id") != seat.id
        ]

        async def once(
            kind: str, packet: dict[str, Any], predicate: Callable[[], bool]
        ) -> None:
            mark = (str(seat.id), str(phase_id), kind)
            if mark not in self.done:
                self.done.add(mark)
                await seat.command(packet, predicate, kind)

        if phase == "night" and me.get("role") in {
            "mafia",
            "doctor",
            "detective",
            "bodyguard",
        }:
            candidates = [
                item
                for item in targets
                if not (me.get("role") == "mafia" and item.get("mafia"))
            ]
            if candidates:
                target = candidates[0]["id"]
                await once(
                    "action",
                    {"t": "action", "phase_id": phase_id, "target": target},
                    lambda: (
                        seat.state.get("phase_id") == phase_id
                        and seat.state.get("me", {}).get("action_target") == target
                    ),
                )
        elif phase == "vote" and targets:
            target = targets[0]["id"]
            await once(
                "vote",
                {"t": "vote", "phase_id": phase_id, "target": target},
                lambda: (
                    seat.state.get("phase_id") == phase_id
                    and seat.state.get("me", {}).get("vote_target") == target
                ),
            )
        elif phase == "verdict" and state.get("accused_id") != seat.id:
            await once(
                "judge",
                {"t": "judge", "phase_id": phase_id, "execute": True},
                lambda: (
                    seat.state.get("phase_id") == phase_id
                    and seat.state.get("me", {}).get("judgement") is True
                ),
            )
        elif phase == "day":
            if (
                state.get("speaker_id") == seat.id
                and state.get("speaker_deadline", 0) - calibrated_now >= 3000
            ):
                await once(
                    "claim",
                    {
                        "t": "claim",
                        "text": "부하 검증용 공개 진술입니다. 확인된 기록을 대조하겠습니다.",
                    },
                    lambda: any(
                        item.get("speaker_id") == seat.id
                        and item.get("round") == state.get("round")
                        for item in seat.state.get("claims", [])
                    ),
                )
            if time.monotonic() - self.chat_at.get(str(seat.id), 0) >= 15:
                self.chat_at[str(seat.id)] = time.monotonic()
                marker = f"Load message {seat.index} {secrets.token_hex(3)}"
                await seat.command(
                    {"t": "chat", "text": marker},
                    lambda: any(
                        item.get("from_id") == seat.id and item.get("text") == marker
                        for item in seat.state.get("chat", [])
                    ),
                    "chat",
                )


async def monitor_resources(
    options: Options, metrics: Metrics, stop: asyncio.Event
) -> str | None:
    try:
        while not stop.is_set():
            measured = available_memory_bytes()
            if measured is not None:
                metrics.minimum_free_memory = min(
                    metrics.minimum_free_memory or measured, measured
                )
            require_memory(options.min_free_mib, measured)
            target = time.monotonic() + 0.5
            await asyncio.sleep(0.5)
            lag = max(0, time.monotonic() - target) * 1000
            metrics.generator_lag.add(lag)
            if lag > 2000:
                raise LoadFailure("generator_event_loop_stalled")
    except LoadFailure as error:
        metrics.errors[error.args[0]] += 1
        stop.set()
        return error.args[0]
    return None


async def run_stage(
    options: Options, users: int, run_id: str, stage: int
) -> dict[str, Any]:
    if not 1 <= users <= HARD_MAX_USERS:
        raise ValueError("stage_user_count_exceeds_safe_ceiling")
    metrics, stop = Metrics(), asyncio.Event()
    start_time, cpu_start = time.monotonic(), time.process_time()
    require_memory(options.min_free_mib, available_memory_bytes())
    pacer = Pacer(options.join_rate, stop)
    rooms = []
    seat_index = 0
    for number, count in enumerate(groups_for_users(users, options.room_size)):
        name = f"load-{run_id}-{stage}-{number}"
        seats = [
            Seat(
                options.url,
                name,
                seat_index + index,
                metrics,
                pacer,
                stop,
                options.ack_timeout,
            )
            for index in range(count)
        ]
        seat_index += count
        rooms.append(RoomExercise(seats, options, metrics))
    monitor = asyncio.create_task(monitor_resources(options, metrics, stop))
    setup_tasks = [asyncio.create_task(room.setup()) for room in rooms]
    setup = asyncio.gather(*setup_tasks)
    stop_waiter = asyncio.create_task(stop.wait())
    drivers: list[asyncio.Task] = []
    hold_started = 0.0
    failure_code = None
    try:
        done, _ = await asyncio.wait(
            [setup, stop_waiter], return_when=asyncio.FIRST_COMPLETED
        )
        if stop_waiter in done:
            raise LoadFailure("safety_stop")
        await setup
        hold_started = time.monotonic()
        metrics.begin_hold(users)
        drivers = [asyncio.create_task(room.run()) for room in rooms]
        hold = asyncio.create_task(asyncio.sleep(options.duration))
        try:
            finished, _ = await asyncio.wait(
                [*drivers, hold, stop_waiter], return_when=asyncio.FIRST_COMPLETED
            )
            for task in finished:
                if task in drivers:
                    await task
                    raise LoadFailure("room_driver_stopped")
        finally:
            hold.cancel()
            await asyncio.gather(hold, return_exceptions=True)
    except asyncio.CancelledError:
        raise
    except Exception as error:
        code = error.args[0] if isinstance(error, LoadFailure) else type(error).__name__
        failure_code = str(code)
        if not metrics.errors:
            metrics.errors[failure_code] += 1
    finally:
        held_seconds = time.monotonic() - hold_started if hold_started else 0.0
        metrics.finish_hold()
        stop.set()
        setup.cancel()
        for task in setup_tasks:
            task.cancel()
        for driver in drivers:
            driver.cancel()
        stop_waiter.cancel()
        await asyncio.gather(
            setup, *setup_tasks, *drivers, stop_waiter, return_exceptions=True
        )
        await asyncio.gather(*(seat.close() for room in rooms for seat in room.seats))
        monitor_reason = await monitor
        if failure_code is None and monitor_reason is not None:
            failure_code = monitor_reason
    elapsed = time.monotonic() - start_time
    gameplay = sum(
        metrics.acknowledgements[kind]
        for kind in ("action", "vote", "judge", "claim", "chat")
    )

    def within(samples: Samples, percentile: str, maximum: float) -> bool:
        measured = samples.summary()[percentile]
        return measured is not None and measured <= maximum

    checks = {
        "all_requested_users_connected": metrics.counts["connection_successes"]
        == users,
        "all_rooms_started": metrics.counts["rooms_started"] == len(rooms),
        "full_hold_completed": held_seconds >= options.duration - 0.2,
        "no_recorded_errors": not metrics.errors,
        "ping_observed": metrics.ping.total_count > 0,
        "all_rooms_resumed_same_seat": metrics.counts["resume_successes"] == len(rooms),
        "join_p95_within_2000_ms": within(metrics.handshake, "p95_ms", 2000),
        "command_ack_p95_within_1000_ms": within(metrics.command_ack, "p95_ms", 1000),
        "ping_p95_within_1000_ms": within(metrics.ping, "p95_ms", 1000),
        "resume_p95_within_3000_ms": within(metrics.resume, "p95_ms", 3000),
        "generator_lag_p99_within_250_ms": within(metrics.generator_lag, "p99_ms", 250),
    }
    return {
        "stage": stage,
        "requested_users": users,
        "peak_connected_users": metrics.peak_online,
        "minimum_connected_during_hold": metrics.hold_minimum_online,
        "seconds_at_requested_concurrency": round(metrics.at_target_seconds, 3),
        "rooms": len(rooms),
        "configured_room_size": options.room_size,
        "requested_hold_seconds": options.duration,
        "observed_hold_seconds": round(held_seconds, 3),
        "elapsed_seconds": round(elapsed, 3),
        "passed": all(checks.values()),
        "stopped_reason": failure_code,
        "checks": checks,
        "scope": "loopback_active_gameplay"
        if gameplay
        else "loopback_join_start_reconnect_smoke",
        "counts": dict(metrics.counts),
        "errors": dict(metrics.errors),
        "phase_frame_counts": dict(metrics.phases),
        "acknowledgements": dict(metrics.acknowledgements),
        "latencies": {
            "join_to_first_state": metrics.handshake.summary(),
            "command_to_confirmed_state": metrics.command_ack.summary(),
            "app_ping_rtt": metrics.ping.summary(),
            "seat_resume": metrics.resume.summary(),
            "planned_disconnect_to_restored_state": metrics.planned_resume_outage.summary(),
            "generator_event_loop_lag": metrics.generator_lag.summary(),
        },
        "minimum_available_memory_mib": round(metrics.minimum_free_memory / MIB, 1)
        if metrics.minimum_free_memory
        else None,
        "generator_cpu_seconds": round(time.process_time() - cpu_start, 3),
        "resume_latency_note": "seat_resume excludes join-pacer wait; planned_disconnect_to_restored_state includes intentional 250ms offline and pacing",
        "voice_media_tested": False,
        "server_restart_tested": False,
        "production_capacity_validated": False,
        "target_40000_validated": False,
    }


async def run(options: Options) -> dict[str, Any]:
    report: dict[str, Any] = {
        "schema": 1,
        "started_at": datetime.now(UTC).isoformat(),
        "endpoint": options.url,
        "environment": {
            "os": platform.system(),
            "python": platform.python_version(),
            "logical_cpus": os.cpu_count(),
            "latency_clock": "perf_counter",
            "latency_clock_resolution_seconds": time.get_clock_info(
                "perf_counter"
            ).resolution,
            "timer_clock_resolution_seconds": time.get_clock_info(
                "monotonic"
            ).resolution,
        },
        "policy": {
            "loopback_only": True,
            "hard_max_users": HARD_MAX_USERS,
            "minimum_free_memory_mib": options.min_free_mib,
            "join_rate_per_second": options.join_rate,
            "tls": False,
            "websocket_compression": False,
            "system_proxy": False,
        },
        "stages": [],
        "target_40000_validated": False,
    }
    run_id = secrets.token_hex(4)
    try:
        for index, users in enumerate(options.stages, 1):
            result = await run_stage(options, users, run_id, index)
            report["stages"].append(result)
            if not result["passed"]:
                break
        report["passed"] = len(report["stages"]) == len(options.stages) and all(
            stage["passed"] for stage in report["stages"]
        )
    except LoadFailure as error:
        report["passed"] = False
        report["stopped_reason"] = error.args[0]
    report["finished_at"] = datetime.now(UTC).isoformat()
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="ws://127.0.0.1:8000/api/ws")
    parser.add_argument(
        "--stages",
        default="10,25",
        help="Increasing synthetic user counts; hard cap500",
    )
    parser.add_argument("--room-size", type=int, choices=(4, 6), default=4)
    parser.add_argument(
        "--duration",
        type=float,
        default=420,
        help="Hold seconds after all rooms start, per stage",
    )
    parser.add_argument("--join-rate", type=float, default=2)
    parser.add_argument("--ack-timeout", type=float, default=10)
    parser.add_argument("--min-free-mib", type=int, default=1024)
    parser.add_argument("--json-output", type=Path)
    args = parser.parse_args()
    if args.json_output and args.json_output.exists():
        parser.error("json_output_already_exists")
    try:
        options = Options(
            args.url,
            parse_stages(args.stages),
            args.room_size,
            args.duration,
            args.join_rate,
            args.ack_timeout,
            args.min_free_mib,
        )
    except ValueError as error:
        parser.error(str(error))
    try:
        report = asyncio.run(run(options))
    except KeyboardInterrupt:
        return 130
    encoded = json.dumps(report, ensure_ascii=False, indent=2)
    if args.json_output:
        # Evidence is a local output artifact, never a frame/key dump.
        with args.json_output.open("x", encoding="utf-8") as output:
            output.write(encoded + "\n")
    print(encoded)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
