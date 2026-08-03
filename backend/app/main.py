"""FastAPI application entrypoint for the VisionAssist AI orchestrator."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__
from .config import get_settings
from .http_client import aclose_client, get_client
from .logging_config import configure_logging
from .middleware import (
    BodySizeLimitMiddleware,
    RequestContextMiddleware,
    request_id_ctx,
)
from .routes import chat, health, voice, ws

settings = get_settings()
configure_logging(level=settings.log_level, fmt=settings.log_format)
logger = logging.getLogger("visionassist")


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Build the pooled upstream client up front so the first user request
    # doesn't pay client construction on top of its TLS handshake.
    get_client()
    logger.info(
        "VisionAssist AI orchestrator v%s starting (CORS: %s)",
        __version__,
        ", ".join(settings.cors_origin_list) or "<none>",
    )
    yield
    await aclose_client()
    logger.info("VisionAssist AI orchestrator shutting down")


app = FastAPI(
    title="VisionAssist AI — Orchestrator",
    version=__version__,
    description=(
        "Privacy-first BYOK orchestrator. Routes streaming multimodal calls to the user's "
        "chosen LLM provider. API keys are never persisted server-side."
    ),
    lifespan=lifespan,
)

# Middleware is applied outermost-last, so this reads bottom-up: request context wraps
# everything (an access log line and an id for every request, including rejected ones),
# then the body-size guard, then CORS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=False,  # BYOK key travels in a header, not cookies — no credentials.
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Provider-Key", "X-Request-ID"],
    expose_headers=["X-Request-ID"],
    max_age=600,
)
app.add_middleware(BodySizeLimitMiddleware, max_bytes=settings.max_body_bytes)
app.add_middleware(RequestContextMiddleware)


@app.exception_handler(Exception)
async def _unhandled_exception(request: Request, exc: Exception) -> JSONResponse:
    """Never leak stack traces or internals to clients; log server-side instead.

    The request id goes back in the body so a user reporting "it broke" hands over
    the exact string needed to find the traceback in the logs.
    """
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Internal server error.",
            "request_id": getattr(request.state, "request_id", "-"),
        },
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
