"""Application configuration.

All settings are environment-driven with sane local defaults. Crucially, this does NOT
hold any provider API keys — VisionAssist is BYOK, so keys arrive from the client on each
request and are never persisted server-side.
"""

from __future__ import annotations

from functools import lru_cache

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

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
