"""Local browser fixture; never used by the production entrypoint.

Run explicitly with BLACK_MIDNIGHT_BROWSER_TEST=1 and a disposable DATABASE_URL.
Only the clock and the first-case RNG seed are controlled. Requests still travel
through the real WebSocket route, role validation, game engine and database.
"""

import os
import random


def main() -> None:
    if os.environ.get("BLACK_MIDNIGHT_BROWSER_TEST") != "1":
        raise RuntimeError("This fixture requires BLACK_MIDNIGHT_BROWSER_TEST=1")
    if not os.environ.get("DATABASE_URL"):
        raise RuntimeError("Provide a disposable DATABASE_URL for browser tests")

    import uvicorn
    from app.game import EARLY_ADVANCE_MINIMUM, PACE_SECONDS, Room

    PACE_SECONDS["first"].update(
        reveal=2, night=14, dawn=2, day=48, vote=10, defense=4, verdict=8, result=2
    )
    EARLY_ADVANCE_MINIMUM["first"].update(night=10, vote=5, verdict=4)
    original_start = Room.start

    def seeded_start(room: Room, pid: str) -> str | None:
        if not room.name.startswith("first-e2e-"):
            return original_start(room, pid)
        state = random.getstate()
        random.seed(5)  # a surviving Mafia host can exercise the whole flow
        try:
            return original_start(room, pid)
        finally:
            random.setstate(state)

    Room.start = seeded_start
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
