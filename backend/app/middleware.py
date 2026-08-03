"""ASGI middleware: request correlation, access logging, and body-size enforcement.

Kept as raw ASGI rather than Starlette's `BaseHTTPMiddleware` on purpose.
`BaseHTTPMiddleware` wraps the response in an anyio task group and buffers it through
a memory stream, which breaks the streaming behaviour this app depends on — SSE token
deltas and TTS audio would arrive in chunks instead of as they are produced. Raw ASGI
middleware passes `send` straight through and stays out of the hot path.
"""

from __future__ import annotations

import logging
import time
import uuid
from contextvars import ContextVar

from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger("visionassist.access")

#: Correlation id for the request currently being handled. Read by the logging filter
#: so every line emitted during a request carries its id without threading it through
#: every call signature.
request_id_ctx: ContextVar[str] = ContextVar("request_id", default="-")

#: Health checks run constantly (Kubernetes liveness/readiness, load balancers). Logging
#: them buries real traffic in noise.
_QUIET_PATHS = frozenset({"/health", "/"})


class RequestContextMiddleware:
    """Assign a request id, echo it back, and emit one access line per request."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Honour an upstream id so a trace survives across a proxy or gateway.
        incoming = _header(scope, b"x-request-id")
        request_id = incoming or uuid.uuid4().hex[:16]
        token = request_id_ctx.set(request_id)

        # Also stash it on the scope. Starlette's ServerErrorMiddleware sits *outside*
        # user middleware, so by the time the 500 handler runs this middleware's
        # `finally` has already reset the context var — but the scope is still the
        # same dict, and `request.state` reads straight from it.
        scope.setdefault("state", {})["request_id"] = request_id

        started = time.perf_counter()
        status_code = 500

        async def send_wrapper(message: Message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                headers = message.setdefault("headers", [])
                headers.append((b"x-request-id", request_id.encode("latin-1")))
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            path = scope.get("path", "")
            if path not in _QUIET_PATHS:
                logger.info(
                    "%s %s %s %.1fms",
                    scope.get("method", "-"),
                    path,
                    status_code,
                    (time.perf_counter() - started) * 1000,
                )
            request_id_ctx.reset(token)


class BodySizeLimitMiddleware:
    """Reject request bodies larger than `max_bytes`.

    Two checks, because either alone is insufficient. `Content-Length` catches the
    common case before a single byte is read, but it is absent on chunked uploads and
    is client-supplied either way. Counting bytes as they stream in is authoritative;
    the header check just avoids reading a body we already know is too large.
    """

    def __init__(self, app: ASGIApp, max_bytes: int):
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        declared = _header(scope, b"content-length")
        if declared is not None:
            try:
                if int(declared) > self.max_bytes:
                    await _reject(send)
                    return
            except ValueError:
                pass  # malformed header — the byte counter below still applies

        received = 0
        exceeded = False

        async def counting_receive() -> Message:
            nonlocal received, exceeded
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    exceeded = True
                    # Signal end-of-body so the handler unwinds instead of hanging.
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message: Message) -> None:
            if exceeded and message["type"] == "http.response.start":
                message = dict(message)
                message["status"] = 413
            await send(message)

        await self.app(scope, counting_receive, guarded_send)


def _header(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers", []):
        if key == name:
            return value.decode("latin-1")
    return None


async def _reject(send: Send) -> None:
    body = b'{"detail":"Request body too large."}'
    await send({
        "type": "http.response.start",
        "status": 413,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode("latin-1")),
        ],
    })
    await send({"type": "http.response.body", "body": body})


class RequestIdFilter(logging.Filter):
    """Attach the current request id to every record so log lines correlate."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = request_id_ctx.get()
        return True
