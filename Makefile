.PHONY: help install install-backend install-frontend backend frontend \
        test test-backend test-frontend lint lint-backend lint-frontend \
        typecheck coverage build docker-build docker-up docker-down clean

# The venv layout differs by platform: POSIX puts executables in bin/, Windows in
# Scripts/. Detect once so every target below works on both — the previous version
# hard-coded `. .venv/bin/activate` and could not run on Windows at all.
ifeq ($(OS),Windows_NT)
    VENV_BIN := .venv/Scripts
    PY       := python
else
    VENV_BIN := .venv/bin
    PY       := python3
endif

help:
	@echo "VisionAssist AI — common tasks"
	@echo ""
	@echo "  make install        Install backend (venv) and frontend deps"
	@echo "  make backend        Run FastAPI orchestrator on :8000 (reload)"
	@echo "  make frontend       Run Next.js dev server on :3000"
	@echo ""
	@echo "  make test           Everything CI runs: lint, types, tests, build"
	@echo "  make test-backend   pytest"
	@echo "  make test-frontend  vitest"
	@echo "  make lint           ruff + eslint"
	@echo "  make typecheck      mypy + tsc"
	@echo "  make coverage       Coverage reports for both sides"
	@echo ""
	@echo "  make docker-build   Build both container images"
	@echo "  make docker-up      Run the full stack via docker compose"
	@echo "  make docker-down    Stop the stack"

# -- setup -----------------------------------------------------------------

install: install-backend install-frontend

install-backend:
	cd backend && $(PY) -m venv .venv
	cd backend && $(VENV_BIN)/python -m pip install --upgrade pip
	cd backend && $(VENV_BIN)/python -m pip install -r requirements-dev.txt

install-frontend:
	cd frontend && npm install

# -- run -------------------------------------------------------------------

backend:
	cd backend && $(VENV_BIN)/uvicorn app.main:app --reload --port 8000

frontend:
	cd frontend && npm run dev

# -- quality gates ---------------------------------------------------------

lint: lint-backend lint-frontend

lint-backend:
	cd backend && $(VENV_BIN)/ruff check .

lint-frontend:
	cd frontend && npm run lint

typecheck:
	cd backend && $(VENV_BIN)/mypy
	cd frontend && npm run typecheck

test-backend:
	cd backend && $(VENV_BIN)/pytest

test-frontend:
	cd frontend && npm test

coverage:
	cd backend && $(VENV_BIN)/pytest --cov --cov-report=term-missing
	cd frontend && npm run test:coverage

build:
	cd frontend && npm run build

# Mirrors the CI pipeline, so a green `make test` means a green CI run.
test: lint typecheck test-backend test-frontend build

# -- containers ------------------------------------------------------------

docker-build:
	docker compose build

docker-up:
	docker compose up --build

docker-down:
	docker compose down

clean:
	cd frontend && rm -rf .next coverage
	cd backend && rm -rf .pytest_cache .mypy_cache .ruff_cache htmlcov .coverage coverage.xml
