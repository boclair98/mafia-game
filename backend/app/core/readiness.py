"""Portable, credential-safe TCP readiness check before database migrations."""

import os
import socket
import time
from urllib.parse import urlsplit


def wait_for_database(database_url: str, timeout: float = 60.0) -> None:
    """Retry budget; OS DNS resolution is not a hard wall-clock guarantee."""
    if not database_url:
        return
    try:
        parsed = urlsplit(database_url)
        host, port = parsed.hostname, parsed.port or 5432
    except ValueError:
        raise RuntimeError("DATABASE_URL has an invalid database host or port") from None
    if not host:
        raise RuntimeError("DATABASE_URL must include a database host")
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError("PostgreSQL TCP readiness deadline exceeded")
        try:
            with socket.create_connection((host, port), timeout=min(2.0, remaining)):
                return
        except OSError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("PostgreSQL TCP readiness deadline exceeded") from None
            time.sleep(min(1.0, remaining))


if __name__ == "__main__":
    wait_for_database(os.environ.get("DATABASE_URL", ""))
