"""Focused tests for the server-authoritative trial and room controls."""

import asyncio
import json
import time

from app.game import Player, Room, RoomManager


def player(pid: str, role: str = "citizen", *, bot: bool = False) -> Player:
    return Player(
        id=pid,
        key=f"key-{pid}-12345678",
        nick=pid.upper(),
        coders_id=None,
        ws=None,
        role=role,
        ready=bot,
        is_bot=bot,
    )


def room_with(*roles: str) -> Room:
    room = Room("trial-test")
    for index, role in enumerate(roles):
        participant = player(f"p{index + 1}", role)
        room.players[participant.id] = participant
    room.host_id = "p1"
    return room


def test_unique_vote_opens_defense_without_immediate_execution():
    room = room_with("mafia", "doctor", "detective", "citizen", "citizen")
    room.phase = "vote"
    room.votes = {"p1": "p5", "p2": "p5", "p3": "p1", "p4": "p5"}

    room._resolve_vote()

    assert room.phase == "defense"
    assert room.accused_id == "p5"
    assert room.players["p5"].alive is True
    assert "최후 변론" in room.case_log[-1]


def test_tied_vote_skips_trial_and_keeps_everyone_alive():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.phase = "vote"
    room.votes = {"p1": "p3", "p2": "p3", "p3": "p1", "p4": "p1"}

    room._resolve_vote()

    assert room.phase == "result"
    assert room.accused_id is None
    assert all(participant.alive for participant in room.players.values())


def test_only_accused_can_speak_during_final_defense():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.phase = "defense"
    room.accused_id = "p4"

    assert "피고인만" in room.add_chat("p2", "제가 말할게요")
    assert room.add_chat("p4", "제 행동을 다시 확인해 주세요") is None
    assert room.chat[-1]["from"] == "P4"


def test_execute_majority_hides_role_until_game_over_and_moves_to_result():
    room = room_with("mafia", "doctor", "detective", "citizen", "citizen", "citizen")
    room.phase = "verdict"
    room.accused_id = "p6"
    room.judgements = {"p1": True, "p2": True, "p3": True, "p4": False}

    room._resolve_verdict()

    assert room.players["p6"].alive is False
    assert room.phase == "result"
    assert "사건이 끝날 때까지 공개되지 않습니다" in room.case_log[-1]
    assert room._state_for(room.players["p1"])["players"][-1]["role"] is None


def test_tie_in_final_judgement_spares_accused():
    room = room_with("mafia", "doctor", "detective", "citizen", "citizen")
    room.phase = "verdict"
    room.accused_id = "p5"
    room.judgements = {"p1": True, "p2": True, "p3": False, "p4": False}

    room._resolve_verdict()

    assert room.players["p5"].alive is True
    assert room.phase == "result"
    assert "석방" in room.case_log[-1]


def test_executed_trickster_wins_immediately():
    room = room_with("mafia", "doctor", "detective", "citizen", "trickster")
    room.round = 1
    room.phase = "verdict"
    room.accused_id = "p5"
    room.judgements = {"p1": True, "p2": True, "p3": True, "p4": False}

    room._resolve_verdict()

    assert room.phase == "gameover"
    assert room.winner == "trickster"
    assert room.players["p5"].score == 103


def test_ready_gate_names_unprepared_human():
    room = room_with("citizen", "citizen", "citizen", "citizen")
    room.players["p2"].ready = True
    room.players["p3"].ready = True

    error = room.start("p1")

    assert error is not None and "P4" in error
    assert room.phase == "lobby"


def test_bot_target_can_grow_and_shrink_room():
    room = room_with("citizen")
    room.fill_bots("p1", 8)
    assert len(room.players) == 8
    assert sum(participant.is_bot for participant in room.players.values()) == 7

    room.fill_bots("p1", 4)
    assert len(room.players) == 4
    assert sum(participant.is_bot for participant in room.players.values()) == 3


def test_bots_are_playable_seats_but_not_live_human_connections():
    room = room_with("citizen")
    room.fill_bots("p1", 4)
    assert len(room.connected_players) == 1
    assert len(room.lobby_seats) == 4
    assert room.start("p1") is None
    assert room.phase == "reveal"


