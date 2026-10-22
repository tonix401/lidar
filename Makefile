# Common tasks on Linux. Needs Bun ≥ 1.4 and make.
# See README → Setup for installing those per OS.
ARGS    ?=
NAME    ?= default
OBJECTS := proc-servers/object-detection
# the object-detection servers: one per settings database data/<name>.db; "default" when there is none yet
OBJ_NAMES = $(sort $(basename $(notdir $(wildcard $(OBJECTS)/data/*.db))))

.PHONY: help check install browser build run run-source run-debug run-objects dev test test-layers test-libs test-source test-procs \
        test-clients test-e2e sim-session tracks profile profile-node empty-dbs clean

help:
	@echo "make install        the Bun workspace (libs, servers, clients)"
	@echo "make browser        download Playwright's Chromium for the browser test (only if you have no Chrome/Chromium)"
	@echo "make build          the three web pages (source server, debug client, object-detection client)"
	@echo "make run            the source server, the debug server and an object-detection server per database (ARGS: the source's)"
	@echo "                    first start: :8000, :8010, :8020; addresses, ports and the rest are settings on each server's page"
	@echo "make run-source     only the source server (ARGS='--offline')"
	@echo "make run-debug      only the debug server"
	@echo "make run-objects    only the object-detection server of data/\$$NAME.db (NAME=default; a new name is a new server)"
	@echo "make dev            the servers + Vite dev servers with hot reload: debug :5173, source :5174, objects :5175"
	@echo "make test           every project (typecheck, unit tests), the import rules and the browser end-to-end test"
	@echo "make sim-session    a simulated 3-sensor session in recordings/sim_rig3 (ARGS='folder seconds beams')"
	@echo "make tracks         a recording's fused tracks, the same to the byte every run (ARGS='sim_rig3 out.jsonl')"
	@echo "make profile        ms per scan of every pipeline step, three simulated sensors, in Bun (ARGS='beams scans')"
	@echo "make profile-node   the same in Node (for comparing the runtimes on a device)"
	@echo "make empty-dbs      write each server's committed empty.db anew from its defaults (after changing them)"
	@echo "make clean          remove build output and test artifacts"

check:
	@bun -e "const [a,b]=Bun.version.split('.').map(Number); process.exit(a>1||(a===1&&b>=4)?0:1)" 2>/dev/null || \
	  { echo "error: need Bun 1.4+ (found: $$(bun --version 2>/dev/null || echo none)), see README → Setup"; exit 1; }

install: node_modules/.installed

node_modules/.installed: package.json bun.lock $(wildcard libs/*/package.json source-server/package.json proc-servers/*/package.json clients/*/package.json) | check
	bun install --frozen-lockfile
	@touch $@

browser: install
	cd clients/debug && bun --bun run browser

build: install
	cd source-server && bun --bun run build
	cd clients/debug && bun --bun run build
	cd clients/object-detection && bun --bun run build

run: build
	@trap 'kill 0' EXIT; \
	bun source-server/src/main.ts $(ARGS) & sleep 1; \
	bun proc-servers/debug/src/main.ts & \
	for n in $(or $(OBJ_NAMES),default); do bun $(OBJECTS)/src/main.ts --db $(OBJECTS)/data/$$n.db & done; \
	wait

run-source: build
	bun source-server/src/main.ts $(ARGS)

run-debug: build
	bun proc-servers/debug/src/main.ts

run-objects: build
	bun $(OBJECTS)/src/main.ts --db $(OBJECTS)/data/$(NAME).db

# the Vite dev servers proxy to the addresses in the servers' databases (read when they start)
dev: install
	@trap 'kill 0' EXIT; \
	bun source-server/src/main.ts $(ARGS) & sleep 1; \
	bun proc-servers/debug/src/main.ts & \
	bun $(OBJECTS)/src/main.ts --db $(OBJECTS)/data/$(NAME).db & sleep 1; \
	(cd source-server/web && bun --bun x vite) & \
	(cd clients/object-detection && OBJECTS_DB=$(CURDIR)/$(OBJECTS)/data/$(NAME).db bun --bun x vite) & \
	cd clients/debug && bun --bun run dev

test: test-layers test-libs test-source test-procs test-clients test-e2e

test-layers: install
	bun test ./tests/layers.test.ts

test-libs: install
	for d in libs/processing libs/wire libs/server-common libs/web; do (cd $$d && bun --bun run typecheck && bun --bun run test) || exit 1; done

test-source: install
	cd source-server && bun --bun run typecheck && bun --bun run test

test-procs: install
	for d in proc-servers/debug proc-servers/object-detection; do (cd $$d && bun --bun run typecheck && bun --bun run test) || exit 1; done

test-clients: install
	for d in clients/debug clients/object-detection; do (cd $$d && bun --bun run typecheck && bun --bun run test) || exit 1; done

test-e2e: build
	cd clients/debug && bun --bun run test:e2e

sim-session: install
	bun libs/processing/scripts/simulate-session.ts $(ARGS)

tracks: install
	bun $(OBJECTS)/scripts/tracks.ts $(ARGS)

profile: install
	cd clients/debug && bun scripts/profile-pipeline.ts $(ARGS)

profile-node: install
	cd clients/debug && bun build scripts/profile-pipeline.ts --target=node --outfile=node_modules/.cache/profile-pipeline.mjs \
	  && node node_modules/.cache/profile-pipeline.mjs $(ARGS)

empty-dbs: install
	for d in source-server proc-servers/debug proc-servers/object-detection; do bun $$d/scripts/empty-db.ts || exit 1; done

clean:
	rm -rf source-server/web/dist clients/debug/dist clients/object-detection/dist clients/debug/e2e/artifacts
