"""Action-linked evidence and publicly attributable questioning rules."""

import json
import random
import time
from unittest.mock import patch

from app.game import Player, Room


def prepared_room() -> Room:
    room = Room("evidence-test")
    for index, role in enumerate(("mafia", "doctor", "detective", "citizen", "citizen"), 1):
        pid = f"p{index}"
        room.players[pid] = Player(id=pid, key=f"{pid}-12345678", nick=pid.upper(),
                                   coders_id=None, ws=None, role=role)
    room.host_id = "p1"
    room.round = 1
    room.phase = "night"
    room.theory_stakes = {pid: 2 for pid in room.players}
    return room


def daylight_room() -> Room:
    room = prepared_room()
    room.actions = {"p1": "p5", "p2": "p5", "p3": "p1"}
    room._resolve_night()
    room._advance()
    room.speaker_id = "p1"
    assert room.add_claim("p1", "첫 번째 보고를 함께 확인해 주세요") is None
    return room


def test_night_evidence_describes_the_final_action_and_keeps_truth_private():
    room = prepared_room()
    room.actions = {"p1": "p4", "p2": "p2", "p3": "p1"}
    room.actions["p1"] = "p5"  # the final choice supersedes an earlier click
    room._resolve_night()

    state = room._state_for(room.players["p4"])
    assert state["night_summary"]["outcome"] == "attack"
    assert "P5" in state["night_summary"]["detail"]
    assert "P4" not in state["night_summary"]["detail"]
    assert state["night_replay"] == []
    assert "attacker_ids" not in json.dumps(state)
    assert "_attacker_ids" not in state["clues"][-1]
    assert state["clues"][-1]["event_id"] == state["night_summary"]["id"]
    assert all(any(card["id"] == "attack" for card in cards) for cards in room.scene_fragments.values())
    room._finish("citizen")
    replay = room._state_for(room.players["p4"])["night_replay"][-1]
    assert replay["victim_id"] == "p5"
    assert next(action for action in replay["actions"] if action["actor_id"] == "p1")["target_id"] == "p5"


def test_quiet_morning_is_an_eligible_record_without_inventing_an_attack():
    room = prepared_room()
    room._resolve_night()
    room._advance()
    room.speaker_id = "p1"
    room.add_claim("p1", "아무도 희생되지 않은 이유를 확인하죠")
    summary = room._state_for(room.players["p4"])["night_summary"]
    assert summary["outcome"] == "quiet"
    assert list(room.clues) == []
    assert room.challenge_claim("p4", str(room.claims[-1]["id"]), summary["id"], "이 사건 보고와 진술을 함께 설명해 주세요") is None
    assert room.cross_examinations[-1]["clue_title"] == summary["title"]
    room._set_phase("night", 20)
    assert room._state_for(room.players["p4"])["night_summary"] is None


def test_challenge_snapshots_records_requires_target_reply_and_is_idempotent():
    room = daylight_room()
    claim = room.claims[-1]
    summary = room._night_summary()
    assert summary
    question = "이 사건 보고와 지금 진술은 어떻게 연결되나요?"
    assert room.challenge_claim("p4", str(claim["id"]), summary["id"], question) is None
    entry = room.cross_examinations[-1]
    assert room.challenge_claim("p4", str(claim["id"]), summary["id"], question) is None
    assert len(room.cross_examinations) == 1
    assert room.challenge_claim("p4", str(claim["id"]), summary["id"], "다른 질문을 다시 보냅니다") is not None
    assert room.reply_challenge("p2", entry["id"], "저를 향한 질문은 아닙니다", "clarify") is not None
    assert room.reply_challenge("p1", entry["id"], "단서만으로 정체를 알 수 없다고 설명했습니다", "clarify") is None
    assert room.reply_challenge("p1", entry["id"], "단서만으로 정체를 알 수 없다고 설명했습니다", "clarify") is None
    assert room.reply_challenge("p1", entry["id"], "답변을 다시 덮어 씁니다", "revise") is not None
    room.claims.clear()
    room.clues.clear()
    assert entry["claim_text"] == claim["text"]
    assert entry["clue_detail"] == summary["detail"]
    assert entry["response_kind"] == "clarify"


def test_challenge_rejects_private_missing_dead_or_late_sources():
    room = daylight_room()
    claim_id = str(room.claims[-1]["id"])
    source_id = str(room._night_summary()["id"])
    assert room.challenge_claim("p4", claim_id, "private-record", "이 기록을 대조해 주세요") is not None
    assert room.challenge_claim("p4", "missing-claim", source_id, "이 기록을 대조해 주세요") is not None
    assert room.challenge_claim("p1", claim_id, source_id, "내 진술을 스스로 대조합니다") is not None
    room.players["p4"].alive = False
    assert room.challenge_claim("p4", claim_id, source_id, "이 기록을 대조해 주세요") is not None
    room.players["p4"].alive = True
    room.deadline = time.time() - 1
    assert room.challenge_claim("p4", claim_id, source_id, "이 기록을 대조해 주세요") is not None


