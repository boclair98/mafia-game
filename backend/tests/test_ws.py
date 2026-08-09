"""WebSocket behavior for the social deduction room."""

from __future__ import annotations

from urllib.parse import quote
from uuid import uuid4

import pytest
from app.core.config import settings
from app.game import MIN_PLAYERS
from app.main import app
from fastapi.testclient import TestClient


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
            assert ws.receive_json()["t"] == "pong"
