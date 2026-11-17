# Setup

You need **[Bun](https://bun.sh) 1.4+** (package manager and runtime of everything; no Node needed), **make** and
**git**. Chrome or Chromium is only needed for the browser test.

| Distribution | Install the prerequisites |
|---|---|
| Arch / Manjaro / EndeavourOS | `sudo pacman -S bun make git` (optional: `chromium`) |
| Debian / Ubuntu / Mint | `sudo apt install make git unzip`, then Bun with `curl -fsSL https://bun.sh/install | bash` |
| Fedora | `sudo dnf install make git unzip`, then Bun with `curl -fsSL https://bun.sh/install | bash` |
| NixOS | `nix-shell` in the repo (see `shell.nix`) |
| Other | make and git from the package manager; Bun from the package manager if it has 1.4+, else `curl -fsSL https://bun.sh/install | bash` |

`make install` checks the version and says what's missing. You don't have to run it first: `run`, `dev` and the test
targets install automatically.

## Make targets

| Command | What it does |
|---|---|
| `make install` | The Bun workspace (every library, server and client); reruns only when dependencies change |
| `make build` | The three pages: the source server's, the viewer, the objects page |
| `make run` | The source server (its page), the debug server (the viewer) and an object-detection server per settings database `proc-servers/object-detection/data/<name>.db` (`default` when there is none). On the first start they listen on http://localhost:8000, :8010 and :8020; after that, wherever their settings say. `ARGS` go to the source server |
| `make run ARGS="--offline"` | No sensor connection at all: replay recordings from the viewer |
| `make run-source`, `make run-debug`, `make run-objects NAME=lobby` | One server alone (a new `NAME` is a new object-detection server with its own database) |
| `make dev` | The servers + Vite hot reload: viewer http://localhost:5173, source page :5174, objects page :5175 |
| `make test` | Every project (typecheck + vitest), the import rules between projects, the browser end-to-end test (`test-layers`, `test-libs`, `test-source`, `test-procs`, `test-clients`, `test-e2e` run each part) |
| `make browser` | Download Playwright's Chromium (about 150 MB), only if you have no Chrome/Chromium |
| `make sim-session` | A simulated 3-sensor session in `recordings/sim_rig3/` ([multisensor.md](multisensor.md); `ARGS="folder seconds beams"`) |
| `make tracks ARGS="sim_rig3 out.jsonl"` | A recording's fused tracks, the same to the byte on every run ([development.md](development.md)) |
| `make profile` | ms per scan of every pipeline step, three simulated sensors at full resolution ([development.md](development.md#measuring-speed); `ARGS="beams scans"`) |
| `make clean` | Remove build output and test artifacts |

## Configuration

Every server keeps its settings in its own SQLite database, not in git, and edits them on its page; a change applies
at once, without a restart. There are no command-line options for them: a server takes only `--db` (which database)
and, for the source server, `--offline` (no sensor connection: tests, demos).

| Server | Database | Edited on | Holds |
|---|---|---|---|
| source | `source-server/data/source.db` | its page: Sensors, Registered processing servers, Settings | the sensors (address, enabled, mount, which one is main, pose), the registered processing servers with their tokens, address and port, the recordings folder, `open`, admin token, other allowed origins |
| debug | `proc-servers/debug/data/debug.db` | the viewer's Server section | the source server's URL and its token there, its name, a replay every page opens first, address and port, its own objects and their processing settings, admin token, origins |
| object detection | `proc-servers/object-detection/data/<name>.db` | its page's Server section | the source server's URL and token, its name, address and port, processing settings, track cache folder, replays at once, registered clients, `open`, admin token, origins |

- **The first start** copies the server's committed empty database (`source-server/empty.db`,
  `proc-servers/debug/empty.db`, `proc-servers/object-detection/empty.db`: the defaults, 127.0.0.1 and port 8000, 8010
  or 8020) to its `data/` folder. After changing the defaults in code, `make empty-dbs` writes them anew (a test checks
  that they agree).
- **Another address or port** rebinds the server at once: the new one is bound first (a taken port is refused and
  nothing changes), and the page moves there. Whoever uses the server then needs the new address: the processing
  servers their *Source server* setting, the clients theirs. A server that now listens on 127.0.0.1 only can no longer
  be reached from another machine.
- **Access.** All servers listen on 127.0.0.1 until their *Address* is set to 0.0.0.0. Anyone who can reach a server
  can use it: set an admin token (and turn off *Unregistered … may connect*) before sharing one on a network. Once a
  server has an admin token, its settings and every change need it: each page has a field for it.
- **The Vite dev servers** (`make dev`) proxy to the addresses in the databases, read when they start; restart
  `make dev` after moving a server.

## Common problems

| Problem | Fix |
|---|---|
| A port is taken | While the server runs: change its *Port* on its page. When it cannot start at all (`error: cannot listen on …`), write another one into its database, e.g. `bun libs/server-common/scripts/seed.ts source-server/data/source.db '{"port": 8100}'`, then set the processing servers' *Source server* to it |
| The viewer says the source is not reachable | The source server must be running first (`make run` starts it before the others) |
| Browser test finds no Chromium | It looks for `$CHROMIUM`, then `chromium` / `google-chrome` on PATH. Install one, set `CHROMIUM=/path/to/browser`, or run `make browser` |
| Playwright's Chromium won't start (bare system) | `cd clients/debug && sudo bunx playwright-core install-deps chromium` |
| A request from another page is refused (403) | Add its origin (e.g. `http://localhost:5180`) to the server's *Other pages allowed to make changes* setting. The `make dev` pages need nothing: their proxy keeps the page's address |
| "… is not a name of this server" (403) | The server is reached by a name it does not know as its own (e.g. a DNS name, or a Docker service name). Add an origin with that name, e.g. `http://box.lan:8000`, to its *Other pages allowed to make changes* (from `localhost` on that machine), or use its address |
| The settings say "this needs the admin token" | Enter the server's admin token in the page's admin token field |

**Recordings** are not in git (too big): share `.tpc.zstd` files separately (download them on the source server's
page) and put them in `recordings/`. See [recordings.md](recordings.md).

## Without make

```sh
bun source-server/src/main.ts                                       # settings in source-server/data/source.db
bun source-server/src/main.ts --db /srv/lidar/source.db --offline   # another database; no sensor connection
bun proc-servers/debug/src/main.ts                                  # settings in proc-servers/debug/data/debug.db
bun proc-servers/object-detection/src/main.ts --db proc-servers/object-detection/data/lobby.db   # the server "lobby"
```