def test_solo_start_builds_a_full_case_with_distinct_ai_personas():
    room = room_with("citizen")

    assert room.solo_start("p1") is None
    assert room.phase == "reveal"
    assert len(room.players) == 8
    bots = [participant for participant in room.players.values() if participant.is_bot]
    assert len(bots) == 7
    assert len({participant.bot_profile for participant in bots}) == 7
    state = room._state_for(room.players["p1"])
    assert state["mode"] == "solo"
    assert all(player["bot_persona"] for player in state["players"] if player["bot"])
    assert all(player["role"] is None for player in state["players"])


def test_reactions_are_phase_limited_whitelisted_and_rate_limited():
    room = room_with("citizen", "citizen", "citizen", "citizen")
    room.phase = "day"
    assert room.add_reaction("p1", "🔥") is not None
    assert room.add_reaction("p1", "👀") is None
    assert room.add_reaction("p1", "👍") is None
    assert len(room.reactions) == 1

    room.phase = "night"
    room.players["p2"].last_reaction_at = 0
    assert room.add_reaction("p2", "👍") is not None


def test_bot_vote_follows_its_public_suspicion_without_targeting_mafia_team():
    room = room_with("mafia", "mafia", "doctor", "citizen", "citizen", "citizen", "citizen")
    room.players["p1"].is_bot = True
    room.players["p1"].connected = False
    room._bot_suspicions["p1"] = "p5"
    room.phase = "vote"

    room._run_bots()

    assert room.votes["p1"] == "p5"


def test_decision_progress_requires_every_eligible_living_player():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.phase = "vote"
    room.votes = {"p1": "p2", "p2": "p1", "p3": "p1"}
    assert room._decision_progress() == (3, 4)
    assert room._decisions_complete() is False
    room.votes["p4"] = "p1"
    assert room._decisions_complete() is True

    room.phase = "verdict"
    room.accused_id = "p4"
    room.judgements = {"p1": True, "p2": False, "p3": True}
    assert room._decision_progress() == (3, 3)
    assert room._decisions_complete() is True


def test_complete_match_keeps_secrets_private_and_reaches_citizen_win():
    room = room_with("mafia", "doctor", "detective", "citizen", "citizen")
    room.round = 1
    room.phase = "night"
    assert room.add_chat("p1", "P5를 습격합니다") is None
    room.actions = {"p1": "p5", "p2": "p2", "p3": "p1"}

    room._resolve_night()
    assert room.players["p5"].alive is False
    assert room.case_log[-1] == "P5님이 죽었습니다."
    assert room.phase == "dawn"
    assert "마피아입니다" in room.players["p3"].intel[-1]
    assert room._state_for(room.players["p1"])["chat"][-1]["text"] == "P5를 습격합니다"
    assert room._state_for(room.players["p2"])["chat"] == []
    assert room._state_for(room.players["p2"])["me"]["intel"] == []

    room._advance()  # dawn -> day
    room._advance()  # day -> vote
    room.votes = {"p1": "p2", "p2": "p1", "p3": "p1", "p4": "p1"}
    room._advance()  # vote -> defense
    assert room.accused_id == "p1"
    room._advance()  # defense -> verdict
    room.judgements = {"p2": True, "p3": True, "p4": True}
    room._advance()  # verdict -> gameover

    assert room.phase == "gameover"
    assert room.winner == "citizen"
    assert room.players["p1"].alive is False
    assert all(item["role"] for item in room._state_for(room.players["p2"])["players"])


def test_voice_presence_and_signaling_stay_inside_the_room():
    class FakeSocket:
        def __init__(self) -> None:
            self.messages: list[str] = []

        async def send_text(self, payload: str) -> None:
            self.messages.append(payload)

    room = room_with("mafia", "doctor", "detective", "citizen")
    socket = FakeSocket()
    room.players["p2"].ws = socket
    assert room.set_voice_presence("p1", True) is None
    assert room.set_voice_presence("p2", True) is None
    assert room._state_for(room.players["p1"])["players"][0]["voice"] is True

    signal = {"kind": "candidate", "candidate": {"candidate": "test"}}
    assert asyncio.run(room.relay_voice("p1", "p2", signal)) is None
    payload = json.loads(socket.messages[-1])
    assert payload == {"t": "voice_signal", "from": "p1", "data": signal}


