import os
from contextlib import nullcontext
from unittest.mock import Mock

import pytest
from app.core import readiness


def test_ready_database_starts_without_an_unconditional_sleep(monkeypatch):
    connect = Mock(return_value=nullcontext())
    sleep = Mock()
    monkeypatch.setattr(readiness.socket, "create_connection", connect)
    monkeypatch.setattr(readiness.time, "sleep", sleep)
    readiness.wait_for_database("postgresql+asyncpg://app:fake@localhost:55482/game")
    assert connect.call_args.args == (("localhost", 55482),)
    sleep.assert_not_called()


def test_connection_retry_and_deadline_are_bounded_without_exposing_url(monkeypatch):
    monkeypatch.setattr(readiness.socket, "create_connection", Mock(side_effect=OSError("private detail")))
    monkeypatch.setattr(readiness.time, "monotonic", Mock(side_effect=[0, 0, 2]))
    with pytest.raises(RuntimeError, match="readiness deadline exceeded") as error:
        readiness.wait_for_database("postgresql://app:fake-secret@localhost/game", timeout=1)
    assert "fake-secret" not in str(error.value)
    assert "private detail" not in str(error.value)


def test_temporarily_unavailable_database_recovers(monkeypatch):
    connect = Mock(side_effect=[ConnectionRefusedError(), nullcontext()])
    monkeypatch.setattr(readiness.socket, "create_connection", connect)
    monkeypatch.setattr(readiness.time, "monotonic", lambda: 0)
    sleep = Mock()
    monkeypatch.setattr(readiness.time, "sleep", sleep)
    readiness.wait_for_database("postgresql://app@localhost/game", timeout=5)
    assert connect.call_count == 2
    sleep.assert_called_once_with(1.0)


@pytest.mark.parametrize("url", ["postgresql://app:fake@localhost:bad/game", "postgresql:///missing-host"])
def test_invalid_database_address_is_safe(url):
    with pytest.raises(RuntimeError, match="DATABASE_URL") as error:
        readiness.wait_for_database(url)
    assert url not in str(error.value)


def test_unconfigured_database_does_not_open_a_connection(monkeypatch):
    connect = Mock()
    monkeypatch.setattr(readiness.socket, "create_connection", connect)
    readiness.wait_for_database("")
    connect.assert_not_called()


def test_actual_isolated_postgresql_accepts_tcp():
    database_url = os.environ.get("TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("Requires an explicitly isolated TEST_DATABASE_URL")
    readiness.wait_for_database(database_url, timeout=2)
