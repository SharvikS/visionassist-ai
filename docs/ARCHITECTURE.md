# Architecture

VisionAssist AI is a two-tier real-time system: a **Next.js client** that owns all media
capture, encryption, and low-latency signal processing, and a **FastAPI orchestrator** that
brokers streaming multimodal calls to the user's chosen LLM provider and drives automation.

## Design principles

1. **The key never leaves the user's control.** Encryption/decryption happens in the browser
   (Web Crypto, AES-GCM). The server sees a plaintext key only for the duration of an active
   provider request, held in memory, never persisted.
2. **Pay only for change.** Screen frames are diffed client-side; visually-identical frames are
   evicted before they ever cost a vision token.
3. **Full-duplex, interruptible.** Voice in and voice out run concurrently. A client-side VAD
   trigger sends a `CANCEL` control frame that purges TTS buffers and halts server generation.
4. **Provider-agnostic core.** A single `ModelRouter` abstracts OpenAI / Anthropic / Gemini
   behind one streaming interface so models are hot-swappable at runtime.

## Client (Next.js 16)

| Module | Responsibility |
|--------|----------------|
| `MediaStream Engine` | Acquires mic audio + `getDisplayMedia()` screen stream. |
| `Canvas Sampler` | Samples the video stream at ~10 FPS. Diffs a 32×32 thumbnail first and only draws/encodes the full frame when it survives eviction. |
| `Smart Frame Eviction` | Computes the grayscale-signature MSE delta between consecutive frames; drops stagnant ones. |
| `VAD` | Detects speech onset/offset in-browser to gate audio and trigger interrupts. Currently an energy (RMS) detector behind a callback interface a Silero-WASM model can replace. |
| `SpeechQueue` | Synthesizes and plays assistant speech sentence by sentence, overlapping synthesis with generation. |
| `BYOK Vault` | AES-GCM encrypt/decrypt of provider keys; stored in `localStorage`. |
| `Transport` | WebSocket (control + JSON) full-duplex channel, with reconnect and send-buffer backpressure. |

## Server (FastAPI)

| Module | Responsibility |
|--------|----------------|
| `Key Manager` | Receives the per-request key via encrypted header; keeps it in-memory only. |
| `Model Router` | Normalizes chat/vision/stream calls across providers. |
| `Streaming Pipeline` | STT → Vision LLM → TTS orchestration with backpressure + cancellation. |
| `Command Bridge` | Validates model-proposed action plans and executes approved ones in a Playwright browser this backend owns. There is no OS-level input path — see [Automation](#automation). |

## Control-plane message contract (WebSocket)

All control messages are JSON with a `type` discriminator.

| `type` | Direction | Purpose |
|--------|-----------|---------|
| `init` | client → server | Session setup: `provider`, `model`, `apiKey`, and optional `system`. |
| `frame` | client → server | A visual frame (base64 JPEG) that survived eviction. Only the most recent is retained. |
| `prompt` | client → server | A user text/voice prompt cue. |
| `cancel` | client → server | Interrupt: halt the in-flight generation. |
| `ping` | client → server | Keep-alive; answered with `pong`. |
| `status` | server → client | Session state; see below. |
| `token` | server → client | Streaming text token from the LLM. |
| `done` | server → client | Generation finished normally. |
| `error` | server → client | Validation or upstream failure; the session stays open. |
| `pong` | server → client | Reply to `ping`. |

Note that `init` takes **`apiKey`** in camelCase. The socket contract is camelCase because
it is written and read by the browser client; the HTTP API is snake_case. An `init`
carrying `api_key` is not an error — it leaves the session unconfigured, and the `status`
reply says so.

### `status` states

| State | Meaning |
|---|---|
| `connected` | Socket accepted. Sent before any `init`. |
| `ready` | `init` supplied provider, model, and key. The session can generate. |
| `unconfigured` | `init` was received but one of those three was missing or empty. |
| `error` | `init` named a provider the router doesn't know; an `error` message precedes it. |
| `generating` | A generation is in flight. |
| `interrupted` | A new prompt arrived and cancelled the previous generation (barge-in). |
| `cancelled` | An explicit `cancel` stopped the generation. |
| `frame_received` | Sent **once per session**, not per frame — at 10 FPS, per-frame acks were 10 wasted round trips a second. |
| `idle_timeout` | The session was silent for `VA_WS_IDLE_TIMEOUT` and is closing, freeing the in-memory key. |

Audio does not cross this socket. STT and TTS use the `/voice/*` HTTP endpoints, which keeps
the control plane small and lets speech synthesis be pipelined per sentence on the client.

Automation does not cross it either. An earlier draft of M4 planned a server → client
`action` message; the shipped design uses two HTTP endpoints instead, because approval is
a request/response interaction with a human in the middle, not a stream. A pushed action
frame would have arrived unsolicited and needed its own correlation and approval protocol
layered back on top of the socket.

## Automation

Off unless `VA_AUTOMATION_ENABLED=true`. It is the only part of the service that *acts*
rather than answers, so it does not enable itself.

### The flow

```
POST /automation/plan       model proposes  →  nothing runs
        ↓  human reads the plan, action by action
POST /automation/execute    approved: true  →  runs in a fresh browser context
```

Splitting these is the gate: `/plan` has no side effects at all, so the model's output
stays inert until a person has read it and posted it back.

### Action plan schema

A plan is a `goal` plus up to 12 actions, each discriminated by `type`:

```json
{
  "goal": "Search the docs for the rate-limit settings",
  "actions": [
    { "type": "navigate", "url": "https://example.com/docs",
      "reason": "The docs search lives here." },
    { "type": "click", "x": 0.45, "y": 0.72,
      "reason": "Focus the search box." },
    { "type": "type", "text": "rate limit", "selector": "#search",
      "reason": "Enter the query." },
    { "type": "press", "key": "Enter", "reason": "Submit the search." }
  ]
}
```

The seven action types are `navigate`, `click`, `type`, `press`, `scroll`, `wait`, and
`screenshot`. The last three are `LOW` risk (observational); the rest are `HIGH` (they
change state) and are never pre-checked in the approval UI.

An **empty** `actions` list is valid and meaningful — the prompt tells the model to return
one when the goal is already met or it cannot see what it needs. Rejecting empty would
conflate a deliberate no-op with malformed output.

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

Actions run in a **Playwright browser this backend owns**. There is deliberately no
OS-level input path — no desktop daemon, no synthetic global mouse or keyboard events. A
model that has been prompt-injected by a hostile page can, at worst, drive the same browser
that is already showing it that page.

### Coordinates

Click coordinates are **normalized** floats in `[0,1]`, never pixels; the mapper multiplies
by the viewport's real pixel dimensions at execution time. The model sees a screenshot
downscaled to a 1536px long edge, and normalized values are invariant to both that
downscale and device pixel ratio — so the mapping stays correct without the model knowing
either, and without a scale factor that can drift out of sync with capture settings.
