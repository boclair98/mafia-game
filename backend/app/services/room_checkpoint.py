"""Versioned, allowlisted JSON codec for private game state, never pickle."""

from __future__ import annotations

import json
import math
import re
import time
from collections import deque
from dataclasses import fields
from uuid import UUID

SCHEMA_VERSION = 1
MAX_CHECKPOINT_BYTES = 2_000_000

# An explicit contract prevents newly added tasks/sockets/caches from silently
# entering persistence. New durable fields require a codec/schema migration.
ROOM_FIELDS = (
    "name lobby_mode host_id phase phase_id round deadline phase_started_at winner mode case_mode "
    "actions votes accused_id judgements reads wills interrogation_order speaker_id speaker_deadline "
    "_speaker_index last_death_id pace case_profile case_solution case_grade case_badges final_highlights "
    "best_persuader ai_memories ai_relationships private_leads ghost_predictions memory_seals memory_prompts "
    "scene_fragments scene_submissions scene_results theories theory_stakes oaths contracts pressure_marks "
    "round_event awards _bot_suspicions detective_results last_activity match_id _pending_score_results"
).split()
DEQUES = {
    "story": 7, "case_log": 48, "chat": 40, "ghost_chat": 80, "reactions": 20,
    "questions": 24, "claims": 36, "tips": 18, "moments": 48, "clues": 12,
    "reports": 100, "public_leads": 18, "ghost_echoes": 24, "director_beats": 12,
    "night_records": 32, "cross_examinations": 48,
}
SETS = ("tip_marks", "ghost_echo_marks", "_bot_marks")
PLAYER_FIELDS = (
    "id key nick coders_id connected ready alive role intel score is_bot bot_profile mission "
    "last_chat_at last_reaction_at"
).split()


class InvalidCheckpoint(ValueError):
    """No private payload or credential is included in this exception."""


def _validate_json(value, depth=0):
    if depth > 24:
        raise InvalidCheckpoint("checkpoint_depth")
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise InvalidCheckpoint("checkpoint_number")
        return
    if isinstance(value, list):
        for item in value:
            _validate_json(item, depth + 1)
        return
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        for item in value.values():
            _validate_json(item, depth + 1)
        return
    raise InvalidCheckpoint("checkpoint_type")


def encode_room(room, *, saved_at: float | None = None) -> dict:
    body = {name: getattr(room, name) for name in ROOM_FIELDS}
    body.update({name: list(getattr(room, name)) for name in DEQUES})
    body.update({name: sorted(getattr(room, name)) for name in SETS})
    players = []
    for player in room.players.values():
        values = {name: getattr(player, name) for name in PLAYER_FIELDS}
        values["coders_id"] = str(player.coders_id) if player.coders_id else None
        players.append(values)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "saved_at": saved_at if saved_at is not None else (room._clock_saved_at if room._recovery_paused else time.time()),
        "room": body, "players": players,
    }
    _validate_json(payload)
    # Detach all nested references before an awaited DB commit.
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    if len(encoded.encode("utf-8")) > MAX_CHECKPOINT_BYTES:
        raise InvalidCheckpoint("checkpoint_size")
    return json.loads(encoded)


