# VisionAssist AI — Backend

FastAPI orchestrator. Provider-agnostic model router over OpenAI, Anthropic, and Gemini.
**BYOK**: the client sends its provider key in the `X-Provider-Key` header per request; the
server never persists it.

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

### Example

```bash
curl -s http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -H "X-Provider-Key: $ANTHROPIC_API_KEY" \
  -d '{
        "provider": "anthropic",
        "model": "claude-3-5-sonnet-20241022",
        "messages": [{"role": "user", "text": "Say hi in 3 words."}]
      }'
```

## Layout

```
app/
├── main.py            # FastAPI app + CORS
├── config.py          # env-driven settings (no keys)
├── schemas.py         # shared pydantic models
├── router.py          # ModelRouter — provider-agnostic dispatch
├── providers/         # one adapter per provider
│   ├── base.py
│   ├── anthropic_provider.py
│   ├── openai_provider.py
│   └── gemini_provider.py
└── routes/            # health + chat HTTP routes
```

## Tests

```bash
pip install pytest
pytest
```
