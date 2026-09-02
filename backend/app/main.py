from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.core.config import settings
from app.core.database import AsyncSessionLocal, engine
from app.game import rooms
from app.routes.leaderboard import router as leaderboard_router
from app.routes.users import router as users_router
from app.routes.ws import router as ws_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        yield
    finally:
        # Close pooled DB connections during rolling deploys so the managed
        # Postgres instance does not retain half-open connections from old pods.
        await engine.dispose()


app = FastAPI(
    title="Black Midnight Mafia API",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

# Capacitor/WebView shells load the UI from a local origin while calling the
# hosted API. Keep this allowlist exact: arbitrary web origins (and arbitrary
# localhost ports) must not be able to make credentialed API requests.
NATIVE_AND_WEB_ORIGINS = (
    "https://localhost",
    "capacitor://localhost",
    "http://localhost",
    "https://black-midnight.coders.kr",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=NATIVE_AND_WEB_ORIGINS,
    allow_credentials=True,
    allow_methods=("GET", "POST", "OPTIONS"),
    allow_headers=("Accept", "Content-Type", "X-Requested-With"),
)

app.include_router(users_router)
app.include_router(leaderboard_router)
app.include_router(ws_router)


@app.get("/api/health")
async def health() -> JSONResponse:
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse(
            status_code=503, content={"status": "error", "detail": "database"}
        )
    return JSONResponse(content={"status": "ok"})


@app.get("/api/health/live")
async def liveness() -> JSONResponse:
    """Liveness probe — answers the instant this process can serve a request,
    touching NOTHING (no DB, no I/O). The frontend's warming banner
    (frontend/lib/warming.ts) hits this to tell a real cold start apart from a
    merely slow request: when the api KSvc is scaled to zero, Knative's
    activator buffers this until a pod is up, so the probe is slow ⇔ the server
    is genuinely waking. When warm it returns in ~1ms even while a heavy
    endpoint is still in flight — so the banner stays off for ordinary slowness.
    Keep it dependency-free; adding a DB hit here would reintroduce false
    'warming' whenever the DB (not the pod) is the slow part."""
    return JSONResponse(content={"status": "ok"})


@app.get("/api/status")
async def public_status() -> JSONResponse:
    """Dependency-free public presence numbers; never exposes room names."""
    return JSONResponse(
        content={
            "status": "online",
            "players": rooms.online,
            "rooms": rooms.room_count,
            "active_matches": rooms.active_matches,
            "limits": {
                "max_connections_per_instance": settings.max_connections,
                "max_rooms_per_instance": settings.max_rooms,
            },
            "headroom": {
                "connections": max(settings.max_connections - rooms.online, 0),
                "rooms": max(settings.max_rooms - rooms.room_count, 0),
            },
        }
    )