def checkpoint_signature(payload: dict) -> str:
    return json.dumps([payload["room"], payload["players"]], sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def decode_room(payload: dict):
    from app.game import PACE_SECONDS, ROLE_NAMES, Player, Room, clean_room_name

    _validate_json(payload)
    if not isinstance(payload, dict) or set(payload) != {"schema_version", "saved_at", "room", "players"}:
        raise InvalidCheckpoint("checkpoint_envelope")
    if type(payload["schema_version"]) is not int or payload["schema_version"] != SCHEMA_VERSION:
        raise InvalidCheckpoint("checkpoint_schema")
    if type(payload["saved_at"]) not in (int, float) or payload["saved_at"] <= 0:
        raise InvalidCheckpoint("checkpoint_clock")
    body, players = payload["room"], payload["players"]
    if not isinstance(body, dict) or set(body) != set(ROOM_FIELDS) | set(DEQUES) | set(SETS):
        raise InvalidCheckpoint("checkpoint_fields")
    name = body["name"]
    if not isinstance(name, str) or clean_room_name(name) != name:
        raise InvalidCheckpoint("checkpoint_room")
    room = Room(name)
    for field in ROOM_FIELDS:
        value, expected = body[field], getattr(room, field)
        if expected is not None:
            valid = type(value) is type(expected) or (isinstance(expected, float) and type(value) in (int, float))
            if not valid:
                raise InvalidCheckpoint("checkpoint_field_type")
        elif value is not None:
            nullable_dicts = {"best_persuader", "round_event"}
            if type(value) is not (dict if field in nullable_dicts else str):
                raise InvalidCheckpoint("checkpoint_nullable_type")
        setattr(room, field, value)
    if room.phase not in {"lobby", "reveal", "night", "dawn", "day", "vote", "defense", "verdict", "result", "gameover"} or room.pace not in PACE_SECONDS:
        raise InvalidCheckpoint("checkpoint_phase")
    if room.winner not in {None, "mafia", "citizen", "trickster"} or room.mode not in {"solo", "party"} or room.case_mode not in {"first", "classic"}:
        raise InvalidCheckpoint("checkpoint_mode")
    if not all(isinstance(room.case_profile.get(key), str) for key in ("code", "title", "location", "briefing")):
        raise InvalidCheckpoint("checkpoint_case")
    try:
        UUID(room.match_id)
    except (ValueError, TypeError, AttributeError) as error:
        raise InvalidCheckpoint("checkpoint_match") from error
    for field, capacity in DEQUES.items():
        if not isinstance(body[field], list) or len(body[field]) > capacity:
            raise InvalidCheckpoint("checkpoint_buffer")
        element_type = str if field in {"story", "case_log"} else dict
        if not all(isinstance(item, element_type) for item in body[field]):
            raise InvalidCheckpoint("checkpoint_buffer_type")
        setattr(room, field, deque(body[field], maxlen=capacity))
    for field in SETS:
        if not isinstance(body[field], list) or not all(isinstance(item, str) for item in body[field]):
            raise InvalidCheckpoint("checkpoint_set")
        setattr(room, field, set(body[field]))
    if not isinstance(players, list) or len(players) > 1000:
        raise InvalidCheckpoint("checkpoint_players")
    keys = set()
    for values in players:
        if not isinstance(values, dict) or set(values) != set(PLAYER_FIELDS):
            raise InvalidCheckpoint("checkpoint_player_fields")
        if not all(isinstance(values[field], str) for field in ("id", "key", "nick", "role", "bot_profile", "mission")):
            raise InvalidCheckpoint("checkpoint_player_type")
        if any(type(values[field]) is not bool for field in ("connected", "ready", "alive", "is_bot")):
            raise InvalidCheckpoint("checkpoint_player_flags")
        if values["role"] not in ROLE_NAMES or values["id"] in room.players or values["key"] in keys:
            raise InvalidCheckpoint("checkpoint_player_identity")
        if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", values["key"]) or not values["id"] or len(values["id"]) > 64:
            raise InvalidCheckpoint("checkpoint_player_key")
        if any(type(values[field]) not in (int, float) for field in ("last_chat_at", "last_reaction_at")):
            raise InvalidCheckpoint("checkpoint_player_clock")
        if not isinstance(values["intel"], list) or not all(isinstance(line, str) for line in values["intel"]) or type(values["score"]) is not int:
            raise InvalidCheckpoint("checkpoint_player_state")
        values = dict(values)
        try:
            values["coders_id"] = UUID(values["coders_id"]) if values["coders_id"] is not None else None
        except (ValueError, TypeError, AttributeError) as error:
            raise InvalidCheckpoint("checkpoint_player_user") from error
        values["connected"] = values["connected"] if values["is_bot"] else False
        player = Player(**values, ws=None, socket_owner=None, voice=False, last_command_at=0.0)
        keys.add(player.key)
        room.players[player.id] = player
    ids = set(room.players)
    if room.round < 0 or any(key not in ids or not isinstance(value, str) or value not in ids for key, value in room.actions.items()):
        raise InvalidCheckpoint("checkpoint_action_identity")
    if any(key not in ids or not isinstance(value, str) or value not in ids | {"skip"} for key, value in room.votes.items()):
        raise InvalidCheckpoint("checkpoint_vote_identity")
    if any(key not in ids or type(value) is not bool for key, value in room.judgements.items()):
        raise InvalidCheckpoint("checkpoint_judgement")
    room._clock_saved_at = float(payload["saved_at"])
    room._recovery_paused = True
    room._voice_generation += int(time.time() * 1000)
    _preflight_restored_room(room)
    return room


def _preflight_restored_room(room) -> None:
    """Validate current projections/intents before any recovered room is ready.

    A JSON-shaped nested record can still miss a field required by the actual
    projector. This check emits nothing and does not expose private DB state.
    """
    from app.services.passport import CaseResult

    try:
        result_fields = {field.name for field in fields(CaseResult)}
        for entry in room._pending_score_results:
            if not isinstance(entry, dict) or set(entry) != {"coders_id", "name", "score", "result"}:
                raise ValueError
            UUID(entry["coders_id"])
            if not isinstance(entry["name"], str) or type(entry["score"]) is not int:
                raise ValueError
            if not isinstance(entry["result"], dict) or set(entry["result"]) != result_fields:
                raise ValueError
            result = CaseResult(**entry["result"])
            UUID(result.match_id)
            if any(type(getattr(result, name)) is not int for name in ("score", "timeline_score", "social_actions")):
                raise ValueError
            if any(not isinstance(getattr(result, name), str) for name in ("case_code", "case_title", "grade")):
                raise ValueError
            if result.mode not in {"solo", "party"} or result.winner not in {"mafia", "citizen", "trickster"} or type(result.won) is not bool:
                raise ValueError
            if not isinstance(result.badges, list) or not all(isinstance(item, str) for item in result.badges):
                raise ValueError
        for viewer in room.players.values():
            json.dumps(room._state_for(viewer), ensure_ascii=False, allow_nan=False)
    except Exception:
        # Do not log payloads, role information, resume keys or nested values.
        raise InvalidCheckpoint("checkpoint_projection_or_result") from None
