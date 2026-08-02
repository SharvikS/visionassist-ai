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

Milestones 1–3 are complete and working end to end. Milestones 4–5 are not built yet.

| | Milestone | State |
|---|---|---|
| ✅ | **M1** — Core platform & BYOK vault | Dashboard, Web Crypto vault, model router |
| ✅ | **M2** — Streaming pipeline & screen capture | `getDisplayMedia`, canvas sampling, frame eviction, WebSocket |
| ✅ | **M3** — Voice & interruption | Web Audio VAD, Whisper STT, pipelined TTS, barge-in |
| ⬜ | **M4** — On-screen automation | Action schema, coordinate mapper, Playwright runner |
| ⬜ | **M5** — Polish, rate limiting & deploy | Cost overlay, confirmation modals, Docker, hosting |

The dashboard shows M4 as a placeholder panel. Anything below is real unless marked otherwise.

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

On macOS and Linux, `make install`, `make backend`, `make frontend`, and `make test` wrap
these steps.

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

No provider keys go here. See `backend/.env.example`.

### Frontend (`frontend/.env.local`)

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:8000` | Backend origin (the WebSocket URL is derived from it). |

---

## Testing

```bash
cd backend  && pytest        # API, WS control plane, provider payloads, HTTP pooling
cd frontend && npm run lint && npm run build
```

`make test` runs all three.

Tests cover payload shaping, input validation, WebSocket protocol behaviour, and the pooled
client — none of them make live provider calls, so no API key is needed.

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
- Inbound payloads are size- and shape-limited at the edge (`app/schemas.py`).
- Security headers are set in `next.config.ts`. A strict CSP is deliberately deferred to M5,
  where the deployed API origin is known.

**Run this over TLS in production.** Keys travel in request headers and WebSocket frames;
plain HTTP exposes them on the wire.

---

## Roadmap

- **M4 — On-screen automation.** JSON action schema, normalized→pixel coordinate mapper,
  Playwright runner, and an approval queue for high-risk actions.
- **M5 — Polish & deploy.** Live cost overlay, confirmation modals, rate limiting, strict
  CSP, Docker images, and hosted deployment.

Details in [`docs/ROADMAP.md`](docs/ROADMAP.md).

---

## Repository layout

```
visionassist-ai/
├── frontend/     # Next.js 16 dashboard (vault, capture, voice, streaming client)
├── backend/      # FastAPI orchestrator (router, providers, voice, WebSocket)
├── docs/         # architecture + roadmap
└── Makefile      # install / run / test shortcuts (macOS + Linux)
```

## License

[MIT](LICENSE) © 2026 Sharvik
