"""Independent adversarial checks for evidence authority and bot knowledge.

These tests compare observable outcomes and privacy boundaries. They do not
interpret free-form speech as true or false and do not assert who must win.
"""

from __future__ import annotations

import asyncio
import copy
import json
import random
import time
from uuid import uuid4

import pytest
from app.game import Player, Room, rooms
from app.main import app
from app.routes.leaderboard import persist_best_score
from app.services.passport import CaseResult
from fastapi.testclient import TestClient


def arena() -> Room:
    room = Room("evidence-quality")
    roles = ("mafia", "doctor", "detective", "bodyguard", "citizen", "citizen")
    for index, role in enumerate(roles, 1):
        pid = f"p{index}"
        room.players[pid] = Player(
            id=pid, key=f"quality-key-{pid}", nick=pid.upper(),
            coders_id=None, ws=None, role=role,
        )
    room.host_id = "p1"
    room.round = 1
    room._set_phase("day", 90)
    return room


def claim_and_source(room: Room) -> tuple[str, str]:
    room.speaker_id = "p2"
    assert room.add_claim("p2", "공개된 기록을 확인한 뒤 판단하겠습니다.") is None
    room._record_night("quiet", "밤에는 확인된 희생자가 없습니다.", None, [])
    return str(room.claims[-1]["id"]), str(room._night_summary()["id"])


def test_unknown_role_swap_does_not_change_civilian_bot_reads_or_verdicts():
    room = arena()
    bot = room.players["p6"]
    bot.is_bot = True
    room.interrogation_order = ["p1"]
    room.phase_started_at = time.time()
    room.deadline = room.phase_started_at + 90
    room.accused_id = "p1"
    room._bot_suspicions["p3"] = "p1"  # Another investigator's private result.

    rng_state = random.getstate()
    try:
        results = []
        for role_one, role_two in (("mafia", "doctor"), ("doctor", "mafia")):
            room.players["p1"].role = role_one
            room.players["p2"].role = role_two
            room.phase = "day"
            room._speaker_index = -1
            room.reads.clear()
            random.seed(49121)
            room._run_interrogation()
            stance = room.reads[bot.id]["1:p1"]
            room.phase = "verdict"
            room.judgements.clear()
            random.seed(49121)
            room._run_bots()
            results.append((stance, room.judgements[bot.id]))
        assert results[0] == results[1]
    finally:
        random.setstate(rng_state)


def test_bot_memory_cannot_invent_an_alibi_contradiction_without_claims():
    room = arena()
    bot, target = room.players["p6"], room.players["p1"]
    bot.is_bot = True
    room._remember_ai(bot, "공개된 지목을 검토함", target, "doubt")
    assert not room.claims
    line = room._ai_memory_line(bot, target)
    assert line
    assert "알리바이가 달라" not in line
    assert "모순을 확인" not in line


def test_private_moments_are_filtered_in_the_whole_public_snapshot():
    room = arena()
    room.round_event = {"id": "blackout", "sealed_pressure": True}
    assert room.apply_pressure("p1", "p2") is None
    assert room.make_contract("p1", "p3", "두 사람만 공유하는 비공개 계약입니다.") is None
    outsider = room._state_for(room.players["p6"])
    assert outsider["pressure_counts"] == {}
    assert outsider["contracts"] == []
    assert all(moment.get("target") is None for moment in outsider["moments"] if moment["kind"] == "pressure")
    assert not any(moment["kind"] == "contract" for moment in outsider["moments"])
    assert "두 사람만 공유하는 비공개 계약입니다." not in json.dumps(outsider, ensure_ascii=False)


@pytest.mark.parametrize("outcome", ["quiet", "attack", "rescue", "guard"])
def test_night_report_matches_the_resolved_actions_but_not_private_participants(outcome):
    room = arena()
    room._set_phase("night", 90)
    room.actions = {} if outcome == "quiet" else {"p1": "p6"}
    if outcome == "rescue":
        room.actions["p2"] = "p6"
    if outcome == "guard":
        room.actions["p4"] = "p6"
    room._resolve_night()
    record = room.night_records[-1]
    assert record["outcome"] == outcome
    for viewer in room.players.values():
        state = room._state_for(viewer)
        assert state["night_summary"]["id"] == record["id"]
        assert state["night_summary"]["outcome"] == outcome
        assert set(state["night_summary"]) == {"id", "round", "outcome", "title", "detail"}
        assert state["night_replay"] == []
        snapshot = json.dumps(state, ensure_ascii=False)
        assert "_attacker_ids" not in snapshot
        assert "attacker_ids" not in snapshot
        assert not any(key.startswith("_") for clue in state["clues"] for key in clue)
    assert all(fragment["event_id"] == record["id"] for fragment in room.scene_fragments["p5"])


