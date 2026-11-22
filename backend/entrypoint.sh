#!/bin/sh
set -e

# /dev/tcp is a bash extension, not available in Debian's /bin/sh (dash).
# A real socket probe starts immediately when PostgreSQL is ready and applies
# connection/retry timeouts without logging credentials. DNS follows OS limits.
# Alembic then checks
# authentication and schema readiness; accepting TCP alone is not that proof.
uv run python -m app.core.readiness

uv run alembic upgrade head

exec uv run uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}" --no-access-log --log-level warning
