from app.main import app
from app.services.passport import CaseResult, level_for_xp, next_level_xp
from fastapi.testclient import TestClient


def test_level_progression_is_bounded_and_predictable():
    assert level_for_xp(0) == 1
    assert level_for_xp(499) == 1
    assert level_for_xp(500) == 2
    assert level_for_xp(49_999) == 100
    assert next_level_xp(1) == 500
    assert next_level_xp(4) == 2_000


def test_case_result_rewards_participation_evidence_and_social_play():
    result = CaseResult(
        case_code="BM-042",
        case_title="시계탑의 마지막 종",
        mode="solo",
        winner="citizen",
        score=140,
        grade="A",
        won=True,
        timeline_score=80,
        social_actions=2,
    )
    assert result.xp_earned == 220


def test_case_result_has_a_floor_for_a_failed_match():
    result = CaseResult(
        case_code="BM-007",
        case_title="빈 복도의 발자국",
        mode="party",
        winner="mafia",
        score=0,
        grade="C",
    )
    assert result.xp_earned == 20


def test_passport_requires_a_signed_in_identity():
    response = TestClient(app).get("/api/passport")
    assert response.status_code == 401
