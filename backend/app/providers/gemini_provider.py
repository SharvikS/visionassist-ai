"""Google Gemini provider adapter — generateContent API."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

from ..schemas import ChatResponse, Message, ProviderInfo
from .base import BaseProvider

_BASE = "https://generativelanguage.googleapis.com/v1beta/models"


class GeminiProvider(BaseProvider):
    info = ProviderInfo(
        id="gemini",
        label="Google (Gemini)",
        default_model="gemini-1.5-pro",
        models=["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash"],
        supports_vision=True,
    )

    @staticmethod
    def _role(role: str) -> str:
        # Gemini uses "model" for assistant turns; system is handled separately.
        return "model" if role == "assistant" else "user"

    def _build_payload(
        self, messages: list[Message], max_tokens: int, temperature: float
    ) -> dict:
        contents: list[dict] = []
        system_parts: list[str] = []
        for m in messages:
            if m.role == "system":
                if m.text:
                    system_parts.append(m.text)
                continue
            parts: list[dict] = []
            if m.text:
                parts.append({"text": m.text})
            for img in m.images:
                parts.append({"inline_data": {"mime_type": "image/jpeg", "data": img}})
            contents.append({"role": self._role(m.role), "parts": parts or [{"text": ""}]})

        payload: dict = {
            "contents": contents,
            "generationConfig": {"maxOutputTokens": max_tokens, "temperature": temperature},
        }
        if system_parts:
            payload["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_parts)}]}
        return payload

    @staticmethod
    def _extract_text(data: dict) -> str:
        candidates = data.get("candidates") or []
        if not candidates:
            return ""
        parts = candidates[0].get("content", {}).get("parts", [])
        return "".join(p.get("text", "") for p in parts)

    async def chat(self, *, api_key, model, messages, max_tokens, temperature) -> ChatResponse:
        payload = self._build_payload(messages, max_tokens, temperature)
        url = f"{_BASE}/{model}:generateContent?key={api_key}"
        async with self._client() as client:
            resp = await client.post(url, json=payload)
            self._raise_for_upstream(resp)
            data = resp.json()
        usage = data.get("usageMetadata", {})
        return ChatResponse(
            provider="gemini", model=model, text=self._extract_text(data),
            input_tokens=usage.get("promptTokenCount"),
            output_tokens=usage.get("candidatesTokenCount"),
        )

    async def stream_chat(self, *, api_key, model, messages, max_tokens, temperature) -> AsyncIterator[str]:
        payload = self._build_payload(messages, max_tokens, temperature)
        url = f"{_BASE}/{model}:streamGenerateContent?alt=sse&key={api_key}"
        async with self._client() as client:
            async with client.stream("POST", url, json=payload) as resp:
                if resp.status_code >= 400:
                    self._raise_for_status(resp.status_code, await resp.aread())
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw:
                        continue
                    text = self._extract_text(json.loads(raw))
                    if text:
                        yield text
