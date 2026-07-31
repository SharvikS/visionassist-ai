# VisionAssist AI 🦾👁️

> **Real-Time Multimodal Screen Assistant & Automation SaaS — Bring Your Own Key (BYOK)**

VisionAssist AI is a **privacy-first, web-based copilot** that turns any browser tab or
screen into an interactive visual agent. Plug in your own API keys (OpenAI, Anthropic, or
Gemini) and get **real-time voice, live vision analysis, and automated on-screen action
execution** directly over your screen-sharing feed.

Your keys never touch our database — they are AES-256 encrypted client-side and passed only
on active requests.

---

## ✨ Why VisionAssist

| Principle | What it means |
|-----------|---------------|
| 🔐 **BYOK & Privacy-first** | Keys are encrypted in your browser with the Web Crypto API. Never persisted server-side. |
| ⚡ **Real-time** | Full-duplex voice + streaming vision over WebSockets, with mid-sentence interruption. |
| 💸 **Token-efficient** | Smart Frame Eviction drops visually-identical frames so you only pay for changes. |
| 🤖 **Hot-swappable models** | Switch between Claude, GPT, and Gemini on the fly for the right cost/latency/quality tradeoff. |
| 🖱️ **Autonomous actions** | Vision models ground UI targets to coordinates; Playwright / a local daemon execute them. |

---

## 🏗️ Architecture

```
        ┌───────────────────────── CLIENT BROWSER ─────────────────────────┐
        │  Next.js 15 (App Router) + Tailwind + Lucide                      │
        │   • MediaStream Engine  (mic + getDisplayMedia)                   │
        │   • Canvas frame sampler (10 FPS)                                 │
        │   • Smart Frame Eviction (MSE / perceptual hash)                  │
        │   • Client-side VAD (Silero WASM)                                 │
        │   • BYOK Vault (Web Crypto AES-GCM)                               │
        └───────────────────────────────┬──────────────────────────────────┘
                                         │  WebSocket / WebRTC (full-duplex)
        ┌───────────────────────────────▼──────────────────────────────────┐
        │  FastAPI Orchestrator (Python + asyncio)                          │
        │   • Encrypted BYOK Key Manager                                    │
        │   • Multimodal Streaming Pipeline (STT → Vision LLM → TTS)        │
        │   • Multi-provider model router                                   │
        └───────────────────────────────┬──────────────────────────────────┘
                                         │  Command Bridge
        ┌───────────────────────────────▼──────────────────────────────────┐
        │  Automation Target — Playwright (web) / PyAutoGUI daemon (OS)     │
        └───────────────────────────────────────────────────────────────────┘
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design.

---

## 🧰 Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS v4 + Lucide Icons |
| Client A/V | HTML5 Canvas, Web Audio API, Silero VAD (WASM) |
| Transport | WebSockets / WebRTC (aiortc) |
| Backend | Python 3.12+, FastAPI, asyncio |
| Security | Web Crypto API (AES-GCM) |
| Automation | Playwright / PyAutoGUI |

---

## 📁 Repository Layout

```
visionassist-ai/
├── frontend/     # Next.js 15 dashboard (BYOK vault, workspace, streaming client)
├── backend/      # FastAPI orchestrator (model router, streaming pipeline)
├── docs/         # Architecture, roadmap, API contracts
└── README.md
```

---

## 🚀 Getting Started

> ⚠️ Early development — milestones are landing incrementally. See the roadmap below.

### Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev   # http://localhost:3000
```

---

## 🗺️ Roadmap

- [ ] **M1 — Core Platform & BYOK** · dashboard UI, Web Crypto vault, model router
- [ ] **M2 — Streaming Pipeline & Screen Capture** · getDisplayMedia, canvas sampling, frame eviction, WS
- [ ] **M3 — Voice & Interruption** · Web Audio, Silero VAD, STT/TTS streaming, interrupt handler
- [ ] **M4 — On-Screen Automation** · JSON action schema, coordinate mapper, Playwright runner
- [ ] **M5 — Polish, Rate-limiting & Deploy** · cost overlay, confirmation modals, Docker, Vercel + Fly.io

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for details.

---

## 🔒 Security Model

- API keys are encrypted **client-side** using AES-GCM (Web Crypto API) before touching `localStorage`.
- Keys are transmitted only on active requests via encrypted headers and are **never written to a backend database**.
- The backend holds keys only in-memory for the lifetime of a request/session.

---

## 📄 License

[MIT](LICENSE) © 2026 Sharvik
