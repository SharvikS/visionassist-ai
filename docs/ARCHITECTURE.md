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
| `Command Bridge` | Emits validated automation actions to Playwright or the local OS daemon. |

## Control-plane message contract (WebSocket)

All control messages are JSON with a `type` discriminator.

**Implemented today:**

| `type` | Direction | Purpose |
|--------|-----------|---------|
| `init` | client → server | Provider, model, BYOK key, and system prompt for this session. |
| `frame` | client → server | A visual frame (base64 JPEG) that survived eviction. Only the most recent is retained. |
| `prompt` | client → server | A user text/voice prompt cue. |
| `cancel` | client → server | Interrupt: halt the in-flight generation. |
| `ping` | client → server | Keep-alive; answered with `pong`. |
| `status` | server → client | `connected`, `ready`, `generating`, `interrupted`, `cancelled`, `idle_timeout`, and a single `frame_received` ack per session. |
| `token` | server → client | Streaming text token from the LLM. |
| `done` | server → client | Generation finished normally. |
| `error` | server → client | Validation or upstream failure; the session stays open. |
| `pong` | server → client | Reply to `ping`. |

**Planned (M4):**

| `type` | Direction | Purpose |
|--------|-----------|---------|
| `action` | server → client | Proposed automation action (see below). |

Audio does not cross this socket. STT and TTS use the `/voice/*` HTTP endpoints, which keeps
the control plane small and lets speech synthesis be pipelined per sentence on the client.

## Automation action schema

```json
{
  "action": "click",
  "target": "Submit Button",
  "coordinates": { "x": 0.45, "y": 0.72 },
  "explanation": "Clicking the submit button to post the form."
}
```

Coordinates are **normalized** floats in `[0,1]`; the coordinate mapper multiplies by the
captured surface's real pixel dimensions before dispatch. High-risk actions require explicit
user confirmation via the action approval queue.
