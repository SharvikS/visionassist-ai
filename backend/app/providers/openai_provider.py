"""OpenAI (GPT) provider adapter — Chat Completions API."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

from ..schemas import ChatResponse, Message, ProviderInfo
from .base import BaseProvider

_API_URL = "https://api.openai.com/v1/chat/completions"


class OpenAIProvider(BaseProvider):
    info = ProviderInfo(
        id="openai",
        label="OpenAI (GPT)",
        default_model="gpt-4.1",
        models=["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"],
        supports_vision=True,
    )

    def _headers(self, api_key: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    def _build_payload(
        self, model: str, messages: list[Message], max_tokens: int, temperature: float
    ) -> dict:
        wire: list[dict] = []
        for m in messages:
            if m.images:
                content: list[dict] = []
                if m.text:
                    content.append({"type": "text", "text": m.text})
                for img in m.images:
                    content.append({
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{img}"},
                    })
                wire.append({"role": m.role, "content": content})
            else:
                wire.append({"role": m.role, "content": m.text})
        return {
            "model": model,
            "messages": wire,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }

    async def chat(self, *, api_key, model, messages, max_tokens, temperature) -> ChatResponse:
        payload = self._build_payload(model, messages, max_tokens, temperature)
        client = self._client()
        resp = await client.post(_API_URL, headers=self._headers(api_key), json=payload)
        self._raise_for_upstream(resp)
        data = resp.json()
        text = data["choices"][0]["message"]["content"] or ""
        usage = data.get("usage", {})
        return ChatResponse(
            provider="openai", model=model, text=text,
            input_tokens=usage.get("prompt_tokens"), output_tokens=usage.get("completion_tokens"),
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
                if not raw or raw == "[DONE]":
                    continue
                try:
                    event = json.loads(raw)
                except ValueError:
                    continue  # keep-alive / partial frame — not fatal to the stream
                choices = event.get("choices") or []
                if choices:
                    delta = choices[0].get("delta", {})
                    if delta.get("content"):
                        yield delta["content"]
