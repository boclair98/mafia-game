# Black Midnight

A cinematic, real-time Mafia social deduction game for 4–12 players. Create a private room, invite friends with one link, hide your role, survive the night, and expose the liars before the city falls.

**Live game:** [black-midnight.coders.kr](https://black-midnight.coders.kr)

![Black Midnight cinematic city](frontend/public/midnight-city-ui.png)

## Highlights

- Real-time room matches powered by WebSockets
- Server-authoritative roles, night actions, votes, and win conditions
- Mafia, Doctor, Detective, Citizen, Bodyguard, Trickster, and Spectator roles
- Full game loop: sealed identity → night action → dawn → discussion → public vote → verdict
- Private Mafia night chat and confidential Detective investigation records
- Quick and Classic match pacing
- AI players that can fill a room and participate in chat, actions, and voting
- Personal secret missions and a private safe/suspicious evidence board
- Adaptive Korean AI narrator with optional browser speech synthesis
- Cinematic rule briefing for first-time players
- Friend invitations through Web Share, copied room links, and generated invitation posters
- Shareable post-game case report with the winning team, role, and round
- Responsive mobile/desktop interface and installable PWA support
- Reconnection keys, host controls, ready state, rematches, local stats, and haptic feedback

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
```

The backend includes WebSocket game-flow tests under `backend/tests`.

## Deployment

The repository includes a `coders.yaml` manifest for a static Next.js frontend, a FastAPI service, and PostgreSQL. The production game is available at [black-midnight.coders.kr](https://black-midnight.coders.kr).
