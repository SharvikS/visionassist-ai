"""FastAPI application entrypoint for the VisionAssist AI orchestrator."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import __version__
from .config import get_settings
from .routes import chat, health, voice, ws

settings = get_settings()

app = FastAPI(
    title="VisionAssist AI — Orchestrator",
    version=__version__,
    description=(
        "Privacy-first BYOK orchestrator. Routes streaming multimodal calls to the user's "
        "chosen LLM provider. API keys are never persisted server-side."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(chat.router)
app.include_router(voice.router)
app.include_router(ws.router)


@app.get("/", tags=["health"])
async def root() -> dict:
    return {
        "service": "VisionAssist AI",
        "version": __version__,
        "docs": "/docs",
    }
