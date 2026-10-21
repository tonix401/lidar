# Setup

You need **Python ≥ 3.14** (with `venv`; recordings use its built-in `compression.zstd`), **[Bun](https://bun.sh) 1.4+** (package manager and runtime of the TypeScript side; no Node needed), **make** and **git**. Chrome or Chromium is only needed for the browser test.

| Distribution | Install the prerequisites |
|---|---|
| Arch / Manjaro / EndeavourOS | `sudo pacman -S python bun make git` (optional: `chromium`) |
| Debian / Ubuntu / Mint | `sudo apt install python3 python3-venv make git unzip`, then Bun with `curl -fsSL https://bun.sh/install | bash` |
| Fedora | `sudo dnf install python3 make git unzip`, then Bun with `curl -fsSL https://bun.sh/install | bash` |
| NixOS | `nix-shell` in the repo (see `shell.nix`) |
| Other | Python 3 + venv, make and git from the package manager; Bun from the package manager if it has 1.4+, else `curl -fsSL https://bun.sh/install | bash` |

`make install` checks the versions and says what's missing. You don't have to run it first: `run`, `dev` and the test targets install automatically.

## Make targets

| Command | What it does |
|---|---|
| `make install` | `backend/.venv` (editable, dev extras) + `frontend/node_modules`; reruns only when dependencies change |
| `make run` | Build the frontend, serve everything on http://localhost:8000 |
| `make run ARGS="--replay recordings/<file>.tpc.zstd"` | Replay a recording |
| `make run ARGS="--offline --replay recordings/<file>.tpc.zstd"` | Replay without ever touching the sensor |
| `make dev` | Backend :8000 + Vite hot reload on http://localhost:5173 (also takes `ARGS`) |
| `make test` | pytest + typecheck + vitest + browser end-to-end test (`test-backend`, `test-frontend`, `test-e2e` run each part) |
| `make browser` | Download Playwright's Chromium (about 150 MB), only if you have no Chrome/Chromium |
| `make sim-session` | A simulated 3-sensor session in `recordings/sim_rig3/` ([multisensor.md](multisensor.md); `ARGS="folder seconds beams"`) |
| `make profile` | ms per scan of every pipeline step, three simulated sensors at full resolution ([development.md](development.md#measuring-speed); `ARGS="beams scans"`) |
| `make clean` | Remove build output and test artifacts |

`backend/.venv` is rebuilt from scratch whenever `backend/pyproject.toml` is newer than `backend/.venv/.installed`.

## Common problems

| Problem | Fix |
|---|---|
| Python too old, or several installed | `make install PYTHON=python3.14` (or a full path). If the distro has no 3.14 yet: `uv python install 3.14`, then `make install PYTHON=$(uv python find 3.14)` |
| "venv module is missing" | Install the distro's venv package, e.g. `python3-venv` on Debian/Ubuntu |
| Node too old | `nvm install 24`, then `make install` in the same shell |
| Browser test finds no Chromium | It looks for `$CHROMIUM`, then `chromium` / `google-chrome` on PATH. Install one, set `CHROMIUM=/path/to/browser`, or run `make browser` |
| Playwright's Chromium won't start (bare system) | `cd frontend && sudo bunx playwright-core install-deps chromium` |

**Recordings** are not in git (too big): share `.tpc.zstd` files separately (download button in the viewer) and put them in `recordings/`. See [recordings.md](recordings.md).

## Without make

```sh
backend/.venv/bin/mrs6000-viewer --host 0.0.0.0     # share on the LAN (anyone there can record/delete!)
backend/.venv/bin/mrs6000 info | status | dump | get <Var>
backend/.venv/bin/mrs6000 scan                      # one scan summary (CoLa)
backend/.venv/bin/mrs6000 record [--mount auto|upright|upside-down]   # one full-res frame → .cola.txt/.csv/.ply/.json
backend/.venv/bin/mrs6000 echo-filter [first|all|last] [--save] [--env .env]   # needs login from .env
backend/.venv/bin/mrs6000 compress | decompress <files>   # x.tpc ↔ x.tpc.zstd
```

Interactive API docs are served at `http://localhost:8000/docs` (see also [api.md](api.md)).
