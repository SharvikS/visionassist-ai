"""Groq provider adapter — OpenAI-compatible Chat Completions on Groq's LPU inference.

Groq serves the OpenAI Chat Completions format, including the `image_url` content parts
this app uses for vision and the same `data: ` SSE framing. So this adapter is the OpenAI
one with a different base URL and catalog; the payload shaping and stream parsing are
inherited rather than copied, which keeps the two from drifting apart.

Model IDs move faster here than at the other providers — Groq adds and retires hosted
open-weight models frequently. `GET https://api.groq.com/openai/v1/models` with your key
returns the live list; treat the catalog below as a starting point and check it there
before assuming a name is still served.

One caveat this app's per-provider `supports_vision` flag cannot express: on Groq, vision
is per *model*, not per provider. The Llama 4 models below accept images; the Llama 3.x and
GPT-OSS ones are text-only and will reject a request carrying a screen frame. The default
is therefore a vision-capable model, since screen capture is this app's main path.
"""

from __future__ import annotations

from typing import ClassVar

from ..schemas import ProviderInfo
from .openai_provider import OpenAIProvider


class GroqProvider(OpenAIProvider):
    api_url: ClassVar[str] = "https://api.groq.com/openai/v1/chat/completions"

    info = ProviderInfo(
        id="groq",
        label="Groq (open models)",
        default_model="meta-llama/llama-4-scout-17b-16e-instruct",
        models=[
            # Vision-capable.
            "meta-llama/llama-4-scout-17b-16e-instruct",
            "meta-llama/llama-4-maverick-17b-128e-instruct",
            # Text-only.
            "llama-3.3-70b-versatile",
            "llama-3.1-8b-instant",
            "openai/gpt-oss-120b",
            "openai/gpt-oss-20b",
        ],
        supports_vision=True,
    )
