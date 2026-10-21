# Common tasks on Linux. Needs Python ≥ 3.14 with venv (the backend, until the Bun server replaces it), Bun ≥ 1.4, make.
# See README → Setup for installing those per OS.
PYTHON  ?= python3
PY      := backend/.venv/bin/python
ARGS    ?=

.PHONY: help check install browser build run run-python dev test test-backend test-server test-frontend test-e2e sim-session profile profile-node clean

help:
	@echo "make install        backend venv (editable, with dev extras) + the Bun workspace (processing, frontend)"
	@echo "make browser        download Playwright's Chromium for the browser test (only if you have no Chrome/Chromium)"
	@echo "make run            build the frontend, start the server on http://localhost:8000 (ARGS='--replay ...')"
	@echo "make dev            server :8000 + Vite dev server with hot reload on http://localhost:5173"
	@echo "make run-python     the same with the Python backend the server replaces (until it is removed)"
	@echo "make test           backend (pytest) + server, processing and frontend (typecheck, vitest) + browser end-to-end test"
	@echo "make sim-session    a simulated 3-sensor session in recordings/sim_rig3 (ARGS='folder seconds beams')"
	@echo "make profile        ms per scan of every pipeline step, three simulated sensors, in Bun (ARGS='beams scans')"
	@echo "make profile-node   the same in Node (for comparing the runtimes on a device)"
	@echo "make clean          remove build output and test artifacts"

install: backend/.venv/.installed node_modules/.installed

check:
	@$(PYTHON) -c "import sys; sys.exit(sys.version_info < (3, 14))" 2>/dev/null || \
	  { echo "error: need Python >= 3.14 as '$(PYTHON)' (or run: make PYTHON=/path/to/python3.14 ...)"; exit 1; }
	@$(PYTHON) -c "import ensurepip, venv" 2>/dev/null || \
	  { echo "error: Python's venv module is missing. Debian/Ubuntu: sudo apt install python3-venv"; exit 1; }
	@bun -e "const [a,b]=Bun.version.split('.').map(Number); process.exit(a>1||(a===1&&b>=4)?0:1)" 2>/dev/null || \
	  { echo "error: need Bun 1.4+ (found: $$(bun --version 2>/dev/null || echo none)), see README → Setup"; exit 1; }

backend/.venv/.installed: backend/pyproject.toml | check
	rm -rf backend/.venv
	$(PYTHON) -m venv backend/.venv
	$(PY) -m pip install -q --upgrade pip
	$(PY) -m pip install -q -e "backend[dev,preview]"
	@touch $@

node_modules/.installed: package.json processing/package.json server/package.json frontend/package.json bun.lock | check
	bun install --frozen-lockfile
	@touch $@

browser: install
	cd frontend && bun --bun run browser

build: install
	cd frontend && bun --bun run build

run: build
	bun server/src/main.ts $(ARGS)

run-python: build
	$(PY) -m mrs6000.server $(ARGS)

dev: install
	trap 'kill 0' EXIT; bun server/src/main.ts $(ARGS) & cd frontend && bun --bun run dev

test: test-backend test-server test-frontend test-e2e

test-backend: install
	$(PY) -m pytest backend

test-server: install
	cd server && bun --bun run typecheck && bun --bun run test

test-frontend: install
	cd processing && bun --bun run typecheck && bun --bun run test
	cd frontend && bun --bun run typecheck && bun --bun run test

test-e2e: build
	cd frontend && bun --bun run test:e2e

sim-session: install
	cd processing && bun scripts/simulate-session.ts $(ARGS)

profile: install
	cd frontend && bun scripts/profile-pipeline.ts $(ARGS)

profile-node: install
	cd frontend && bun build scripts/profile-pipeline.ts --target=node --outfile=node_modules/.cache/profile-pipeline.mjs \
	  && node node_modules/.cache/profile-pipeline.mjs $(ARGS)

clean:
	rm -rf frontend/dist frontend/e2e/artifacts backend/.pytest_cache
