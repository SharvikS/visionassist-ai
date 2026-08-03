"""Token-bucket rate limiting.

Every expensive endpoint here fans out to a paid upstream API. Without a throttle a
single client — a runaway retry loop as easily as an abusive one — can burn the user's
provider quota and saturate the connection pool that every other session shares.

A token bucket (rather than a fixed window) is the right shape for this traffic: it
allows a short burst, which is exactly what a normal session does when it opens and
fires several requests, while still bounding the sustained rate.

Scope: in-process. That matches the project's "no broker, no state store" posture and
is correct for a single instance. Behind more than one replica each process enforces
its own bucket, so the effective limit multiplies by the replica count — put the limit
at the load balancer, or move the buckets to Redis, if that matters to you.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from starlette.types import ASGIApp, Receive, Scope, Send

#: Stale buckets are swept no more often than this, so a long-running process doesn't
#: accumulate an entry per IP that ever connected.
_SWEEP_INTERVAL = 300.0


@dataclass
class _Bucket:
    tokens: float
    #: Stamped by the caller with the same `now` it used for the refill maths. Reading
    #: the clock a second time here would make the first refill interval wrong.
    updated: float


class TokenBucketLimiter:
    """Refills at `rate` tokens/second up to `burst`. One bucket per key."""

    def __init__(self, rate: float, burst: int):
        self.rate = rate
        self.burst = burst
        self._buckets: dict[str, _Bucket] = {}
        self._last_sweep = time.monotonic()

    def allow(self, key: str, cost: float = 1.0) -> tuple[bool, float]:
        """Consume `cost` tokens. Returns (allowed, retry_after_seconds)."""
        now = time.monotonic()
        self._maybe_sweep(now)

        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = _Bucket(tokens=float(self.burst), updated=now)
            self._buckets[key] = bucket

        # Refill for the time elapsed since this bucket was last touched.
        elapsed = now - bucket.updated
        bucket.tokens = min(self.burst, bucket.tokens + elapsed * self.rate)
        bucket.updated = now

        if bucket.tokens >= cost:
            bucket.tokens -= cost
            return True, 0.0

        deficit = cost - bucket.tokens
        return False, deficit / self.rate if self.rate > 0 else 60.0

    def _maybe_sweep(self, now: float) -> None:
        """Drop buckets that have refilled to full — they carry no state worth keeping."""
        if now - self._last_sweep < _SWEEP_INTERVAL:
            return
        self._last_sweep = now
        full_after = self.burst / self.rate if self.rate > 0 else _SWEEP_INTERVAL
        self._buckets = {
            key: b
            for key, b in self._buckets.items()
            if now - b.updated < full_after
        }

    def reset(self) -> None:
        self._buckets.clear()


def client_key(scope: Scope, trust_proxy: bool) -> str:
    """Identify the caller for limiting purposes.

    `X-Forwarded-For` is trusted only when explicitly enabled, because any client can
    send it. Honouring it unconditionally would let one caller mint a fresh identity
    per request and bypass the limit entirely.
    """
    if trust_proxy:
        for name, value in scope.get("headers", []):
            if name == b"x-forwarded-for":
                # Left-most entry is the original client.
                return value.decode("latin-1").split(",")[0].strip()
    client = scope.get("client")
    return client[0] if client else "unknown"


class RateLimitMiddleware:
    """Apply the limiter to configured path prefixes."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        rate: float,
        burst: int,
        paths: tuple[str, ...],
        trust_proxy: bool = False,
    ):
        self.app = app
        self.limiter = TokenBucketLimiter(rate=rate, burst=burst)
        self.paths = paths
        self.trust_proxy = trust_proxy

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not self._limited(scope.get("path", "")):
            await self.app(scope, receive, send)
            return

        allowed, retry_after = self.limiter.allow(client_key(scope, self.trust_proxy))
        if not allowed:
            await _too_many(send, retry_after)
            return
        await self.app(scope, receive, send)

    def _limited(self, path: str) -> bool:
        return any(path.startswith(p) for p in self.paths)


async def _too_many(send: Send, retry_after: float) -> None:
    body = b'{"detail":"Rate limit exceeded. Slow down and retry."}'
    await send({
        "type": "http.response.start",
        "status": 429,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode("latin-1")),
            (b"retry-after", str(max(1, int(retry_after + 0.999))).encode("latin-1")),
        ],
    })
    await send({"type": "http.response.body", "body": body})
