"""Logging setup.

Two formats. `text` is for a human watching a terminal in development. `json` emits one
object per line, which is what every log aggregator (CloudWatch, Datadog, Loki, ELK)
wants — parsing a human-readable format at ingest is lossy and brittle.

Every record carries the current `request_id`, so a single request's lines can be pulled
out of interleaved concurrent traffic.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any

from .middleware import RequestIdFilter

#: Fields already on every LogRecord. Anything else a caller attaches via `extra=`
#: is merged into the JSON output as a structured field.
_RESERVED = frozenset({
    "args", "asctime", "created", "exc_info", "exc_text", "filename", "funcName",
    "levelname", "levelno", "lineno", "module", "msecs", "message", "msg", "name",
    "pathname", "process", "processName", "relativeCreated", "stack_info",
    "taskName", "thread", "threadName", "request_id",
})


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": getattr(record, "request_id", "-"),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO", fmt: str = "text") -> None:
    """Install the root handler. Idempotent — safe to call from a reloading worker."""
    handler = logging.StreamHandler(sys.stdout)
    handler.addFilter(RequestIdFilter())

    if fmt == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)-8s %(name)s [%(request_id)s] %(message)s",
                datefmt="%H:%M:%S",
            )
        )

    root = logging.getLogger()
    # Replace rather than append, so a reload doesn't duplicate every line.
    for existing in root.handlers[:]:
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level.upper())

    # uvicorn installs its own access log that duplicates ours without the request id.
    logging.getLogger("uvicorn.access").handlers = []
    logging.getLogger("uvicorn.access").propagate = False