def test_day_interrogation_records_claim_questions_and_private_reads():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.round = 1
    room.phase = "day"
    room.phase_started_at = time.time()
    room.deadline = room.phase_started_at + 96
    room._start_interrogation()

    assert room.speaker_id == "p1"
    assert room.add_claim("p1", "저는 시민이고 P3의 주장이 이상합니다") is None
    assert room.add_question("p2", "어젯밤 누구를 선택했나요?") is None
    assert room.submit_read("p2", "p1", "suspect") is None

    state = room._state_for(room.players["p2"])
    assert state["me"]["reads"] == {"p1": "suspect"}
    assert state["questions"][-1]["from"] == "P2"
    assert state["claims"][-1]["speaker"] == "P1"
    assert state["read_summary"] == {}

    room.phase = "vote"
    summary = room._state_for(room.players["p2"])["read_summary"]
    assert summary["p1"]["suspect"] == 1


def test_day_discussion_allows_every_living_player_to_talk_while_spotlight_rotates():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.round = 1
    room.phase = "day"
    room.phase_started_at = time.time()
    room.deadline = room.phase_started_at + 96
    room._start_interrogation()

    assert room.speaker_id == "p1"
    assert room.add_chat("p2", "저도 공개 토론에 참여합니다") is None
    assert room.chat[-1]["from"] == "P2"
    room.players["p4"].alive = False
    assert "사망자" in room.add_chat("p4", "유령 발언")


def test_anonymous_tip_is_one_per_player_per_day_and_never_exposes_author():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.round = 1
    room.phase = "day"

    assert room.add_tip("p2", "사건 시각과 출입 기록이 맞지 않습니다") is None
    assert "이미 봉인" in room.add_tip("p2", "두 번째 제보")
    assert room.tips[-1]["text"] == "사건 시각과 출입 기록이 맞지 않습니다"
    state = room._state_for(room.players["p1"])
    assert state["tips"][-1]["text"] == "사건 시각과 출입 기록이 맞지 않습니다"
    assert "from" not in state["tips"][-1]
    assert state["me"]["can_tip"] is True

    room.players["p3"].alive = False
    assert "생존자" in room.add_tip("p3", "유령 제보")


def test_ballot_feed_stays_sealed_until_trial_and_persists_through_result():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.phase = "vote"
    room.votes = {"p1": "p4", "p2": "p4", "p3": "p1"}

    state = room._state_for(room.players["p2"])
    assert state["ballot_feed"] == []
    assert all(player["votes"] == 0 for player in state["players"])
    room._resolve_vote()
    assert room.phase == "defense"
    revealed = room._state_for(room.players["p2"])["ballot_feed"]
    assert revealed[0] == {
        "voter_id": "p1", "voter": "P1", "target_id": "p4", "target": "P4"
    }
    assert len(revealed) == 3
    defense_state = room._state_for(room.players["p2"])
    assert next(player for player in defense_state["players"] if player["id"] == "p4")["votes"] == 2


def test_private_leads_are_isolated_and_can_be_publicly_revealed_once():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.round = 1
    room.private_leads = {
        "p1": {
            "id": "lead-p1",
            "title": "봉인 훼손 감정",
            "detail": "P3님의 좌석 주변에서 왁스 조각이 발견됐습니다.",
            "suspect_id": "p3",
            "revealed": False,
            "authentic": False,
        },
        "p2": {
            "id": "lead-p2",
            "title": "출입 시각 기록",
            "detail": "P1님의 출입 기록이 사건 시각과 겹칩니다.",
            "suspect_id": "p1",
            "revealed": False,
            "authentic": True,
        },
    }
    room.phase = "day"

    p1_state = room._state_for(room.players["p1"])
    p2_state = room._state_for(room.players["p2"])
    assert p1_state["me"]["private_lead"]["id"] == "lead-p1"
    assert p2_state["me"]["private_lead"]["id"] == "lead-p2"
    assert "authentic" not in p1_state["me"]["private_lead"]
    assert p1_state["public_leads"] == []

    assert room.reveal_private_lead("p2", "lead-p1") == "공개할 수 없는 증거입니다."
    assert room.reveal_private_lead("p1", "lead-p1") is None
    assert room.reveal_private_lead("p1", "lead-p1") == "이미 공개한 증거입니다."

    public = room._state_for(room.players["p2"])["public_leads"][0]
    assert public == {
        "id": "lead-p1",
        "owner_id": "p1",
        "owner": "P1",
        "title": "봉인 훼손 감정",
        "detail": "P3님의 좌석 주변에서 왁스 조각이 발견됐습니다.",
        "round": 1,
        "suspect_id": "p3",
    }
    assert "authentic" not in public
    assert room.case_log[-1] == "봉인 증거 공개 — P1: 봉인 훼손 감정"


