"""Server-authoritative social deduction game state.

Rooms are intentionally in-memory: a room link creates a lightweight match,
and only state changes plus a one-second clock pulse are broadcast. Private
roles, night actions, and detective results are filtered per connection.
"""

from __future__ import annotations

import asyncio
import json
import random
import re
import secrets
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from uuid import UUID

from fastapi import WebSocket

MIN_PLAYERS = 4
MAX_PLAYERS = 12
PACE_SECONDS = {
    "quick": {"reveal": 7, "night": 24, "dawn": 6, "day": 42, "vote": 24, "result": 6},
    "classic": {"reveal": 9, "night": 35, "dawn": 8, "day": 75, "vote": 35, "result": 8},
}

_ROOM_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_NICK_RE = re.compile(r"[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ _.-]")

ROLE_NAMES = {
    "mafia": "마피아",
    "doctor": "의사",
    "detective": "탐정",
    "bodyguard": "경호원",
    "trickster": "광대",
    "citizen": "시민",
    "spectator": "관전자",
}

BOT_NAMES = ["루나", "검은고양이", "제로", "모카", "백야", "도윤", "비비", "하울"]
BOT_LINES = [
    "첫날 정보 있는 사람부터 말해봐요.",
    "말이 너무 빠른 사람도 조금 의심스럽네요.",
    "투표는 근거 듣고 할게요.",
    "밤 행동 결과를 숨기는 사람이 있는 것 같아요.",
    "지금 침묵하는 사람도 체크해 둡시다.",
]
MISSIONS = [
    "낮 토론에서 서로 다른 두 사람에게 질문하기",
    "첫 투표 전에 가장 의심스러운 사람을 공개 지목하기",
    "누군가를 한 번 변호한 뒤 최종 판단하기",
    "자신의 역할을 직접 말하지 않고 능력을 암시하기",
    "투표가 끝나기 전 한 번은 기존 의견을 재검토하기",
]


def clean_room_name(raw: str | None) -> str:
    if not raw:
        return "lobby"
    value = raw.strip().lower()
    return value if _ROOM_RE.fullmatch(value) else "lobby"


def clean_nick(raw: str | None, fallback: str) -> str:
    value = _NICK_RE.sub("", (raw or "").strip())[:16]
    return value or fallback


def clean_player_key(raw: str | None) -> str:
    return raw if raw and _KEY_RE.fullmatch(raw) else secrets.token_urlsafe(18)


@dataclass
class Player:
    id: str
    key: str
    nick: str
    coders_id: UUID | None
    ws: WebSocket | None
    connected: bool = True
    ready: bool = False
    alive: bool = True
    role: str = "citizen"
    intel: list[str] = field(default_factory=list)
    score: int = 0
    is_bot: bool = False
    mission: str = ""


