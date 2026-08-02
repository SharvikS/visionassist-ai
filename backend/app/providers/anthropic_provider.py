"""Anthropic (Claude) provider adapter — Messages API."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

from ..schemas import ChatResponse, Message, ProviderInfo
from .base import BaseProvider

_API_URL = "https://api.anthropic.com/v1/messages"
_API_VERSION = "2023-06-01"

#: Claude 5-series models reject `temperature` / `top_p` / `top_k` outright (400).
#: Behaviour is steered by prompting instead.
_NO_SAMPLING_PARAMS = (
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
)

#: Models that accept `thinking`. VisionAssist turns thinking off: this is a
#: real-time screen assistant, so time-to-first-token is the product, and
#: thinking tokens share the `max_tokens` budget with the answer itself.
_SUPPORTS_THINKING = _NO_SAMPLING_PARAMS


class AnthropicProvider(BaseProvider):
    info = ProviderInfo(
        id="anthropic",
        label="Anthropic (Claude)",
        default_model="claude-sonnet-5",
        models=[
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-haiku-4-5",
        ],
        supports_vision=True,
    )

    def _headers(self, api_key: str) -> dict[str, str]:
        return {
            "x-api-key": api_key,
            "anthropic-version": _API_VERSION,
            "content-type": "application/json",
        }

    def _build_payload(
        self, model: str, messages: list[Message], max_tokens: int, temperature: float
    ) -> dict:
        system_parts: list[str] = []
        wire_messages: list[dict] = []
        for m in messages:
            if m.role == "system":
                if m.text:
                    system_parts.append(m.text)
                continue
            content: list[dict] = []
            for img in m.images:
                content.append({
                    "type": "image",
                    "source": {"type": "base64", "media_type": "image/jpeg", "data": img},
                })
            if m.text:
                content.append({"type": "text", "text": m.text})
            wire_messages.append({"role": m.role, "content": content or [{"type": "text", "text": ""}]})

        payload: dict = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": wire_messages,
        }
        if not model.startswith(_NO_SAMPLING_PARAMS):
            payload["temperature"] = temperature
        if model.startswith(_SUPPORTS_THINKING):
            payload["thinking"] = {"type": "disabled"}
        if system_parts:
            payload["system"] = "\n\n".join(system_parts)
        return payload

    async def chat(self, *, api_key, model, messages, max_tokens, temperature) -> ChatResponse:
        payload = self._build_payload(model, messages, max_tokens, temperature)
        client = self._client()
        resp = await client.post(_API_URL, headers=self._headers(api_key), json=payload)
        self._raise_for_upstream(resp)
        data = resp.json()
        text = "".join(
            block.get("text", "") for block in data.get("content", []) if block.get("type") == "text"
        )
        usage = data.get("usage", {})
        return ChatResponse(
            provider="anthropic", model=model, text=text,
            input_tokens=usage.get("input_tokens"), output_tokens=usage.get("output_tokens"),
        )

    async def stream_chat(self, *, api_key, model, messages, max_tokens, temperature) -> AsyncIterator[str]:
        payload = self._build_payload(model, messages, max_tokens, temperature)
        payload["stream"] = True
        client = self._client()
        async with client.stream(
            "POST", _API_URL, headers=self._headers(api_key), json=payload
        ) as resp:
            if resp.status_code >= 400:
                self._raise_for_status(resp.status_code, await resp.aread())
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                raw = line[5:].strip()
                if not raw:
                    continue
                try:
                    event = json.loads(raw)
                except ValueError:
                    continue  # keep-alive / partial frame — not fatal to the stream
                if event.get("type") == "content_block_delta":
                    delta = event.get("delta", {})
                    if delta.get("type") == "text_delta":
                        yield delta.get("text", "")
