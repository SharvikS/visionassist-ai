"""Abstract provider interface.

Each provider adapter normalizes VisionAssist's internal `Message` list into the wire
format of a specific LLM API and exposes a single async `chat()` entrypoint plus a
streaming `stream_chat()` generator. The user's BYOK API key is passed in per call and is
never stored on the adapter instance.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator

import httpx

from ..schemas import ChatResponse, Message, ProviderInfo


class ProviderError(Exception):
    """Raised when an upstream provider call fails. Carries an HTTP-ish status code."""

    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


class BaseProvider(ABC):
    #: Static metadata describing this provider and its selectable models.
    info: ProviderInfo

    def __init__(self, timeout: float = 60.0):
        self._timeout = timeout

    @abstractmethod
    async def chat(
        self, *, api_key: str, model: str, messages: list[Message],
        max_tokens: int, temperature: float,
    ) -> ChatResponse:
        """Return a full (non-streamed) completion."""

    @abstractmethod
    def stream_chat(
        self, *, api_key: str, model: str, messages: list[Message],
        max_tokens: int, temperature: float,
    ) -> AsyncIterator[str]:
        """Yield text token deltas as they arrive."""

    # -- shared helpers -------------------------------------------------------

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(timeout=self._timeout)

    @staticmethod
    def _raise_for_upstream(resp: httpx.Response) -> None:
        if resp.status_code >= 400:
            detail = resp.text[:500]
            raise ProviderError(
                f"Upstream provider error ({resp.status_code}): {detail}",
                status_code=resp.status_code,
            )

    @staticmethod
    def _raise_for_status(status_code: int, body: bytes) -> None:
        """Streaming-friendly variant that takes an already-read error body."""
        if status_code >= 400:
            raise ProviderError(
                f"Upstream provider error ({status_code}): "
                f"{body[:500].decode('utf-8', 'replace')}",
                status_code=status_code,
            )