class Room:
    def __init__(self, name: str) -> None:
        self.name = name
        self.players: dict[str, Player] = {}
        self.host_id: str | None = None
        self.phase = "lobby"
        self.round = 0
        self.deadline = 0.0
        self.winner: str | None = None
        self.actions: dict[str, str] = {}
        self.votes: dict[str, str] = {}
        self.story: deque[str] = deque(maxlen=7)
        self.chat: deque[dict[str, str | int]] = deque(maxlen=40)
        self.pace = "quick"
        self._bot_marks: set[str] = set()
        self._task: asyncio.Task | None = None

    @property
    def connected_players(self) -> list[Player]:
        return [p for p in self.players.values() if p.connected]

    def join(
        self,
        ws: WebSocket,
        nick: str,
        coders_id: UUID | None,
        player_key: str,
    ) -> tuple[Player, bool]:
        existing = next((p for p in self.players.values() if p.key == player_key), None)
        if existing:
            existing.ws = ws
            existing.connected = True
            existing.nick = nick
            if coders_id is not None:
                existing.coders_id = coders_id
            return existing, True

        if self.phase == "lobby" and len(self.players) < MAX_PLAYERS:
            player = Player(
                id=secrets.token_urlsafe(6),
                key=player_key,
                nick=self._unique_nick(nick),
                coders_id=coders_id,
                ws=ws,
            )
            self.players[player.id] = player
            if self.host_id is None:
                self.host_id = player.id
            self.story.append(f"{player.nick}님이 테이블에 앉았습니다.")
        else:
            player = Player(
                id=secrets.token_urlsafe(6),
                key=player_key,
                nick=self._unique_nick(nick),
                coders_id=coders_id,
                ws=ws,
                alive=False,
                role="spectator",
            )
            self.players[player.id] = player

        if self._task is None or self._task.done():
            self._task = asyncio.get_running_loop().create_task(self._ticker())
        return player, False

    def _unique_nick(self, nick: str) -> str:
        existing = {p.nick for p in self.players.values()}
        if nick not in existing:
            return nick
        for suffix in range(2, 100):
            candidate = f"{nick[:13]} {suffix}"
            if candidate not in existing:
                return candidate
        return f"{nick[:11]}-{secrets.token_hex(2)}"

    def leave(self, pid: str) -> None:
        player = self.players.get(pid)
        if not player:
            return
        if self.phase == "lobby":
            self.players.pop(pid, None)
            self.story.append(f"{player.nick}님이 자리를 떠났습니다.")
            if self.host_id == pid:
                self.host_id = next((p.id for p in self.players.values() if not p.is_bot), None)
        else:
            player.connected = False
            player.ws = None

    def toggle_ready(self, pid: str) -> None:
        if self.phase == "lobby" and pid in self.players:
            self.players[pid].ready = not self.players[pid].ready

    def set_pace(self, pid: str, pace: str) -> str | None:
        if self.phase != "lobby" or pid != self.host_id:
            return "방장만 게임 속도를 바꿀 수 있습니다."
        if pace not in PACE_SECONDS:
            return "지원하지 않는 게임 속도입니다."
        self.pace = pace
        return None

    def fill_bots(self, pid: str, target: int = 6) -> str | None:
        if self.phase != "lobby" or pid != self.host_id:
            return "방장만 AI 플레이어를 초대할 수 있습니다."
        target = max(MIN_PLAYERS, min(target, 8, MAX_PLAYERS))
        available = [name for name in BOT_NAMES if name not in {p.nick for p in self.players.values()}]
        while len(self.players) < target and available:
            name = available.pop(random.randrange(len(available)))
            bot = Player(
                id=secrets.token_urlsafe(6), key=f"bot-{secrets.token_urlsafe(10)}",
                nick=name, coders_id=None, ws=None, ready=True, is_bot=True,
            )
            self.players[bot.id] = bot
            self.story.append(f"AI 플레이어 {bot.nick}님이 참가했습니다.")
        return None

    def start(self, pid: str) -> str | None:
        if self.phase != "lobby" or pid != self.host_id:
            return "방장만 게임을 시작할 수 있습니다."
        active = self.connected_players
        if len(active) < MIN_PLAYERS:
            return f"최소 {MIN_PLAYERS}명이 필요합니다."

        # Disconnected lobby seats never enter the game.
        self.players = {p.id: p for p in active}
        mafia_count = 2 if len(active) >= 7 else 1
        roles = ["mafia"] * mafia_count + ["doctor", "detective"]
        if len(active) >= 6:
            roles.append("trickster")
        if len(active) >= 9:
            roles.append("bodyguard")
        roles += ["citizen"] * (len(active) - len(roles))
        random.shuffle(roles)
        for player, role in zip(active, roles, strict=True):
            player.role = role
            player.alive = True
            player.ready = False
            player.intel.clear()
            player.score = 0
            player.mission = random.choice(MISSIONS)
        self.round = 1
        self.winner = None
        self.actions.clear()
        self.votes.clear()
        self.story.clear()
        self.story.append("도시에 검은 자정이 내렸습니다. 역할을 확인하세요.")
        self._bot_marks.clear()
        self._set_phase("reveal", self._seconds("reveal"))
        return None

    def rematch(self, pid: str) -> str | None:
        if self.phase != "gameover" or pid != self.host_id:
            return "방장만 다시 게임을 준비할 수 있습니다."
        self.players = {p.id: p for p in self.players.values() if p.connected}
        for player in self.players.values():
            player.role = "citizen"
            player.alive = True
            player.ready = False
            player.intel.clear()
            player.mission = ""
        self.round = 0
        self.winner = None
        self.actions.clear()
        self.votes.clear()
        self.story.clear()
        self.story.append("새 게임을 준비합니다. 모두 준비 버튼을 눌러주세요.")
        self._set_phase("lobby", 0)
        return None

    def act(self, pid: str, target_id: str) -> str | None:
        actor = self.players.get(pid)
        target = self.players.get(target_id)
        if self.phase != "night" or not actor or not actor.alive:
            return "지금은 밤 행동을 할 수 없습니다."
        if not target or not target.alive:
            return "선택할 수 없는 대상입니다."
        if actor.role == "mafia" and target.role == "mafia":
            return "같은 마피아는 지목할 수 없습니다."
        if actor.role in {"detective", "bodyguard"} and target.id == actor.id:
            return "자신을 조사할 수 없습니다."
        if actor.role not in {"mafia", "doctor", "detective", "bodyguard"}:
            return "당신에게는 밤 행동이 없습니다."
        self.actions[pid] = target_id
        return None

    def vote(self, pid: str, target_id: str) -> str | None:
        voter = self.players.get(pid)
        target = self.players.get(target_id)
        if self.phase != "vote" or not voter or not voter.alive:
            return "지금은 투표할 수 없습니다."
        if not target or not target.alive or target.id == voter.id:
            return "선택할 수 없는 대상입니다."
        self.votes[pid] = target_id
        return None

    def add_chat(self, pid: str, raw: str) -> str | None:
        player = self.players.get(pid)
        text = " ".join(raw.strip().split())[:160]
        if not player or not text:
            return None
        if self.phase == "night":
            if not player.alive or player.role != "mafia":
                return "밤에는 마피아만 대화할 수 있습니다."
            visibility = "mafia"
        elif self.phase in {"lobby", "day", "vote", "gameover"}:
            visibility = "all"
        else:
            return "지금은 대화할 수 없습니다."
        self.chat.append(
            {"id": secrets.token_hex(4), "from": player.nick, "text": text,
             "visibility": visibility, "at": int(time.time() * 1000)}
        )
        return None

    async def _ticker(self) -> None:
        while self.players:
            self._run_bots()
            if self.phase != "lobby" and self.deadline and time.time() >= self.deadline:
                self._advance()
            await self.broadcast()
            await asyncio.sleep(1)

    def _advance(self) -> None:
        if self.phase == "reveal":
            self.actions.clear()
            self.story.append(f"{self.round}일차 밤. 도시는 숨을 죽였습니다.")
            self._set_phase("night", self._seconds("night"))
        elif self.phase == "night":
            self._resolve_night()
        elif self.phase == "dawn":
            self.story.append("낮이 되었습니다. 말의 모순을 찾아내세요.")
            self._set_phase("day", self._seconds("day"))
        elif self.phase == "day":
            self.votes.clear()
            self.story.append("투표가 시작되었습니다. 가장 의심스러운 사람을 지목하세요.")
            self._set_phase("vote", self._seconds("vote"))
        elif self.phase == "vote":
            self._resolve_vote()
        elif self.phase == "result":
            if self._check_win():
                return
            self.round += 1
            self.actions.clear()
            self.story.append(f"{self.round}일차 밤이 찾아왔습니다.")
            self._set_phase("night", self._seconds("night"))

    def _seconds(self, phase: str) -> int:
        return PACE_SECONDS[self.pace][phase]

    def _run_bots(self) -> None:
        bots = [p for p in self.players.values() if p.is_bot and p.alive]
        alive = [p for p in self.players.values() if p.alive and p.role != "spectator"]
        if self.phase == "night":
            for bot in bots:
                if bot.id in self.actions or bot.role not in {"mafia", "doctor", "detective", "bodyguard"}:
                    continue
                targets = [p for p in alive if p.id != bot.id]
                if bot.role == "mafia":
                    targets = [p for p in targets if p.role != "mafia"]
                if targets:
                    self.actions[bot.id] = random.choice(targets).id
        elif self.phase == "day" and self.deadline - time.time() < self._seconds("day") - 5:
            for bot in bots:
                mark = f"day:{self.round}:{bot.id}"
                if mark not in self._bot_marks and random.random() < 0.22:
                    self._bot_marks.add(mark)
                    line = random.choice(BOT_LINES)
                    self.chat.append({"id": secrets.token_hex(4), "from": bot.nick, "text": line,
                                      "visibility": "all", "at": int(time.time() * 1000)})
        elif self.phase == "vote":
            for bot in bots:
                if bot.id not in self.votes:
                    targets = [p for p in alive if p.id != bot.id]
                    if targets:
                        self.votes[bot.id] = random.choice(targets).id

    def _resolve_night(self) -> None:
        mafia_targets = [
            target for actor_id, target in self.actions.items()
            if self.players.get(actor_id) and self.players[actor_id].role == "mafia"
        ]
        doctor_targets = [
            target for actor_id, target in self.actions.items()
            if self.players.get(actor_id) and self.players[actor_id].role == "doctor"
        ]
        guard_targets = [
            (actor_id, target) for actor_id, target in self.actions.items()
            if self.players.get(actor_id) and self.players[actor_id].role == "bodyguard"
        ]
        victim_id = Counter(mafia_targets).most_common(1)[0][0] if mafia_targets else None
        saved_id = doctor_targets[-1] if doctor_targets else None

        for actor_id, target_id in self.actions.items():
            actor = self.players.get(actor_id)
            target = self.players.get(target_id)
            if actor and target and actor.role == "detective":
                verdict = "마피아입니다" if target.role == "mafia" else "마피아가 아닙니다"
                actor.intel.append(f"{self.round}일차: {target.nick}님은 {verdict}.")

        guarding = next(((guard, target) for guard, target in guard_targets if target == victim_id), None)
        if victim_id and victim_id != saved_id and guarding and guarding[0] in self.players:
            guard = self.players[guarding[0]]
            guard.alive = False
            self.story.append(f"경호원 {guard.nick}님이 누군가를 지키다 대신 희생되었습니다.")
        elif victim_id and victim_id != saved_id and victim_id in self.players:
            victim = self.players[victim_id]
            victim.alive = False
            self.story.append(f"새벽, {victim.nick}님이 싸늘한 주검으로 발견되었습니다.")
        elif victim_id and victim_id == saved_id:
            self.story.append("누군가 습격받았지만 의사의 치료로 살아남았습니다.")
        else:
            self.story.append("밤은 조용히 지나갔습니다. 아무도 희생되지 않았습니다.")

        if not self._check_win():
            self._set_phase("dawn", self._seconds("dawn"))

    def _resolve_vote(self) -> None:
        counts = Counter(self.votes.values())
        eliminated: Player | None = None
        if counts:
            ordered = counts.most_common()
            if len(ordered) == 1 or ordered[0][1] > ordered[1][1]:
                eliminated = self.players.get(ordered[0][0])
        if eliminated:
            eliminated.alive = False
            role_name = ROLE_NAMES.get(eliminated.role, eliminated.role)
            self.story.append(f"{eliminated.nick}님이 처형되었습니다. 정체는 {role_name}였습니다.")
            if eliminated.role == "trickster":
                self.story.append("모두가 광대의 연기에 속았습니다. 광대 단독 승리!")
                self._finish("trickster")
                return
        else:
            self.story.append("표가 갈렸습니다. 오늘은 아무도 처형되지 않았습니다.")
        if not self._check_win():
            self._set_phase("result", self._seconds("result"))

    def _check_win(self) -> bool:
        alive = [p for p in self.players.values() if p.alive and p.role != "spectator"]
        mafia = sum(p.role == "mafia" for p in alive)
        citizens = len(alive) - mafia
        winner = None
        if mafia == 0:
            winner = "citizen"
            self.story.append("시민 팀 승리! 도시의 마지막 마피아가 사라졌습니다.")
        elif mafia >= citizens:
            winner = "mafia"
            self.story.append("마피아 팀 승리! 도시는 완전히 장악되었습니다.")
        if winner:
            self._finish(winner)
            return True
        return False

    def _finish(self, winner: str) -> None:
        self.winner = winner
        for p in self.players.values():
            won = (winner == "mafia" and p.role == "mafia") or (
                winner == "citizen" and p.role not in {"mafia", "trickster", "spectator"}
            ) or (winner == "trickster" and p.role == "trickster")
            if won:
                p.score = 100 + (20 if p.alive else 0)
        self._set_phase("gameover", 0)

    def _set_phase(self, phase: str, seconds: int) -> None:
        self.phase = phase
        self.deadline = time.time() + seconds if seconds else 0

    def _guide_for(self, viewer: Player) -> str:
        if self.phase == "lobby":
            return "처음이라면 AI 플레이어를 채워 연습해 보세요. 방장은 퀵 모드로 약 8분 안에 한 판을 끝낼 수 있습니다."
        if self.phase == "reveal":
            return f"당신은 {ROLE_NAMES.get(viewer.role, viewer.role)}입니다. 역할 카드는 다른 사람에게 보이지 않으니 승리 조건부터 확인하세요."
        if not viewer.alive:
            return "탈락해도 사건은 계속됩니다. 채팅과 투표 흐름을 보며 누가 거짓말했는지 추리해 보세요."
        if self.phase == "night":
            tips = {
                "mafia": "동료와 목표를 맞추세요. 낮에 의심받지 않을 알리바이도 미리 준비해야 합니다.",
                "doctor": "마피아가 노릴 사람을 예측해 치료하세요. 자신도 치료할 수 있습니다.",
                "detective": "조사 결과는 당신만 봅니다. 너무 빨리 공개하면 다음 밤의 표적이 될 수 있습니다.",
                "bodyguard": "중요한 정보 역할을 경호하세요. 습격받으면 당신이 대신 희생됩니다.",
                "trickster": "밤 행동은 없습니다. 낮에 수상하게 보이되 마피아에게 제거당하지 않는 것이 핵심입니다.",
                "citizen": "밤에는 행동이 없습니다. 낮에 누가 결과를 바꾸어 말하는지 기억하세요.",
            }
            return tips.get(viewer.role, "밤이 끝날 때까지 다른 사람의 행동을 기다리세요.")
        if self.phase == "day":
            if viewer.intel:
                return f"최근 조사 기록: {viewer.intel[-1]} 공개할지, 한 턴 더 숨길지 판단하세요."
            return "한 사람을 몰아가기보다 각자 ‘어젯밤 누구를 선택했는지’ 물어보면 모순을 찾기 쉽습니다."
        if self.phase == "vote":
            return "표가 실시간 공개됩니다. 광대는 처형되면 혼자 승리하므로 단순히 수상하다는 이유만으로 찍지 마세요."
        if self.phase in {"dawn", "result"}:
            return "사건 기록과 투표수를 확인하세요. 결과가 나오기 전 했던 주장과 맞는지 비교하면 다음 단서가 됩니다."
        return "역할 공개와 사건 기록을 비교해 승부를 가른 거짓말을 찾아보세요."

    def _state_for(self, viewer: Player) -> dict:
        vote_counts = Counter(self.votes.values()) if self.phase == "vote" else Counter()
        visible_chat = [
            {k: v for k, v in msg.items() if k != "visibility"}
            for msg in self.chat
            if msg["visibility"] == "all" or viewer.role == "mafia"
        ]
        mafia_team = [
            p.id for p in self.players.values()
            if viewer.role == "mafia" and p.role == "mafia"
        ]
        return {
            "t": "state",
            "room": self.name,
            "phase": self.phase,
            "round": self.round,
            "deadline": round(self.deadline * 1000),
            "winner": self.winner,
            "pace": self.pace,
            "host": self.host_id,
            "min_players": MIN_PLAYERS,
            "max_players": MAX_PLAYERS,
            "players": [
                {
                    "id": p.id,
                    "n": p.nick,
                    "alive": p.alive,
                    "connected": p.connected,
                    "ready": p.ready,
                    "votes": vote_counts[p.id],
                    "mafia": p.id in mafia_team,
                    "role": p.role if self.phase == "gameover" else None,
                    "bot": p.is_bot,
                }
                for p in self.players.values()
            ],
            "me": {
                "id": viewer.id,
                "role": viewer.role,
                "alive": viewer.alive,
                "action_target": self.actions.get(viewer.id),
                "vote_target": self.votes.get(viewer.id),
                "intel": viewer.intel[-4:],
                "mission": viewer.mission,
            },
            "story": list(self.story),
            "guide": self._guide_for(viewer),
            "chat": visible_chat[-30:],
        }

    async def broadcast(self) -> None:
        sends = []
        for player in list(self.players.values()):
            if player.connected and player.ws:
                payload = json.dumps(self._state_for(player), ensure_ascii=False, separators=(",", ":"))
                sends.append(player.ws.send_text(payload))
        if sends:
            await asyncio.gather(*sends, return_exceptions=True)


class RoomManager:
    def __init__(self) -> None:
        self._rooms: dict[str, Room] = {}

    def get(self, name: str) -> Room:
        if name not in self._rooms:
            self._rooms[name] = Room(name)
        return self._rooms[name]

    def sweep(self, name: str) -> None:
        room = self._rooms.get(name)
        if room is not None and not room.players:
            self._rooms.pop(name, None)

    @property
    def online(self) -> int:
        return sum(len(r.connected_players) for r in self._rooms.values())


rooms = RoomManager()


def welcome_message(room: Room, player: Player, resumed: bool) -> str:
    return json.dumps(
        {
            "t": "welcome",
            "id": player.id,
            "nick": player.nick,
            "room": room.name,
            "player_key": player.key,
            "signed_in": player.coders_id is not None,
            "resumed": resumed,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
