"""Application configuration.

All settings are environment-driven with sane local defaults. Crucially, this does NOT
hold any provider API keys — VisionAssist is BYOK, so keys arrive from the client on each
request and are never persisted server-side.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="VA_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    cors_origins: str = "http://localhost:3000"
    host: str = "0.0.0.0"
    port: int = 8000

    # -- logging ---------------------------------------------------------------
    log_level: str = "INFO"
    #: "text" for humans, "json" for log aggregators. Use json in deployed environments.
    log_format: Literal["text", "json"] = "text"

    # -- upstream HTTP ---------------------------------------------------------
    provider_timeout: float = 60.0
    connect_timeout: float = 10.0
    max_connections: int = 100
    max_keepalive_connections: int = 20
    keepalive_expiry: float = 60.0

    # -- WebSocket session -----------------------------------------------------
    #: Close a session that has sent nothing for this long, so abandoned tabs
    #: don't pin a connection (and its in-memory key) open indefinitely.
    ws_idle_timeout: float = 300.0

    # -- request limits --------------------------------------------------------
    #: Hard ceiling on a JSON request body. Pydantic can only reject an oversized
    #: payload *after* Starlette has buffered the whole thing into memory, so the
    #: real bound has to be enforced before the body is read.
    max_body_bytes: int = 24 * 1024 * 1024

    #: Largest accepted STT upload. Matches OpenAI's own 25 MB Whisper limit —
    #: anything bigger is rejected upstream anyway, so buffering it is pure waste.
    max_audio_bytes: int = 25 * 1024 * 1024

    #: Longest text accepted for synthesis. OpenAI's speech endpoint caps input at
    #: 4096 characters; matching it here turns a guaranteed upstream 400 into a
    #: cheap local one.
    max_tts_chars: int = 4096

    # -- rate limiting ---------------------------------------------------------
    #: Sustained requests/second allowed per client for the expensive endpoints.
    rate_limit_rps: float = 2.0
    #: Burst allowance. A session legitimately fires several requests on open, so a
    #: pure sustained limit would reject normal use.
    rate_limit_burst: int = 20
    #: Set to false to disable limiting entirely (e.g. behind a gateway that does it).
    rate_limit_enabled: bool = True
    #: Trust `X-Forwarded-For` for client identity. Enable ONLY behind a proxy that
    #: overwrites the header — any client can send it, so trusting it when directly
    #: exposed lets a caller mint a new identity per request and bypass the limit.
    trust_proxy_headers: bool = False
    #: Concurrent WebSocket sessions allowed from one client address.
    max_ws_sessions_per_client: int = 8

    @field_validator("log_level")
    @classmethod
    def _valid_log_level(cls, v: str) -> str:
        level = v.upper()
        if level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            raise ValueError(f"Invalid log level '{v}'.")
        return level

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
