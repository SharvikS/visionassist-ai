"""ModelRouter — the single provider-agnostic entrypoint for the orchestrator.

Given a `ChatRequest` (which names a provider) and the caller's BYOK key, it dispatches to
the right adapter. This is what makes models hot-swappable: the rest of the app only ever
talks to the router.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from .config import get_settings
from .providers import (
    AnthropicProvider,
    BaseProvider,
    GeminiProvider,
    OpenAIProvider,
    ProviderError,
)
from .schemas import ChatRequest, ChatResponse, Message, ProviderInfo


class ModelRouter:
    def __init__(self, timeout: float | None = None):
        t = timeout if timeout is not None else get_settings().provider_timeout
        self._providers: dict[str, BaseProvider] = {
            "anthropic": AnthropicProvider(timeout=t),
            "openai": OpenAIProvider(timeout=t),
            "gemini": GeminiProvider(timeout=t),
        }

    def _get(self, provider: str) -> BaseProvider:
        adapter = self._providers.get(provider)
        if adapter is None:
            raise ProviderError(f"Unknown provider '{provider}'.", status_code=400)
        return adapter

    def catalog(self) -> list[ProviderInfo]:
        return [p.info for p in self._providers.values()]

    async def chat(self, req: ChatRequest, *, api_key: str) -> ChatResponse:
        return await self._get(req.provider).chat(
            api_key=api_key, model=req.model, messages=req.messages,
            max_tokens=req.max_tokens, temperature=req.temperature,
        )

    def stream_chat(self, req: ChatRequest, *, api_key: str) -> AsyncIterator[str]:
        return self._get(req.provider).stream_chat(
            api_key=api_key, model=req.model, messages=req.messages,
            max_tokens=req.max_tokens, temperature=req.temperature,
        )


_router: ModelRouter | None = None


def get_router() -> ModelRouter:
    global _router
    if _router is None:
        _router = ModelRouter()
    return _router