def test_private_lead_reveal_requires_a_living_player_during_day():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.private_leads["p2"] = {
        "id": "lead-p2",
        "title": "출입 시각 기록",
        "detail": "P1님의 출입 기록이 사건 시각과 겹칩니다.",
        "suspect_id": "p1",
        "revealed": False,
        "authentic": True,
    }

    room.phase = "night"
    assert "낮 토론" in room.reveal_private_lead("p2", "lead-p2")
    room.phase = "day"
    room.players["p2"].alive = False
    assert "생존자" in room.reveal_private_lead("p2", "lead-p2")
    assert list(room.public_leads) == []


def test_start_deals_one_private_lead_per_playable_seat_without_truth_marker():
    room = room_with("citizen")
    room.fill_bots("p1", 4)

    assert room.start("p1") is None
    assert set(room.private_leads) == set(room.players)
    for participant in room.players.values():
        lead = room._state_for(participant)["me"]["private_lead"]
        assert lead is not None
        assert lead["suspect_id"] != participant.id
        assert lead["suspect_id"] in room.players
        assert "authentic" not in lead


def test_dead_player_can_predict_a_living_mafia_and_result_stays_private_until_end():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.round = 1
    room.phase = "day"
    room.players["p4"].alive = False

    room.players["p1"].alive = False
    assert "마피아" in room.ghost_predict("p1", "p2")
    room.players["p1"].alive = True

    assert "사망한 플레이어" in room.ghost_predict("p2", "p1")
    assert "생존한 용의자" in room.ghost_predict("p4", "p4")
    assert room.ghost_predict("p4", "p1") is None

    during_match = room._state_for(room.players["p4"])["me"]
    assert during_match["ghost_prediction"] == "p1"
    assert during_match["ghost_correct"] is False
    assert room._state_for(room.players["p2"])["me"]["ghost_prediction"] is None
    assert "보너스 15점" in room._guide_for(room.players["p4"])

    room._finish("citizen")
    at_gameover = room._state_for(room.players["p4"])["me"]
    assert at_gameover["ghost_prediction"] == "p1"
    assert at_gameover["ghost_correct"] is True
    assert room.players["p4"].score == 118
    assert "지금" in room.ghost_predict("p4", "p1")


def test_night_victim_can_leave_one_public_will_at_dawn():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.round = 1
    room.phase = "night"
    room.actions = {"p1": "p4", "p2": "p2", "p3": "p1"}

    room._resolve_night()

    assert room.phase == "dawn"
    assert room._state_for(room.players["p4"])["me"]["can_leave_will"] is True
    assert room.leave_will("p4", "P2는 믿어도 됩니다") is None
    assert room.case_log[-1] == "마지막 유언 — P4: P2는 믿어도 됩니다"
    assert room.leave_will("p4", "두 번째 유언") == "유언은 한 번만 남길 수 있습니다."


def test_forensic_clue_always_includes_the_real_attacker_without_revealing_one_answer():
    room = room_with("mafia", "doctor", "detective", "citizen", "citizen")
    room.round = 1
    room.phase = "night"
    room.actions = {"p1": "p5", "p2": "p2", "p3": "p4"}

    room._resolve_night()

    clue = room.clues[-1]
    assert "p1" in clue["suspect_ids"]
    assert len(clue["suspect_ids"]) == 3
    assert "P1" in clue["detail"]
    assert room._state_for(room.players["p2"])["clues"][-1]["id"] == clue["id"]


def test_match_exposes_a_curated_case_profile_and_chat_sender_id():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.phase = "day"
    room.players["p1"].last_chat_at = 0
    assert room.add_chat("p1", "현장 기록을 확인했습니다") is None

    state = room._state_for(room.players["p2"])
    assert state["case_profile"]["code"].startswith("BM-")
    assert state["case_profile"]["briefing"]
    assert state["chat"][-1]["from_id"] == "p1"


