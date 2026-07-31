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

## Client (Next.js 15)

| Module | Responsibility |
|--------|----------------|
| `MediaStream Engine` | Acquires mic audio + `getDisplayMedia()` screen stream. |
| `Canvas Sampler` | Draws the video stream to an offscreen canvas at ~10 FPS, extracts frame buffers. |
| `Smart Frame Eviction` | Computes MSE / perceptual-hash delta between consecutive frames; drops stagnant ones. |
| `VAD (Silero WASM)` | Detects speech onset/offset in-browser to gate audio and trigger interrupts. |
| `BYOK Vault` | AES-GCM encrypt/decrypt of provider keys; stored in `localStorage`. |
| `Transport` | WebSocket (control + JSON) and/or WebRTC (media) full-duplex channel. |

## Server (FastAPI)

| Module | Responsibility |
|--------|----------------|
| `Key Manager` | Receives the per-request key via encrypted header; keeps it in-memory only. |
| `Model Router` | Normalizes chat/vision/stream calls across providers. |
| `Streaming Pipeline` | STT → Vision LLM → TTS orchestration with backpressure + cancellation. |
| `Command Bridge` | Emits validated automation actions to Playwright or the local OS daemon. |

## Control-plane message contract (WebSocket)

All control messages are JSON with a `type` discriminator:

| `type` | Direction | Purpose |
|--------|-----------|---------|
| `frame` | client → server | A visual frame (base64 JPEG) that survived eviction. |
| `audio` | client → server | An audio chunk (PCM/opus) for STT. |
| `prompt` | client → server | A user text/voice prompt cue. |
| `cancel` | client → server | Interrupt: purge TTS + halt generation. |
| `token` | server → client | Streaming text token from the LLM. |
| `tts` | server → client | Streaming audio chunk. |
| `action` | server → client | Proposed automation action (see below). |
| `status` | server → client | Pipeline / usage / error status. |

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
