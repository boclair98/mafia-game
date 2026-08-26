"""Tests for the sealed Chain of Evidence hypothesis loop."""

from app.game import Player, Room


def player(pid: str, role: str = "citizen") -> Player:
    return Player(
        id=pid,
        key=f"key-{pid}-12345678",
        nick=pid.upper(),
        coders_id=None,
        ws=None,
        role=role,
    )


def prepared_room() -> Room:
    room = Room("theory-test")
    for pid, role in (("p1", "mafia"), ("p2", "doctor"), ("p3", "detective"), ("p4", "citizen")):
        room.players[pid] = player(pid, role)
    room.host_id = "p1"
    room.round = 1
    room.phase = "day"
    room.theory_stakes = {pid: 2 for pid in room.players}
    room.scene_fragments["p4"] = [
        {"id": "attack", "time": "00:40", "title": "습격의 흔적", "detail": "실제 공격 흔적"},
        {"id": "alibi", "time": "00:41", "title": "알리바이 신호", "detail": "통화 기록"},
    ]
    room.clues.append({
        "id": "clue-1",
        "code": "E-01-01",
        "round": 1,
        "title": "불완전한 지문",
        "detail": "P1 · P2 중 한 명의 기록과 유사합니다.",
        "outcome": "사망 사건",
        "suspect_ids": ["p1", "p2"],
        "suspects": ["P1", "P2"],
    })
    return room


def test_theory_requires_owned_fragment_and_matching_clue():
    room = prepared_room()

    assert room.submit_theory("p4", "p3", "clue-1", "attack", 1) == "선택한 감식 단서는 그 용의자를 가리키지 않습니다."
    assert room.submit_theory("p4", "p1", "clue-1", "not-owned", 1) == "당신이 받은 시간 조각만 증거 연결에 사용할 수 있습니다."
    assert room.submit_theory("p4", "p1", "clue-1", "attack", 1) is None
    assert room.theory_stakes["p4"] == 1
    assert "status" not in room._state_for(room.players["p1"])["theory_board"][0]
    assert room.submit_theory("p4", "p1", "clue-1", "attack", 1) == "이번 낮의 증거 연결 고리는 이미 봉인했습니다."


def test_theory_resolves_at_gameover_and_rewards_a_confirmed_chain():
    room = prepared_room()
    assert room.submit_theory("p4", "p1", "clue-1", "attack", 2) is None

    room._finish("citizen")

    board = room._state_for(room.players["p4"])["theory_board"]
    assert board[0]["status"] == "confirmed"
    assert board[0]["matched_links"] == 3
    assert board[0]["total_links"] == 3
    assert "실제 마피아" in board[0]["explanation"]
    assert room.players["p4"].score >= 140
    assert any(badge["id"] == "chain-link" for badge in room.case_badges)


def test_partial_chain_is_public_only_after_case_closes():
    room = prepared_room()
    assert room.submit_theory("p4", "p2", "clue-1", "attack", 1) is None

    during_match = room._state_for(room.players["p4"])["theory_board"][0]
    assert "matched_links" not in during_match
    room._finish("citizen")

    resolved = room._state_for(room.players["p4"])["theory_board"][0]
    assert resolved["status"] == "partial"
    assert resolved["matched_links"] == 2
