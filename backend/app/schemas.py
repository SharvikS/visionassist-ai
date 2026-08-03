"""Pydantic request/response schemas shared across routes and providers.

These carry input validation so malformed or abusive payloads are rejected at the edge
(422) rather than being forwarded upstream to a provider.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

Provider = Literal["openai", "anthropic", "gemini"]
Role = Literal["system", "user", "assistant"]

# Guard rails — generous, but bound resource use and upstream cost.
MAX_MESSAGES = 100
MAX_TEXT_CHARS = 100_000
MAX_MODEL_CHARS = 200
MAX_IMAGES_PER_MESSAGE = 8
MAX_IMAGE_B64_CHARS = 12_000_000  # ~9 MB decoded; a full-screen JPEG is far smaller
MAX_TOKENS_LIMIT = 32_768

#: Ceiling on the *total* base64 image payload in one request. The per-image and
#: per-message limits multiply out to gigabytes (100 messages x 8 images x 12 MB),
#: so without an aggregate bound a single well-formed request could exhaust memory.
#:
#: Deliberately below `Settings.max_body_bytes` so this is the constraint that actually
#: binds image content, with the body-size middleware as the outer backstop. A capture
#: frame is a few hundred KB, so ~12 MB decoded is still far more than any real request.
MAX_TOTAL_IMAGE_CHARS = 16_000_000


class Message(BaseModel):
    role: Role
    text: str = Field(default="", max_length=MAX_TEXT_CHARS)
    images: list[str] = Field(
        default_factory=list,
        description="Optional base64 JPEG frames to attach as vision input.",
    )

    @field_validator("images")
    @classmethod
    def _validate_images(cls, images: list[str]) -> list[str]:
        if len(images) > MAX_IMAGES_PER_MESSAGE:
            raise ValueError(f"At most {MAX_IMAGES_PER_MESSAGE} images per message.")
        for img in images:
            if len(img) > MAX_IMAGE_B64_CHARS:
                raise ValueError("Image exceeds the maximum allowed size.")
        return images


class ChatRequest(BaseModel):
    provider: Provider
    model: str = Field(..., min_length=1, max_length=MAX_MODEL_CHARS)
    messages: list[Message] = Field(..., min_length=1, max_length=MAX_MESSAGES)
    max_tokens: int = Field(default=1024, ge=1, le=MAX_TOKENS_LIMIT)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    stream: bool = False

    @model_validator(mode="after")
    def _require_content(self) -> "ChatRequest":
        if not any(m.text.strip() or m.images for m in self.messages):
            raise ValueError("At least one message must contain text or an image.")
        return self

    @model_validator(mode="after")
    def _bound_total_images(self) -> "ChatRequest":
        total = sum(len(img) for m in self.messages for img in m.images)
        if total > MAX_TOTAL_IMAGE_CHARS:
            raise ValueError("Total image payload exceeds the maximum allowed size.")
        return self


class ChatResponse(BaseModel):
    provider: Provider
    model: str
    text: str
    input_tokens: int | None = None
    output_tokens: int | None = None


class ProviderInfo(BaseModel):
    id: Provider
    label: str
    default_model: str
    models: list[str]
    supports_vision: bool
