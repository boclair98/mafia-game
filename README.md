# Black Midnight

[![Production checks](https://github.com/boclair98/mafia-game/actions/workflows/ci.yml/badge.svg)](https://github.com/boclair98/mafia-game/actions/workflows/ci.yml)

A cinematic, real-time Mafia social deduction game for 4–12 players. Create a private room, invite friends with one link, hide your role, survive the night, and expose the liars before the city falls.

**Live game:** [black-midnight.coders.kr](https://black-midnight.coders.kr)

![Black Midnight cinematic city](frontend/public/midnight-city-ui.webp)

## Highlights

- Real-time room matches powered by WebSockets
- Server-authoritative roles, night actions, votes, and win conditions
- Mafia, Doctor, Detective, Citizen, Bodyguard, Trickster, and Spectator roles
- Full game loop: sealed identity → night action → dawn → discussion → public vote → final defense → execute/spare verdict
- Private Mafia night chat and confidential Detective investigation records
- Quick and Classic match pacing
- AI players that can fill 4/6/8 seats, build a public suspicion, question suspects, act, defend themselves, and vote consistently
- Personal secret missions and a private safe/suspicious evidence board
- Adaptive Korean AI narrator with optional browser speech synthesis
- Cinematic rule briefing for first-time players
- Friend invitations through Web Share, copied room links, and generated invitation posters
- Shareable post-game case report with the winning team, role, and round
- Live emoji reactions, an animated courtroom, and a copyable full incident archive
- Persistent signed-in leaderboard plus privacy-safe live player/match presence
- Responsive mobile/desktop interface and installable PWA support
- Reconnection keys, host controls, enforced ready state, rematches, local stats, scoring, and haptic feedback
- Automatic inactive-room cleanup, message/reaction throttling, server-side input validation, and private state filtering
- GitHub Actions production checks for frontend lint/build and backend tests/Ruff with PostgreSQL
- WebP-optimized cinematic artwork for a substantially smaller mobile first load

All character portraits are fictional AI-generated people and do not represent real individuals.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 16, React 19, TypeScript, CSS, Lucide icons |
| Realtime API | FastAPI, Python, WebSockets |
| Database | PostgreSQL, SQLAlchemy, Alembic |
| Packaging | Docker Compose, multi-stage Docker builds |
| Hosting | coders.kr multi-service deployment |

## Run Locally

The easiest way to start the complete stack is Docker Compose:

```bash
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000), then join the same room code from multiple browser windows.

### Frontend only

```bash
cd frontend
pnpm install
pnpm dev
```

### Backend only

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

## Project Structure

```text
frontend/   Next.js static-export client and PWA assets
backend/    FastAPI WebSocket game server and tests
coders.yaml Multi-service production deployment manifest
compose.yaml Local frontend, backend, and PostgreSQL stack
```

## Validation

```bash
cd frontend
pnpm lint
pnpm build

cd ../backend
uv sync --extra dev
uv run pytest -q
```

The backend includes WebSocket and focused server-authoritative game-flow tests under `backend/tests`. The trial suite covers vote ties, final defense permissions, execute/spare ties, Trickster wins, bot seat management, reaction controls, and readiness enforcement.

## Match Rules

1. The host invites friends and can fill the room to 4, 6, or 8 seats with AI players.
2. Every non-host human confirms readiness; the server then seals and privately assigns roles.
3. At night, Mafia attack, Doctor heals, Detective investigates, and Bodyguard protects. Only Mafia can use the private night channel.
4. During the day, everyone compares claims, marks a private evidence board, and uses public reactions.
5. A unique public-vote leader becomes the accused. Only that player may speak during final defense.
6. Living players except the accused choose execute or spare. A tie means spare.
7. Citizens win when every Mafia member is gone; Mafia win at parity; the Trickster wins immediately when executed by the city.

Secret roles, night commands, Detective intel, Mafia chat, verdict validation, and win calculations are all enforced on the server rather than trusted to the browser.

## Deployment

The repository includes a `coders.yaml` manifest for a static Next.js frontend, a FastAPI service, and PostgreSQL. The production game is available at [black-midnight.coders.kr](https://black-midnight.coders.kr).
