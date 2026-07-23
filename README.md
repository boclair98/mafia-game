# template-coders — Game (Realtime)

[![Deploy on coders.kr](https://coders.kr/deploy-button.svg)](https://coders.kr/deploy?repo=https://github.com/cykim8811/template-coders)

A realtime multiplayer game starter for the
[coders.kr](https://coders.kr) platform. Hand a Claude Code session the
link to this repo, ask it to deploy, and you have a live game where:

- Anyone can play instantly — a fullscreen canvas arena over a
  WebSocket, no sign-in wall.
- Rooms are just links: `/?room=friday-crew` is its own world.
- Signing in (optional, one click, no OAuth code in this repo) upgrades
  a guest to a named player whose **best score persists** on a public
  leaderboard.

The example game is a tiny "orb arena" — steer a circle, eat orbs,
score points. It's deliberately small: the point of this template is
the *wiring* every realtime game here needs — the socket lifecycle,
reconnect, interpolation, optional identity, server-authoritative
state — with the game rules isolated where you'll swap them out.

> Building a plain CRUD site instead? Use the **Basic Full-Stack Web**
> template on the [`main` branch](https://github.com/coders-kr/template-coders)
> — same platform wiring, request/response app shape. This branch was
> cloned with:
> ```bash
> git clone -b game --single-branch https://github.com/coders-kr/template-coders <name>
> ```

## What the platform gives you

Identity works on the WebSocket exactly like it does on HTTP: the gate
validates the visitor's `coders_session` cookie on the **handshake**
and stamps `X-Coders-User` (+ `X-Coders-User-Name`) before the request
reaches you. Two twists matter for games (PLATFORM.md §5):

1. **The handshake is a GET, so the gate never forces sign-in.**
   Anonymous visitors connect fine — that's what makes login *optional*
   here. Guests get a generated nick; signed-in players keep their
   coders.kr name and their best score.
2. **The gate can't see inside the socket.** Once upgraded, individual
   messages aren't method-gated — authorize every state-changing
   message in your own handler. This template's server is authoritative
   end-to-end: clients send *intent* (a direction vector), the server
   integrates movement, detects pickups, and owns every score.

Cost model you're designing against (PLATFORM.md §5b): **WebSockets are
billed by egress bytes, not open-time** — an idle socket is ~free, and
what costs money is snapshot size × tick rate × players. This template
ticks at 15 Hz with compact single-letter keys; raise either only on
purpose.

And one operational truth: **sockets drop routinely** (Spot-node
preemption, redeploys, idle scale-to-zero). The client treats a dead
socket as normal and reconnects with backoff; the server treats every
connect as a fresh join. Build your game state around that assumption.

## Code tour

```
backend/
  app/game.py             the game: rooms, players, orbs, 15 Hz tick loop,
                          server-side collision — swap THIS for your game
  app/routes/ws.py        /api/ws — handshake identity, message loop,
                          persist-best-score on disconnect
  app/routes/leaderboard.py  GET /api/leaderboard + the GREATEST() upsert
  app/routes/users.py     /api/me — auto-upserts the local row on first sight
  app/models.py           User + Score (one best-score row per user)
frontend/
  lib/ws.ts               reconnecting GameSocket (backoff + jitter, 20s ping)
  lib/game.ts             wire types + snapshot-interpolation buffer
  components/GameCanvas.tsx  fullscreen DPR-aware canvas, rAF render loop,
                          camera follow, keyboard + touch input → intent
  components/Hud.tsx      status/score overlay, optional sign-in corner,
                          leaderboard panel
  app/page.tsx            glues socket ↔ buffer ↔ canvas ↔ HUD
  nginx.conf.template     /api/ws location with Upgrade headers + 3600s
coders.yaml               web + api (+postgres), timeout: 3600 on both
```

The split to internalize: `app/game.py` and the drawing half of
`GameCanvas.tsx` are the *example game*; everything else is the
*template* and survives whatever game you build.

## Local development

```bash
docker compose up
```

Zero setup — Postgres + FastAPI (:8000) + Next dev (:3000). Open
http://localhost:3000 in two windows to see multiplayer. REST `/api/*`
is proxied by the Next dev server; the WebSocket connects straight to
`ws://localhost:8000` (Next dev can't proxy sockets).

There's no platform gate locally, so compose pre-sets `DEV_FAKE_USER`
and every request/socket counts as that signed-in user. Unset it (or
override in `backend/.env`) to exercise the guest path.

Backend tests (needs a Postgres; compose's works):

```bash
cd backend && uv run pytest
```

## Deploying

This repo ships a [`.mcp.json`](./.mcp.json) that points Claude Code at
the coders.kr MCP server. Then, in Claude Code:

```
deploy https://github.com/<you>/<your-repo>
```

The platform reads `coders.yaml`, builds both images, wires Postgres,
and fronts everything at `<name>.coders.kr` — WebSocket included (the
gate proxies upgrades; `timeout: 3600` in coders.yaml is what keeps a
socket open past Knative's 300s default).

## Platform policies (read before you ship)

[**PLATFORM.md**](./PLATFORM.md) — identity, the cost model, quota
pools, cold start. For this template **§5 is the one that bites**:
egress-billed WebSockets (cheap when idle, priced by your snapshot
bytes), the 3600s timeout ceiling, and why disconnects are a fact of
life, not a bug.

## Going further

- **Swap the game**: keep the message shape (`input` in, `state` out)
  and replace `app/game.py`'s `_step` + the canvas drawing code.
- **Cut egress**: send deltas instead of full snapshots, or drop the
  tick rate for slow-paced games (a turn-based game can broadcast only
  on moves — zero idle cost).
- **Keep rooms across pods?** Room state is in-process by design (one
  api pod). If you ever scale out, move rooms to a `redis` component.
- **Match history / unlocks**: FK new tables on `users.id` — the
  first-sight upsert in `routes/users.py` already gives every signed-in
  player a stable local UUID.
