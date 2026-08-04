# VisionAssist AI — Backend

FastAPI orchestrator. Provider-agnostic model router over OpenAI, Anthropic, and Gemini,
plus the voice (STT/TTS) pipeline and the WebSocket control plane.

**BYOK**: the client sends its provider key per request (`X-Provider-Key` header for HTTP,
the `init` message for WebSocket sessions). The server holds it in memory for the life of
that request or connection and never persists it.

## Run

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Open http://localhost:8000/docs for interactive API docs.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/health` | Liveness probe. |
| `GET`  | `/providers` | Catalog of providers + selectable models. |
| `POST` | `/chat` | Non-streaming completion (routes by `provider`). |
| `POST` | `/chat/stream` | SSE token stream. |
| `POST` | `/voice/stt` | Transcribe an audio blob (Whisper). |
| `POST` | `/voice/tts` | Stream synthesized speech (MP3). |
| `GET`  | `/voice/voices` | Available TTS voices and default models. |
| `WS`   | `/ws/session` | Full-duplex session: frames in, tokens out. |
| `POST` | `/automation/plan` | Propose an action plan from a screenshot. Runs nothing. |
| `POST` | `/automation/execute` | Run a human-approved plan in a fresh browser context. |

The two automation endpoints are separate on purpose: `/plan` has no side effects, so a
model's output stays inert until a person has read it and posted it back with
`approved: true`. Both return `503` unless `VA_AUTOMATION_ENABLED=true`.

### Example

```bash
curl -s http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -H "X-Provider-Key: $ANTHROPIC_API_KEY" \
  -d '{
        "provider": "anthropic",
        "model": "claude-sonnet-5",
        "messages": [{"role": "user", "text": "Say hi in 3 words."}]
      }'
```

## Performance notes

A few things here are load-bearing and easy to regress:

- **One pooled `httpx.AsyncClient` for the whole process** (`app/http_client.py`). Provider
  adapters call `self._client()` and must **never** wrap it in `async with` — that would
  close the shared pool. A client per request costs a full TLS handshake on every call,
  straight out of the user's time-to-first-token.
- **SSE responses set `X-Accel-Buffering: no`** and `Cache-Control: no-transform`. Without
  them, nginx and most CDNs buffer the whole stream and token streaming stops being
  streaming.
- **WebSocket generations are cancelled with `await`** (`_cancel_and_wait`). `Task.cancel()`
  alone only *requests* cancellation, so barge-in could otherwise interleave two answers
  onto the same socket.
- **Frames are acknowledged once, not per frame.** They arrive at up to 10 FPS and the
  client tracks its own stats, so per-frame acks were pure round-trip noise.

### Anthropic request shape

Claude 5-series models reject `temperature`/`top_p`/`top_k` with a 400, so the adapter omits
them for those models and steers behaviour by prompt instead. It also sends
`thinking: {"type": "disabled"}`: this is a real-time assistant where latency is the product,
and thinking tokens would otherwise share the `max_tokens` budget with the answer.

## Configuration

All settings are environment-driven with a `VA_` prefix (see `.env.example`). No provider
keys live here — VisionAssist is BYOK.

| Variable | Default | Purpose |
|----------|---------|---------|
| `VA_CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowed origins. |
| `VA_PROVIDER_TIMEOUT` | `60.0` | Upstream read timeout (seconds). |
| `VA_CONNECT_TIMEOUT` | `10.0` | Upstream connect timeout — fails fast on a dead network. |
| `VA_MAX_CONNECTIONS` | `100` | Connection-pool ceiling. |
| `VA_MAX_KEEPALIVE_CONNECTIONS` | `20` | Warm connections kept between requests. |
| `VA_KEEPALIVE_EXPIRY` | `60.0` | Seconds an idle pooled connection is retained. |
| `VA_WS_IDLE_TIMEOUT` | `300.0` | Close silent WebSocket sessions (frees the in-memory key). |
| `VA_LOG_LEVEL` | `INFO` | Log verbosity. |
| `VA_LOG_FORMAT` | `text` | `text` for humans, `json` for log aggregators. |
| `VA_MAX_BODY_BYTES` | `25165824` | Ceiling on a request body, enforced before buffering. |
| `VA_MAX_AUDIO_BYTES` | `26214400` | Largest STT upload (matches Whisper's limit). |
| `VA_MAX_TTS_CHARS` | `4096` | Longest text accepted for synthesis. |
| `VA_RATE_LIMIT_ENABLED` | `true` | Token-bucket limiting on `/chat` and `/voice`. |
| `VA_RATE_LIMIT_RPS` | `2` | Sustained requests/second per client. |
| `VA_RATE_LIMIT_BURST` | `20` | Burst allowance. |
| `VA_MAX_WS_SESSIONS_PER_CLIENT` | `8` | Concurrent WebSocket sessions per client. |
| `VA_TRUST_PROXY_HEADERS` | `false` | Honour `X-Forwarded-For`. Enable **only** behind a proxy that overwrites it. |
| `VA_AUTOMATION_ENABLED` | `false` | Enable the automation endpoints. Off by default. |
| `VA_AUTOMATION_HEADLESS` | `true` | Run the Playwright browser headless. |

## Layout

```
app/
├── main.py            # FastAPI app, CORS, lifespan (owns the pooled HTTP client)
├── config.py          # env-driven settings (no keys)
├── http_client.py     # shared pooled httpx.AsyncClient
├── schemas.py         # shared pydantic models + input limits
├── router.py          # ModelRouter — provider-agnostic dispatch
├── voice.py           # Whisper STT + OpenAI TTS
├── middleware.py      # raw ASGI: request context, body limits, rate limiting
├── rate_limit.py      # per-client token buckets
├── logging_config.py  # text/JSON formatters, request-ID injection
├── providers/         # one adapter per provider
│   ├── base.py
│   ├── anthropic_provider.py
│   ├── openai_provider.py
│   └── gemini_provider.py
├── automation/        # M4 — off unless VA_AUTOMATION_ENABLED
│   ├── schema.py          # ActionPlan: the validation boundary
│   ├── coordinates.py     # normalized [0,1] → pixel mapping
│   ├── prompt.py          # planning system prompt
│   ├── runner.py          # executes a plan, stops at first failure
│   └── playwright_page.py # optional-dependency browser launch
└── routes/            # health, chat, voice, ws, automation
```

Middleware is raw ASGI rather than `BaseHTTPMiddleware` on purpose: the latter buffers
responses through a memory stream, which would collapse SSE token deltas and streamed TTS
audio back into a single blob.

## Tests

```bash
pip install -r requirements-dev.txt
pytest --cov        # 156 tests, 85% coverage
ruff check . && mypy
```

Covers payload shaping, input validation, the WebSocket control plane, rate limiting,
request/body middleware, connection pooling, the automation schema and runner, and the
provider SSE parsers (against a mock transport). The error-redaction tests assert that a
rejected API key never appears in a surfaced error, on both the buffered and streaming
paths, and one test asserts that `/automation/plan` never launches a browser.

No test makes a network call, so no API key is needed.
