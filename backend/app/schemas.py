"""Pydantic request/response schemas shared across routes and providers."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Provider = Literal["openai", "anthropic", "gemini"]
Role = Literal["system", "user", "assistant"]


class ImageContent(BaseModel):
    """A base64-encoded image part (e.g. a captured screen frame)."""

    kind: Literal["image"] = "image"
    media_type: str = "image/jpeg"
    data: str = Field(..., description="Base64-encoded image bytes (no data: prefix).")


class TextContent(BaseModel):
    kind: Literal["text"] = "text"
    text: str


class Message(BaseModel):
    role: Role
    text: str = ""
    images: list[str] = Field(
        default_factory=list,
        description="Optional base64 JPEG frames to attach as vision input.",
    )


class ChatRequest(BaseModel):
    provider: Provider
    model: str
    messages: list[Message]
    max_tokens: int = 1024
    temperature: float = 0.7
    stream: bool = False


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