def test_player_report_is_validated_and_recorded_without_public_broadcast():
    room = room_with("mafia", "doctor", "detective", "citizen")
    assert room.report_player("p1", "p1", "스팸") is not None
    assert room.report_player("p1", "p2", "") is not None
    assert room.report_player("p1", "p2", "괴롭힘 또는 혐오 발언") is None
    assert room.reports[-1]["target_id"] == "p2"
    assert "reports" not in room._state_for(room.players["p1"])


def test_rematch_erases_previous_public_and_mafia_chat():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.phase = "gameover"
    room.chat.extend([
        {"id": "a", "from": "P1", "text": "secret", "visibility": "mafia", "at": 1},
        {"id": "b", "from": "P2", "text": "public", "visibility": "all", "at": 2},
    ])
    room.private_leads["p1"] = {"id": "old-private-lead"}
    room.public_leads.append({"id": "old-public-lead"})
    room.ghost_predictions["p4"] = "p1"

    assert room.rematch("p1") is None
    assert room.phase == "lobby"
    assert list(room.chat) == []
    assert room.private_leads == {}
    assert list(room.public_leads) == []
    assert room.ghost_predictions == {}


def test_public_presence_counts_humans_without_exposing_bot_seats():
    manager = RoomManager()
    room = manager.get("presence")
    room.players["human"] = player("human")
    room.players["bot"] = player("bot", bot=True)
    room.players["bot"].connected = False
    assert manager.online == 1
    assert manager.room_count == 1
    assert manager.active_matches == 0
    room.phase = "night"
    assert manager.active_matches == 1


def test_match_draws_a_round_event_and_exposes_it_to_every_player():
    room = room_with("citizen")
    room.fill_bots("p1", 4)

    assert room.start("p1") is None
    assert room.round_event is not None
    assert room.round_event["id"]
    state = room._state_for(room.players["p1"])
    assert state["round_event"]["title"] == room.round_event["title"]
    assert "자정 사건 카드" in " ".join(room.case_log)


def test_blackout_seals_pressure_until_vote_and_limits_one_mark_per_day():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.round = 1
    room.phase = "day"
    room.round_event = {
        "id": "blackout", "title": "기록실 정전", "tag": "SEALED PRESSURE",
        "copy": "봉인됩니다.", "sealed_pressure": True,
    }

    assert room.apply_pressure("p2", "p1") is None
    assert "이미 사용" in room.apply_pressure("p2", "p3")
    day_state = room._state_for(room.players["p3"])
    assert day_state["pressure_counts"] == {}
    assert day_state["pressure_progress"] == {
        "completed": 1, "total": 4, "sealed": True,
    }

    room._advance()
    vote_state = room._state_for(room.players["p3"])
    assert room.phase == "vote"
    assert vote_state["pressure_counts"] == {"p1": 1}
    assert "P2님이 P1님을 지목" in " ".join(room.case_log)


def test_endgame_awards_and_pressure_bonus_reflect_real_actions():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.round = 1
    room.phase = "day"
    room.pressure_marks = {"1:p2": "p1"}
    room.questions.append({
        "id": "q1", "from": "P2", "from_id": "p2", "speaker_id": "p3",
        "text": "행동 대상은?", "round": 1, "at": 1,
    })
    room.claims.append({
        "id": "c1", "speaker_id": "p3", "speaker": "P3",
        "text": "P1을 조사했습니다.", "round": 1, "at": 1,
    })

    room._finish("citizen")

    assert room.players["p2"].score == 129
    assert {award["title"] for award in room.awards} >= {
        "질문 폭격기", "기록 설계자", "붉은 실의 주인",
    }
    assert room._state_for(room.players["p2"])["awards"] == room.awards


def test_only_host_can_remove_another_lobby_seat():
    room = room_with("citizen", "citizen", "citizen", "citizen")
    assert room.remove_lobby_seat("p2", "p3") is not None
    assert room.remove_lobby_seat("p1", "p1") is not None
    assert room.remove_lobby_seat("p1", "p4") is None
    assert "p4" not in room.players
    assert "방장" in room.case_log[-1]