def test_civilian_bot_cannot_read_hidden_role_or_other_detective_knowledge():
    def stance(hidden_role: str, shared_intel: bool) -> str:
        room = prepared_room()
        room.players["p1"].role = hidden_role
        room.players["p4"].is_bot = True
        room.phase = "day"
        room._set_phase("day", 100)
        room.interrogation_order = ["p1", "p2", "p3", "p4", "p5"]
        if shared_intel:
            room.detective_results = {"p3": {"p1": True}}
            room._bot_suspicions["p3"] = "p1"
        random.seed(101)
        room._run_interrogation()
        return room.reads["p4"]["1:p1"]

    assert stance("mafia", False) == stance("citizen", False)
    assert stance("mafia", False) == stance("mafia", True)


def test_bot_memory_never_asserts_a_nonexistent_changed_alibi():
    room = prepared_room()
    bot, target = room.players["p4"], room.players["p1"]
    bot.is_bot = True
    room._remember_ai(bot, "공개 질문을 확인함", target, "doubt")
    assert not room.claims
    line = room._ai_memory_line(bot, target)
    assert line and "기록" in line
    assert "알리바이가 달라" not in line


def test_questions_without_an_implicating_record_do_not_create_suspicion():
    room = daylight_room()
    bot = room.players["p4"]
    bot.is_bot = True
    summary = room._night_summary()
    with patch("app.game.random.uniform", return_value=0):
        before = room._bot_target_score(bot, room.players["p1"])
        assert room.challenge_claim("p5", str(room.claims[-1]["id"]), summary["id"], "이 사건 보고와 진술을 함께 설명해 주세요") is None
        after = room._bot_target_score(bot, room.players["p1"])
    assert before == after


def test_evidence_question_can_make_bot_reconsider_its_public_suspicion():
    room = daylight_room()
    bot = room.players["p3"]
    bot.is_bot = True
    room.claims.append({"id": "bot-claim", "speaker_id": "p3", "speaker": "P3", "text": "P4의 기록을 먼저 확인하겠습니다",
                        "suspect_id": "p4", "round": 1, "at": 1})
    room._bot_suspicions["p3"] = "p4"
    room.clues.append({"id": "new-clue", "code": "E-1", "round": 1, "title": "다른 후보의 흔적", "detail": "P1과 P2의 흔적입니다",
                       "outcome": "치료 개입", "suspect_ids": ["p1", "p2"], "suspects": ["P1", "P2"]})
    assert room.challenge_claim("p5", "bot-claim", "new-clue", "당신이 지목한 사람은 이 기록에 없는데요?") is None
    entry = room.cross_examinations[-1]
    assert entry["response_kind"] == "revise"
    assert entry["response"]
    assert "p3" not in room._bot_suspicions
    with patch("app.game.random.uniform", return_value=0):
        assert room._bot_target_score(bot, room.players["p4"]) < room._bot_target_score(bot, room.players["p1"])


def test_sealed_pressure_and_private_contract_do_not_leak_through_moments():
    room = daylight_room()
    room.round_event = {"id": "blackout", "sealed_pressure": True}
    room.apply_pressure("p4", "p1")
    room.make_contract("p2", "p3", "우리끼리 기록을 다시 확인합시다")
    outsider = room._state_for(room.players["p5"])
    assert outsider["pressure_counts"] == {}
    assert outsider["contracts"] == []
    assert all(item.get("target") is None for item in outsider["moments"] if item["kind"] == "pressure")
    assert not any(item["kind"] == "contract" for item in outsider["moments"])


def test_new_theory_accepts_any_owned_fragment_from_the_actual_night_event():
    room = daylight_room()
    clue = room.clues[-1]
    fragment = next(card for card in room.scene_fragments["p4"] if card["id"] != "attack")
    assert room.submit_theory("p4", "p1", clue["id"], fragment["id"], 1) is None
    room._finish("citizen")
    resolved = room._state_for(room.players["p4"])["theory_board"][-1]
    assert resolved["status"] == "confirmed"
    old_score = room.players["p4"].score
    room._finish("mafia")
    assert room.winner == "citizen"
    assert room.players["p4"].score == old_score


def test_quiet_later_night_does_not_offer_an_incompatible_old_theory():
    room = daylight_room()
    old_clue = room.clues[-1]
    room.round = 2
    room.actions.clear()
    room._set_phase("night", 20)
    room._resolve_night()
    room._advance()
    state = room._state_for(room.players["p4"])
    assert state["me"]["can_theorize"] is False
    fragment = room.scene_fragments["p4"][0]
    assert "같은 밤" in room.submit_theory("p4", "p1", old_clue["id"], fragment["id"], 1)
    assert room.theory_stakes["p4"] == 2
