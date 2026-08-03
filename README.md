# VisionAssist AI 🦾👁️

> **Real-time multimodal screen assistant — bring your own key.**

VisionAssist turns any browser tab or screen into an interactive visual agent. Share your
screen, talk to it, and get streamed answers about what's actually on it. Plug in your own
OpenAI, Anthropic, or Google key — the app has no server-side keys and no database.

Your keys are AES-256-GCM encrypted in the browser and sent only on active requests.

---

## Contents

- [Why VisionAssist](#why-visionassist)
- [Status](#status)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Performance design](#performance-design)
- [Supported models](#supported-models)
- [Configuration](#configuration)
- [Testing](#testing)
- [Security model](#security-model)
- [Roadmap](#roadmap)

---

## Why VisionAssist

| Principle | What it means in practice |
|-----------|---------------------------|
| 🔐 **BYOK, no database** | Keys are encrypted client-side with the Web Crypto API and held server-side only for the life of a request or socket. Nothing is persisted. |
| ⚡ **Real-time** | Token streaming over WebSockets, sentence-pipelined speech, and mid-sentence barge-in interruption. |
| 💸 **Token-efficient** | Smart Frame Eviction drops visually-identical frames, and surviving frames are downscaled before encoding — you pay for change, not for pixels. |
| 🤖 **Hot-swappable models** | One `ModelRouter` abstracts Claude, GPT, and Gemini behind a single streaming interface. Switch at runtime. |
| 🧱 **Boring to operate** | Two processes, no queue, no broker, no state store. |

---

## Status

All five milestones are complete and working end to end.

| | Milestone | State |
|---|---|---|
| ✅ | **M1** — Core platform & BYOK vault | Dashboard, Web Crypto vault, model router |
| ✅ | **M2** — Streaming pipeline & screen capture | `getDisplayMedia`, canvas sampling, frame eviction, WebSocket |
| ✅ | **M3** — Voice & interruption | Web Audio VAD, Whisper STT, pipelined TTS, barge-in |
| ✅ | **M4** — On-screen automation | Action schema, coordinate mapper, Playwright runner, approval queue |
| ✅ | **M5** — Polish, rate limiting & deploy | Cost overlay, rate limiting, strict CSP, Docker, CI |

**Quality gates.** 156 backend tests (85% coverage) and 111 frontend tests, with ruff,
strict mypy, eslint, and `tsc --noEmit` all clean. CI runs the lot on every push, plus a
Docker build that curls `/health` against a running container. Neither test suite touches
the network.

**On-screen automation is off by default** and web-only. See [Automation](#on-screen-automation-m4).

---

## Quick start

You need **Python 3.12+**, **Node 20+**, and at least one provider API key.

### 1. Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate    # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

API docs at http://localhost:8000/docs.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev      # http://localhost:3000
```

If the backend isn't on `http://localhost:8000`, set `NEXT_PUBLIC_API_URL` in
`frontend/.env.local`.

### 3. Use it

1. Create a vault passphrase (this encrypts your keys locally — it is never sent anywhere).
2. Add a provider key via **Manage API keys**.
3. **Share screen** to start capture, then ask about what's on it.
4. **Start voice** to talk instead. Voice needs an OpenAI key for STT and TTS regardless of
   which model answers.

`make install`, `make backend`, `make frontend`, and `make test` wrap these steps on
macOS, Linux, and Windows alike — the Makefile detects the platform's venv layout.

### Or: the whole stack in containers

```bash
docker compose up --build     # frontend :3000, backend :8000
```

Both images are multi-stage and run as a non-root user. `NEXT_PUBLIC_API_URL` is a
**build** arg, not a runtime one — Next inlines it into the client bundle — so it must be
a URL the browser can reach, not the compose service name.

---

## How it works

```
        ┌───────────────────────── CLIENT BROWSER ─────────────────────────┐
        │  Next.js 16 (App Router) + Tailwind v4                            │
        │   • MediaStream engine  (mic + getDisplayMedia)                   │
        │   • Canvas sampler @ 10 FPS → Smart Frame Eviction                │
        │   • Energy VAD (Silero-WASM ready)                                │
        │   • Sentence-pipelined TTS playback queue                         │
        │   • BYOK vault (Web Crypto AES-GCM)                               │
        └───────────────────────────────┬──────────────────────────────────┘
                                        │  WebSocket (full-duplex, JSON)
        ┌───────────────────────────────▼──────────────────────────────────┐
        │  FastAPI orchestrator (Python + asyncio)                          │
        │   • Per-connection session state (key in memory only)             │
        │   • ModelRouter → Anthropic / OpenAI / Gemini adapters            │
        │   • Pooled upstream HTTP client (shared, keep-alive)              │
        │   • Voice pipeline: Whisper STT + OpenAI TTS                      │
        └──────────────────────────────────────────────────────────────────┘
```

### The screen-vision loop

1. The canvas sampler grabs a 32×32 thumbnail of the current frame, ten times a second.
2. It compares that thumbnail to the previous one by mean-squared error. Below threshold,
   the frame is **evicted** and nothing else happens — no full-res draw, no encode, no send.
3. Surviving frames are downscaled to a 1536px long edge, JPEG-encoded asynchronously, and
   pushed over the socket. The server keeps only the most recent one.
4. When you ask a question, that latest frame plus your text goes to the model, and tokens
   stream back over the same socket.

### The voice loop

Mic → energy VAD segments an utterance → Whisper transcribes it → the LLM answers over the
WebSocket → each finished sentence is synthesized and played while the next one is still
generating. Speaking at any point cancels the in-flight generation and stops playback.

Full message contract: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## On-screen automation (M4)

Off unless `VA_AUTOMATION_ENABLED=true`. It is the only part of the service that *acts*
rather than answers, so it does not enable itself.

### The boundary

Actions run in a **Playwright browser this backend owns**. There is deliberately no
OS-level input path — no desktop daemon, no synthetic global mouse or keyboard events.
A model that has been prompt-injected by a hostile page can, at worst, drive the same
browser that is already showing it that page. Adding a desktop daemon would move the
blast radius from one browser tab to everything the user's account can do, and no
approval UI meaningfully compensates for that once a plan is approved.

### The flow

```
POST /automation/plan       model proposes  →  nothing runs
        ↓  human reads the plan, action by action
POST /automation/execute    approved: true  →  runs in a fresh browser context
```

Splitting these is the gate. `/plan` has no side effects at all (a test asserts it never
launches a browser), so the model's output stays inert until a person has read it.

### What bounds a plan

The producer is a model reading a screenshot that may have been authored by someone
hostile, so these are a security boundary, not input hygiene:

| Bound | Why |
|---|---|
| URL schemes allowlisted to http/https | `javascript:` is script execution; `file:` and `data:` read local or attacker-supplied content; the rest are OS handlers that launch other applications. |
| Keys allowlisted, not blocklisted | So a browser or OS shortcut can't be reached by omission. |
| 12 actions per plan | A 40-step plan is unreviewable, which defeats the gate it has to pass. |
| Re-validated at execute | Approval doesn't bypass the schema — an approved `javascript:` navigation is still rejected. |
| Fresh browser context per plan | No cookies or storage carry between runs. |
| Stops at first failure | Later actions were planned against a page state the failed one was meant to produce. |

The planning prompt states that page text is content, not instructions, and tells the
model to report rather than obey anything that looks like a command.

Coordinates are normalized `[0,1]`, never pixels: the model sees a screenshot downscaled
to a 1536px long edge, and normalized values are invariant to both that downscale and
device pixel ratio — so the mapping stays correct without the model knowing either, and
without a scale factor that can drift out of sync with the capture settings.

### Enabling it

Playwright is an optional dependency; the browser binaries dwarf the rest of the image,
so the endpoints return a clear 503 rather than failing at startup when it's absent.

```bash
cd backend
pip install -r requirements-automation.txt
python -m playwright install chromium
VA_AUTOMATION_ENABLED=true uvicorn app.main:app --port 8000
```

---

## Performance design

The bottlenecks in a system like this are all on hot paths that run continuously, so a few
choices here are load-bearing. If you change them, change them deliberately.

### Backend

| Concern | Approach |
|---|---|
| **Connection setup** | One process-wide pooled `httpx.AsyncClient` (`app/http_client.py`). A client per request costs a full TCP + TLS handshake before any prompt is sent — directly in time-to-first-token. Provider adapters call `self._client()` and must never wrap it in `async with`. |
| **Proxy buffering** | SSE responses set `X-Accel-Buffering: no` and `Cache-Control: no-transform`. Without them nginx and most CDNs buffer the whole stream, and token streaming silently stops being streaming. |
| **Interrupt correctness** | Generations are cancelled with `await` (`_cancel_and_wait`). `Task.cancel()` only *requests* cancellation, so without the await a barge-in can interleave two answers on one socket. |
| **Socket chatter** | Frames are acknowledged once per session, not per frame. At 10 FPS, per-frame acks were 10 wasted round trips a second. |
| **Abandoned sessions** | Idle WebSocket sessions close after `VA_WS_IDLE_TIMEOUT`, releasing the connection and the in-memory key. |
| **Middleware choice** | Request context, body limits, and rate limiting are raw ASGI, not `BaseHTTPMiddleware`. The latter buffers responses through a memory stream, which would turn SSE token deltas and TTS audio back into one blob. |

### Frontend

| Concern | Approach |
|---|---|
| **Main-thread stalls** | Encoding uses the async `canvas.toBlob`. The synchronous `toDataURL` blocks the main thread for tens of milliseconds per frame — ten times a second, that is visible jank. |
| **Wasted work** | The eviction check runs on a 32×32 thumbnail *before* any full-resolution draw, so discarded frames cost almost nothing. |
| **Token and bandwidth cost** | Frames are capped at a 1536px long edge before encoding. Screen shares are often 1440p or 4K; vision models gain nothing from those extra pixels for UI content, but you are billed for them. |
| **Backpressure** | Frames are dropped, never queued, while an encode is in flight or the socket's `bufferedAmount` is high. A stale frame is worthless; a backlog is harmful. |
| **Render churn** | Capture stats are throttled to ~4 updates/second instead of re-rendering the panel on every sampled frame. |
| **Speech latency** | `SpeechQueue` synthesizes sentence by sentence while the previous clip plays, instead of waiting for the full answer and then the full synthesis. |
| **Memory** | Audio object URLs are revoked as each clip finishes rather than accumulating for the tab's lifetime. |

---

## Supported models

Catalogs live in `backend/app/providers/*.py` and are mirrored in
`frontend/src/lib/providers.ts` — **keep the two in sync**.

| Provider | Models | Default |
|---|---|---|
| Anthropic | `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5` | `claude-sonnet-5` |
| OpenAI | `gpt-4.1`, `gpt-4.1-mini`, `gpt-4o`, `gpt-4o-mini` | `gpt-4.1` |
| Google | `gemini-2.0-flash`, `gemini-2.0-flash-lite`, `gemini-1.5-pro` | `gemini-2.0-flash` |

Two Anthropic-specific details the adapter handles for you: Claude 5-series models reject
`temperature`/`top_p`/`top_k` outright, so those are omitted for them; and the adapter sends
`thinking: {"type": "disabled"}`, because this is a real-time assistant where latency is the
product and thinking tokens would otherwise share the `max_tokens` budget with the answer.

---

## Configuration

### Backend (`backend/.env`, all prefixed `VA_`)

| Variable | Default | Purpose |
|---|---|---|
| `VA_CORS_ORIGINS` | `http://localhost:3000` | Comma-separated allowed origins. |
| `VA_PROVIDER_TIMEOUT` | `60.0` | Upstream read timeout (seconds). |
| `VA_CONNECT_TIMEOUT` | `10.0` | Upstream connect timeout. |
| `VA_MAX_CONNECTIONS` | `100` | Connection-pool ceiling. |
| `VA_MAX_KEEPALIVE_CONNECTIONS` | `20` | Warm connections kept between requests. |
| `VA_KEEPALIVE_EXPIRY` | `60.0` | Seconds an idle pooled connection is retained. |
| `VA_WS_IDLE_TIMEOUT` | `300.0` | Close silent WebSocket sessions. |
| `VA_LOG_LEVEL` | `INFO` | Log verbosity. |
| `VA_LOG_FORMAT` | `text` | `text` for humans, `json` for log aggregators. |
| `VA_MAX_BODY_BYTES` | `25165824` | Ceiling on a request body, enforced before buffering. |
| `VA_MAX_AUDIO_BYTES` | `26214400` | Largest STT upload (matches OpenAI's Whisper limit). |
| `VA_MAX_TTS_CHARS` | `4096` | Longest text accepted for synthesis. |
| `VA_RATE_LIMIT_ENABLED` | `true` | Token-bucket limiting on `/chat` and `/voice`. |
| `VA_RATE_LIMIT_RPS` | `2` | Sustained requests/second per client. |
| `VA_RATE_LIMIT_BURST` | `20` | Burst allowance. |
| `VA_MAX_WS_SESSIONS_PER_CLIENT` | `8` | Concurrent WebSocket sessions per client. |
| `VA_TRUST_PROXY_HEADERS` | `false` | Honour `X-Forwarded-For`. Enable **only** behind a proxy that overwrites it. |

No provider keys go here. See `backend/.env.example`.

Rate limiting is in-process. Behind multiple replicas each process enforces its own
bucket, so the effective limit multiplies by the replica count — limit at the load
balancer, or move the buckets to Redis, if that matters to you.

### Frontend (`frontend/.env.local`)

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | Backend origin. The WebSocket URL and the CSP `connect-src` allowlist are both derived from it — it is inlined at **build** time, so changing it requires a rebuild. |

---

## Testing

```bash
make test          # everything CI runs: lint, types, both suites, build

# or individually
cd backend  && pytest --cov          # 85 tests, 85% coverage
cd frontend && npm test              # 100 tests
cd frontend && npm run typecheck     # tsc --noEmit
```

**Backend** — payload shaping, input validation, the WebSocket control plane, rate
limiting, request/body middleware, connection pooling, and the provider SSE parsers
(against a mock transport). The error-redaction tests assert that a rejected API key never
appears in a surfaced error, on both the buffered and streaming paths.

**Frontend** — the framework-free libraries: frame eviction, the AES-GCM vault, the speech
queue's barge-in path, WebSocket reconnect/backpressure, and cost estimation. Vault tests
assert that neither a plaintext key nor the passphrase ever reaches `localStorage`.

Neither suite makes a network call, so no API key is needed and the whole thing runs in
seconds. `ruff check`, `mypy` (strict), `eslint`, and `tsc --noEmit` are all clean and
enforced in CI.

---

## Security model

- Keys are encrypted **in the browser** with AES-GCM (Web Crypto) under a passphrase-derived
  key before touching `localStorage`. The passphrase is never transmitted.
- Keys reach the server only on active requests — `X-Provider-Key` for HTTP, the `init`
  message for WebSocket sessions — and live in memory for that request or connection only.
  Nothing is written to disk or to a database.
- The Gemini adapter sends its key as a header rather than a query parameter, so keys don't
  land in proxy or access logs.
- Upstream `401`/`403` bodies are replaced with a fixed message rather than echoed, since
  providers sometimes quote the rejected credential back.
- Inbound payloads are size- and shape-limited at the edge (`app/schemas.py`), and request
  bodies are bounded *before* being buffered — Pydantic can only reject an oversized
  payload after Starlette has already read all of it into memory.
- A strict **Content-Security-Policy** is set in `next.config.ts`. `connect-src` is pinned
  to the single backend origin (plus its `ws`/`wss` form), so a compromised dependency
  cannot exfiltrate a decrypted API key to an arbitrary host.
- **Rate limiting** (token bucket, per client) fronts every endpoint that proxies a paid
  upstream call, and WebSocket sessions have their own concurrency cap since socket
  upgrades never traverse HTTP middleware.
- Every request carries an `X-Request-ID`, echoed on the response and attached to each log
  line, so a reported failure maps to an exact traceback.

**Run this over TLS in production.** Keys travel in request headers and WebSocket frames;
plain HTTP exposes them on the wire.

---

## Roadmap

- **M4 — On-screen automation.** JSON action schema, normalized→pixel coordinate mapper,
  Playwright runner, and an approval queue for high-risk actions. Not started — this is the
  one milestone still outstanding, and the confirmation-modal work is scoped with it since
  there are no autonomous actions to confirm until the runner exists.

Details in [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Repository layout

```
visionassist-ai/
├── frontend/           # Next.js 16 dashboard (vault, capture, voice, cost overlay)
│   └── Dockerfile      # multi-stage, standalone output, non-root
├── backend/            # FastAPI orchestrator (router, providers, voice, WebSocket)
│   └── Dockerfile      # multi-stage, venv-only runtime, non-root
├── docs/               # architecture + roadmap
├── .github/workflows/  # CI: lint, types, tests, build, Docker smoke test
├── docker-compose.yml  # full stack, healthchecked
└── Makefile            # install / run / test / docker shortcuts (all platforms)
```

## License

[MIT](LICENSE) © 2026 Sharvik
