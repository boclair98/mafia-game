"""Ungraceful process-kill/restart check against an explicit disposable local DB.

Run after Alembic migrations, with RECOVERY_TEST_DATABASE_URL set. This creates
only synthetic rooms, owns both child processes, and never targets production.
It does not dump frames, session keys, SQL errors or credential-bearing URLs.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import secrets
import socket
import sys
import time
from urllib.parse import urlencode, urlsplit

import httpx
from websockets.asyncio.client import connect

logging.getLogger("websockets").disabled = True


def disposable_database(value: str) -> bool:
    try:
        parsed = urlsplit(value)
    except ValueError:
        return False
    return parsed.scheme == "postgresql+asyncpg" and parsed.hostname in {"127.0.0.1", "localhost", "::1"} and any(
        marker in parsed.path.lower() for marker in ("test", "recovery", "qa")
    )


async def wait_state(ws, predicate, timeout: float = 45):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        message = json.loads(await asyncio.wait_for(ws.recv(), end - time.monotonic()))
        if message.get("t") == "error":
            raise RuntimeError("game_command_rejected")
        if message.get("t") == "state" and predicate(message):
            return message
    raise RuntimeError("state_timeout")


async def wait_welcome(ws):
    message = json.loads(await asyncio.wait_for(ws.recv(), 15))
    if message.get("t") != "welcome":
        raise RuntimeError("welcome_missing")
    return message


async def start_server(database_url: str, port: int):
    env = dict(os.environ)
    env.update(DATABASE_URL=database_url, ROOM_PERSISTENCE_ENABLED="true", ROOM_LEASE_SECONDS="5")
    env.pop("DEV_FAKE_USER", None)
    env.pop("BLACK_MIDNIGHT_BROWSER_TEST", None)
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
        "--port", str(port), "--no-access-log", "--log-level", "warning",
        env=env, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        async with httpx.AsyncClient(timeout=2, trust_env=False) as client:
            end = time.monotonic() + 45
            while time.monotonic() < end:
                if process.returncode is not None:
                    raise RuntimeError("child_server_exited")
                try:
                    response = await client.get(f"http://127.0.0.1:{port}/api/health")
                    if response.status_code == 200:
                        return process
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.2)
        raise RuntimeError("child_readiness_timeout")
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise


async def stop_server(process):
    if process is None or process.returncode is not None:
        return
    process.terminate()
    try:
        await asyncio.wait_for(process.wait(), 10)
    except TimeoutError:
        process.kill()
        await process.wait()


async def exercise(database_url: str, port: int) -> dict:
    first = second = None
    room = f"first-recovery-{secrets.token_hex(6)}"
    query = urlencode({"room": room, "nick": "복구점검관", "key": secrets.token_urlsafe(24)})
    url = f"ws://127.0.0.1:{port}/api/ws?{query}"
    try:
        first = await start_server(database_url, port)
        async with connect(url, proxy=None, open_timeout=15) as ws:
            welcome = await wait_welcome(ws)
            await wait_state(ws, lambda state: state["phase"] == "lobby")
            await ws.send(json.dumps({"t": "first_start"}))
            before = await wait_state(ws, lambda state: state["phase"] == "night")
            checked_action = before["me"]["role"] in {"mafia", "doctor", "detective", "bodyguard"}
            if checked_action:
                target = next(player for player in before["players"] if player["bot"] and player["alive"] and not player.get("mafia"))
                await ws.send(json.dumps({"t": "action", "phase_id": before["phase_id"], "target": target["id"]}))
                before = await wait_state(ws, lambda state: state["me"]["action_target"] == target["id"], timeout=10)
            first.kill()  # Our child only: SIGKILL on POSIX, TerminateProcess on Windows.
            await first.wait()

        second = await start_server(database_url, port)
        async with connect(url + "&join_only=true", proxy=None, open_timeout=15) as ws:
            resumed = await wait_welcome(ws)
            after = await wait_state(ws, lambda state: state["me"]["id"] == welcome["id"])
            checks = {
                "same_seat": resumed["id"] == welcome["id"] and resumed["resumed"] is True,
                "same_role": after["me"]["role"] == before["me"]["role"],
                "same_phase_round": (after["phase"], after["round"]) == (before["phase"], before["round"]),
                "same_phase_id": after["phase_id"] == before["phase_id"],
                "same_action": after["me"]["action_target"] == before["me"]["action_target"],
                "private_night_stays_private": after["night_summary"] is None and after["night_replay"] == [],
            }
            old_remaining = (before["deadline"] - before["server_now"]) / 1000
            new_remaining = (after["deadline"] - after["server_now"]) / 1000
            checks["outage_did_not_consume_phase"] = abs(old_remaining - new_remaining) < 2
            return {"passed": all(checks.values()), "checks": checks,
                    "actual_process_kill": True, "action_was_available_and_tested": checked_action,
                    "phase": after["phase"], "old_remaining_seconds": round(old_remaining, 2),
                    "restored_remaining_seconds": round(new_remaining, 2),
                    "production_tested": False}
    finally:
        await stop_server(first)
        await stop_server(second)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8012)
    options = parser.parse_args()
    database_url = os.environ.get("RECOVERY_TEST_DATABASE_URL", "")
    if not disposable_database(database_url) or not 1024 <= options.port <= 65535:
        parser.error("Explicit disposable loopback RECOVERY_TEST_DATABASE_URL and safe local port required")
    with socket.socket() as probe:
        try:
            probe.bind(("127.0.0.1", options.port))
        except OSError:
            parser.error("Local port is already in use; no existing process will be stopped")
    try:
        result = asyncio.run(exercise(database_url, options.port))
    except Exception:
        print(json.dumps({"passed": False, "error": "process_recovery_check_failed", "production_tested": False}))
        return 1
    print(json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
