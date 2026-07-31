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
│   ├── VaultGate.tsx     # create / unlock screens
│   ├── Dashboard.tsx     # sidebar + workspace shell
│   ├── ModelSwitcher.tsx
│   ├── ApiKeyModal.tsx
│   └── TestConsole.tsx
└── lib/
    ├── crypto.ts         # Web Crypto AES-GCM primitives
    ├── vault.ts          # passphrase-locked key vault
    ├── providers.ts      # provider metadata
    └── api.ts            # backend client (chat + SSE stream)
```
