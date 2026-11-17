# Plan: containerize the servers, then split them into projects

Goal: run the source server, the debug server and the object-detection server as separate Docker containers, then (optionally) make each a separate project with the shared libraries installed as packages.

## Findings from reading the code

- **Sensor link:** a plain outbound TCP connection (`node:net` in `source-server/src/cola.ts`), with no UDP discovery. Bridge networking works, so `network_mode: host` is not needed.
- **Dependencies:** SQLite and zstd are built into Bun (`bun:sqlite`, `Bun.zstd`), so the images need no native packages. The servers have no third-party runtime dependencies and run TypeScript directly, with no build step. Only the web pages need a Vite build.
- **Paths:** `recordings` and `cache` are settings resolved as `resolve(REPO, value)` (`source-server/src/settings.ts:15`, `proc-servers/object-detection/src/settings.ts:19`). An absolute path such as `/data/recordings` already overrides the repo root, so those need only a seeded value.
- **Already independent:** `tests/layers.test.ts` enforces that each project imports only the four libs (`processing`, `wire`, `server-common`, `web`) and never another project.

## Blockers for a clean split

| Coupling | Where | Fix |
|---|---|---|
| Libs export raw `.ts` via `"./*": "./src/*.ts"` and are `private` | `libs/*/package.json` | Publish as-is: Bun runs TS from `node_modules`. Verify that Vite transpiles it. |
| Proc servers serve `clients/*/dist` through repo-relative paths | `proc-servers/*/src/main.ts:22-23` | Move each client into its server's project, as the source server already does with `web/`. Make the web root a setting. |
| `REPO` is used for recordings and track-cache roots | `source-server/src/main.ts:28`, object-detection `cacheRoot(REPO, …)` | A `DATA_DIR` env var, plus absolute paths in the settings. |
| `empty.db` and `data/*.db` are resolved relative to the source tree | `main.ts` in all three servers | The same `DATA_DIR` approach. |
| Test helpers reach across projects | `libs/server-common/src/testing.ts:13` (`../../../source-server/src/main.ts`), the e2e test, `clients/debug` using `server-common` in tests, and Vite configs calling `libs/server-common/scripts/listen.ts` | Move `testing.ts` out of the shared lib. Use an env var for the dev proxy target. |
| The debug client bundles `processing` for its browser workers | `clients/debug` | Fine as a normal dependency. The debug server and its client are versioned together. |

## Phase A: Docker in the monorepo

Estimated agent time: about 30–60 minutes, plus 15–30 minutes of review.

### A1. Make paths configurable
Do the same in all three `main.ts` files.
- Add an optional `WEB_DIR` env var. It overrides `clients/*/dist` in the two proc servers (`main.ts:22-23`) and `web/dist` in the source server (`main.ts:29`). Without it, nothing changes.
- Add a `DATA_DIR` env var that sets the default `--db` to `$DATA_DIR/<name>.db`, replacing `resolve(HERE, "data/…")`.
- `empty.db` stays next to the code, so the template copy still works.
- Update the `--help` text and `docs/setup.md`.

### A2. Make the first start container-friendly
The committed `empty.db` listens on `127.0.0.1`, so a mapped port would be unreachable.
- Add an entrypoint step: if `$DATA_DIR/<name>.db` does not exist, run `libs/server-common/scripts/seed.ts` with `{"host":"0.0.0.0", "port":…, "recordings":"/data/recordings"}`. For the proc servers, also seed `"source": {"url": "http://source:8000", "token": ""}`. Confirm the exact settings key names against each server's `settings.ts` while implementing.
- Existing DBs are never overwritten, so settings edited on the page persist in the volume.

### A3. Dockerfiles
Three Dockerfiles: `source-server/Dockerfile`, `proc-servers/debug/Dockerfile`, `proc-servers/object-detection/Dockerfile`. They share one pattern and use the repo root as the build context, because the workspace needs `libs/`.
- Stage 1 is `oven/bun:1.4`. It copies the workspace manifests and `bun.lock`, then runs `bun install --frozen-lockfile`.
- It copies the sources and runs `vite build` for that server's page.
- The runtime stage keeps only `libs/`, the server, the built page, and production `node_modules`. It runs as a non-root user.
- It declares `VOLUME /data`, `ENV DATA_DIR=/data WEB_DIR=…`, and an `EXPOSE` for its port.
- Healthcheck: check which endpoint `libs/server-common/src/health.ts` exposes and point `HEALTHCHECK` at it.
- Add a root `.dockerignore` covering `node_modules`, `dist`, `recordings`, `data` and `.git`.

