"""Focused tests for the server-authoritative trial and room controls."""

import asyncio
import json
import time

import pytest
from app.game import (
    CASE_TIMELINE,
    CASE_TIMELINE_LAYOUTS,
    Player,
    Room,
    RoomCapacityError,
    RoomManager,
)


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


@pytest.mark.parametrize("phase,method,args,storage", [
    ("night", "act", ("p1", "p4"), "actions"),
    ("vote", "vote", ("p1", "p4"), "votes"),
    ("verdict", "judge", ("p1", True), "judgements"),
])
def test_decisions_close_at_deadline_before_ticker_runs(monkeypatch, phase, method, args, storage):
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.phase = phase
    room.deadline = 100.0
    room.accused_id = "p4"
    monkeypatch.setattr("app.game.time.time", lambda: 99.999)
    assert getattr(room, method)(*args) is None
    original = dict(getattr(room, storage))
    monkeypatch.setattr("app.game.time.time", lambda: 100.0)
    changed_args = ("p1", False) if method == "judge" else ("p1", "p2")
    assert getattr(room, method)(*changed_args) is not None
    assert getattr(room, storage) == original


@pytest.mark.parametrize("phase", ["lobby", "night"])
async def test_stale_socket_departure_preserves_resumed_seat(phase):
    room = room_with("citizen", "citizen", "citizen", "citizen")
    old_socket, new_socket = object(), object()
    room.players["p1"].ws = old_socket
    room.phase = phase
    resumed, was_resumed = room.join(new_socket, "P1", None, room.players["p1"].key)
    assert was_resumed is True
    assert room.leave("p1", old_socket) is False
    assert room.players["p1"] is resumed
    assert resumed.connected is True
    assert resumed.ws is new_socket
    assert room.host_id == "p1"
    assert room.leave("p1", new_socket) is True


@pytest.mark.parametrize("resumed", [False, True])
async def test_failed_broadcast_preserves_latest_socket_cleanup_authority(resumed):
    class FailedSocket:
        async def send_text(self, payload):
            raise RuntimeError("connection closed")

    manager = RoomManager()
    room = manager.get("cleanup-regression")
    original = FailedSocket()
    current = FailedSocket() if resumed else original
    participant, _ = room.join(original, "확인", None, "cleanup-test-key")
    if resumed:
        room.join(current, "확인", None, participant.key)
    await room.broadcast()
    assert participant.ws is None
    assert participant.connected is False
    assert participant.socket_owner is current
    if resumed:
        assert room.leave(participant.id, original) is False
        assert participant.id in room.players
    assert room.leave(participant.id, current) is True
    manager.sweep(room.name)
    assert manager.find(room.name) is None
    assert participant.socket_owner is None


@pytest.mark.parametrize("orphan_host", [None, "bot", "disconnected"])
async def test_existing_gameover_seat_restores_orphan_host_and_can_rematch(orphan_host):
    room = room_with("citizen", "mafia", "doctor", "citizen")
    room.phase = "gameover"
    for participant in room.players.values():
        participant.connected = False
    room.players["p2"].is_bot = orphan_host == "bot"
    room.players["p2"].connected = orphan_host == "bot"
    room.host_id = "p2" if orphan_host else None
    resumed, restored = room.join(object(), "P1", None, room.players["p1"].key)
    assert restored is True
    assert room.host_id == resumed.id
    assert room._state_for(resumed)["host"] == resumed.id
    assert room.rematch(resumed.id) is None
    assert room.phase == "lobby"


async def test_resuming_previous_host_does_not_displace_current_connected_host():
    room = room_with("citizen", "mafia", "doctor", "citizen")
    room.phase = "gameover"
    room.players["p1"].connected = False
    room.host_id = "p2"
    room.join(object(), "P1", None, room.players["p1"].key)
    assert room.host_id == "p2"
    assert room.rematch("p1") is not None
    assert room.rematch("p2") is None


async def test_resuming_spectator_never_becomes_orphan_room_host():
    room = room_with("citizen", "spectator")
    room.phase = "gameover"
    room.players["p1"].connected = False
    room.players["p2"].alive = False
    room.host_id = None
    room.join(object(), "P2", None, room.players["p2"].key)
    assert room.host_id is None
    assert room.rematch("p2") is not None


def test_host_departure_does_not_promote_connected_spectator():
    room = room_with("citizen", "spectator", "citizen")
    room.phase = "gameover"
    room.players["p2"].alive = False
    room.players["p3"].connected = False
    assert room.leave("p1") is True
    assert room.host_id is None


@pytest.mark.parametrize("role", ["citizen", "mafia", "spectator"])
def test_dead_players_cannot_post_public_ballot_chat(role):
    room = room_with("mafia", "doctor", "detective", role)
    room.phase = "vote"
    room.players["p4"].alive = False
    assert room.add_chat("p4", "생존자에게 전달할 비밀") is not None
    assert list(room.chat) == []
    assert room.add_chat("p2", "투표 근거를 확인합니다") is None
    assert room._state_for(room.players["p1"])["chat"][-1]["from_id"] == "p2"


