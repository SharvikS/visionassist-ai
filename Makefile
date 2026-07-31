.PHONY: help install backend frontend test test-backend lint build

help:
	@echo "VisionAssist AI — common tasks"
	@echo "  make install       Install backend (venv) and frontend deps"
	@echo "  make backend       Run FastAPI orchestrator on :8000 (reload)"
	@echo "  make frontend      Run Next.js dev server on :3000"
	@echo "  make test          Run backend tests + frontend lint & build"

install:
	cd backend && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt
	cd frontend && npm install

backend:
	cd backend && . .venv/bin/activate && uvicorn app.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

test-backend:
	cd backend && . .venv/bin/activate && pytest -q

lint:
	cd frontend && npm run lint

build:
	cd frontend && npm run build

test: test-backend lint build
