from __future__ import annotations

import base64
import hashlib
import hmac
import json

import pytest
from app.core.voice_ice import VoiceICEConfig, voice_configuration
from pydantic import ValidationError


@pytest.fixture(autouse=True)
def clean_voice_environment(monkeypatch):
    for name in ("VOICE_STUN_URLS", "VOICE_TURN_URLS", "VOICE_TURN_SHARED_SECRET", "VOICE_TURN_TTL_SECONDS"):
        monkeypatch.delenv(name, raising=False)


def test_default_configuration_does_not_claim_relay():
    response = voice_configuration(VoiceICEConfig(_env_file=None))
    assert response["t"] == "voice_config"
    assert response["relay_configured"] is False
    assert response["expires_at"] == 0
    assert response["ice_servers"] == [{"urls": [
        "stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478",
    ]}]


def test_time_limited_turn_credentials_use_coturn_contract_without_shared_secret():
    shared = "synthetic-test-secret-32-characters-only"
    config = VoiceICEConfig(
        turn_urls=["turn:relay.example:3478?transport=udp", "turns:relay.example:5349?transport=tcp"],
        turn_shared_secret=shared, _env_file=None,
    )
    response = voice_configuration(config, now=1000.25)
    server = response["ice_servers"][-1]
    assert response["relay_configured"] is True
    assert response["expires_at"] == 1_900_000
    expiry, nonce = server["username"].split(":")
    assert expiry == "1900" and len(nonce) == 24
    expected = base64.b64encode(hmac.new(shared.encode(), server["username"].encode(), hashlib.sha1).digest()).decode()
    assert server["credential"] == expected
    assert shared not in json.dumps(response)
    assert shared not in repr(config)
    assert voice_configuration(config, now=1000.25)["ice_servers"][-1]["username"] != server["username"]


@pytest.mark.parametrize("url", [
    "https://relay.example", "turn://relay.example", "turn:alice:password@relay.example:3478",
    "turn:relay.example:99999", "turn:relay.example:0", "turn:relay.example/path",
    "turn:relay.example?transport=bad", "turn:relay.example#fragment", "turn:relay example",
])
def test_rejects_malformed_or_static_credential_urls(url):
    with pytest.raises(ValidationError):
        VoiceICEConfig(turn_urls=[url], turn_shared_secret="s" * 32, _env_file=None)


def test_supports_bracketed_ipv6_and_turn_only_mode():
    config = VoiceICEConfig(stun_urls=[], turn_urls=["turn:[::1]:3478?transport=tcp"],
                            turn_shared_secret="s" * 32, _env_file=None)
    assert len(voice_configuration(config)["ice_servers"]) == 1


def test_invalid_secret_configuration_errors_do_not_echo_input():
    with pytest.raises(ValidationError) as error:
        VoiceICEConfig(turn_urls=["turn:relay.example:3478"], turn_shared_secret="too-short-private", _env_file=None)
    assert "too-short-private" not in str(error.value)
    with pytest.raises(ValidationError):
        VoiceICEConfig(turn_shared_secret="s" * 32, _env_file=None)


def test_environment_settings_use_server_only_prefix(monkeypatch):
    monkeypatch.setenv("VOICE_TURN_URLS", '["turns:relay.example:5349?transport=tcp"]')
    monkeypatch.setenv("VOICE_TURN_SHARED_SECRET", "s" * 32)
    monkeypatch.setenv("VOICE_TURN_TTL_SECONDS", "120")
    response = voice_configuration(VoiceICEConfig(_env_file=None), now=2000)
    assert response["expires_at"] == 2_120_000
    assert response["relay_configured"] is True