def test_doctor_resolves_before_mafia_kill():
    room = room_with("mafia", "doctor", "detective", "citizen", "citizen")
    room.phase = "night"
    assert room.act("p1", "p4") is None
    assert room.act("p2", "p4") is None
    room._resolve_night()
    assert room.players["p4"].alive is True
    assert room.last_death_id is None
    assert room.phase == "dawn"


def test_case_timeline_layouts_keep_the_same_anchors_but_change_causality():
    anchor_ids = {fragment["id"] for fragment in CASE_TIMELINE}
    assert len(CASE_TIMELINE_LAYOUTS) >= 4
    assert CASE_TIMELINE_LAYOUTS[0]["id"] == "canonical"
    assert len({tuple(layout["order"]) for layout in CASE_TIMELINE_LAYOUTS}) == len(CASE_TIMELINE_LAYOUTS)

    for layout in CASE_TIMELINE_LAYOUTS:
        order = layout["order"]
        assert len(order) == len(anchor_ids)
        assert set(order) == anchor_ids
        assert len(layout["clock"]) == len(order)
        assert layout["chain_label"].count("→") == len(order) - 1


def test_general_case_start_selects_a_server_owned_timeline_layout():
    room = room_with("mafia", "doctor", "detective", "citizen")
    for participant in room.players.values():
        participant.ready = True

    assert room.start("p1") is None
    solution = room.case_solution
    assert solution["layout_id"] in {layout["id"] for layout in CASE_TIMELINE_LAYOUTS}
    assert [card["id"] for card in solution["timeline"]] == solution["order"]
    assert set(solution["links"]) == set(solution["order"][:-1])


def test_unique_vote_opens_defense_without_immediate_execution():
    room = room_with("mafia", "doctor", "detective", "citizen", "citizen")
    room.phase = "vote"
    room.votes = {"p1": "p5", "p2": "p5", "p3": "p1", "p4": "p5"}

    room._resolve_vote()

    assert room.phase == "defense"
    assert room.accused_id == "p5"
    assert room.players["p5"].alive is True
    assert "최후 변론" in room.case_log[-1]


def test_skip_is_a_sealed_completed_ballot_and_not_a_candidate():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.phase = "vote"
    assert room.vote("p1", "skip") is None
    assert room.vote("p2", "skip") is None
    assert room.vote("p3", "skip") is None
    assert room.vote("p4", "p1") is None
    state = room._state_for(room.players["p1"])
    assert state["me"]["vote_target"] == "skip"
    assert state["decision_progress"] == {"completed": 4, "total": 4}
    assert state["ballot_feed"] == []
    assert state["skip_votes"] == 0
    room._resolve_vote()
    assert room.phase == "defense"
    assert room.accused_id == "p1"
    revealed = room._state_for(room.players["p2"])
    assert revealed["skip_votes"] == 3
    assert revealed["ballot_feed"][0]["target"] == "기권"
    assert revealed["ballot_feed"][0]["target_id"] == "skip"
    assert "기권 3표" in room.case_log[-1]


@pytest.mark.parametrize("ballots", [
    {"p1": "skip", "p2": "skip", "p3": "skip", "p4": "skip"},
    {"p1": "p2", "p2": "p1", "p3": "skip", "p4": "skip"},
])
def test_all_skip_and_tied_target_ballots_have_no_accused(ballots):
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.phase = "vote"
    room.votes = ballots
    room._resolve_vote()
    assert room.phase == "result"
    assert room.accused_id is None
    assert all(participant.alive for participant in room.players.values())


def test_skip_keeps_voter_authority_and_deadline_rules():
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.phase = "vote"
    room.players["p2"].alive = False
    assert room.vote("p2", "skip") is not None
    room.deadline = time.time() - 1
    assert room.vote("p1", "skip") is not None
    assert room.votes == {}


@pytest.mark.parametrize("phase", ["night", "day", "vote", "gameover"])
def test_ghost_chat_never_reaches_alive_players_even_at_game_over(phase):
    room = room_with("mafia", "doctor", "mafia", "citizen", "spectator")
    room.phase = phase
    room.players["p3"].alive = False
    room.players["p4"].alive = False
    room.players["p5"].alive = False
    assert room.add_ghost_chat("p1", "살아있는 마피아") is not None
    assert room.add_ghost_chat("p2", "살아있는 시민") is not None
    assert room.add_ghost_chat("p3", "사망한 마피아") is None
    assert room.add_ghost_chat("p4", "사망한 시민") is None
    assert room.add_ghost_chat("p5", "관전자") is None
    assert list(room.chat) == []
    for pid in ("p1", "p2"):
        assert room._state_for(room.players[pid])["ghost_chat"] == []
    for pid in ("p3", "p4", "p5"):
        assert len(room._state_for(room.players[pid])["ghost_chat"]) == 3


