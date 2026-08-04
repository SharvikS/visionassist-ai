# VisionAssist AI — Frontend

Next.js 16 (App Router) dashboard. Dark-mode workspace, BYOK encrypted key vault, and a
hot-swappable model switcher that talks to the FastAPI orchestrator.

## Run

```bash
npm install
cp .env.example .env.local   # point NEXT_PUBLIC_API_URL at your backend
npm run dev                  # http://localhost:3000
```

The backend must be running (default `http://localhost:8000`) for the Model Test Console.

## What's implemented (Milestone 1)

- **BYOK Vault** — passphrase-locked, AES-256-GCM (Web Crypto) encryption of provider keys.
  Keys are stored only as ciphertext in `localStorage`; the derived key lives in memory for
  the unlocked session. See `src/lib/crypto.ts` and `src/lib/vault.ts`.
- **Vault gate** — first-run creation + unlock screens (`src/components/VaultGate.tsx`).
- **API Key modal** — add/replace/remove keys per provider (`src/components/ApiKeyModal.tsx`).
- **Model switcher** — hot-swap Anthropic / OpenAI / Gemini and their models.
- **Model Test Console** — streams a live completion through the backend router to verify a
  provider + key end-to-end (`src/components/TestConsole.tsx`).

## What's implemented (Milestone 2)

- **Screen capture** — `getDisplayMedia` + a 10 FPS canvas sampler (`src/lib/capture.ts`).
- **Smart Frame Eviction** — grayscale-signature + MSE differencing drops visually-identical
  frames before they cost vision tokens (`src/lib/frame-eviction.ts`).
- **Full-duplex WebSocket** — `SessionSocket` over `/ws/session`, with exponential-backoff
  reconnect and a `canSendFrame` backpressure signal (`src/lib/ws.ts`).
- **Screen Vision panel** — live preview, eviction stats, and ask-about-your-screen streaming
  with an interrupt button (`src/components/ScreenCapturePanel.tsx`).

## What's implemented (Milestone 3)

- **Voice session** — mic capture + energy-based VAD segmenting utterances (`src/lib/voice-session.ts`).
  The VAD is behind a VAD-agnostic interface so a Silero-WASM detector can drop in later.
- **STT/TTS client** — Whisper transcription + OpenAI speech synthesis (`src/lib/voice-api.ts`).
- **Sentence-pipelined playback** — `SpeechQueue` synthesizes each sentence while the previous
  one plays, so speech starts about a sentence into generation instead of after the whole
  answer (`src/lib/speech-queue.ts`).
- **Voice panel** — speak → transcribe → LLM answer over WS → spoken reply, with a live mic
  meter and **barge-in interruption** (talking cancels the in-flight answer and stops playback)
  (`src/components/VoicePanel.tsx`). Voice uses your OpenAI key for STT + TTS.

## What's implemented (Milestone 4)

- **Automation client** — typed mirror of the backend action schema (`src/lib/automation.ts`).
  The types are a deliberate mirror rather than a loose `unknown`: the approval UI renders
  these fields to a human deciding whether to let them run, so a shape change that silently
  drops a field from the review is a safety regression, not a cosmetic one.
- **Approval queue** — every plan is reviewed action by action before anything runs
  (`src/components/AutomationPanel.tsx`). Plan and execute are separate round trips; the
  `approved` flag is passed explicitly at the call site so the gate is visible in the code,
  not implied by which function was called.
- State-changing actions (`navigate`, `click`, `type`, `press`) are flagged `high` risk and
  are never pre-selected. Automation is **off** unless the backend sets
  `VA_AUTOMATION_ENABLED=true`, and returns a clear 503 otherwise.

## What's implemented (Milestone 5)

- **Usage & cost overlay** — live per-session token and USD estimates
  (`src/lib/cost.ts`, `src/components/UsageOverlay.tsx`, `src/components/usage-context.tsx`).
  These are explicitly *estimates*: the streaming path doesn't surface upstream token
  counts, so it counts characters and applies a ratio. `PRICING_AS_OF` makes a stale price
  table visible rather than silent. A screen-sharing assistant can run up a bill quickly
  and invisibly — a rough number that is obviously rough beats no number.
- **Strict CSP + security headers** in `next.config.ts`. `connect-src` is pinned to the
  single backend origin (plus its `ws`/`wss` form), so a compromised dependency can't
  exfiltrate a decrypted key to an arbitrary host.

## Hot-path notes

The capture loop runs 10× a second on the main thread, so the ordering in `capture.ts` is
deliberate — keep it if you touch that file:

1. Draw a 32×32 thumbnail and diff it. This is the only work every tick pays.
2. Return immediately if the frame is evicted (the common case on a static screen).
3. Only for surviving frames: draw the full frame **downscaled to a 1536px long edge** and
   encode it with the async `canvas.toBlob`.

Two things that look harmless but are not: drawing the full-resolution frame before the
eviction check (wasted work on every discarded frame), and `canvas.toDataURL` (synchronous —
it blocks the main thread for tens of milliseconds per frame and visibly janks the UI).

Frames are also dropped rather than queued while a previous encode is in flight or the socket
buffer is backed up. A stale frame has no value; a growing backlog actively hurts.

## Structure

```
src/
├── app/
│   ├── layout.tsx        # dark theme + fonts + metadata
│   ├── page.tsx          # renders <AppRoot/>
│   └── globals.css       # design tokens
├── components/
│   ├── AppRoot.tsx       # vault-state router (gate vs dashboard)
│   ├── vault-context.tsx # React context over the vault
│   ├── usage-context.tsx # React context over session usage
│   ├── VaultGate.tsx     # create / unlock screens
│   ├── Dashboard.tsx     # sidebar + workspace shell
│   ├── ErrorBoundary.tsx
│   ├── ModelSwitcher.tsx
│   ├── ApiKeyModal.tsx
│   ├── ScreenCapturePanel.tsx
│   ├── VoicePanel.tsx
│   ├── AutomationPanel.tsx  # plan review + approval queue
│   ├── UsageOverlay.tsx     # live token/cost estimate
│   └── TestConsole.tsx
└── lib/
    ├── crypto.ts         # Web Crypto AES-GCM primitives
    ├── vault.ts          # passphrase-locked key vault
    ├── providers.ts      # provider metadata
    ├── capture.ts        # screen sampler + eviction hot path
    ├── frame-eviction.ts # DOM-free signature/MSE helpers
    ├── voice-session.ts  # mic capture + VAD
    ├── voice-api.ts      # STT/TTS client
    ├── speech-queue.ts   # sentence-pipelined TTS playback
    ├── automation.ts     # automation client + action types
    ├── cost.ts           # pricing table + cost estimation
    ├── ws.ts             # WebSocket session client
    └── api.ts            # backend client (chat + SSE stream)
```

## Tests

```bash
npm test           # 111 tests (vitest)
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
```

The suite covers the framework-free libraries — frame eviction, the AES-GCM vault, the
speech queue's barge-in path, WebSocket reconnect/backpressure, action-plan risk
classification, and cost estimation. Vault tests assert that neither a plaintext key nor
the passphrase ever reaches `localStorage`. Nothing makes a network call, so no API key is
needed.