### A4. Compose file
`compose.yaml` defines `source`, `debug` and `objects`.
- Named volumes hold each server's `/data`.
- Ports are 8000, 8010 and 8020.
- The proc services use `depends_on: source`.
- The object-detection service is written so that more instances can be added as copies of it, each with its own DB and port (one container per DB).
- Add `make docker-build` and `make docker-up` targets.

### A5. Verify
- Build all three images, then run `docker compose up`.
- Run `curl` against each server's `/api/state` and its page.
- Run the source server in `--offline` mode with a seeded recording, and check that debug and objects stream from it over the compose network (`http://source:8000`).
- Restart the containers and confirm the settings persist.
- Run `make test`, to confirm the path changes broke nothing.

**Needs the user:** a real sensor test, from inside the container to the lidar's IP. Everything else is covered by the offline mode.

## Checkpoint: decide on Phase B

Phase A delivers separately running containers and keeps the monorepo, and the layers test keeps the projects independent. Phase B pays off only if different teams or release cycles need the split. The ongoing cost: `wire` is the protocol shared by every server and client, so each change to it means bumping and releasing several repos in order, where today it is one commit.

## Phase B: separate projects with installable libs

Estimated agent time: about 3–6 hours, plus 1–2 hours of review. Most of it goes to rerunning typecheck, unit tests and the browser e2e after each move, and to fixing the relative paths that break.

### B1. Decouple the shared libs from the clients and tests
- Move `libs/server-common/src/testing.ts` out of the shared lib into the proc servers as a test helper, spawning the source server through a configurable command or image.
- Make the Vite configs stop calling `libs/server-common/scripts/listen.ts` and `proc-servers/*/data/*.db`, and use an `API_URL` env var for the dev proxy target.
- Remove `server-common` as a client dev dependency, or confine it to the debug client's tests.

### B2. Move the clients into their servers
- `clients/debug` moves to `proc-servers/debug/web`, and `clients/object-detection` to `proc-servers/object-detection/web`. This matches `source-server/web`.
- Update the workspace globs, the Makefile, the e2e test and the `WEB_DIR` defaults.
- Update `layers.test.ts` to its new shape.

### B3. Make the libs publishable
- Remove `"private": true`, and set a scope, a `repository` field, and a `files` list.
- Keep the raw `.ts` exports. Verify the Vite build transpiles TS from `node_modules`. If it does not, add `optimizeDeps` or `ssr.noExternal` config, or build the libs (about an hour more).
- Replace `workspace:*` with real semver ranges between the libs.
- Check that `Worker(new URL("./worker.ts", import.meta.url))` in `libs/server-common` still resolves from an installed copy.

### B4. Split the repos
Use `git filter-repo` per project, which keeps history. The result is these repos:
- `mrs6000-libs`, a monorepo of the four packages, versioned and released together.
- `mrs6000-source-server`.
- `mrs6000-debug-server`.
- `mrs6000-objects-server`.

Each server repo depends on the packages through a registry (a git dependency does not work for a subpackage of a monorepo).

### B5. Per-repo Docker and CI
- Each server repo gets its own Dockerfile, which now runs `bun install` against published packages.
- Each gets a CI workflow that runs typecheck, tests and the image build.
- The libs repo gets a release workflow that publishes the packages.
- Compose lives in a small deploy repo, or in the source-server repo.

### B6. Verify
- In each repo, run `bun install` from a clean checkout, then typecheck and test.
- Run the browser e2e against the three images.
- Make a wire-format change in the libs repo, to check the bump-and-release flow before relying on it.

**Needs the user:**
- The registry choice (npm, GitHub Packages or a self-hosted one) and its tokens.
- The names of the repos and the hosting account.
- Whether to keep history in the split.

## Order

1. A1 and A2, then `make test`. Commit.
2. A3–A5. Commit. This is a working deliverable on its own.
3. Pause and decide whether Phase B is worth the release overhead.
4. B1–B2 in the monorepo, keeping `make test` green. Commit.
5. B3–B6.

## Risks

- **Web root changes:** a wrong default would show up as a blank page. A5 covers it.
- **Settings page vs. container ports:** the page can still change `host` and `port`, which can strand a container behind its port mapping. Document it, or lock those fields when `DATA_DIR` is set (a product decision).
- **Vite and TS in `node_modules`:** the biggest unknown in B3. If it fails, building the libs adds about an hour.
- **Sensor access from a container:** untested until someone runs it against a real lidar.