def test_ghost_chat_throttle_size_bound_and_rematch_clear(monkeypatch):
    room = room_with("mafia", "doctor", "detective", "citizen")
    room.phase = "day"
    ghost = room.players["p4"]
    ghost.alive = False
    monkeypatch.setattr("app.game.time.time", lambda: 100.0)
    assert room.add_ghost_chat("p4", "  기록  " + "가" * 200) is None
    assert len(room.ghost_chat[-1]["text"]) == 160
    monkeypatch.setattr("app.game.time.time", lambda: 100.449)
    assert room.add_ghost_chat("p4", "너무 빠름") is not None
    monkeypatch.setattr("app.game.time.time", lambda: 100.45)
    assert room.add_ghost_chat("p4", "정상 간격") is None
    for index in range(81):
        ghost.last_chat_at = 0
        assert room.add_ghost_chat("p4", f"기록 {index}") is None
    assert len(room.ghost_chat) == 80
    assert room.ghost_chat[-1]["text"] == "기록 80"
    room.phase = "gameover"
    assert room.rematch("p1") is None
    assert list(room.ghost_chat) == []
    assert room.add_ghost_chat("p4", "이전 게임 유령") is not None


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
    scope = room._state_for(room.players["p1"])["voice_scope"]
    assert asyncio.run(room.relay_voice("p1", "p2", signal, scope)) is None
    payload = json.loads(socket.messages[-1])
    assert payload == {"t": "voice_signal", "from": "p1", "data": signal, "scope": scope}


@pytest.mark.parametrize("kind", ["offer", "answer", "candidate"])
@pytest.mark.parametrize("phase,sender_id,target_id,allowed", [
    ("day", "p1", "p2", True),
    ("day", "p1", "p4", False),
    ("night", "p1", "p5", True),
    ("night", "p1", "p2", False),
    ("night", "p4", "p5", False),
    ("night", "p4", "p6", True),
    ("verdict", "p1", "p5", False),
])
async def test_voice_signals_and_presence_are_filtered_by_channel(kind, phase, sender_id, target_id, allowed):
    class FakeSocket:
        def __init__(self):
            self.messages = []

        async def send_text(self, payload):
            self.messages.append(json.loads(payload))

    room = room_with("mafia", "doctor", "detective", "mafia", "mafia", "spectator")
    room.players["p4"].alive = False
    room.players["p6"].alive = False
    for participant in room.players.values():
        participant.ws = FakeSocket()
        participant.voice = True
    room._set_phase(phase, 30)
    state = room._state_for(room.players[sender_id])
    signal = (
        {"kind": "candidate", "candidate": {"candidate": "test"}}
        if kind == "candidate" else
        {"kind": "description", "description": {"type": kind, "sdp": "test"}}
    )
    error = await room.relay_voice(sender_id, target_id, signal, state["voice_scope"])
    assert (error is None) is allowed
    visible_target = next(p for p in state["players"] if p["id"] == target_id)
    assert visible_target["voice"] is allowed
    assert bool(room.players[target_id].ws.messages) is allowed


async def test_voice_scope_expires_on_phase_change_and_reconnection():
    class FakeSocket:
        async def send_text(self, payload):
            pass

    room = room_with("mafia", "mafia", "doctor", "citizen")
    for participant in room.players.values():
        participant.ws = FakeSocket()
        participant.voice = True
    room._set_phase("day", 30)
    before = room._state_for(room.players["p1"])["voice_scope"]
    signal = {"kind": "candidate", "candidate": {"candidate": "test"}}
    room._set_phase("night", 30)
    current = room._state_for(room.players["p1"])["voice_scope"]
    assert current != before
    assert await room.relay_voice("p1", "p2", signal, before) is not None
    assert await room.relay_voice("p1", "p2", signal) is not None
    assert await room.relay_voice("p1", "p2", signal, current) is None
    room.join(FakeSocket(), "P2", None, room.players["p2"].key)
    assert room.players["p2"].voice is False
    assert room._state_for(room.players["p1"])["voice_scope"] != current
    assert await room.relay_voice("p1", "p2", signal, current) is not None


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


async def test_broadcast_suppresses_duplicate_snapshots_but_replays_changes(monkeypatch):
    class FakeSocket:
        def __init__(self):
            self.frames: list[str] = []

        async def send_text(self, payload: str):
            self.frames.append(payload)

    room = Room("broadcast-test")
    socket = FakeSocket()
    room.join(socket, "Smoke", None, "broadcast-key-1234")

    monkeypatch.setattr("app.game.time.time", lambda: 100.0)
    await room.broadcast()
    assert json.loads(socket.frames[-1])["server_now"] == 100000
    monkeypatch.setattr("app.game.time.time", lambda: 101.0)
    await room.broadcast()
    assert len(socket.frames) == 1

    room._record("상태 변경")
    await room.broadcast()
    assert len(socket.frames) == 2


def test_room_manager_rejects_new_rooms_at_process_limit():
    manager = RoomManager(max_rooms=1)
    manager.get("capacity-one")
    try:
        manager.get("capacity-two")
    except RoomCapacityError:
        pass
    else:
        raise AssertionError("room capacity should reject the second room")