def test_night_ledger_uses_the_last_accepted_choice_and_only_reveals_after_close():
    room = arena()
    room._set_phase("night", 90)
    assert room.act("p1", "p5") is None
    assert room.act("p1", "p6") is None
    room._resolve_night()
    record = room.night_records[-1]
    attack = next(item for item in record["actions"] if item["actor_id"] == "p1")
    assert attack["target_id"] == "p6"
    assert room._state_for(room.players["p5"])["night_replay"] == []
    room._finish("citizen")
    replay = room._state_for(room.players["p5"])["night_replay"]
    assert replay[-1]["actions"] == record["actions"]


@pytest.mark.parametrize("invalid", ["self", "dead_asker", "spectator", "dead_target", "old_claim", "foreign_source", "deadline"])
def test_invalid_challenge_does_not_create_a_record_or_change_relationships(invalid):
    room = arena()
    claim_id, source_id = claim_and_source(room)
    asker_id = "p5"
    if invalid == "self":
        asker_id = "p2"
    elif invalid == "dead_asker":
        room.players[asker_id].alive = False
    elif invalid == "spectator":
        room.players[asker_id].role = "spectator"
    elif invalid == "dead_target":
        room.players["p2"].alive = False
    elif invalid == "old_claim":
        room.claims[-1]["round"] = 0
    elif invalid == "foreign_source":
        source_id = "private-record-belongs-to-someone-else"
    elif invalid == "deadline":
        room.deadline = time.time() - 0.001
    before = copy.deepcopy(room.ai_relationships)
    assert room.challenge_claim(asker_id, claim_id, source_id, "이 공개 기록에 대해 어떻게 설명하시겠어요?")
    assert not room.cross_examinations
    assert room.ai_relationships == before


def test_exact_retries_are_idempotent_and_only_the_addressed_player_can_reply():
    room = arena()
    claim_id, source_id = claim_and_source(room)
    question = "이 공개 기록에 대해 어떻게 설명하시겠어요?"
    assert room.challenge_claim("p5", claim_id, source_id, question) is None
    entry = copy.deepcopy(room.cross_examinations[0])
    count = len(room.moments)
    assert room.challenge_claim("p5", claim_id, source_id, question) is None
    assert list(room.cross_examinations) == [entry]
    assert len(room.moments) == count
    assert room.challenge_claim("p5", claim_id, source_id, "내용이 다른 두 번째 질문입니다.")
    assert room.reply_challenge("p1", entry["id"], "질문과 관계없는 사람이 답을 시도합니다.", "clarify")
    assert room.cross_examinations[0]["response"] is None
    reply = "새로 확인한 기록에 맞춰 판단을 수정하겠습니다."
    assert room.reply_challenge("p2", entry["id"], reply, "revise") is None
    answered = copy.deepcopy(room.cross_examinations[0])
    count = len(room.moments)
    assert room.reply_challenge("p2", entry["id"], reply, "revise") is None
    assert room.cross_examinations[0] == answered
    assert len(room.moments) == count
    assert room.reply_challenge("p2", entry["id"], "이미 확정한 답변을 임의로 덮어씁니다.", "clarify")
    assert room.cross_examinations[0] == answered


def test_citation_snapshots_survive_source_eviction_and_no_machine_guilt_is_added():
    room = arena()
    claim_id, source_id = claim_and_source(room)
    assert room.challenge_claim("p5", claim_id, source_id, "이 공개 기록을 어떻게 해석하셨는지 알려주세요.") is None
    question = copy.deepcopy(room.cross_examinations[0])
    room.claims.clear()
    room.clues.clear()
    room.night_records.clear()
    public = room._state_for(room.players["p4"])["cross_examinations"][0]
    assert public["claim_text"] == question["claim_text"]
    assert public["clue_title"] == question["clue_title"]
    assert public["clue_detail"] == question["clue_detail"]
    assert not {"guilty", "truth", "verified", "contradiction_confirmed"} & public.keys()


def test_quiet_night_bot_answer_cites_the_report_without_inventing_a_murder():
    room = arena()
    claim_id, source_id = claim_and_source(room)
    room.players["p2"].is_bot = True
    assert room.challenge_claim("p5", claim_id, source_id, "아무도 희생되지 않은 이 기록을 어떻게 설명하나요?") is None
    question = room.cross_examinations[0]
    assert question["response"]
    assert room._night_summary()["title"] in question["response"]
    assert question["response_kind"] == "clarify"
    assert "범인으로 확인" not in question["response"]


