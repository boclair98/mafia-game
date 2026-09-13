"""Investigator passport progression.

The passport is the retention layer for Black Midnight: every completed case
adds durable progress, a small set of daily goals, and a replayable case entry.
It deliberately contains no gameplay modifiers. Future purchases can grant
cosmetic entitlements against these stable IDs without changing game fairness.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import desc, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import CaseRun, InvestigatorProfile, User

BADGE_CATALOG: tuple[dict[str, str], ...] = (
    {
        "id": "first-case",
        "title": "첫 사건 완주",
        "copy": "첫 번째 사건을 끝까지 완주했습니다.",
    },
    {
        "id": "case-solver",
        "title": "사건 해결자",
        "copy": "시민 팀 또는 개인 승리를 기록했습니다.",
    },
    {
        "id": "timeline-analyst",
        "title": "시간의 복원자",
        "copy": "타임라인 연결 점수 67점 이상을 달성했습니다.",
    },
    {
        "id": "social-detective",
        "title": "심문 기록관",
        "copy": "질문·진술·맹세로 테이블의 증거를 만들었습니다.",
    },
    {
        "id": "solo-survivor",
        "title": "혼자서도 수사관",
        "copy": "AI 용의자 사건을 완주했습니다.",
    },
    {
        "id": "streak-three",
        "title": "연속 출석 수사관",
        "copy": "3일 연속 사건을 완주했습니다.",
    },
)


@dataclass(frozen=True)
class CaseResult:
    case_code: str
    case_title: str
    mode: str
    winner: str
    score: int
    grade: str
    won: bool = False
    timeline_score: int = 0
    social_actions: int = 0
    badges: tuple[str, ...] = ()

    @property
    def xp_earned(self) -> int:
        # XP rewards participation first, then evidence and social play. It is
        # intentionally unrelated to a player's role power or paid status.
        total = (
            min(250, max(0, self.score))
            + (50 if self.won else 0)
            + (20 if self.timeline_score >= 67 else 0)
            + (10 if self.social_actions > 0 else 0)
        )
        return max(20, min(300, total))


def level_for_xp(xp: int) -> int:
    return max(1, min(100, 1 + max(0, xp) // 500))


def next_level_xp(level: int) -> int:
    return max(500, level * 500)


def _normalise_badges(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(str(item) for item in value if isinstance(item, str)))


def _daily_missions(profile: InvestigatorProfile, today: date) -> list[dict[str, Any]]:
    if profile.daily_play_date != today:
        daily_cases = daily_evidence = daily_social = 0
    else:
        daily_cases = profile.daily_cases
        daily_evidence = profile.daily_evidence
        daily_social = profile.daily_social
    return [
        {
            "id": "daily-case",
            "title": "오늘의 사건 완주",
            "copy": "사건 하나를 끝까지 플레이하세요.",
            "progress": min(daily_cases, 1),
            "target": 1,
        },
        {
            "id": "daily-evidence",
            "title": "증거 연결",
            "copy": "타임라인을 67점 이상으로 복원하세요.",
            "progress": min(daily_evidence, 1),
            "target": 1,
        },
        {
            "id": "daily-social",
            "title": "한 줄의 심문",
            "copy": "질문·진술·맹세 중 하나를 남기세요.",
            "progress": min(daily_social, 1),
            "target": 1,
        },
    ]


def serialize_profile(
    user: User,
    profile: InvestigatorProfile,
    recent_runs: list[CaseRun],
    *,
    today: date | None = None,
) -> dict[str, Any]:
    current_date = today or datetime.now(UTC).date()
    badges = _normalise_badges(profile.unlocked_badges)
    level = level_for_xp(profile.xp)
    level_floor = (level - 1) * 500
    return {
        "investigator": {
            "display_name": user.display_name,
            "level": level,
            "xp": profile.xp,
            "level_xp": profile.xp - level_floor,
            "next_level_xp": next_level_xp(level) - level_floor,
            "cases_played": profile.cases_played,
            "cases_won": profile.cases_won,
            "solo_cases": profile.solo_cases,
            "party_cases": profile.party_cases,
            "best_score": profile.best_score,
            "current_streak": profile.current_streak,
            "best_streak": profile.best_streak,
        },
        "daily_missions": [
            {
                **mission,
                "complete": mission["progress"] >= mission["target"],
            }
            for mission in _daily_missions(profile, current_date)
        ],
        "badges": [
            {**badge, "unlocked": badge["id"] in badges} for badge in BADGE_CATALOG
        ],
        "recent_cases": [
            {
                "id": str(run.id),
                "case_code": run.case_code,
                "case_title": run.case_title,
                "mode": run.mode,
                "winner": run.winner,
                "score": run.score,
                "grade": run.grade,
                "xp_earned": run.xp_earned,
                "timeline_score": run.timeline_score,
                "social_actions": run.social_actions,
                "badges": _normalise_badges(run.badges),
                "completed_at": run.completed_at.isoformat(),
            }
            for run in recent_runs
        ],
    }


async def ensure_profile(
    session: AsyncSession, user: User, *, for_update: bool = False
) -> InvestigatorProfile:
    query = select(InvestigatorProfile).where(InvestigatorProfile.user_id == user.id)
    if for_update:
        query = query.with_for_update()
    profile = (await session.execute(query)).scalar_one_or_none()
    if profile is not None:
        return profile
    # Two matches can finish for the same signed-in player at the same time.
    # Let Postgres arbitrate the unique user_id constraint instead of exposing
    # an IntegrityError to one of those sessions.
    await session.execute(
        pg_insert(InvestigatorProfile)
        .values(user_id=user.id, unlocked_badges=[])
        .on_conflict_do_nothing(index_elements=["user_id"])
    )
    query = select(InvestigatorProfile).where(InvestigatorProfile.user_id == user.id)
    if for_update:
        query = query.with_for_update()
    return (await session.execute(query)).scalar_one()


async def record_case_result(
    session: AsyncSession, user: User, result: CaseResult
) -> InvestigatorProfile:
    """Atomically add one completed case to the user's passport."""
    profile = await ensure_profile(session, user, for_update=True)
    today = datetime.now(UTC).date()
    yesterday = today - timedelta(days=1)

    if profile.last_play_date == today:
        streak = profile.current_streak or 1
    elif profile.last_play_date == yesterday:
        streak = max(1, profile.current_streak) + 1
    else:
        streak = 1

    if profile.daily_play_date != today:
        daily_cases = daily_evidence = daily_social = 0
    else:
        daily_cases = profile.daily_cases
        daily_evidence = profile.daily_evidence
        daily_social = profile.daily_social

    badges = _normalise_badges(profile.unlocked_badges)
    if profile.cases_played == 0:
        badges.append("first-case")
    if result.won:
        badges.append("case-solver")
    if result.timeline_score >= 67:
        badges.append("timeline-analyst")
    if result.social_actions > 0:
        badges.append("social-detective")
    if result.mode == "solo":
        badges.append("solo-survivor")
    if streak >= 3:
        badges.append("streak-three")
    badges = list(dict.fromkeys(badges))

    profile.xp += result.xp_earned
    profile.cases_played += 1
    profile.cases_won += int(result.won)
    profile.solo_cases += int(result.mode == "solo")
    profile.party_cases += int(result.mode != "solo")
    profile.best_score = max(profile.best_score, result.score)
    profile.current_streak = streak
    profile.best_streak = max(profile.best_streak, streak)
    profile.last_play_date = today
    profile.daily_play_date = today
    profile.daily_cases = daily_cases + 1
    profile.daily_evidence = daily_evidence + int(result.timeline_score >= 67)
    profile.daily_social = daily_social + int(result.social_actions > 0)
    profile.unlocked_badges = badges

    session.add(
        CaseRun(
            user_id=user.id,
            case_code=result.case_code,
            case_title=result.case_title,
            mode=result.mode,
            winner=result.winner,
            score=result.score,
            grade=result.grade[:2] or "C",
            xp_earned=result.xp_earned,
            timeline_score=result.timeline_score,
            social_actions=result.social_actions,
            badges=list(result.badges),
        )
    )
    await session.flush()
    return profile


async def get_passport(
    session: AsyncSession, user: User, *, limit: int = 12
) -> dict[str, Any]:
    profile = await ensure_profile(session, user)
    runs = (
        (
            await session.execute(
                select(CaseRun)
                .where(CaseRun.user_id == user.id)
                .order_by(desc(CaseRun.completed_at))
                .limit(max(1, min(limit, 50)))
            )
        )
        .scalars()
        .all()
    )
    return serialize_profile(user, profile, list(runs))
