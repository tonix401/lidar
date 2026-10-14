# Common tasks on Linux. Needs Python ≥ 3.14 with venv, Node ≥ 22.22, make.
# See README → Setup for installing those per OS.
PYTHON  ?= python3
PY      := backend/.venv/bin/python
ARGS    ?=

.PHONY: help check install browser build run dev test test-backend test-frontend test-e2e clean

help:
	@echo "make install        backend venv (editable, with dev extras) + frontend node_modules"
	@echo "make browser        download Playwright's Chromium for the browser test (only if you have no Chrome/Chromium)"
	@echo "make run            build the frontend, start the backend on http://localhost:8000 (ARGS='--replay ...')"
	@echo "make dev            backend :8000 + Vite dev server with hot reload on http://localhost:5173"
	@echo "make test           backend (pytest) + frontend (typecheck, vitest) + browser end-to-end test"
	@echo "make clean          remove build output and test artifacts"

install: backend/.venv/.installed frontend/node_modules/.installed

check:
	@$(PYTHON) -c "import sys; sys.exit(sys.version_info < (3, 14))" 2>/dev/null || \
	  { echo "error: need Python >= 3.14 as '$(PYTHON)' (or run: make PYTHON=/path/to/python3.14 ...)"; exit 1; }
	@$(PYTHON) -c "import ensurepip, venv" 2>/dev/null || \
	  { echo "error: Python's venv module is missing. Debian/Ubuntu: sudo apt install python3-venv"; exit 1; }
	@node -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>24||(a===24&&b>=15)||(a===22&&b>=22)?0:1)" 2>/dev/null || \
	  { echo "error: need Node.js 22.22+ or 24.15+ (found: $$(node --version 2>/dev/null || echo none)), see README → Setup"; exit 1; }

backend/.venv/.installed: backend/pyproject.toml | check
	rm -rf backend/.venv
	$(PYTHON) -m venv backend/.venv
	$(PY) -m pip install -q --upgrade pip
	$(PY) -m pip install -q -e "backend[dev,preview]"
	@touch $@

frontend/node_modules/.installed: frontend/package.json frontend/package-lock.json
	cd frontend && npm ci
	@touch $@

browser: install
	cd frontend && npm run browser

build: install
	cd frontend && npm run build

run: build
	$(PY) -m mrs6000.server $(ARGS)

dev: install
	trap 'kill 0' EXIT; $(PY) -m mrs6000.server $(ARGS) & cd frontend && npx vite

test: test-backend test-frontend test-e2e

test-backend: install
	$(PY) -m pytest backend

test-frontend: install
	cd frontend && npm run typecheck && npm test

test-e2e: build
	cd frontend && npm run test:e2e

clean:
	rm -rf frontend/dist frontend/e2e/artifacts backend/.pytest_cache
