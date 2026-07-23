"""WebSocket behavior, via Starlette's sync TestClient (ASGI, no network).

No DB needed for any of this — the game world is in-memory. The DB only
enters the picture at disconnect (persist_best_score), which is covered
in test_leaderboard.py against a real Postgres.
"""

from __future__ import annotations

from urllib.parse import quote
from uuid import uuid4

import pytest
from app.core.config import settings
from app.game import ORB_COUNT
from app.main import app
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def _really_anonymous(monkeypatch):
    """A local backend/.env may set DEV_FAKE_USER; neutralize it so the
    guest-path assertions below mean what they say."""
    monkeypatch.setattr(settings, "dev_fake_user", None)


def test_guest_can_play_without_signing_in():
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws?room=t-guest") as ws:
            w = ws.receive_json()
            assert w["t"] == "welcome"
            assert w["signed_in"] is False
            assert w["nick"].startswith("guest-")
            assert w["room"] == "t-guest"

            s = ws.receive_json()
            assert s["t"] == "state"
            assert any(p["id"] == w["id"] for p in s["players"])
            assert len(s["orbs"]) == ORB_COUNT


def test_signed_in_identity_comes_from_the_gate_headers():
    headers = {
        "X-Coders-User": str(uuid4()),
        # The gate URL-encodes the display name (headers are ASCII).
        "X-Coders-User-Name": quote("김철수"),
    }
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws?room=t-auth", headers=headers) as ws:
            w = ws.receive_json()
            assert w["signed_in"] is True
            assert w["nick"] == "김철수"


def test_input_moves_only_your_own_player():
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws?room=t-move") as ws:
            w = ws.receive_json()
            first = ws.receive_json()
            me = next(p for p in first["players"] if p["id"] == w["id"])

            ws.send_json({"t": "input", "dx": 1, "dy": 0})
            # Give the 15 Hz tick loop a few frames to pick the input up.
            for _ in range(10):
                s = ws.receive_json()
                if s["t"] != "state":
                    continue
                now = next(p for p in s["players"] if p["id"] == w["id"])
                if now["x"] > me["x"]:
                    return
            pytest.fail("player never moved right after an input message")


def test_two_players_see_each_other():
    with TestClient(app) as client:
        with (
            client.websocket_connect("/api/ws?room=t-duo") as a,
            client.websocket_connect("/api/ws?room=t-duo") as b,
        ):
            a_id = a.receive_json()["id"]
            b_id = b.receive_json()["id"]
            for _ in range(10):
                s = a.receive_json()
                ids = {p["id"] for p in s["players"]}
                if {a_id, b_id} <= ids:
                    return
            pytest.fail("second player never showed up in the first's state")


def test_ping_gets_a_pong_between_states():
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws") as ws:
            ws.receive_json()  # welcome
            ws.send_json({"t": "ping"})
            for _ in range(10):
                if ws.receive_json()["t"] == "pong":
                    return
            pytest.fail("no pong within 10 frames")


def test_junk_room_names_fall_back_to_lobby():
    with TestClient(app) as client:
        with client.websocket_connect("/api/ws?room=NOT%20a%20room!") as ws:
            assert ws.receive_json()["room"] == "lobby"
