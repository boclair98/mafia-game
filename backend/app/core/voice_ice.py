"""ICE configuration for an already admitted game WebSocket.

No shared TURN secret is sent to the browser. Optional credentials follow
coturn's time-limited REST authentication contract; STUN alone is not a relay.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time
from typing import Any
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _check_ice_url(value: str, schemes: set[str]) -> str:
    scheme, separator, address = value.partition(":")
    if not separator or scheme not in schemes or len(value) > 512:
        raise ValueError("Invalid ICE URL scheme or length")
    authority, _, query = address.partition("?")
    if query and (scheme not in {"turn", "turns"} or query not in {"transport=udp", "transport=tcp"}):
        raise ValueError("Invalid ICE transport")
    try:
        parsed = urlsplit("//" + authority)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError as error:
        raise ValueError("Invalid ICE host or port") from error
    if (
        not hostname or not re.fullmatch(r"[a-zA-Z0-9.:-]+", hostname)
        or parsed.username is not None or parsed.password is not None
        or parsed.path or parsed.fragment or "#" in address
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise ValueError("ICE URLs must contain only a host, port and transport")
    return value


class VoiceICEConfig(BaseSettings):
    stun_urls: list[str] = Field(default_factory=lambda: [
        "stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478",
    ], max_length=8)
    turn_urls: list[str] = Field(default_factory=list, max_length=8)
    turn_shared_secret: SecretStr | None = None
    turn_ttl_seconds: int = Field(default=900, ge=120, le=3600)

    model_config = SettingsConfigDict(
        env_prefix="VOICE_", env_file=".env", extra="ignore", hide_input_in_errors=True,
    )

    @field_validator("stun_urls")
    @classmethod
    def validate_stun(cls, values: list[str]) -> list[str]:
        return [_check_ice_url(value, {"stun", "stuns"}) for value in values]

    @field_validator("turn_urls")
    @classmethod
    def validate_turn(cls, values: list[str]) -> list[str]:
        return [_check_ice_url(value, {"turn", "turns"}) for value in values]

    @model_validator(mode="after")
    def validate_relay_auth(self) -> VoiceICEConfig:
        secret = self.turn_shared_secret.get_secret_value() if self.turn_shared_secret else ""
        if self.turn_urls and len(secret) < 32:
            raise ValueError("TURN URLs require a server-only shared secret of at least 32 characters")
        if secret and not self.turn_urls:
            raise ValueError("TURN shared secret requires TURN URLs")
        return self


voice_settings = VoiceICEConfig()


def voice_configuration(config: VoiceICEConfig | None = None, *, now: float | None = None) -> dict[str, Any]:
    """Call only after WS admission; returned credentials must not be logged."""
    config = config or voice_settings
    servers: list[dict[str, Any]] = []
    if config.stun_urls:
        servers.append({"urls": list(config.stun_urls)})
    expires_at = 0
    if config.turn_urls:
        expiry = int(time.time() if now is None else now) + config.turn_ttl_seconds
        # No nickname, platform id or persistent seat key appears in the
        # username. Each response has a fresh pseudonymous allocation identity.
        username = f"{expiry}:{secrets.token_hex(12)}"
        assert config.turn_shared_secret is not None
        digest = hmac.new(
            config.turn_shared_secret.get_secret_value().encode("utf-8"),
            username.encode("ascii"), hashlib.sha1,
        ).digest()
        servers.append({"urls": list(config.turn_urls), "username": username,
                        "credential": base64.b64encode(digest).decode("ascii")})
        expires_at = expiry * 1000
    return {"t": "voice_config", "ice_servers": servers, "expires_at": expires_at,
            "relay_configured": bool(config.turn_urls)}