@pytest.mark.parametrize("command", ["challenge", "challenge_reply"])
def test_socket_requires_current_phase_for_record_questions_and_replies(command):
    name = f"qa-phase-{uuid4().hex[:10]}"
    with TestClient(app) as api:
        with api.websocket_connect(f"/api/ws?room={name}&key=qa-phase-key-123") as socket:
            welcome = socket.receive_json()
            socket.receive_json()
            room = rooms.get(name)
            actor = room.players[welcome["id"]]
            actor.role = "citizen"
            room.round = 1
            room._set_phase("day", 90)
            old_phase = room.phase_id
            room._set_phase("night", 90)
            room._set_phase("day", 90)
            socket.send_json({
                "t": command, "phase_id": old_phase,
                "claim_id": "no-current-claim", "clue_id": "no-current-source",
                "challenge_id": "no-current-question", "text": "이전 화면에서 지연된 기록 질문입니다.",
                "kind": "clarify",
            })
            for _ in range(8):
                response = socket.receive_json()
                if response["t"] == "error":
                    assert response.get("code") == "stale_phase"
                    break
            else:
                pytest.fail("a delayed record-question command did not receive stale_phase")
            assert not room.cross_examinations


async def test_completed_case_persists_and_is_only_visible_in_the_owners_passport(client):
    owner, other = uuid4(), uuid4()
    result = CaseResult(
        case_code="QA-OWNER", case_title="독립 검증용 사건", mode="solo",
        winner="citizen", score=145, grade="A", won=True,
        timeline_score=100, social_actions=2,
    )
    await persist_best_score(owner, "Quality Owner", result.score, case_result=result)
    response = await client.get("/api/passport", headers={"X-Coders-User": str(owner)})
    assert response.status_code == 200
    payload = response.json()
    assert payload["investigator"]["cases_played"] == 1
    assert payload["investigator"]["xp"] == result.xp_earned
    assert payload["investigator"]["current_streak"] == 1
    assert payload["investigator"]["best_streak"] == 1
    assert all(mission["complete"] for mission in payload["daily_missions"])
    assert {badge["id"] for badge in payload["badges"] if badge["unlocked"]} == {
        "first-case", "case-solver", "timeline-analyst", "social-detective", "solo-survivor",
    }
    assert payload["recent_cases"][0]["case_code"] == result.case_code
    assert payload["recent_cases"][0]["score"] == result.score
    assert payload["recent_cases"][0]["social_actions"] == 2
    private_response = await client.get("/api/passport", headers={"X-Coders-User": str(other)})
    assert private_response.status_code == 200
    assert private_response.json()["investigator"]["cases_played"] == 0
    assert private_response.json()["recent_cases"] == []
    anonymous_response = await client.get("/api/passport")
    assert anonymous_response.status_code == 401


async def test_concurrent_completed_cases_preserve_both_runs_and_the_best_score(client):
    owner = uuid4()
    results = [
        CaseResult(case_code=f"QA-PARALLEL-{index}", case_title="동시 종료 검증 사건",
                   mode=mode, winner="citizen", score=score, grade="B", won=True)
        for index, (mode, score) in enumerate((("solo", 80), ("party", 120)), 1)
    ]
    await asyncio.gather(*(
        persist_best_score(owner, "Quality Concurrent", result.score, case_result=result)
        for result in results
    ))
    response = await client.get("/api/passport", headers={"X-Coders-User": str(owner)})
    assert response.status_code == 200
    payload = response.json()
    assert payload["investigator"]["cases_played"] == 2
    assert payload["investigator"]["xp"] == sum(result.xp_earned for result in results)
    assert payload["investigator"]["best_score"] == 120
    assert payload["investigator"]["solo_cases"] == 1
    assert payload["investigator"]["party_cases"] == 1
    assert payload["investigator"]["current_streak"] == 1
    assert payload["investigator"]["best_streak"] == 1
    assert {run["case_code"] for run in payload["recent_cases"]} == {result.case_code for result in results}
    leaderboard = await client.get("/api/leaderboard")
    assert leaderboard.status_code == 200
    assert leaderboard.json()[0]["best_score"] == 120


@pytest.mark.parametrize("limit", [0, 51])
async def test_passport_query_limit_is_server_validated(client, limit):
    response = await client.get(f"/api/passport?limit={limit}", headers={"X-Coders-User": str(uuid4())})
    assert response.status_code == 422
