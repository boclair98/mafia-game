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
from typing import TYPE_CHECKING, Any
from uuid import UUID

from app.core.config import settings

if TYPE_CHECKING:
    from fastapi import WebSocket
else:
    WebSocket = Any

MIN_PLAYERS = 4
MAX_PLAYERS = 12
PACE_SECONDS = {
    # A guided first case is deliberately short enough to finish in one sitting
    # while still leaving space for the director's narration and a real vote.
    "first": {"reveal": 14, "night": 28, "dawn": 10, "day": 78, "vote": 34, "defense": 26, "verdict": 24, "result": 10},
    # Even the quick table leaves room for the announcer, role reveal, and a
    # complete thought before the next phase arrives. The old 12/40 second
    # windows made a first-time player miss the hand-off between screens.
    "quick": {"reveal": 18, "night": 70, "dawn": 18, "day": 180, "vote": 75, "defense": 60, "verdict": 55, "result": 18},
    "classic": {"reveal": 24, "night": 90, "dawn": 24, "day": 240, "vote": 100, "defense": 80, "verdict": 70, "result": 24},
}
EARLY_ADVANCE_MINIMUM = {
    "first": {"night": 18, "vote": 22, "verdict": 16},
    "quick": {"night": 45, "vote": 40, "verdict": 35},
    "classic": {"night": 60, "vote": 60, "verdict": 50},
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


class RoomCapacityError(RuntimeError):
    """Raised when this API process has reached its room safety limit."""

BOT_NAMES = ["루나", "검은고양이", "제로", "모카", "백야", "도윤", "비비", "하울"]
BOT_PERSONAS = {
    "루나": {"id": "analyst", "label": "기록 분석가", "talk_chance": 0.72, "suspect_bias": 0.18,
             "lines": ["사건 기록의 시간 순서를 다시 맞춰볼게요.", "숫자와 동선이 어긋나는 사람부터 확인하죠."]},
    "검은고양이": {"id": "provocateur", "label": "도발적인 심문관", "talk_chance": 0.86, "suspect_bias": 0.32,
                  "lines": ["다들 너무 안전한 말만 하네요. 한 명은 지금 숨기고 있어요.", "좋아요, 그럼 가장 불편한 질문부터 하겠습니다."]},
    "제로": {"id": "skeptic", "label": "냉정한 회의론자", "talk_chance": 0.58, "suspect_bias": 0.05,
             "lines": ["확신보다 확인 가능한 사실을 먼저 보죠.", "아직은 보류입니다. 다음 기록이 더 필요해요."]},
    "모카": {"id": "empath", "label": "알리바이 중재자", "talk_chance": 0.68, "suspect_bias": -0.08,
             "lines": ["서로의 말을 끝까지 듣고 판단했으면 해요.", "지금 몰아가면 진짜 단서를 놓칠 수 있어요."]},
    "백야": {"id": "archivist", "label": "침묵하는 기록관", "talk_chance": 0.46, "suspect_bias": 0.12,
             "lines": ["저는 발언보다 행동의 순서를 기록하고 있습니다.", "방금 말과 어젯밤 선택이 맞는지 비교해 보세요."]},
    "도윤": {"id": "captain", "label": "결단 빠른 현장대장", "talk_chance": 0.78, "suspect_bias": 0.25,
             "lines": ["시간이 없습니다. 지금 가장 모순된 한 명을 좁혀야 해요.", "제 판단은 바뀔 수 있지만, 근거 없이 표를 흩뜨리진 맙시다."]},
    "비비": {"id": "observer", "label": "감정적인 목격자", "talk_chance": 0.74, "suspect_bias": 0.2,
             "lines": ["말투가 조금 이상했어요. 그 부분을 그냥 넘기면 안 돼요.", "저는 방금 반응이 가장 신경 쓰입니다."]},
    "하울": {"id": "maverick", "label": "독단적인 승부사", "talk_chance": 0.9, "suspect_bias": 0.4,
             "lines": ["저는 한 명을 찍고 끝까지 검증하겠습니다.", "모두가 보류하면 범인만 편해집니다."]},
}
DEFAULT_BOT_PERSONA = {"id": "balanced", "label": "균형 잡힌 수사관", "talk_chance": 0.65, "suspect_bias": 0.12,
                       "lines": ["기록과 발언을 함께 비교해 보죠."]}
BOT_LINES = [
    "첫날 정보 있는 사람부터 말해봐요.",
    "말이 너무 빠른 사람도 조금 의심스럽네요.",
    "투표는 근거 듣고 할게요.",
    "밤 행동 결과를 숨기는 사람이 있는 것 같아요.",
    "지금 침묵하는 사람도 체크해 둡시다.",
]
BOT_QUESTIONS = [
    "{target}님, 어젯밤 누구를 선택했는지 먼저 말해 주세요.",
    "저는 지금 {target}님의 앞뒤가 조금 안 맞는다고 봅니다.",
    "{target}님이 첫날부터 결론을 너무 빨리 내리는 것 같아요.",
    "일단 {target}님 발언을 사건 기록과 다시 비교해 봅시다.",
    "{target}님, 본인이 시민이라고 볼 수 있는 근거가 있나요?",
]
BOT_DEFENSE_LINES = [
    "잠깐만요. 제 발언보다 투표가 몰린 과정부터 다시 봐주세요.",
    "제가 마피아라면 이렇게 눈에 띄게 움직이지 않았을 겁니다.",
    "오늘 저를 보내면 내일 정보가 더 줄어듭니다. 한 번만 보류해 주세요.",
    "근거 없이 표가 따라붙었습니다. 처음 지목한 사람을 확인해 주세요.",
]
ALLOWED_REACTIONS = {"👀", "⚠️", "👍", "🤥", "❓", "🩸"}
ALLOWED_READS = {"trust", "hold", "suspect"}
MISSIONS = [
    "낮 토론에서 서로 다른 두 사람에게 질문하기",
    "첫 투표 전에 가장 의심스러운 사람을 공개 지목하기",
    "누군가를 한 번 변호한 뒤 최종 판단하기",
    "자신의 역할을 직접 말하지 않고 능력을 암시하기",
    "투표가 끝나기 전 한 번은 기존 의견을 재검토하기",
]

MEMORY_PROMPTS = [
    "사건 직전 마지막으로 본 사람과 장소를 기록하세요.",
    "오늘 밤 가장 믿고 싶은 사람과 그 이유를 남기세요.",
    "범인이 남겼을 법한 작은 흔적을 한 문장으로 상상하세요.",
    "아침에 가장 먼저 확인할 기록을 적어 두세요.",
]

SCENE_FRAGMENTS = [
    {"id": "scene-gate", "time": "00:38", "title": "출입 기록", "detail": "서쪽 출입문이 한 번 열리고, 잠금 장치가 12초 늦게 닫혔습니다."},
    {"id": "scene-blackout", "time": "00:39", "title": "짧은 정전", "detail": "복도 카메라가 47초 동안 검게 변했습니다. 누군가 기록실에 접근했습니다."},
    {"id": "scene-trace", "time": "00:40", "title": "젖은 흔적", "detail": "창가에서 젖은 구두 자국 두 개와 끊긴 섬유 조각이 발견됐습니다."},
    {"id": "scene-call", "time": "00:41", "title": "마지막 통화", "detail": "피해자의 전화에서 18초짜리 발신 기록이 남았지만 상대는 확인되지 않았습니다."},
    {"id": "scene-exit", "time": "00:42", "title": "잠긴 현장", "detail": "비상등이 켜진 뒤 객실이 안쪽에서 잠겼고, 현장의 시계가 멈췄습니다."},
]
SCENE_ORDER = [fragment["id"] for fragment in SCENE_FRAGMENTS]

FORENSIC_CLUES = [
    ("CCTV 음영 구역", "00:38~00:42 사이 복도 카메라에서 {suspects} 중 한 명의 동선이 끊겼습니다."),
    ("미세 섬유 조각", "현장에서 발견된 짙은 섬유는 {suspects} 중 한 명의 외투에서 떨어졌을 가능성이 있습니다."),
    ("복제된 키카드", "잠금 기록과 대조한 결과 {suspects} 중 한 명이 사용한 동선과 겹칩니다."),
    ("불완전한 지문", "감식반이 복원한 부분 지문은 {suspects} 중 한 명의 기록과 유사합니다."),
    ("젖은 구두 자국", "빗물 성분이 남은 발자국은 {suspects} 중 한 명이 현장을 지났음을 시사합니다."),
]

CASE_PROFILES = [
    {"id": "hotel-404", "code": "BM-404", "title": "404호의 마지막 연주", "location": "백야 호텔 4층", "victim": "바이올리니스트 한서윤", "briefing": "잠긴 객실 안에서 연주자가 숨진 채 발견됐습니다. 출입 기록은 방 안의 누군가가 조작했습니다."},
    {"id": "night-train", "code": "BM-717", "title": "7호 야간열차 밀실", "location": "자정행 7호 열차", "victim": "탐사 기자 윤재하", "briefing": "터널을 통과한 4분 동안 기자가 살해됐습니다. 용의자는 모두 같은 객차에 있었습니다."},
    {"id": "black-wing", "code": "BM-113", "title": "검은 날개 전시관", "location": "아르카 미술관", "victim": "수석 큐레이터 차유진", "briefing": "정전 직후 경보가 울렸고 큐레이터가 사라졌습니다. 위조된 작품표가 범인의 동선을 가리킵니다."},
    {"id": "observatory", "code": "BM-042", "title": "관측소의 00시 42분", "location": "북악 천문 관측소", "victim": "천문학자 강이안", "briefing": "관측 기록이 끊긴 90초 사이 사건이 벌어졌습니다. 남겨진 신호는 내부자의 암호입니다."},
    {"id": "archive-fire", "code": "BM-206", "title": "불타지 않은 기록실", "location": "구시청 지하 기록실", "victim": "기록관 서지후", "briefing": "화재 경보는 울렸지만 단 한 장의 사건 파일만 사라졌습니다. 출입카드는 세 번 복제됐습니다."},
    {"id": "rooftop-rain", "code": "BM-318", "title": "옥상에 남은 빗방울", "location": "동쪽 송신탑 옥상", "victim": "기상 캐스터 한도윤", "briefing": "폭우 속 송신이 끊긴 3분, 옥상 문은 안에서 잠겼습니다. 젖은 발자국은 두 방향으로 갈립니다."},
    {"id": "glasshouse", "code": "BM-527", "title": "유리온실의 빈자리", "location": "백야 식물원 유리온실", "victim": "보존가 윤소담", "briefing": "온실의 습도 기록과 실제 발자국이 맞지 않습니다. 누군가 알리바이를 위해 자동 급수를 켰습니다."},
    {"id": "radio-room", "code": "BM-631", "title": "02:17 라디오 침묵", "location": "폐쇄된 심야 라디오국", "victim": "프로듀서 이가람", "briefing": "생방송 신호가 17초 끊긴 사이 사건이 일어났습니다. 마지막 큐시트가 찢겨 있습니다."},
    {"id": "ferry-deck", "code": "BM-744", "title": "안개 속 3번 갑판", "location": "새벽항 여객선", "victim": "선내 의사 최문아", "briefing": "안개 경보 중 갑판의 CCTV가 회전했습니다. 승객 명부에는 한 명의 가짜 이름이 있습니다."},
    {"id": "theatre-box", "code": "BM-856", "title": "막이 내린 뒤의 객석", "location": "월광 극장 2층 박스석", "victim": "연출가 오태성", "briefing": "커튼콜 직후 조명이 꺼졌고 박스석이 잠겼습니다. 무대 소품의 위치가 한 걸음 어긋나 있습니다."},
    {"id": "subway-platform", "code": "BM-903", "title": "막차 플랫폼의 빈 90초", "location": "검은선 지하철 9번 승강장", "victim": "노선 설계자 박예린", "briefing": "막차가 들어온 90초 동안 승강장 카메라가 지워졌습니다. 승차 태그는 네 개뿐입니다."},
    {"id": "winter-cabin", "code": "BM-117", "title": "눈보라 전의 난로", "location": "북부 산장 1호실", "victim": "사진가 민재호", "briefing": "눈보라가 길을 막기 직전 난로의 재가 뒤집혔습니다. 밖으로 나간 발자국은 하나뿐입니다."},
    {"id": "museum-vault", "code": "BM-268", "title": "금고 안의 푸른 봉인", "location": "청람 박물관 보존 금고", "victim": "감정사 정하린", "briefing": "금고는 열리지 않았지만 봉인만 바뀌었습니다. 감식 장갑의 섬유가 용의자 셋을 가리킵니다."},
    {"id": "rooftop-garden", "code": "BM-371", "title": "정원에 떨어진 검은 씨앗", "location": "도심 옥상정원", "victim": "도시농부 강세아", "briefing": "새벽 급수 장치가 한 번 작동했고, 화단 흙에서 낯선 금속 조각이 발견됐습니다."},
    {"id": "hotel-kitchen", "code": "BM-482", "title": "마지막 주문은 4번 테이블", "location": "백야 호텔 주방", "victim": "수석 셰프 김도현", "briefing": "주문표가 뒤바뀐 2분 동안 주방 출입 기록이 비었습니다. 범인은 맛을 아는 사람입니다."},
]

# Every case uses five readable anchors, but the causal layout and surface clues
# change. This keeps the deduction legible for new players while preventing
# experienced players from solving a room by sorting timestamps alone.
CASE_TIMELINE = [
    {"id": "approach", "time": "00:38", "title": "접근 기록", "detail": "잠금 장치가 12초 늦게 닫혔습니다. 누군가 현장에 들어온 흔적입니다.", "action_tag": "entry"},
    {"id": "blindspot", "time": "00:39", "title": "기록 공백", "detail": "카메라가 47초 동안 검게 변했습니다. 그 사이 역할 능력이 사용됐을 가능성이 있습니다.", "action_tag": "blindspot"},
    {"id": "attack", "time": "00:40", "title": "습격의 흔적", "detail": "피해자의 마지막 흔적과 공격 흔적이 겹칩니다. 마피아의 밤 행동과 대조하세요.", "action_tag": "attack"},
    {"id": "alibi", "time": "00:41", "title": "알리바이 신호", "detail": "18초짜리 통화가 남았지만 발신자는 확인되지 않았습니다. 누군가의 알리바이가 만들어졌습니다.", "action_tag": "alibi"},
    {"id": "lock", "time": "00:42", "title": "봉인된 현장", "detail": "비상등이 켜진 뒤 현장이 안쪽에서 잠겼습니다. 마지막 행동이 사건을 완성합니다.", "action_tag": "lock"},
]

# General cases rotate the causal layout so the reconstruction is not a
# timestamp-sorting exercise. The first case keeps the canonical layout for
# teaching; party and solo cases can introduce clock drift and a different
# chain of cause and effect while preserving the same five readable anchors.
CASE_TIMELINE_LAYOUTS = [
    {
        "id": "canonical",
        "order": ["approach", "blindspot", "attack", "alibi", "lock"],
        "clock": ["00:38", "00:39", "00:40", "00:41", "00:42"],
        "chain_label": "접근 기록 → 기록 공백 → 습격의 흔적 → 알리바이 신호 → 봉인된 현장",
    },
    {
        "id": "forged-call",
        "order": ["approach", "attack", "blindspot", "alibi", "lock"],
        "clock": ["00:38", "00:41", "00:39", "00:40", "00:42"],
        "chain_label": "접근 기록 → 습격의 흔적 → 기록 공백 → 알리바이 신호 → 봉인된 현장",
    },
    {
        "id": "blackout-entry",
        "order": ["blindspot", "approach", "attack", "lock", "alibi"],
        "clock": ["00:39", "00:38", "00:40", "00:42", "00:41"],
        "chain_label": "기록 공백 → 접근 기록 → 습격의 흔적 → 봉인된 현장 → 알리바이 신호",
    },
    {
        "id": "sealed-witness",
        "order": ["approach", "alibi", "blindspot", "attack", "lock"],
        "clock": ["00:38", "00:41", "00:39", "00:40", "00:42"],
        "chain_label": "접근 기록 → 알리바이 신호 → 기록 공백 → 습격의 흔적 → 봉인된 현장",
    },
]

ROUND_EVENTS = [
    {
        "id": "red-thread",
        "title": "붉은 실",
        "tag": "PUBLIC PRESSURE",
        "copy": "긴급 지목이 즉시 공개됩니다. 누가 의심의 방향을 만들었는지 추적하세요.",
        "sealed_pressure": False,
    },
    {
        "id": "blackout",
        "title": "기록실 정전",
        "tag": "SEALED PRESSURE",
        "copy": "긴급 지목은 낮 동안 봉인되고 시민 투표가 시작될 때 한꺼번에 공개됩니다.",
        "sealed_pressure": True,
    },
    {
        "id": "last-call",
        "title": "마지막 통화",
        "tag": "FINAL CALL",
        "copy": "이번 낮의 긴급 지목은 최종 사건 파일에 결정적 장면으로 기록됩니다.",
        "sealed_pressure": False,
    },
    {
        "id": "cross-exam",
        "title": "교차 심문",
        "tag": "CROSS EXAMINATION",
        "copy": "말보다 선택이 오래 남습니다. 발언을 들은 뒤 가장 모순된 한 명을 지목하세요.",
        "sealed_pressure": False,
    },
]

LEAD_TEMPLATES = [
    ("출입 시각 기록", "{suspect}님의 출입 기록이 사건 추정 시각과 4분 겹칩니다."),
    ("젖은 외투의 흔적", "현장 창가의 빗물 성분이 {suspect}님의 좌석 주변에서 발견됐습니다."),
    ("봉인 훼손 감정", "증거 봉투의 왁스 조각이 {suspect}님이 있던 구역과 같은 성분입니다."),
    ("통화 기록 공백", "{suspect}님의 기기만 사건 전후 6분간 네트워크에서 사라졌습니다."),
    ("목격 진술 조각", "정전 직전 {suspect}님과 비슷한 체격의 인물이 복도를 지났습니다."),
    ("잔류 향 성분", "현장에 남은 향 성분이 {suspect}님의 소지품과 일부 일치합니다."),
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
    bot_profile: str = "balanced"
    mission: str = ""
    last_chat_at: float = 0.0
    last_reaction_at: float = 0.0
    last_command_at: float = 0.0
    voice: bool = False


class Room:
    def __init__(self, name: str) -> None:
        self.name = name
        # Solo room codes are intentionally recognisable and server-enforced;
        # a copied solo link must not silently turn into a party lobby.
        self.lobby_mode = "first" if name.startswith("first-") else "solo" if name.startswith("solo-") else "party"
        self.players: dict[str, Player] = {}
        self.host_id: str | None = None
        self.phase = "lobby"
        self.round = 0
        self.deadline = 0.0
        self.phase_started_at = time.time()
        self.winner: str | None = None
        self.mode = "party"
        self.case_mode = "first" if self.lobby_mode == "first" else "classic"
        self.actions: dict[str, str] = {}
        self.votes: dict[str, str] = {}
        self.accused_id: str | None = None
        self.judgements: dict[str, bool] = {}
        self.story: deque[str] = deque(maxlen=7)
        self.case_log: deque[str] = deque(maxlen=48)
        self.chat: deque[dict[str, str | int]] = deque(maxlen=40)
        self.reactions: deque[dict[str, str | int]] = deque(maxlen=20)
        self.questions: deque[dict[str, str | int]] = deque(maxlen=24)
        self.claims: deque[dict[str, str | int]] = deque(maxlen=36)
        self.tips: deque[dict[str, str | int]] = deque(maxlen=18)
        self.tip_marks: set[str] = set()
        self.moments: deque[dict[str, str | int | None]] = deque(maxlen=48)
        self.clues: deque[dict[str, Any]] = deque(maxlen=12)
        self.reads: dict[str, dict[str, str]] = {}
        self.wills: dict[str, str] = {}
        self.interrogation_order: list[str] = []
        self.speaker_id: str | None = None
        self.speaker_deadline = 0.0
        self._speaker_index = -1
        self.last_death_id: str | None = None
        self.pace = "first" if self.case_mode == "first" else "quick"
        self.case_profile = random.choice(CASE_PROFILES)
        self.case_solution: dict[str, Any] = {}
        self.case_grade = ""
        self.case_badges: list[dict[str, str]] = []
        self.final_highlights: list[dict[str, str]] = []
        self.best_persuader: dict[str, str] | None = None
        self.ai_memories: dict[str, list[dict[str, Any]]] = {}
        self.ai_relationships: dict[str, dict[str, dict[str, Any]]] = {}
        self.reports: deque[dict[str, Any]] = deque(maxlen=100)
        self.private_leads: dict[str, dict[str, Any]] = {}
        self.public_leads: deque[dict[str, Any]] = deque(maxlen=18)
        self.ghost_predictions: dict[str, str] = {}
        self.memory_seals: dict[str, dict[str, Any]] = {}
        self.memory_prompts: dict[str, str] = {}
        self.scene_fragments: dict[str, list[dict[str, Any]]] = {}
        self.scene_submissions: dict[str, dict[str, Any]] = {}
        self.scene_results: dict[str, dict[str, Any]] = {}
        # Publicly visible hypotheses that bind a suspect, a forensic clue,
        # and one private timeline fragment.  The hidden link evaluation is
        # intentionally kept server-side until the case is closed.
        self.theories: dict[str, dict[str, Any]] = {}
        self.theory_stakes: dict[str, int] = {}
        self.oaths: dict[str, dict[str, Any]] = {}
        self.contracts: dict[str, dict[str, Any]] = {}
        self.ghost_echoes: deque[dict[str, Any]] = deque(maxlen=24)
        self.ghost_echo_marks: set[str] = set()
        self.director_beats: deque[dict[str, Any]] = deque(maxlen=12)
        self.round_event: dict[str, Any] | None = None
        self.pressure_marks: dict[str, str] = {}
        self.awards: list[dict[str, str | int]] = []
        self._bot_marks: set[str] = set()
        self._bot_suspicions: dict[str, str] = {}
        self._task: asyncio.Task | None = None
        self._broadcast_lock = asyncio.Lock()
        self._last_broadcast_payloads: dict[str, str] = {}
        self.last_activity = time.time()

    def _record(self, line: str) -> None:
        self.story.append(line)
        self.case_log.append(line)

    def _director_beat(self, title: str, copy: str, tone: str = "amber") -> None:
        """Add a short, server-authored scene beat without revealing roles."""
        beat = {
            "id": secrets.token_hex(4),
            "round": self.round,
            "title": title,
            "copy": copy,
            "tone": tone,
            "at": int(time.time() * 1000),
        }
        self.director_beats.append(beat)
        self._moment("director", f"{title} — {copy}")

    def _prepare_scene(self) -> None:
        """Deal private evidence fragments from the selected causal timeline."""
        active = [p for p in self.players.values() if p.role != "spectator"]
        fragments = self.case_solution.get("timeline") or SCENE_FRAGMENTS
        self.scene_fragments = {
            player.id: random.sample(fragments, min(3, len(fragments)))
            for player in active
        }
        self.scene_submissions.clear()
        self.scene_results.clear()

    def _mission_completed(self, player: Player) -> bool:
        mission = player.mission
        if not mission:
            return False
        if mission.startswith("낮 토론"):
            return len({item["speaker_id"] for item in self.questions if item["round"] == self.round and item["from_id"] == player.id}) >= 2
        if mission.startswith("첫 투표"):
            return any(key.startswith(f"{self.round}:") and key.endswith(player.id) for key in self.pressure_marks)
        if mission.startswith("누군가를"):
            return any(item.get("actor") == player.id and item.get("kind") == "claim" for item in self.moments) and player.id in self.judgements
        if mission.startswith("자신의 역할"):
            return any(item.get("from_id") == player.id and any(word in str(item.get("text", "")) for word in ("능력", "밤", "조사", "치료", "경호")) for item in self.chat)
        if mission.startswith("투표가"):
            return len(self.reads.get(player.id, {})) >= 2
        return False

    def _moment(
        self,
        kind: str,
        text: str,
        actor: str | None = None,
        target: str | None = None,
    ) -> None:
        self.moments.append({
            "id": secrets.token_hex(4),
            "kind": kind,
            "text": text,
            "actor": actor,
            "target": target,
            "round": self.round,
        })

    def _draw_round_event(self) -> None:
        previous = self.round_event.get("id") if self.round_event else None
        choices = [event for event in ROUND_EVENTS if event["id"] != previous]
        self.round_event = dict(random.choice(choices or ROUND_EVENTS))
        self._record(
            f"자정 사건 카드 — {self.round_event['title']}: "
            f"{self.round_event['copy']}"
        )

    def _build_awards(self) -> None:
        """Create playful, factual end-of-match accolades from public actions."""
        awards: list[dict[str, str | int]] = []
        playable = [p for p in self.players.values() if p.role != "spectator"]

        question_counts = Counter(str(item["from_id"]) for item in self.questions)
        if question_counts:
            pid, count = question_counts.most_common(1)[0]
            player = self.players.get(pid)
            if player:
                awards.append({
                    "id": "interrogator", "player_id": pid, "player": player.nick,
                    "title": "질문 폭격기", "copy": f"핵심 질문 {count}개로 진술을 흔들었습니다.",
                })

        claim_counts = Counter(str(item["speaker_id"]) for item in self.claims)
        if claim_counts:
            pid, count = claim_counts.most_common(1)[0]
            player = self.players.get(pid)
            if player:
                awards.append({
                    "id": "archivist", "player_id": pid, "player": player.nick,
                    "title": "기록 설계자", "copy": f"공식 진술 {count}개를 사건 파일에 남겼습니다.",
                })

        correct_reads: Counter[str] = Counter()
        for pid, choices in self.reads.items():
            for key, stance in choices.items():
                target = self.players.get(key.split(":", 1)[-1])
                if target and stance == "suspect" and target.role == "mafia":
                    correct_reads[pid] += 1
        if correct_reads:
            pid, count = correct_reads.most_common(1)[0]
            player = self.players.get(pid)
            if player:
                awards.append({
                    "id": "hawk-eye", "player_id": pid, "player": player.nick,
                    "title": "매의 눈", "copy": f"마피아를 향한 의심 판단을 {count}번 적중시켰습니다.",
                })

        pressure_counts: Counter[str] = Counter()
        for key, target_id in self.pressure_marks.items():
            actor_id = key.split(":", 1)[-1]
            target = self.players.get(target_id)
            actor = self.players.get(actor_id)
            if actor and actor.role != "mafia" and target and target.role == "mafia":
                pressure_counts[actor_id] += 1
        if pressure_counts:
            pid, count = pressure_counts.most_common(1)[0]
            player = self.players.get(pid)
            if player:
                awards.append({
                    "id": "red-thread", "player_id": pid, "player": player.nick,
                    "title": "붉은 실의 주인", "copy": f"긴급 지목으로 범인을 {count}번 정확히 압박했습니다.",
                })

        confirmed_theories = Counter(
            str(theory.get("owner_id"))
            for theory in self.theories.values()
            if theory.get("status") == "confirmed"
        )
        if confirmed_theories:
            pid, count = confirmed_theories.most_common(1)[0]
            player = self.players.get(pid)
            if player:
                awards.append({
                    "id": "chain-link", "player_id": pid, "player": player.nick,
                    "title": "인과 고리 설계자", "copy": f"용의자·단서·시간을 {count}번 모두 연결했습니다.",
                })

        if not awards and playable:
            survivor = next((p for p in playable if p.alive), playable[0])
            awards.append({
                "id": "survivor", "player_id": survivor.id, "player": survivor.nick,
                "title": "자정의 생존자", "copy": "끝까지 사건의 결말을 지켜봤습니다.",
            })
        self.awards = awards[:4]

    def _build_case_report(self) -> None:
        """Turn the public trail into a compact, replayable case report."""
        playable = [p for p in self.players.values() if p.role != "spectator"]
        if not playable:
            return
        evidence_hits = sum(1 for result in self.scene_results.values() if result.get("score", 0) >= 67)
        confirmed_theories = sum(1 for theory in self.theories.values() if theory.get("status") == "confirmed")
        partial_theories = sum(1 for theory in self.theories.values() if theory.get("status") == "partial")
        public_claims = len(self.claims)
        correct_pressure = sum(
            1 for target_id in self.pressure_marks.values()
            if self.players.get(target_id) and self.players[target_id].role == "mafia"
        )
        score = min(100, 35 + evidence_hits * 12 + confirmed_theories * 10 + partial_theories * 3 + correct_pressure * 15 + min(public_claims, 5) * 4)
        self.case_grade = "S" if score >= 86 else "A" if score >= 70 else "B" if score >= 52 else "C"
        self.case_badges = []
        if evidence_hits:
            self.case_badges.append({"id": "timeline", "title": "시간의 복원자", "copy": "실제 행동 순서와 단서를 연결했습니다."})
        if confirmed_theories:
            self.case_badges.append({"id": "chain-link", "title": "인과 고리 설계자", "copy": f"봉인된 가설 {confirmed_theories}개가 실제 사건과 일치했습니다."})
        if correct_pressure:
            self.case_badges.append({"id": "red-thread", "title": "붉은 실 추적자", "copy": "압박 지목이 범인의 행동을 좁혔습니다."})
        if self.case_mode == "first":
            self.case_badges.append({"id": "first-case", "title": "첫 사건 완주", "copy": "짧은 사건의 전 과정을 끝까지 수사했습니다."})
        if not self.case_badges:
            self.case_badges.append({"id": "witness", "title": "침묵의 목격자", "copy": "사건 파일의 마지막 장면까지 살아남았습니다."})
        persuasion = Counter(str(item.get("speaker_id")) for item in self.claims)
        if persuasion:
            pid, count = persuasion.most_common(1)[0]
            player = self.players.get(pid)
            if player:
                self.best_persuader = {"player_id": pid, "player": player.nick, "copy": f"공식 진술 {count}개로 테이블의 시선을 움직였습니다."}
        culprit = next((p for p in playable if p.role == "mafia"), None)
        self.final_highlights = [
            {"kind": "case", "title": "사건의 핵심", "copy": self.case_profile.get("briefing", "")},
            {"kind": "culprit", "title": "범인의 연결 고리", "copy": f"{culprit.nick}님의 밤 행동과 습격 기록이 같은 시간대에 겹쳤습니다." if culprit else "범인의 행동 연결 고리를 복기하세요."},
        ]
        if confirmed_theories or partial_theories:
            self.final_highlights.append({
                "kind": "theory",
                "title": "봉인된 가설 검증",
                "copy": f"완전 적중 {confirmed_theories}개 · 부분 적중 {partial_theories}개. 공개 보드에서 각 연결을 복기하세요.",
            })

    def _add_forensic_clue(
        self,
        attacker_id: str | None,
        victim_id: str,
        outcome: str,
    ) -> None:
        """Reveal a truthful but non-conclusive suspect cluster after an attack."""
        attacker = self.players.get(attacker_id or "")
        victim = self.players.get(victim_id)
        if not attacker or not victim:
            return
        decoys = [
            player for player in self.players.values()
            if player.id not in {attacker.id, victim.id}
            and player.role != "spectator"
        ]
        suspects = [attacker, *random.sample(decoys, min(2, len(decoys)))]
        random.shuffle(suspects)
        title, template = random.choice(FORENSIC_CLUES)
        names = " · ".join(player.nick for player in suspects)
        detail = template.format(suspects=names)
        self.clues.append({
            "id": secrets.token_hex(4),
            "code": f"E-{self.round:02d}-{len(self.clues) + 1:02d}",
            "round": self.round,
            "title": title,
            "detail": detail,
            "outcome": outcome,
            "suspect_ids": [player.id for player in suspects],
            "suspects": [player.nick for player in suspects],
        })

    def touch(self) -> None:
        self.last_activity = time.time()

    @property
    def connected_players(self) -> list[Player]:
        """Humans with a live socket (used for presence and room expiry)."""
        return [p for p in self.players.values() if p.connected and not p.is_bot]

    @property
    def lobby_seats(self) -> list[Player]:
        """Playable lobby seats: connected humans plus server-owned bots."""
        return [p for p in self.players.values() if p.connected or p.is_bot]

    def join(
        self,
        ws: WebSocket,
        nick: str,
        coders_id: UUID | None,
        player_key: str,
    ) -> tuple[Player, bool]:
        self.touch()
        existing = next((p for p in self.players.values() if p.key == player_key), None)
        if existing:
            existing.ws = ws
            existing.connected = True
            existing.nick = nick
            if coders_id is not None:
                existing.coders_id = coders_id
            # A resumed seat has a new socket and must receive a fresh snapshot
            # even if the game state did not change while it reconnected.
            self._last_broadcast_payloads.pop(existing.id, None)
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
            self._record(f"{player.nick}님이 테이블에 앉았습니다.")
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
        self.touch()
        player = self.players.get(pid)
        if not player:
            return
        player.voice = False
        if self.phase == "lobby":
            self.players.pop(pid, None)
            self._last_broadcast_payloads.pop(pid, None)
            self._record(f"{player.nick}님이 자리를 떠났습니다.")
            if self.host_id == pid:
                self.host_id = next((p.id for p in self.players.values() if not p.is_bot), None)
        else:
            player.connected = False
            player.ws = None
            if self.host_id == pid:
                self.host_id = next(
                    (p.id for p in self.players.values() if p.connected and not p.is_bot),
                    None,
                )

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

    def set_voice_presence(self, pid: str, enabled: bool) -> str | None:
        player = self.players.get(pid)
        if not player or player.is_bot:
            return "음성 채팅에 참여할 수 없는 좌석입니다."
        player.voice = enabled and player.connected
        return None

    async def relay_voice(self, pid: str, target_id: str, data: object) -> str | None:
        sender = self.players.get(pid)
        target = self.players.get(target_id)
        if not sender or not sender.voice:
            return "먼저 음성 채팅에 참여해 주세요."
        if not target or target.is_bot or not target.connected or not target.voice or not target.ws:
            return "상대방이 음성 채팅에 연결되어 있지 않습니다."
        if not isinstance(data, dict):
            return "잘못된 음성 연결 정보입니다."
        encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        if len(encoded) > 8192:
            return "음성 연결 정보가 너무 큽니다."
        await target.ws.send_text(json.dumps(
            {"t": "voice_signal", "from": pid, "data": data},
            ensure_ascii=False,
            separators=(",", ":"),
        ))
        return None

    def fill_bots(self, pid: str, target: int = 6) -> str | None:
        if self.phase != "lobby" or pid != self.host_id:
            return "방장만 AI 플레이어를 초대할 수 있습니다."
        target = max(MIN_PLAYERS, min(target, 8, MAX_PLAYERS))
        removable = [p for p in self.players.values() if p.is_bot]
        while len(self.players) > target and removable:
            bot = removable.pop()
            self.players.pop(bot.id, None)
            self._record(f"AI 플레이어 {bot.nick}님이 테이블을 떠났습니다.")
        available = [name for name in BOT_NAMES if name not in {p.nick for p in self.players.values()}]
        while len(self.players) < target and available:
            name = available.pop(random.randrange(len(available)))
            bot = Player(
                id=secrets.token_urlsafe(6), key=f"bot-{secrets.token_urlsafe(10)}",
                nick=name, coders_id=None, ws=None, connected=False, ready=True, is_bot=True,
                bot_profile=BOT_PERSONAS.get(name, DEFAULT_BOT_PERSONA)["id"],
            )
            self.players[bot.id] = bot
            persona = BOT_PERSONAS.get(name, DEFAULT_BOT_PERSONA)
            self._record(f"AI 플레이어 {bot.nick}님이 참가했습니다. · {persona['label']}")
        return None

    def solo_start(self, pid: str) -> str | None:
        """Start a complete story match for a lone player in one command."""
        if self.phase != "lobby" or pid != self.host_id:
            return "혼자 수사 모드는 대기실 방장만 시작할 수 있습니다."
        if len(self.connected_players) != 1:
            return "친구가 함께 있는 방에서는 일반 게임 시작을 사용해 주세요."
        error = self.fill_bots(pid, min(MAX_PLAYERS, 8))
        if error:
            return error
        self._record("혼자 수사 모드 — AI 용의자 7명이 사건 파일에 등록되었습니다.")
        self.case_mode = "classic"
        return self.start(pid)

    def first_start(self, pid: str) -> str | None:
        """Start the guided 4-seat first case for a lone investigator."""
        if self.phase != "lobby" or pid != self.host_id:
            return "첫 사건은 대기실 방장만 시작할 수 있습니다."
        if len(self.connected_players) != 1:
            return "첫 사건은 혼자 수사 방에서 시작해 주세요."
        error = self.fill_bots(pid, 4)
        if error:
            return error
        self.case_mode = "first"
        self._record("첫 사건 모드 — 진행관이 매 단계 설명하고, 4개의 역할만 사용합니다.")
        return self.start(pid)

    def remove_lobby_seat(self, pid: str, target_id: str) -> str | None:
        if self.phase != "lobby" or pid != self.host_id:
            return "방장만 대기실 참가자를 내보낼 수 있습니다."
        if target_id == pid:
            return "방장은 자신을 내보낼 수 없습니다."
        target = self.players.get(target_id)
        if not target:
            return "이미 자리를 떠난 참가자입니다."
        self.players.pop(target_id, None)
        target.connected = False
        if target.ws:
            try:
                asyncio.get_running_loop().create_task(
                    target.ws.close(code=4003, reason="removed_by_host")
                )
            except RuntimeError:
                pass
        self._record(f"{target.nick}님이 방장에 의해 대기실에서 제외되었습니다.")
        return None

    def start(self, pid: str) -> str | None:
        if self.phase != "lobby" or pid != self.host_id:
            return "방장만 게임을 시작할 수 있습니다."
        active = self.lobby_seats
        required_players = 4 if self.case_mode == "first" else MIN_PLAYERS
        if len(active) < required_players:
            return f"최소 {MIN_PLAYERS}명이 필요합니다."
        not_ready = [p.nick for p in active if p.id != self.host_id and not p.ready and not p.is_bot]
        if not_ready:
            return f"아직 준비하지 않은 참가자: {', '.join(not_ready[:3])}"

        # Disconnected lobby seats never enter the game.
        self.players = {p.id: p for p in active}
        self.mode = "solo" if sum(not p.is_bot for p in active) == 1 else "party"
        mafia_count = 1 if self.case_mode == "first" else (2 if len(active) >= 7 else 1)
        roles = ["mafia"] * mafia_count + ["doctor", "detective"]
        if self.case_mode == "first":
            roles += ["citizen"] * max(0, len(active) - len(roles))
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
            player.last_chat_at = 0.0
            player.last_reaction_at = 0.0
        self.round = 1
        self.case_profile = random.choice(CASE_PROFILES)
        layout = CASE_TIMELINE_LAYOUTS[0] if self.case_mode == "first" else random.choice(CASE_TIMELINE_LAYOUTS)
        fragment_by_id = {fragment["id"]: fragment for fragment in CASE_TIMELINE}
        timeline = []
        for index, fragment_id in enumerate(layout["order"]):
            fragment = fragment_by_id[fragment_id]
            card = dict(fragment)
            card["time"] = layout["clock"][index]
            card["detail"] = f"{self.case_profile['location']} — {fragment['detail']}"
            if layout["id"] != "canonical":
                card["detail"] += " 시계 기록과 실제 인과 순서를 함께 대조하세요."
            timeline.append(card)
        self.case_solution = {
            "timeline": timeline,
            "order": [card["id"] for card in timeline],
            "links": {
                left: right
                for left, right in zip(layout["order"], layout["order"][1:], strict=False)
            },
            "layout_id": layout["id"],
            "chain_label": layout["chain_label"],
        }
        self.winner = None
        self.actions.clear()
        self.votes.clear()
        self.accused_id = None
        self.judgements.clear()
        self.story.clear()
        self.case_log.clear()
        self.chat.clear()
        self.reactions.clear()
        self.questions.clear()
        self.claims.clear()
        self.tips.clear()
        self.tip_marks.clear()
        self.moments.clear()
        self.clues.clear()
        self.private_leads.clear()
        self.public_leads.clear()
        self.ghost_predictions.clear()
        self.memory_seals.clear()
        self.memory_prompts = {player.id: random.choice(MEMORY_PROMPTS) for player in active}
        self.scene_submissions.clear()
        self.scene_results.clear()
        self.theories.clear()
        self.theory_stakes = {player.id: 2 for player in active}
        self.oaths.clear()
        self.contracts.clear()
        self.ghost_echoes.clear()
        self.ghost_echo_marks.clear()
        self.director_beats.clear()
        self.pressure_marks.clear()
        self.awards.clear()
        self.case_grade = ""
        self.case_badges.clear()
        self.final_highlights.clear()
        self.best_persuader = None
        self.ai_memories = {player.id: [] for player in active if player.is_bot}
        self.ai_relationships = {player.id: {} for player in active if player.is_bot}
        self.round_event = None
        self.reads.clear()
        self.wills.clear()
        self.interrogation_order.clear()
        self.speaker_id = None
        self.speaker_deadline = 0.0
        self._speaker_index = -1
        self.last_death_id = None
        self._record(f"사건 {self.case_profile['code']} · {self.case_profile['title']}. 현장이 봉쇄되었습니다.")
        self._record(self.case_profile["briefing"])
        if self.mode == "solo":
            self._record("혼자 수사 모드 — AI 용의자들이 각자의 기억과 관계를 들고 앉았습니다.")
        if self.case_mode == "first":
            self._record("진행관 안내 — 8~12분 첫 사건입니다. 각 단서의 행동 태그를 실제 역할과 대조하세요.")
        self._draw_round_event()
        self._prepare_scene()
        self._director_beat("사건 감독관", "각자 다른 기록 조각을 받았습니다. 기억을 봉인하고 현장 순서를 맞춰 보세요.", "blue")
        self._deal_private_leads(active)
        self._bot_marks.clear()
        self._bot_suspicions.clear()
        self._set_phase("reveal", self._seconds("reveal"))
        return None

    def rematch(self, pid: str) -> str | None:
        if self.phase != "gameover" or pid != self.host_id:
            return "방장만 다시 게임을 준비할 수 있습니다."
        self.players = {p.id: p for p in self.players.values() if p.connected or p.is_bot}
        for player in self.players.values():
            player.role = "citizen"
            player.alive = True
            player.ready = player.is_bot
            player.intel.clear()
            player.mission = ""
        self.round = 0
        self.winner = None
        self.mode = "party"
        self.actions.clear()
        self.votes.clear()
        self.accused_id = None
        self.judgements.clear()
        self.story.clear()
        self.case_log.clear()
        self.chat.clear()
        self.reactions.clear()
        self.questions.clear()
        self.claims.clear()
        self.tips.clear()
        self.tip_marks.clear()
        self.moments.clear()
        self.clues.clear()
        self.private_leads.clear()
        self.public_leads.clear()
        self.ghost_predictions.clear()
        self.memory_seals.clear()
        self.memory_prompts.clear()
        self.scene_fragments.clear()
        self.scene_submissions.clear()
        self.scene_results.clear()
        self.theories.clear()
        self.theory_stakes.clear()
        self.oaths.clear()
        self.contracts.clear()
        self.ghost_echoes.clear()
        self.ghost_echo_marks.clear()
        self.director_beats.clear()
        self.pressure_marks.clear()
        self.awards.clear()
        self.round_event = None
        self.reads.clear()
        self.wills.clear()
        self.interrogation_order.clear()
        self.speaker_id = None
        self.speaker_deadline = 0.0
        self._speaker_index = -1
        self.last_death_id = None
        self._bot_marks.clear()
        self._bot_suspicions.clear()
        self._record("새 게임을 준비합니다. 모두 준비 버튼을 눌러주세요.")
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
        if actor.role == "detective" and target.id == actor.id:
            return "자신을 조사할 수 없습니다."
        if actor.role == "bodyguard" and target.id == actor.id:
            return "자신을 경호할 수 없습니다."
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

    def judge(self, pid: str, execute: bool) -> str | None:
        voter = self.players.get(pid)
        if self.phase != "verdict" or not voter or not voter.alive:
            return "지금은 최종 판결을 내릴 수 없습니다."
        if pid == self.accused_id:
            return "피고인은 자신의 판결에 참여할 수 없습니다."
        self.judgements[pid] = bool(execute)
        return None

    def add_reaction(self, pid: str, emoji: str) -> str | None:
        player = self.players.get(pid)
        now = time.time()
        if not player or emoji not in ALLOWED_REACTIONS:
            return "지원하지 않는 반응입니다."
        if self.phase not in {"day", "vote", "defense", "verdict", "gameover"}:
            return "지금은 반응을 보낼 수 없습니다."
        if now - player.last_reaction_at < 1.2:
            return None
        player.last_reaction_at = now
        self.reactions.append(
            {"id": secrets.token_hex(4), "from": player.nick, "emoji": emoji,
             "at": int(now * 1000)}
        )
        return None

    def submit_read(self, pid: str, target_id: str, stance: str) -> str | None:
        reader = self.players.get(pid)
        target = self.players.get(target_id)
        if self.phase != "day" or not reader or not reader.alive:
            return "지금은 인물 판단을 기록할 수 없습니다."
        if target_id != self.speaker_id or not target or not target.alive or target_id == pid:
            return "현재 심문 중인 다른 참가자만 판단할 수 있습니다."
        if stance not in ALLOWED_READS:
            return "지원하지 않는 판단입니다."
        self.reads.setdefault(pid, {})[f"{self.round}:{target_id}"] = stance
        return None

    def apply_pressure(self, pid: str, target_id: str) -> str | None:
        actor = self.players.get(pid)
        target = self.players.get(target_id)
        if self.phase != "day" or not actor or not actor.alive:
            return "낮 토론 중인 생존자만 긴급 지목을 사용할 수 있습니다."
        if not target or not target.alive or target.id == actor.id:
            return "다른 생존자 한 명을 지목해 주세요."
        key = f"{self.round}:{pid}"
        if key in self.pressure_marks:
            return "이번 낮의 긴급 지목은 이미 사용했습니다."
        self.pressure_marks[key] = target_id
        sealed = bool(self.round_event and self.round_event.get("sealed_pressure"))
        if sealed:
            line = f"{actor.nick}님이 긴급 지목을 봉인했습니다."
        else:
            line = f"긴급 지목 — {actor.nick}님이 {target.nick}님을 압박했습니다."
        self._record(line)
        self._moment("pressure", line, actor=pid, target=target_id)
        return None

    def add_question(self, pid: str, raw: str) -> str | None:
        asker = self.players.get(pid)
        speaker = self.players.get(self.speaker_id or "")
        text = " ".join(raw.strip().split())[:100]
        now = time.time()
        if self.phase != "day" or not asker or not asker.alive or not speaker:
            return "지금은 심문 질문을 보낼 수 없습니다."
        if asker.id == speaker.id:
            return "발언자는 자신의 진술에 집중해 주세요."
        if not text:
            return None
        if now - asker.last_chat_at < 1.2:
            return "질문을 너무 빠르게 보내고 있습니다."
        asker.last_chat_at = now
        self.questions.append({
            "id": secrets.token_hex(4), "from": asker.nick, "from_id": asker.id,
            "speaker_id": speaker.id, "text": text, "round": self.round,
            "at": int(now * 1000),
        })
        self.case_log.append(f"심문 질문 — {asker.nick} → {speaker.nick}: {text}")
        return None

    def add_claim(self, pid: str, raw: str) -> str | None:
        speaker = self.players.get(pid)
        text = " ".join(raw.strip().split())[:120]
        if self.phase != "day" or not speaker or not speaker.alive or pid != self.speaker_id:
            return "현재 발언자만 공식 진술을 남길 수 있습니다."
        if not text:
            return None
        if any(item["round"] == self.round and item["speaker_id"] == pid for item in self.claims):
            return "이번 심문에서는 공식 진술을 한 번만 봉인할 수 있습니다."
        line = f"공식 진술 — {speaker.nick}: {text}"
        self.claims.append({
            "id": secrets.token_hex(4), "speaker_id": pid, "speaker": speaker.nick,
            "text": text, "round": self.round, "at": int(time.time() * 1000),
        })
        self.case_log.append(line)
        self._moment("claim", line, actor=pid)
        return None

    def add_tip(self, pid: str, raw: str) -> str | None:
        """Seal one anonymous lead per living player during each daytime round."""
        author = self.players.get(pid)
        text = " ".join(raw.strip().split())[:120]
        if self.phase != "day" or not author or not author.alive:
            return "낮 토론 중인 생존자만 익명 제보를 남길 수 있습니다."
        if not text:
            return "제보 내용을 한 문장으로 작성해 주세요."
        key = f"{self.round}:{pid}"
        if key in self.tip_marks:
            return "이번 낮의 익명 제보는 이미 봉인했습니다."
        self.tip_marks.add(key)
        self.tips.append({
            "id": secrets.token_hex(4),
            "text": text,
            "round": self.round,
            "at": int(time.time() * 1000),
        })
        # Never write the author into the public case log. The point of this
        # channel is to create a useful lead whose credibility must be debated.
        self._record("익명 제보가 사건 파일에 봉인되었습니다.")
        self._moment("tip", "익명 제보가 사건 파일에 봉인되었습니다.")
        return None

    def leave_will(self, pid: str, raw: str) -> str | None:
        player = self.players.get(pid)
        text = " ".join(raw.strip().split())[:120]
        if self.phase != "dawn" or not player or player.alive or pid != self.last_death_id:
            return "지금은 유언을 남길 수 없습니다."
        if pid in self.wills:
            return "유언은 한 번만 남길 수 있습니다."
        if not text:
            return None
        self.wills[pid] = text
        line = f"마지막 유언 — {player.nick}: {text}"
        self._record(line)
        self._moment("will", line, actor=pid)
        return None

    def add_chat(self, pid: str, raw: str) -> str | None:
        player = self.players.get(pid)
        text = " ".join(raw.strip().split())[:160]
        if not player or not text:
            return None
        now = time.time()
        if now - player.last_chat_at < 0.45:
            return "메시지를 너무 빠르게 보내고 있습니다."
        if self.phase == "night":
            if not player.alive or player.role != "mafia":
                return "밤에는 마피아만 대화할 수 있습니다."
            visibility = "mafia"
        elif self.phase == "defense":
            if player.id != self.accused_id or not player.alive:
                return "최후 변론 중에는 피고인만 말할 수 있습니다."
            visibility = "all"
        elif self.phase == "day":
            if not player.alive:
                return "사망자는 토론에 참여할 수 없습니다."
            visibility = "all"
        elif self.phase in {"lobby", "vote", "gameover"}:
            visibility = "all"
        else:
            return "지금은 대화할 수 없습니다."
        player.last_chat_at = now
        self.chat.append(
            {"id": secrets.token_hex(4), "from": player.nick, "from_id": player.id, "text": text,
             "visibility": visibility, "at": int(now * 1000)}
        )
        return None

    def _deal_private_leads(self, active: list[Player]) -> None:
        """Give every player a plausible first-day talking point.

        A lead always names a playable suspect but never proves alignment. Mafia
        receives one fabricated lead that looks identical after publication.
        """
        suspects = [player for player in active if player.role != "spectator"]
        mafia = [player for player in suspects if player.role == "mafia"]
        non_mafia = [player for player in suspects if player.role != "mafia"]
        truth_holder = random.choice(non_mafia) if non_mafia and mafia else None
        for owner in suspects:
            pool = [player for player in suspects if player.id != owner.id]
            if not pool:
                continue
            # Exactly one genuine packet crosses a mafia route. The remaining
            # observations are plausible false positives, so mass disclosure
            # cannot identify the mafia by simple frequency counting.
            if truth_holder and owner.id == truth_holder.id:
                suspect = random.choice(mafia)
            else:
                decoys = [player for player in pool if player.role != "mafia"]
                suspect = random.choice(decoys or pool)
            title, template = random.choice(LEAD_TEMPLATES)
            self.private_leads[owner.id] = {
                "id": secrets.token_hex(5),
                "title": title,
                "detail": template.format(suspect=suspect.nick),
                "suspect_id": suspect.id,
                "revealed": False,
                "authentic": owner.role != "mafia",
            }

    def reveal_private_lead(self, pid: str, lead_id: str) -> str | None:
        player = self.players.get(pid)
        lead = self.private_leads.get(pid)
        if self.phase != "day" or not player or not player.alive:
            return "낮 토론 중인 생존자만 증거를 공개할 수 있습니다."
        if not lead or lead["id"] != lead_id:
            return "공개할 수 없는 증거입니다."
        if lead["revealed"]:
            return "이미 공개한 증거입니다."
        lead["revealed"] = True
        public = {
            "id": lead["id"], "owner_id": player.id, "owner": player.nick,
            "title": lead["title"], "detail": lead["detail"],
            "round": self.round, "suspect_id": lead["suspect_id"],
        }
        self.public_leads.append(public)
        line = f"봉인 증거 공개 — {player.nick}: {lead['title']}"
        self._record(line)
        self._moment("evidence", line, actor=pid, target=lead["suspect_id"])
        return None

    def ghost_predict(self, pid: str, target_id: str) -> str | None:
        player = self.players.get(pid)
        target = self.players.get(target_id)
        if not player or player.alive or player.role == "spectator":
            return "사망한 플레이어만 사후 수사를 진행할 수 있습니다."
        if player.role == "mafia":
            return "마피아는 동료의 정체를 알고 있어 사후 범인 예측에 참여할 수 없습니다."
        if self.phase in {"lobby", "reveal", "gameover"}:
            return "지금은 사후 예측을 봉인할 수 없습니다."
        if not target or not target.alive or target.role == "spectator":
            return "생존한 용의자를 선택해 주세요."
        self.ghost_predictions[pid] = target_id
        return None

    def seal_memory(self, pid: str, raw: str) -> str | None:
        """Let each player lock a private first impression before discussion."""
        player = self.players.get(pid)
        text = " ".join(raw.strip().split())[:160]
        if self.phase != "reveal" or not player or not player.alive or player.role == "spectator":
            return "역할 공개 중인 생존자만 기억을 봉인할 수 있습니다."
        if pid in self.memory_seals:
            return "기억은 한 번만 봉인할 수 있습니다."
        if len(text) < 5:
            return "다섯 글자 이상으로 첫 인상을 남겨 주세요."
        self.memory_seals[pid] = {
            "id": secrets.token_hex(5), "owner_id": pid, "owner": player.nick,
            "text": text, "round": self.round, "sealed_at": int(time.time() * 1000),
        }
        self._record(f"{player.nick}님의 첫 기억이 봉인되었습니다.")
        self._moment("memory", "한 명의 기억이 봉인되었습니다.", actor=pid)
        return None

    def reconstruct_scene(self, pid: str, raw_order: object) -> str | None:
        """Score a player's personal reconstruction of the shared crime timeline."""
        player = self.players.get(pid)
        if self.phase not in {"dawn", "day", "vote"} or not player or not player.alive:
            return "아침부터 투표 전까지 살아 있는 수사관만 현장을 재구성할 수 있습니다."
        if not isinstance(raw_order, list):
            return "현장 조각의 순서를 확인해 주세요."
        cards = self.scene_fragments.get(pid, [])
        allowed = {str(card.get("id")) for card in cards}
        order = [str(item) for item in raw_order]
        if len(order) < 2 or len(order) != len(set(order)) or any(item not in allowed for item in order):
            return "받은 기록 조각을 두 개 이상, 중복 없이 선택해 주세요."
        if self.scene_submissions.get(pid, {}).get("round") == self.round:
            return "이번 라운드의 현장 재구성은 이미 제출했습니다."
        solution_order = self.case_solution.get("order") or SCENE_ORDER
        positions = {fragment_id: index for index, fragment_id in enumerate(solution_order)}
        correct_pairs = sum(
            positions.get(left, -1) < positions.get(right, -1)
            for left, right in zip(order, order[1:], strict=False)
        )
        total = max(1, len(order) - 1)
        # A valid adjacent link is a causal connection, not just an earlier
        # timestamp. This makes the mini-game explain *why* the order works.
        links = self.case_solution.get("links") or {}
        causal_pairs = sum(1 for left, right in zip(order, order[1:], strict=False) if links.get(left) == right)
        score = round((correct_pairs * 0.55 + causal_pairs * 0.45) / total * 100)
        self.scene_submissions[pid] = {"round": self.round, "order": order, "at": int(time.time() * 1000)}
        self.scene_results[pid] = {
            "round": self.round, "score": score, "total": total,
            "correct_pairs": correct_pairs, "causal_pairs": causal_pairs,
            "deduction": f"인과 복원 — {self.case_solution.get('chain_label', '접근 기록 → 기록 공백 → 습격의 흔적 → 알리바이 신호 → 봉인된 현장')}" if causal_pairs else "시계 기록만 믿지 말고 첫 단서와 마지막 봉인의 연결을 다시 확인하세요.",
            "submitted_at": int(time.time() * 1000),
        }
        self._record(f"{player.nick}님이 현장 타임라인을 제출했습니다. ({score}점)")
        self._moment("reconstruction", "현장 타임라인이 제출되었습니다.", actor=pid)
        return None

    def _theory_key(self, pid: str, round_number: int | None = None) -> str:
        return f"{self.round if round_number is None else round_number}:{pid}"

    def _theory_view(self, theory: dict[str, Any], reveal: bool = False) -> dict[str, Any]:
        """Return the public portion of a sealed hypothesis.

        A theory is meant to be a social commitment, not an answer key.  Its
        selected names and evidence are public immediately, while the hidden
        link match and explanation are only attached after the case closes.
        """
        public = {
            "id": theory["id"],
            "round": theory["round"],
            "owner_id": theory["owner_id"],
            "owner": theory["owner"],
            "target_id": theory["target_id"],
            "target": theory["target"],
            "clue_id": theory["clue_id"],
            "clue_code": theory["clue_code"],
            "clue_title": theory["clue_title"],
            "fragment_id": theory["fragment_id"],
            "fragment_time": theory["fragment_time"],
            "fragment_title": theory["fragment_title"],
            "stake": theory["stake"],
            "sealed_at": theory["sealed_at"],
        }
        if reveal:
            public.update({
                "status": theory.get("status", "broken"),
                "matched_links": int(theory.get("matched_links", 0)),
                "total_links": int(theory.get("total_links", 3)),
                "explanation": theory.get("explanation", "검증 결과를 확인할 수 없습니다."),
            })
        return public

    def _resolve_theory(self, theory: dict[str, Any]) -> dict[str, Any]:
        """Resolve the three links in a hypothesis after the hidden roles are known."""
        target = self.players.get(str(theory.get("target_id", "")))
        clue = next((item for item in self.clues if item.get("id") == theory.get("clue_id")), None)
        target_match = bool(target and target.role == "mafia")
        fragment_match = str(theory.get("fragment_id")) == "attack"
        clue_match = bool(clue and theory.get("target_id") in clue.get("suspect_ids", []))
        matched_links = int(target_match) + int(fragment_match) + int(clue_match)
        if target_match and fragment_match and clue_match:
            status = "confirmed"
            explanation = f"{theory['target']}님은 실제 마피아였고, {theory['fragment_title']}가 습격 시각과 일치했습니다."
        elif target_match and clue_match:
            status = "partial"
            explanation = f"{theory['target']}님은 마피아였지만, 선택한 시간 조각은 실제 습격 장면이 아니었습니다."
        elif fragment_match and clue_match:
            status = "partial"
            explanation = f"습격 장면은 정확했지만 {theory['target']}님은 마피아가 아니었습니다. 단서가 만든 함정입니다."
        elif target_match:
            status = "partial"
            explanation = f"{theory['target']}님은 마피아였지만, 단서와 시간 연결을 완성하지 못했습니다."
        elif fragment_match:
            status = "partial"
            explanation = "습격 시각은 맞혔지만 지목한 용의자의 정체는 빗나갔습니다."
        else:
            status = "broken"
            explanation = "용의자·단서·시간 조각이 실제 사건의 인과 고리와 이어지지 않았습니다."
        theory.update({
            "status": status,
            "matched_links": matched_links,
            "total_links": 3,
            "explanation": explanation,
        })
        return theory

    def _resolve_theories(self) -> None:
        for theory in self.theories.values():
            self._resolve_theory(theory)

    def submit_theory(
        self,
        pid: str,
        target_id: str,
        clue_id: str,
        fragment_id: str,
        raw_stake: object,
    ) -> str | None:
        """Seal one causal hypothesis during the daytime discussion.

        The server verifies that the clue belongs to the case file and that
        the private fragment is owned by the player. It never reveals whether
        any of the three links is correct until ``gameover``.
        """
        player = self.players.get(pid)
        target = self.players.get(target_id)
        if self.phase != "day" or not player or not player.alive or player.role == "spectator":
            return "낮 토론 중인 생존자만 증거 연결 고리를 봉인할 수 있습니다."
        key = self._theory_key(pid)
        if key in self.theories:
            return "이번 낮의 증거 연결 고리는 이미 봉인했습니다."
        if isinstance(raw_stake, bool):
            return "증거 인장은 1개 또는 2개만 걸 수 있습니다."
        try:
            stake = int(raw_stake)
        except (TypeError, ValueError):
            return "증거 인장은 1개 또는 2개만 걸 수 있습니다."
        remaining = self.theory_stakes.get(pid, 0)
        if stake not in {1, 2} or stake > remaining:
            return f"남은 증거 인장은 {remaining}개입니다. 1개 또는 2개를 선택해 주세요."
        if not target or not target.alive or target.id == pid or target.role == "spectator":
            return "살아 있는 다른 용의자를 선택해 주세요."
        clue = next((item for item in self.clues if item.get("id") == clue_id), None)
        if not clue:
            return "현재 사건 파일에서 확인할 수 있는 감식 단서를 선택해 주세요."
        fragment = next(
            (item for item in self.scene_fragments.get(pid, []) if item.get("id") == fragment_id),
            None,
        )
        if not fragment:
            return "당신이 받은 시간 조각만 증거 연결에 사용할 수 있습니다."
        now_ms = int(time.time() * 1000)
        theory = {
            "id": secrets.token_hex(6),
            "round": self.round,
            "owner_id": pid,
            "owner": player.nick,
            "target_id": target.id,
            "target": target.nick,
            "clue_id": clue["id"],
            "clue_code": clue["code"],
            "clue_title": clue["title"],
            "fragment_id": fragment["id"],
            "fragment_time": fragment["time"],
            "fragment_title": fragment["title"],
            "stake": stake,
            "sealed_at": now_ms,
        }
        self.theories[key] = theory
        self.theory_stakes[pid] = remaining - stake
        line = f"{player.nick}님이 증거 연결 고리를 봉인했습니다. (인장 {stake}개)"
        self._record(line)
        self._moment("theory", "한 명의 추리 가설이 공개 보드에 봉인되었습니다.", actor=pid, target=target.id)
        if player.is_bot:
            self._remember_ai(player, "증거 연결 고리를 봉인함", target, "doubt")
        return None

    def make_oath(self, pid: str, target_id: str, raw: str) -> str | None:
        player = self.players.get(pid)
        target = self.players.get(target_id)
        text = " ".join(raw.strip().split())[:100] or "다음 투표에서 이 사람을 지목하겠습니다."
        if self.phase != "day" or not player or not player.alive:
            return "낮 토론 중인 생존자만 맹세를 남길 수 있습니다."
        if not target or not target.alive or target.id == player.id or target.role == "spectator":
            return "살아 있는 다른 용의자를 선택해 주세요."
        if self.oaths.get(pid, {}).get("round") == self.round:
            return "이번 라운드의 맹세는 이미 봉인되었습니다."
        self.oaths[pid] = {
            "id": secrets.token_hex(5), "owner_id": pid, "owner": player.nick,
            "target_id": target.id, "target": target.nick, "text": text,
            "round": self.round, "kept": None,
        }
        self._record(f"{player.nick}님이 공개 맹세를 봉인했습니다.")
        self._moment("oath", "한 명의 공개 맹세가 봉인되었습니다.", actor=pid, target=target.id)
        return None

    def make_contract(self, pid: str, target_id: str, raw: str) -> str | None:
        """Create a private one-line alliance that is revealed only to its pair."""
        player = self.players.get(pid)
        target = self.players.get(target_id)
        text = " ".join(raw.strip().split())[:100]
        if self.phase != "day" or not player or not player.alive:
            return "낮 토론 중인 생존자만 비밀 계약을 제안할 수 있습니다."
        if not target or not target.alive or target.id == pid or target.role == "spectator":
            return "살아 있는 다른 용의자를 선택해 주세요."
        if len(text) < 5:
            return "계약 내용을 다섯 글자 이상 입력해 주세요."
        self.contracts[pid] = {"id": secrets.token_hex(5), "owner_id": pid, "owner": player.nick, "target_id": target.id, "target": target.nick, "text": text, "round": self.round, "accepted": None}
        self._record(f"{player.nick}님이 비밀 계약을 제안했습니다.")
        self._moment("contract", "비밀 계약이 봉인되었습니다.", actor=pid, target=target.id)
        if target.is_bot:
            self.contracts[pid]["accepted"] = random.random() > 0.35
            self._remember_ai(target, "비밀 계약 제안 수신", player, "trust" if self.contracts[pid]["accepted"] else "doubt")
        return None

    def respond_contract(self, pid: str, contract_id: str, accepted: bool) -> str | None:
        contract = next((item for item in self.contracts.values() if item.get("id") == contract_id), None)
        if not contract or contract.get("target_id") != pid:
            return "응답할 비밀 계약이 없습니다."
        if contract.get("round") != self.round or self.phase != "day":
            return "현재 라운드에서만 계약에 응답할 수 있습니다."
        contract["accepted"] = accepted
        target = self.players.get(pid)
        owner = self.players.get(str(contract.get("owner_id")))
        if target and owner and owner.is_bot:
            self._remember_ai(owner, "비밀 계약을 수락받음" if accepted else "비밀 계약을 거절당함", target, "trust" if accepted else "doubt")
        self._record(f"비밀 계약 응답이 봉인되었습니다. ({'수락' if accepted else '거절'})")
        return None

    def ghost_echo(self, pid: str, raw: str) -> str | None:
        player = self.players.get(pid)
        text = " ".join(raw.strip().split())[:120]
        if not player or player.alive or player.role in {"spectator", "mafia"}:
            return "시민 팀의 사망자만 유령 메시지를 남길 수 있습니다."
        if self.phase in {"lobby", "reveal", "night", "gameover"}:
            return "아침이 밝은 뒤에만 유령 메시지를 남길 수 있습니다."
        mark = f"{self.round}:{pid}"
        if mark in self.ghost_echo_marks:
            return "이번 라운드에는 유령 메시지를 한 번만 남길 수 있습니다."
        if len(text) < 5:
            return "다섯 글자 이상으로 흔적을 남겨 주세요."
        if any(candidate.nick and len(candidate.nick) >= 2 and candidate.nick in text for candidate in self.players.values()):
            return "유령 메시지에는 특정 생존자의 이름을 직접 적을 수 없습니다."
        echo = {
            "id": secrets.token_hex(5), "owner_id": pid, "owner": player.nick,
            "text": text, "round": self.round, "at": int(time.time() * 1000),
        }
        self.ghost_echoes.append(echo)
        self.ghost_echo_marks.add(mark)
        self._record("사망자의 유령 메시지가 사건 파일에 남았습니다.")
        self._moment("ghost_echo", "새로운 유령 메시지가 기록되었습니다.", actor=pid)
        return None

    def report_player(self, pid: str, target_id: str, raw_reason: str) -> str | None:
        reporter = self.players.get(pid)
        target = self.players.get(target_id)
        reason = " ".join(raw_reason.strip().split())[:160]
        if not reporter or not target or reporter.id == target.id:
            return "신고할 수 없는 대상입니다."
        if not reason:
            return "신고 사유를 선택하거나 입력해 주세요."
        self.reports.append({
            "id": secrets.token_hex(8), "room": self.name,
            "reporter_id": reporter.id, "target_id": target.id,
            "target_name": target.nick, "reason": reason,
            "created_at": int(time.time() * 1000),
        })
        return None

    async def _ticker(self) -> None:
        while self.players:
            if not self.connected_players and time.time() - self.last_activity > 300:
                self.players.clear()
                break
            self._run_interrogation()
            self._run_bots()
            elapsed = time.time() - self.phase_started_at
            minimum = EARLY_ADVANCE_MINIMUM[self.pace].get(self.phase, 0)
            early_ready = (
                self.phase in {"vote", "verdict", "night"}
                and elapsed >= minimum
                and self._decisions_complete()
            )
            if early_ready or (
                self.phase != "lobby" and self.deadline and time.time() >= self.deadline
            ):
                self._advance()
            await self.broadcast()
            await asyncio.sleep(1)
        # The manager owns room references, so clearing players alone would
        # otherwise leave an empty room object behind forever.
        rooms.sweep(self.name)

    def _advance(self) -> None:
        if self.phase == "reveal":
            self.actions.clear()
            self._record(f"{self.round}일차 밤. 도시는 숨을 죽였습니다.")
            self._set_phase("night", self._seconds("night"))
        elif self.phase == "night":
            self._resolve_night()
        elif self.phase == "dawn":
            self._record("낮이 되었습니다. 말의 모순을 찾아내세요.")
            alive_count = sum(
                player.alive and player.role != "spectator"
                for player in self.players.values()
            )
            self._set_phase("day", max(self._seconds("day"), alive_count * 12))
            self._start_interrogation()
            victim = self.players.get(self.last_death_id or "")
            if victim:
                self._director_beat(
                    "현장 감독관",
                    f"{victim.nick}님의 마지막 동선을 복원하세요. 각자 가진 기록 조각이 다릅니다.",
                    "red",
                )
            else:
                self._director_beat(
                    "현장 감독관",
                    "희생자는 없지만 기록이 어긋났습니다. 먼저 말하는 사람이 모든 것을 알고 있지는 않습니다.",
                    "blue",
                )
        elif self.phase == "day":
            self.speaker_id = None
            self.speaker_deadline = 0.0
            self.votes.clear()
            if self.round_event and self.round_event.get("sealed_pressure"):
                for key, target_id in self.pressure_marks.items():
                    round_text, actor_id = key.split(":", 1)
                    if int(round_text) != self.round:
                        continue
                    actor = self.players.get(actor_id)
                    target = self.players.get(target_id)
                    if actor and target:
                        self._record(
                            f"긴급 지목 봉인 해제 — {actor.nick}님이 "
                            f"{target.nick}님을 지목했습니다."
                        )
            self._record("투표가 시작되었습니다. 가장 의심스러운 사람을 지목하세요.")
            self._director_beat(
                "감독관의 경고",
                "봉인된 증거 연결 고리·맹세·현장 재구성 결과를 함께 비교한 뒤 표를 제출하세요.",
                "amber",
            )
            self._set_phase("vote", self._seconds("vote"))
        elif self.phase == "vote":
            self._resolve_vote()
        elif self.phase == "defense":
            self.judgements.clear()
            self._record("최후 변론이 끝났습니다. 처형 찬반 판결을 시작합니다.")
            self._director_beat(
                "최후 변론 기록관",
                "피고인의 마지막 문장과 아침에 봉인된 맹세를 대조해 판결하세요.",
                "purple",
            )
            self._set_phase("verdict", self._seconds("verdict"))
        elif self.phase == "verdict":
            self._resolve_verdict()
        elif self.phase == "result":
            if self._check_win():
                return
            self.round += 1
            self.actions.clear()
            self._bot_suspicions.clear()
            self.accused_id = None
            self.judgements.clear()
            self.scene_submissions.clear()
            self.scene_results.clear()
            self.oaths.clear()
            self._record(f"{self.round}일차 밤이 찾아왔습니다.")
            self._draw_round_event()
            self._prepare_scene()
            self._director_beat("새로운 기록 조각", "현장에 남은 순서가 다시 섞였습니다. 서로 가진 기록을 비교하세요.", "blue")
            self._set_phase("night", self._seconds("night"))

    def _seconds(self, phase: str) -> int:
        return PACE_SECONDS[self.pace][phase]

    def _decision_progress(self) -> tuple[int, int]:
        alive = [
            player for player in self.players.values()
            if player.alive and player.role != "spectator"
        ]
        if self.phase == "night":
            eligible = [
                player for player in alive
                if player.role in {"mafia", "doctor", "detective", "bodyguard"}
            ]
            return sum(player.id in self.actions for player in eligible), len(eligible)
        if self.phase == "vote":
            return sum(player.id in self.votes for player in alive), len(alive)
        if self.phase == "verdict":
            eligible = [player for player in alive if player.id != self.accused_id]
            return sum(player.id in self.judgements for player in eligible), len(eligible)
        return 0, 0

    def _decisions_complete(self) -> bool:
        completed, total = self._decision_progress()
        return total > 0 and completed >= total

    def _start_interrogation(self) -> None:
        alive = [
            player.id for player in self.players.values()
            if player.alive and player.role != "spectator"
        ]
        if alive:
            shift = (self.round - 1) % len(alive)
            alive = alive[shift:] + alive[:shift]
        self.interrogation_order = alive
        self._speaker_index = -1
        self._run_interrogation()

    def _run_interrogation(self) -> None:
        if self.phase != "day" or not self.interrogation_order:
            return
        duration = max(1.0, self.deadline - self.phase_started_at)
        slot = duration / len(self.interrogation_order)
        index = min(len(self.interrogation_order) - 1, int(
            (time.time() - self.phase_started_at) / slot
        ))
        if index == self._speaker_index:
            return
        self._speaker_index = index
        self.speaker_id = self.interrogation_order[index]
        self.speaker_deadline = min(self.deadline, self.phase_started_at + (index + 1) * slot)
        speaker = self.players.get(self.speaker_id)
        if not speaker:
            return
        self.case_log.append(f"{speaker.nick}님의 공개 심문이 시작되었습니다.")
        key = f"{self.round}:{speaker.id}"
        for bot in (p for p in self.players.values() if p.is_bot and p.alive and p.id != speaker.id):
            persona = self._bot_persona(bot)
            if bot.role == "mafia" and speaker.role == "mafia":
                stance = "trust"
            elif speaker.role == "mafia" and random.random() < min(0.92, 0.65 + persona["suspect_bias"]):
                stance = "suspect"
            elif speaker.id in self._bot_suspicions.values() and random.random() < 0.8:
                stance = "suspect"
            else:
                stance = random.choices(
                    ["trust", "hold", "suspect"],
                    weights=[max(1, 3 - int(persona["suspect_bias"] * 4)), 4, max(1, 2 + int(persona["suspect_bias"] * 4))],
                    k=1,
                )[0]
            self.reads.setdefault(bot.id, {})[key] = stance

    def _bot_persona(self, bot: Player) -> dict[str, Any]:
        for persona in BOT_PERSONAS.values():
            if persona["id"] == bot.bot_profile:
                return persona
        return DEFAULT_BOT_PERSONA

    def _remember_ai(self, bot: Player, event: str, target: Player | None = None, emotion: str = "neutral") -> None:
        """Persist a small, inspectable memory so solo bots can reference history."""
        if not bot.is_bot:
            return
        memories = self.ai_memories.setdefault(bot.id, [])
        memories.append({"round": self.round, "event": event, "target_id": target.id if target else None, "target": target.nick if target else None, "emotion": emotion})
        del memories[:-12]
        if target:
            relation = self.ai_relationships.setdefault(bot.id, {}).setdefault(target.id, {"trust": 0, "debt": 0, "emotion": "neutral", "betrayals": 0})
            relation["emotion"] = emotion
            relation["trust"] = max(-3, min(3, int(relation.get("trust", 0)) + (1 if emotion in {"trust", "relief"} else -1 if emotion in {"doubt", "anger"} else 0)))

    def _ai_memory_line(self, bot: Player, target: Player | None) -> str | None:
        if not target:
            return None
        memories = self.ai_memories.get(bot.id, [])
        previous = next((item for item in reversed(memories) if item.get("target_id") == target.id), None)
        if not previous:
            return None
        if previous.get("emotion") in {"doubt", "anger"}:
            return f"{target.nick}님, 지난 라운드에 한 말({previous.get('event')})과 지금 알리바이가 달라요."
        return f"지난 라운드에 {target.nick}님을 믿었지만, 이번 기록과 다시 대조하겠습니다."

    def _bot_target_score(self, bot: Player, target: Player) -> float:
        """Score public evidence so bot votes feel reasoned instead of random."""
        persona = self._bot_persona(bot)
        score = random.uniform(-0.35, 0.35) + float(persona["suspect_bias"])
        if self._bot_suspicions.get(bot.id) == target.id:
            score += 3.2
        relation = self.ai_relationships.get(bot.id, {}).get(target.id, {})
        score -= float(relation.get("trust", 0)) * 0.25
        score += float(relation.get("betrayals", 0)) * 0.45
        if any(target.id in clue.get("suspect_ids", []) for clue in list(self.clues)[-3:]):
            score += 0.65
        if any(lead.get("suspect_id") == target.id for lead in list(self.public_leads)[-4:]):
            score += 0.45
        if any(target.id == marked for marked in self.pressure_marks.values()):
            score += 0.35
        if target.id == self.speaker_id:
            score += 0.18
        if bot.role == "mafia" and target.role != "mafia":
            score += random.uniform(0.05, 0.4)
        return score

    def _bot_choose_target(self, bot: Player, candidates: list[Player]) -> Player | None:
        if not candidates:
            return None
        return max(candidates, key=lambda target: self._bot_target_score(bot, target))

    def _bot_line(self, bot: Player, target: Player | None) -> str:
        persona = self._bot_persona(bot)
        line = self._ai_memory_line(bot, target) or random.choice(persona["lines"])
        if target and random.random() < 0.72:
            return f"{line} {target.nick}님, 이 부분부터 설명해 주세요."
        return line

    def _run_day_bots(self, bots: list[Player], alive: list[Player], elapsed: float) -> None:
        if elapsed <= 3:
            return
        for bot in bots:
            pressure_key = f"{self.round}:{bot.id}"
            duration = max(1.0, self.deadline - self.phase_started_at)
            if pressure_key not in self.pressure_marks and elapsed > duration * 0.58:
                pressure_targets = [p for p in alive if p.id != bot.id]
                if bot.role == "mafia":
                    pressure_targets = [p for p in pressure_targets if p.role != "mafia"]
                preferred = self.players.get(self._bot_suspicions.get(bot.id, ""))
                target = preferred if preferred in pressure_targets else self._bot_choose_target(bot, pressure_targets)
                if target:
                    self.apply_pressure(bot.id, target.id)
            if bot.id != self.speaker_id:
                continue
            mark = f"day:{self.round}:{bot.id}"
            persona = self._bot_persona(bot)
            if mark not in self._bot_marks and random.random() < persona["talk_chance"]:
                self._bot_marks.add(mark)
                candidates = [p for p in alive if p.id != bot.id]
                if bot.role == "mafia":
                    candidates = [p for p in candidates if p.role != "mafia"]
                target = self.players.get(self._bot_suspicions.get(bot.id, ""))
                if not target or not target.alive:
                    target = self._bot_choose_target(bot, candidates)
                if target:
                    self._bot_suspicions[bot.id] = target.id
                    self._remember_ai(bot, "공개 심문에서 의심 지목", target, "doubt")
                line = self._bot_line(bot, target) if target else random.choice(BOT_LINES)
                self.chat.append({"id": secrets.token_hex(4), "from": bot.nick, "from_id": bot.id, "text": line,
                                  "visibility": "all", "at": int(time.time() * 1000)})
                if target and random.random() < 0.42:
                    self.add_tip(
                        bot.id,
                        f"{target.nick}님의 발언과 사건 기록의 시간대가 맞는지 다시 확인해 보세요.",
                    )
                if target and random.random() < 0.25:
                    self._remember_ai(bot, "공개 약속을 지켜보는 중", target, "trust")
                if not any(item["round"] == self.round and item["speaker_id"] == bot.id for item in self.claims):
                    claim = f"제 판단은 {target.nick}님을 우선 확인해야 한다는 것입니다." if target else line
                    self.claims.append({
                        "id": secrets.token_hex(4), "speaker_id": bot.id,
                        "speaker": bot.nick, "text": claim, "round": self.round,
                        "at": int(time.time() * 1000),
                    })
                    line = f"공식 진술 — {bot.nick}: {claim}"
                    self.case_log.append(line)
                    self._moment("claim", line, actor=bot.id)

    def _run_bots(self) -> None:
        bots = [p for p in self.players.values() if p.is_bot and p.alive]
        dead_bots = [
            p for p in self.players.values()
            if p.is_bot and not p.alive and p.role not in {"mafia", "spectator"}
        ]
        alive = [p for p in self.players.values() if p.alive and p.role != "spectator"]
        elapsed = time.time() - self.phase_started_at
        if self.phase == "reveal":
            for bot in bots:
                if bot.id not in self.memory_seals and elapsed > 4:
                    prompt = self.memory_prompts.get(bot.id, MEMORY_PROMPTS[0])
                    self.seal_memory(bot.id, f"{prompt} 기록을 먼저 확인하겠습니다.")
        elif self.phase in {"dawn", "day"}:
            # Bots play the same optional meta-games as humans so solo mode
            # still produces a readable trail of commitments and mistakes.
            for bot in bots:
                if bot.id not in self.scene_submissions and elapsed > 8:
                    cards = self.scene_fragments.get(bot.id, [])
                    order = [card["id"] for card in cards]
                    if random.random() < 0.45:
                        random.shuffle(order)
                    if len(order) >= 2:
                        self.reconstruct_scene(bot.id, order)
                if self.phase == "day" and bot.id not in self.oaths and elapsed > 16:
                    targets = [p for p in alive if p.id != bot.id]
                    if bot.role == "mafia":
                        targets = [p for p in targets if p.role != "mafia"]
                    target = self._bot_choose_target(bot, targets)
                    if target:
                        self.make_oath(bot.id, target.id, "다음 투표에서 이 사람의 알리바이를 확인하겠습니다.")
                if self.phase == "day" and self.theory_stakes.get(bot.id, 0) > 0 and elapsed > 22:
                    theory_key = self._theory_key(bot.id)
                    if theory_key not in self.theories and self.clues:
                        latest_clues = list(self.clues)[-3:]
                        candidates = [
                            p for p in alive
                            if p.id != bot.id
                            and (bot.role != "mafia" or p.role != "mafia")
                        ]
                        target = self.players.get(self._bot_suspicions.get(bot.id, ""))
                        if not target or target not in candidates:
                            clue_targets = {
                                suspect_id
                                for clue in latest_clues
                                for suspect_id in clue.get("suspect_ids", [])
                            }
                            narrowed = [p for p in candidates if p.id in clue_targets]
                            target = self._bot_choose_target(bot, narrowed or candidates)
                        if target:
                            clue = next(
                                (item for item in reversed(latest_clues) if target.id in item.get("suspect_ids", [])),
                                None,
                            )
                            fragments = self.scene_fragments.get(bot.id, [])
                            if clue and fragments:
                                fragment = random.choice(fragments)
                                remaining = self.theory_stakes.get(bot.id, 0)
                                stake = 2 if remaining >= 2 and random.random() < 0.2 else 1
                                self.submit_theory(
                                    bot.id,
                                    target.id,
                                    str(clue["id"]),
                                    str(fragment["id"]),
                                    stake,
                                )
            if elapsed > 5:
                for ghost in dead_bots:
                    mark = f"{self.round}:{ghost.id}"
                    if mark not in self.ghost_echo_marks:
                        self.ghost_echo(ghost.id, random.choice([
                            "시간 기록의 순서가 틀어졌습니다. 먼저 들린 것은 금속음이었습니다.",
                            "창가의 흔적보다 복도 불빛이 먼저 사라졌습니다. 기억해 두세요.",
                            "한 문장이 너무 완벽합니다. 완벽한 알리바이를 다시 확인하세요.",
                        ]))
            if self.phase == "day":
                self._run_day_bots(bots, alive, elapsed)
        elif self.phase == "night":
            for bot in bots:
                if bot.id in self.actions or bot.role not in {"mafia", "doctor", "detective", "bodyguard"}:
                    continue
                targets = [p for p in alive if p.id != bot.id]
                if bot.role == "mafia":
                    targets = [p for p in targets if p.role != "mafia"]
                if targets:
                    self.actions[bot.id] = random.choice(targets).id
        elif self.phase == "vote":
            for bot in bots:
                if bot.id not in self.votes:
                    targets = [p for p in alive if p.id != bot.id]
                    if bot.role == "mafia":
                        targets = [p for p in targets if p.role != "mafia"]
                    if targets:
                        preferred = self.players.get(self._bot_suspicions.get(bot.id, ""))
                        target = preferred if preferred in targets else self._bot_choose_target(bot, targets)
                        if target:
                            self.votes[bot.id] = target.id
        elif self.phase == "defense" and self.accused_id:
            accused = self.players.get(self.accused_id)
            if accused and accused.is_bot:
                mark = f"defense:{self.round}:{accused.id}"
                if mark not in self._bot_marks and self.deadline - time.time() < self._seconds("defense") - 3:
                    self._bot_marks.add(mark)
                    self.chat.append(
                        {"id": secrets.token_hex(4), "from": accused.nick, "from_id": accused.id,
                         "text": random.choice(BOT_DEFENSE_LINES), "visibility": "all",
                         "at": int(time.time() * 1000)}
                    )
        elif self.phase == "verdict":
            for bot in bots:
                if bot.id == self.accused_id or bot.id in self.judgements:
                    continue
                self.judgements[bot.id] = random.random() < 0.58

    def _resolve_night(self) -> None:
        self.last_death_id = None
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
                if actor.is_bot and target.role == "mafia":
                    self._bot_suspicions[actor.id] = target.id

        guarding = next(((guard, target) for guard, target in guard_targets if target == victim_id), None)
        clue_outcome = "습격 흔적"
        if victim_id and victim_id != saved_id and guarding and guarding[0] in self.players:
            guard = self.players[guarding[0]]
            guard.alive = False
            self.last_death_id = guard.id
            line = f"{guard.nick}님이 누군가를 지키다 대신 죽었습니다."
            self._record(line)
            self._moment("death", line, target=guard.id)
            clue_outcome = "경호 개입"
        elif victim_id and victim_id != saved_id and victim_id in self.players:
            victim = self.players[victim_id]
            victim.alive = False
            self.last_death_id = victim.id
            line = f"{victim.nick}님이 죽었습니다."
            self._record(line)
            self._moment("death", line, target=victim.id)
            clue_outcome = "사망 사건"
        elif victim_id and victim_id == saved_id:
            line = "누군가 습격받았지만 의사의 치료로 살아남았습니다."
            self._record(line)
            self._moment("rescue", line)
            clue_outcome = "치료 개입"
        else:
            line = "밤은 조용히 지나갔습니다. 아무도 희생되지 않았습니다."
            self._record(line)
            self._moment("dawn", line)

        if victim_id:
            attackers = [
                actor_id for actor_id, target_id in self.actions.items()
                if target_id == victim_id
                and self.players.get(actor_id)
                and self.players[actor_id].role == "mafia"
            ]
            self._add_forensic_clue(attackers[0] if attackers else None, victim_id, clue_outcome)

        if not self._check_win():
            self._set_phase("dawn", self._seconds("dawn"))

    def _resolve_vote(self) -> None:
        counts = Counter(self.votes.values())
        for oath in self.oaths.values():
            if oath.get("round") == self.round and oath.get("owner_id") in self.votes:
                oath["kept"] = self.votes.get(oath["owner_id"]) == oath.get("target_id")
                owner = self.players.get(str(oath.get("owner_id")))
                target = self.players.get(str(oath.get("target_id")))
                if owner and owner.is_bot and target:
                    self._remember_ai(owner, "공개 맹세를 지킴" if oath["kept"] else "공개 맹세를 어김", target, "relief" if oath["kept"] else "anger")
                    if not oath["kept"]:
                        relationship = self.ai_relationships.setdefault(owner.id, {}).setdefault(target.id, {"trust": 0, "debt": 0, "emotion": "anger", "betrayals": 0})
                        relationship["betrayals"] = int(relationship.get("betrayals", 0)) + 1
        accused: Player | None = None
        if counts:
            ordered = counts.most_common()
            if len(ordered) == 1 or ordered[0][1] > ordered[1][1]:
                accused = self.players.get(ordered[0][0])
        if not accused:
            line = "표가 갈렸습니다. 최종 피고 없이 오늘의 투표를 종료합니다."
            self._record(line)
            self._moment("vote", line)
            self._set_phase("result", self._seconds("result"))
            return
        self.accused_id = accused.id
        self.judgements.clear()
        line = f"{accused.nick}님이 최종 피고로 지목되었습니다. 최후 변론을 시작합니다."
        self._record(line)
        self._moment("accused", line, target=accused.id)
        self._set_phase("defense", self._seconds("defense"))

    def _resolve_verdict(self) -> None:
        accused = self.players.get(self.accused_id or "")
        execute_votes = sum(self.judgements.values())
        spare_votes = len(self.judgements) - execute_votes
        if not accused or not accused.alive:
            self._record("피고 상태를 확인할 수 없어 판결을 종료합니다.")
            self._set_phase("result", self._seconds("result"))
            return
        if execute_votes > spare_votes:
            accused.alive = False
            line = (
                f"최종 판결 {execute_votes} 대 {spare_votes}. {accused.nick}님이 처형되었습니다. "
                "정체는 사건이 끝날 때까지 공개되지 않습니다."
            )
            self._record(line)
            self._moment("execution", line, target=accused.id)
            if accused.role == "trickster":
                line = "모두가 광대의 연기에 속았습니다. 광대 단독 승리!"
                self._record(line)
                self._moment("victory", line, actor=accused.id)
                self._finish("trickster")
                return
            if self._check_win():
                return
        else:
            line = f"최종 판결 {execute_votes} 대 {spare_votes}. {accused.nick}님은 석방되었습니다."
            self._record(line)
            self._moment("spared", line, target=accused.id)
        self._set_phase("result", self._seconds("result"))

    def _check_win(self) -> bool:
        alive = [p for p in self.players.values() if p.alive and p.role != "spectator"]
        mafia = sum(p.role == "mafia" for p in alive)
        citizens = len(alive) - mafia
        winner = None
        if mafia == 0:
            winner = "citizen"
            self._record("시민 팀 승리! 도시의 마지막 마피아가 사라졌습니다.")
        elif mafia >= citizens:
            winner = "mafia"
            self._record("마피아 팀 승리! 도시는 완전히 장악되었습니다.")
        if winner:
            self._moment("victory", self.case_log[-1])
            self._finish(winner)
            return True
        return False

    def _finish(self, winner: str) -> None:
        self.winner = winner
        self._resolve_theories()
        for theory in self.theories.values():
            result = theory.get("status", "broken")
            self._record(
                f"증거 연결 검증 — {theory['owner']}님의 가설은 "
                f"{'확인' if result == 'confirmed' else '부분 적중' if result == 'partial' else '붕괴'}되었습니다."
            )
        for p in self.players.values():
            won = (winner == "mafia" and p.role == "mafia") or (
                winner == "citizen" and p.role not in {"mafia", "trickster", "spectator"}
            ) or (winner == "trickster" and p.role == "trickster")
            participation = min(self.round, 10) * 3
            p.score = (100 if won else 20) + participation
            if p.alive:
                p.score += 20
            if p.role == "detective":
                p.score += min(len(p.intel), 5) * 5
            for key, stance in self.reads.get(p.id, {}).items():
                target = self.players.get(key.split(":", 1)[-1])
                if target and ((stance == "suspect" and target.role == "mafia") or (
                    stance == "trust" and target.role not in {"mafia", "trickster"}
                )):
                    p.score += 3
            prediction = self.players.get(self.ghost_predictions.get(p.id, ""))
            if p.role != "mafia" and prediction and prediction.role == "mafia":
                p.score += 15
            pressure_hits = sum(
                1
                for key, target_id in self.pressure_marks.items()
                if key.split(":", 1)[-1] == p.id
                and p.role != "mafia"
                and self.players.get(target_id)
                and self.players[target_id].role == "mafia"
            )
            p.score += pressure_hits * 6
            if self._mission_completed(p):
                p.score += 10
            scene_result = self.scene_results.get(p.id)
            if scene_result and scene_result.get("score", 0) >= 67:
                p.score += 8
            oath = self.oaths.get(p.id)
            if oath and oath.get("kept") is True:
                p.score += 8
            elif oath and oath.get("kept") is False:
                p.score = max(0, p.score - 2)
            if any(echo.get("owner_id") == p.id for echo in self.ghost_echoes):
                p.score += 4
            for theory in self.theories.values():
                if theory.get("owner_id") != p.id:
                    continue
                stake = int(theory.get("stake", 1))
                if theory.get("status") == "confirmed":
                    p.score += 10 * stake
                elif theory.get("status") == "partial":
                    p.score += 3 * stake
                else:
                    p.score = max(0, p.score - stake)
        self._build_awards()
        self._build_case_report()
        self._set_phase("gameover", 0)
        if not any(player.coders_id is not None for player in self.players.values()):
            return
        try:
            asyncio.get_running_loop().create_task(self._persist_scores())
        except RuntimeError:
            # Pure unit tests may resolve a match outside an event loop.
            pass

    async def _persist_scores(self) -> None:
        """Persist every signed-in participant as soon as a match ends."""
        from app.routes.leaderboard import persist_best_score

        writes = [
            persist_best_score(player.coders_id, player.nick, player.score)
            for player in self.players.values()
            if player.coders_id is not None and player.score > 0
        ]
        if writes:
            await asyncio.gather(*writes, return_exceptions=True)

    def _set_phase(self, phase: str, seconds: int) -> None:
        self.phase = phase
        self.phase_started_at = time.time()
        self.deadline = time.time() + seconds if seconds else 0

    def _guide_for(self, viewer: Player) -> str:
        if self.phase == "lobby":
            return "처음이라면 AI 플레이어를 채워 연습해 보세요. 퀵은 약 12분, 클래식은 20분 이상 깊게 토론하는 흐름입니다."
        if self.phase == "reveal":
            return f"당신은 {ROLE_NAMES.get(viewer.role, viewer.role)}입니다. 역할 카드는 다른 사람에게 보이지 않으니 승리 조건부터 확인하세요."
        if not viewer.alive and viewer.role == "mafia":
            return "당신은 이미 마피아 동료를 알고 있습니다. 공개 사건 기록을 보며 팀의 결말을 지켜보세요."
        if not viewer.alive:
            return "사후 수사실에서 생존한 마피아를 예측해 보세요. 사건 종료 시 적중하면 보너스 15점을 받습니다."
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
            speaker = self.players.get(self.speaker_id or "")
            if speaker:
                event = self.round_event["title"] if self.round_event else "자정 사건"
                can_tip = f"{self.round}:{viewer.id}" not in self.tip_marks
                tip_hint = " 익명 제보실에서 출처 없는 단서를 한 번 봉인할 수 있습니다." if can_tip else " 익명 제보는 이미 봉인했습니다."
                theory_hint = (
                    " 용의자·감식 단서·내 시간 조각을 증거 연결 고리로 봉인하고 인장을 걸 수 있습니다."
                    if self.theory_stakes.get(viewer.id, 0) > 0 and self._theory_key(viewer.id) not in self.theories
                    else " 이번 낮의 증거 연결 고리는 이미 봉인했거나 인장을 모두 사용했습니다."
                )
                return f"{event} 적용 중. 현재 {speaker.nick}님이 집중 발언자입니다. 질문을 듣고 이번 낮 한 번뿐인 긴급 지목을 신중하게 사용하세요.{tip_hint}{theory_hint}"
            if viewer.intel:
                return f"최근 조사 기록: {viewer.intel[-1]} 공개할지, 한 턴 더 숨길지 판단하세요."
            return "한 사람을 몰아가기보다 각자 ‘어젯밤 누구를 선택했는지’ 물어보면 모순을 찾기 쉽습니다."
        if self.phase == "vote":
            return "투표 대상은 공개되지 않고 봉인 완료 인원만 표시됩니다. 광대는 처형되면 혼자 승리하므로 단순히 수상하다는 이유만으로 찍지 마세요."
        if self.phase == "defense":
            if viewer.id == self.accused_id:
                return "최후 변론 시간입니다. 표가 몰린 이유를 반박하고, 확인 가능한 사실을 짧게 제시하세요."
            return "피고인의 최후 변론을 들으세요. 이전 발언과 모순되는 지점을 마지막으로 확인할 시간입니다."
        if self.phase == "verdict":
            if viewer.id == self.accused_id:
                return "최종 판결을 기다리고 있습니다. 피고인은 찬반 투표에 참여할 수 없습니다."
            return "처형 또는 석방을 선택하세요. 기권표는 판결 수에 포함되지 않습니다."
        if self.phase == "dawn" and self.clues:
            clue = self.clues[-1]
            return f"감식 단서 {clue['code']}: {clue['title']}. 후보들의 알리바이와 밤 행동 주장을 대조하세요."
        if self.phase in {"dawn", "result"}:
            return "사건 기록과 투표수를 확인하세요. 결과가 나오기 전 했던 주장과 맞는지 비교하면 다음 단서가 됩니다."
        return "역할 공개와 사건 기록을 비교해 승부를 가른 거짓말을 찾아보세요."

    def _state_for(self, viewer: Player) -> dict:
        vote_counts = (
            Counter(self.votes.values())
            if self.phase in {"defense", "verdict", "result", "gameover"}
            else Counter()
        )
        now_ms = int(time.time() * 1000)
        recent_reactions = [reaction for reaction in self.reactions if now_ms - int(reaction["at"]) <= 5500]
        visible_chat = [
            {k: v for k, v in msg.items() if k != "visibility"}
            for msg in self.chat
            if msg["visibility"] == "all" or viewer.role == "mafia"
        ]
        mafia_team = [
            p.id for p in self.players.values()
            if viewer.role == "mafia" and p.role == "mafia"
        ]
        decision_completed, decision_total = self._decision_progress()
        pressure_key = f"{self.round}:{viewer.id}"
        current_pressure = {
            key.split(":", 1)[1]: target_id
            for key, target_id in self.pressure_marks.items()
            if key.startswith(f"{self.round}:")
        }
        pressure_visible = not (
            self.phase == "day"
            and self.round_event
            and self.round_event.get("sealed_pressure")
        )
        pressure_counts = (
            Counter(current_pressure.values()) if pressure_visible else Counter()
        )
        pressure_total = sum(
            player.alive and player.role != "spectator"
            for player in self.players.values()
        )
        current_reads = {
            key.split(":", 1)[1]: stance
            for key, stance in self.reads.get(viewer.id, {}).items()
            if key.startswith(f"{self.round}:")
        }
        show_read_summary = self.phase in {"vote", "defense", "verdict", "result", "gameover"}
        # Votes stay sealed while the ballot is open.  The complete feed is
        # revealed together once the room enters the defense/results flow so a
        # late voter cannot simply copy the public majority.
        show_ballot_feed = self.phase in {"defense", "verdict", "result", "gameover"}
        read_summary: dict[str, dict[str, int]] = {}
        if show_read_summary:
            for target in self.players.values():
                counts = Counter(
                    choices.get(f"{self.round}:{target.id}")
                    for choices in self.reads.values()
                )
                read_summary[target.id] = {
                    "trust": counts["trust"],
                    "hold": counts["hold"],
                    "suspect": counts["suspect"],
                }
        visible_memory_reveals = [
            seal for seal in self.memory_seals.values()
            if self.phase == "gameover"
            or (self.players.get(seal.get("owner_id", "")) and not self.players[seal["owner_id"]].alive)
        ]
        scene_completed = sum(
            result.get("round") == self.round for result in self.scene_results.values()
        )
        current_oaths = [oath for oath in self.oaths.values() if oath.get("round") == self.round]
        visible_contracts = [contract for contract in self.contracts.values() if contract.get("owner_id") == viewer.id or contract.get("target_id") == viewer.id]
        reveal_theories = self.phase == "gameover"
        theory_board = [
            self._theory_view(theory, reveal=reveal_theories)
            for theory in self.theories.values()
        ]
        viewer_theories = [theory for theory in self.theories.values() if theory.get("owner_id") == viewer.id]
        latest_theory = max(viewer_theories, key=lambda item: (int(item.get("round", 0)), int(item.get("sealed_at", 0))), default=None)
        current_theory = self.theories.get(self._theory_key(viewer.id))
        ai_social = []
        if self.mode == "solo" or self.case_mode == "first":
            for bot in self.players.values():
                if not bot.is_bot:
                    continue
                memories = self.ai_memories.get(bot.id, [])
                relation = self.ai_relationships.get(bot.id, {}).get(viewer.id, {})
                ai_social.append({"player_id": bot.id, "player": bot.nick, "persona": self._bot_persona(bot)["label"], "emotion": relation.get("emotion", "neutral"), "trust": int(relation.get("trust", 0)), "memory": memories[-1].get("event") if memories else "아직 당신에 대한 기억이 없습니다."})
        return {
            "t": "state",
            "room": self.name,
            "case_profile": self.case_profile,
            "round_event": self.round_event,
            "pressure_counts": dict(pressure_counts),
            "pressure_progress": {
                "completed": len(current_pressure),
                "total": pressure_total,
                "sealed": not pressure_visible,
            },
            "awards": list(self.awards) if self.phase == "gameover" else [],
            "public_leads": list(self.public_leads),
            "memory_reveals": visible_memory_reveals,
            "scene_progress": {
                "completed": scene_completed,
                "total": sum(player.alive and player.role != "spectator" for player in self.players.values()),
            },
            "theory_board": theory_board,
            "oaths": current_oaths,
            "contracts": visible_contracts,
            "ai_social": ai_social,
            "ghost_echoes": list(self.ghost_echoes),
            "director_beats": list(self.director_beats)[-5:],
            "tips": list(self.tips)[-12:],
            "phase": self.phase,
            "round": self.round,
            "deadline": round(self.deadline * 1000),
            "winner": self.winner,
            "mode": self.mode,
            "lobby_mode": self.lobby_mode,
            "case_mode": self.case_mode,
            "case_grade": self.case_grade if self.phase == "gameover" else "",
            "case_badges": list(self.case_badges) if self.phase == "gameover" else [],
            "final_highlights": list(self.final_highlights) if self.phase == "gameover" else [],
            "best_persuader": self.best_persuader if self.phase == "gameover" else None,
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
                    "bot_profile": p.bot_profile if p.is_bot else None,
                    "bot_persona": self._bot_persona(p)["label"] if p.is_bot else None,
                    "score": p.score,
                    "voice": p.voice and p.connected and not p.is_bot,
                }
                for p in self.players.values()
            ],
            "me": {
                "id": viewer.id,
                "role": viewer.role,
                "alive": viewer.alive,
                "action_target": self.actions.get(viewer.id),
                "vote_target": self.votes.get(viewer.id),
                "judgement": self.judgements.get(viewer.id),
                "intel": viewer.intel[-4:],
                "mission": viewer.mission,
                "mission_completed": self._mission_completed(viewer) if self.phase != "lobby" else False,
                "can_tip": (
                    self.phase == "day" and viewer.alive
                    and f"{self.round}:{viewer.id}" not in self.tip_marks
                ),
                "reads": current_reads,
                "can_leave_will": (
                    self.phase == "dawn" and viewer.id == self.last_death_id
                    and viewer.id not in self.wills
                ),
                "private_lead": (
                    {k: v for k, v in self.private_leads.get(viewer.id, {}).items() if k != "authentic"}
                    or None
                ),
                "ghost_prediction": self.ghost_predictions.get(viewer.id),
                "ghost_correct": (
                    self.phase == "gameover"
                    and self.ghost_predictions.get(viewer.id) in self.players
                    and self.players[self.ghost_predictions[viewer.id]].role == "mafia"
                ) if viewer.id in self.ghost_predictions else None,
                "pressure_target": self.pressure_marks.get(pressure_key),
                "memory_prompt": self.memory_prompts.get(viewer.id, MEMORY_PROMPTS[0]),
                "memory_seal": self.memory_seals.get(viewer.id),
                "can_seal_memory": (
                    self.phase == "reveal" and viewer.alive and viewer.role != "spectator"
                    and viewer.id not in self.memory_seals
                ),
                "scene_fragments": self.scene_fragments.get(viewer.id, []),
                "scene_result": self.scene_results.get(viewer.id),
                "can_reconstruct": (
                    self.phase in {"dawn", "day", "vote"} and viewer.alive
                    and self.scene_submissions.get(viewer.id, {}).get("round") != self.round
                ),
                "theory": self._theory_view(current_theory or latest_theory, reveal=reveal_theories) if (current_theory or latest_theory) else None,
                "theory_stakes": self.theory_stakes.get(viewer.id, 0),
                "can_theorize": (
                    self.phase == "day" and viewer.alive and viewer.role != "spectator"
                    and self.theory_stakes.get(viewer.id, 0) > 0
                    and current_theory is None
                ),
                "oath_target": self.oaths.get(viewer.id, {}).get("target_id"),
                "oath_text": self.oaths.get(viewer.id, {}).get("text", ""),
                "can_oath": (
                    self.phase == "day" and viewer.alive
                    and self.oaths.get(viewer.id, {}).get("round") != self.round
                ),
                "can_ghost_message": (
                    not viewer.alive and viewer.role not in {"mafia", "spectator"}
                    and self.phase not in {"lobby", "reveal", "night", "gameover"}
                    and f"{self.round}:{viewer.id}" not in self.ghost_echo_marks
                ),
                "ghost_message": next(
                    (echo.get("text") for echo in self.ghost_echoes if echo.get("owner_id") == viewer.id),
                    None,
                ),
            },
            "accused_id": self.accused_id,
            "judgement_counts": {
                "execute": sum(self.judgements.values()),
                "spare": len(self.judgements) - sum(self.judgements.values()),
            },
            "decision_progress": {
                "completed": decision_completed,
                "total": decision_total,
            },
            "ballot_feed": [
                {
                    "voter_id": voter_id,
                    "voter": self.players[voter_id].nick,
                    "target_id": target_id,
                    "target": self.players[target_id].nick,
                }
                for voter_id, target_id in self.votes.items()
                if show_ballot_feed
                and voter_id in self.players and target_id in self.players
            ],
            "story": list(self.story),
            "case_log": list(self.case_log),
            "clues": list(self.clues),
            "guide": self._guide_for(viewer),
            "chat": visible_chat[-30:],
            "reactions": recent_reactions,
            "speaker_id": self.speaker_id,
            "speaker_deadline": round(self.speaker_deadline * 1000),
            "interrogation_order": self.interrogation_order,
            "questions": [
                item for item in self.questions
                if item["round"] == self.round and item["speaker_id"] == self.speaker_id
            ][-5:],
            "claims": list(self.claims)[-12:],
            "read_summary": read_summary,
            "moments": list(self.moments) if self.phase == "gameover" else list(self.moments)[-6:],
        }

    async def broadcast(self) -> None:
        """Send changed snapshots without letting slow sockets pile up.

        The ticker still runs once per second so phase deadlines remain precise,
        but most ticks produce an identical state payload. Suppressing duplicate
        frames cuts bandwidth and JSON work for large rooms. Each recipient has
        its own cache because private roles and intel are viewer-specific.
        """
        async with self._broadcast_lock:
            sends = []
            for player in list(self.players.values()):
                socket = player.ws
                if not player.connected or socket is None:
                    continue
                payload = json.dumps(
                    self._state_for(player),
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                if self._last_broadcast_payloads.get(player.id) == payload:
                    continue
                self._last_broadcast_payloads[player.id] = payload

                async def deliver(
                    recipient: Player = player,
                    recipient_socket: WebSocket = socket,
                    snapshot: str = payload,
                ) -> None:
                    try:
                        await asyncio.wait_for(
                            recipient_socket.send_text(snapshot),
                            timeout=settings.broadcast_timeout,
                        )
                    except Exception:
                        # A dead/slow client must not hold up every other player.
                        # Do not clear a socket that was already replaced by a
                        # fast reconnect while this send was in flight.
                        if recipient.ws is recipient_socket:
                            recipient.connected = False
                            recipient.ws = None

                sends.append(deliver())
            if sends:
                await asyncio.gather(*sends, return_exceptions=True)


class RoomManager:
    def __init__(self, max_rooms: int | None = None) -> None:
        self._rooms: dict[str, Room] = {}
        self.max_rooms = max_rooms or settings.max_rooms

    def get(self, name: str) -> Room:
        if name not in self._rooms:
            if len(self._rooms) >= self.max_rooms:
                raise RoomCapacityError("room_capacity")
            self._rooms[name] = Room(name)
        return self._rooms[name]

    def sweep(self, name: str) -> None:
        room = self._rooms.get(name)
        if room is not None and not room.players:
            self._rooms.pop(name, None)

    @property
    def online(self) -> int:
        return sum(len(r.connected_players) for r in self._rooms.values())

    @property
    def room_count(self) -> int:
        return sum(bool(room.players) for room in self._rooms.values())

    @property
    def active_matches(self) -> int:
        return sum(
            room.phase not in {"lobby", "gameover"} and bool(room.players)
            for room in self._rooms.values()
        )


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
