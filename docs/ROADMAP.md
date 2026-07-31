# Development Roadmap

Small, incremental milestones. Each ships behind a clean interface so later milestones can
build on it without rework.

## Milestone 1 — Core Platform Setup & BYOK Infrastructure
- [ ] Next.js UI with dark-mode dashboard shell
- [ ] API Key Configuration Modal
- [ ] Client-side Web Crypto (AES-GCM) encryption vault in `localStorage`
- [ ] FastAPI backend skeleton (health, config)
- [ ] Model router to test provider responses (OpenAI, Anthropic, Gemini)

## Milestone 2 — Streaming Pipeline & Screen Capture
- [ ] `navigator.mediaDevices.getDisplayMedia()` capture
- [ ] HTML5 Canvas sampling pipeline @ 10 FPS
- [ ] Perceptual-hash / MSE frame-difference eviction engine
- [ ] Bi-directional WebSocket between Next.js and FastAPI

## Milestone 3 — Voice Integration & Interruption Management
- [ ] Browser audio recording via Web Audio API
- [ ] Silero VAD WebAssembly module in the client
- [ ] Server-side STT/TTS streaming pipeline
- [ ] Interrupt handler: client `cancel` frame purges audio buffers

## Milestone 4 — On-Screen Automation & Action Execution
- [ ] JSON action payload prompting template
- [ ] Normalized → pixel coordinate mapper
- [ ] Playwright runner (web automation)
- [ ] WebSocket bridge for local OS desktop actions (PyAutoGUI daemon)

## Milestone 5 — Polishing, Rate-Limiting & Deployment
- [ ] Client-side usage & token-cost tracking overlay
- [ ] Confirmation modal for high-risk autonomous actions
- [ ] Dockerize; deploy frontend (Vercel) + backend (Railway/Fly.io)
