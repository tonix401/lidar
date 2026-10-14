# SICK MRS6224R-131001: data access and live viewer

Tools for a SICK MRS6224R LiDAR at `192.168.178.200`:
- **`backend/`:** a Python package `mrs6000`.
  - The sensor library and a CLI: REST, CoLa A, recording a single scan.
  - The viewer server (FastAPI): live stream, recordings, replay.
- **`frontend/`:** the browser viewer (Vite + TypeScript + three.js). It covers smoothing, object detection and highlighting, the 3D view, the 2D map and the range image, and recording/replay controls.

## Setup

You need **Python ≥ 3.11** (with `venv`), **Node.js 22.22+ or 24.15+**, **make** and **git**. Chrome or Chromium is only needed for the browser test.

| Distribution | Install the prerequisites |
|---|---|
| Arch / Manjaro / EndeavourOS | `sudo pacman -S python nodejs npm make git` (optional: `chromium`) |
| Debian / Ubuntu / Mint | `sudo apt install python3 python3-venv make git`, then Node 24 from [nodejs.org](https://nodejs.org) or `nvm install 24` (the distro's `nodejs` is usually too old) |
| Fedora | `sudo dnf install python3 make git nodejs` (check `node --version`) |
| NixOS | `nix-shell` in the repo (see `shell.nix`) |
| Other | Python 3 + venv, make and git from the package manager; Node from the distro if new enough, else [nvm](https://github.com/nvm-sh/nvm) `install 24` |

`make install` checks the versions and says what's missing. You don't have to run it first: `run`, `dev` and the test targets install automatically.

| Command | What it does |
|---|---|
| `make install` | `backend/.venv` (editable, dev extras) + `frontend/node_modules`; reruns only when dependencies change |
| `make run` | Build the frontend, serve everything on http://localhost:8000 |
| `make run ARGS="--replay recordings/<file>.mrsstream"` | Replay a recording |
| `make run ARGS="--offline --replay recordings/<file>.mrsstream"` | Replay without ever touching the sensor |
| `make dev` | Backend :8000 + Vite hot reload on http://localhost:5173 (also takes `ARGS`) |
| `make test` | pytest + typecheck + vitest + browser end-to-end test (`test-backend`, `test-frontend`, `test-e2e` run each part) |
| `make browser` | Download Playwright's Chromium (about 150 MB), only if you have no Chrome/Chromium |
| `make clean` | Remove build output and test artifacts |

| Problem | Fix |
|---|---|
| Python too old, or several installed | `make install PYTHON=python3.12` (or a full path) |
| "venv module is missing" | Install the distro's venv package, e.g. `python3-venv` on Debian/Ubuntu |
| Node too old | `nvm install 24`, then `make install` in the same shell |
| Browser test finds no Chromium | It looks for `$CHROMIUM`, then `chromium` / `google-chrome` on PATH. Install one, set `CHROMIUM=/path/to/browser`, or run `make browser` |
| Playwright's Chromium won't start (bare system) | `cd frontend && sudo npx playwright-core install-deps chromium` |

**Recordings** are not in git (too big): share `.mrsstream` files separately (download button in the viewer) and put them in `recordings/`.

Without `make`:

```sh
backend/.venv/bin/mrs6000-viewer --host 0.0.0.0     # share on the LAN (anyone there can record/delete!)
backend/.venv/bin/mrs6000 info | status | dump | get <Var>
backend/.venv/bin/mrs6000 scan                      # one scan summary (CoLa)
backend/.venv/bin/mrs6000 record [--mount auto|upright|upside-down]   # one full-res frame → .cola.txt/.csv/.ply/.json
backend/.venv/bin/mrs6000 echo-filter [first|all|last] [--save] [--env .env]   # needs login from .env
```

Interactive API docs are served at `http://localhost:8000/docs`.

## Layout

```text
backend/
  src/mrs6000/            sensor library + CLI
    rest.py cola.py preview.py model.py export.py env.py errors.py variables.py cli.py
    server/               viewer backend
      app.py              HTTP API (FastAPI) + static frontend
      hub.py              live / replay source switching, playback control, epochs
      stream.py           .mrsstream format, Recording (random access), Recorder
      feed.py frames.py status.py health.py main.py
  tests/                  pytest with a fake CoLa sensor (TCP) and a fake REST sensor (HTTP),
                          plus a real 24-layer scan as a fixture
frontend/
  index.html  src/styles.css  src/main.ts  src/app.ts (wiring)
  src/core/               types, math, colours, formatting
  src/config/             settings schema + presets (config.ts), auto mode, storage
  src/pipeline/           one module per processing stage + Processor (order of stages), metrics.ts
  src/objects/            background, segmentation, Kalman, tracker, ObjectDetector
  src/render/             geometry (pure), scene3d (three.js), view2d (canvas)
  src/api/                typed API client, frame long-poll with retry
  src/ui/                 panel sections, problems/health display
  tests/                  vitest on synthetic ray-cast scenes (tests/helpers/scene.ts), jsdom for the panel
  e2e/                    real backend (offline, generated recording) + built frontend in headless Chromium
```

## The sensor

| | |
|---|---|
| Layers × beams | 24 × 923 per scan, **10 Hz fixed**. More supply voltage does *not* give more scans; the mirror runs at 10 Hz. |
| Azimuth | −60…+60°, step 0.1301°. Azimuth = start/10000 − 90 in the telegram. |
| Elevation | About −13.2…+1.2° (vertical FOV about 15°, so only about 0.8 m of a body is visible at 3 m). Per-beam elevation comes from the VANGL channel. |
| Distance | 12.5 mm quantisation (DIST1 scale 12.5). |
| Echo filter | `FREchoFilter`: 0 first, 1 all, 2 last. The device is on **2 (last)**. |
| Mounting | The device parameter `UpsideDown` is **true**: the sensor is on its head. It already reports azimuth in world left/right, so only **z flips**. Flipping y as well mirrors the scene, which was a bug. |

### Interfaces

- **REST** `http://ip/api/<Var>`
  - `GET` returns `{"header":{status,message},"data":{Var:value}}`.
  - `POST` writes need challenge-response: `getChallenge`, then SHA256 over `user:realm:pw`, `POST:name` and the nonce (see `RestClient.login`).
  - The full variable list is in the SOPASair web UI's `current_msdd` zip (`descriptor.json`).
- **WebSocket** `ws://ip/scan`: MessagePack preview at only about 2 Hz, with big-endian uint16 × 12.5 mm distances. Too slow; not used by the viewer.
- **CoLa A, TCP 2111**: the full-rate source.
  - `sEN LMDscandata 1` streams one telegram per **layer**.
  - Channels: DIST1, RSSI1, VANGL (elevation; scale −0.00025, offset 1.5).
  - Layer angle is int16 in 1/200°.
  - Login: `SetAccessMode 04` with the password hashed as MD5, XOR-folded to 4 bytes, little endian.
  - `mEEwriteall` saves permanently; `sMN Run` leaves config mode.
  - Parser pitfall (fixed): after each channel, `i += 6 + n`.

The sensor hung once (HTTP and CoLa stuck in FIN-WAIT-2). A power cycle fixed it.

## Viewer pipeline (`frontend/src/pipeline/`)

The scan is handled as an organized range image (layer × beam), in this order:

1. **Intensity filter**: RSSI min/max, with a histogram.
2. **Layer calibration**: per-layer distance offsets learned live from leave-own-layer-out plane fits. This removes the horizontal "waves" on walls.
   - The degree-0–2 polynomial modes are projected out. Left free, they drift: a 16° wall tilt after about 12 min, and an 8 cm bow.
   - Storage key `mrs6000.layerbias.v2`.
3. **Motion detection** (adaptive per area), run on the unfiltered scan:
   - A per-beam z-gate of 3σ.
   - The beam model must be established (5 or more scans).
   - Changed beams form clusters; clusters smaller than 8 beams are dropped.
   - Clusters grow into the object up to 12 steps, never into beams that match their own background.
   - Beams stay "moving" for 10 scans (Dynablox-style).
4. **Outlier filter**: neighbour support within the layer, relaxed in moving areas.
5. **Temporal smoothing**: Kalman-style per beam, with learned noise σ, change confirmation, and a second background mode for edges.
6. **History filter**: drops flickering beams using the last 32 scans and adds confidence weights.
7. **Bilateral filter**: the range σ adapts to each beam's noise. Moving beams are left to the next stage.
   - **Moving-area smoothing** (`dynsmooth.ts`): 3D smoothing within one scan for moving beams (people), which the per-beam stages pass through almost raw.
     - Each moving point becomes the weighted mean of the 3D points within `radius` (auto: 3× noise floor, at least 4 cm).
     - The weights are split into across the beam (σ = radius/2) and along it (σ = 2× the beam's range noise). The beams are far closer together (0.13°, about 7 mm at 3 m) than the range noise (about 30 mm), so one isotropic Gaussian mostly weighs noise; that version only got roughness from 18.6 to 15.4 mm.
     - Only moving neighbours or ones in front of the empty-scene background count, so a person never blends into the wall.
     - The mean is projected back onto the beam's own ray, so the grid stays organized.
     - Mixed pixels are dropped: a beam on a depth jump of more than `gap` between its two opposite neighbours that matches neither side. At the outline of an arm the sensor merges arm and wall/torso into one in-between echo.
   - **Radial cells** (`cells.ts`, experimental, off by default, see below).
8. **Plane flattening**: PCA plane fit per point; the point moves along its ray when the patch is flat within about 2× the noise floor.
9. **Organized mesh**: breaks at depth jumps.
10. **Remembered walls** (`wall.ts`, display option "Walls behind moving objects", on by default):
    - Each beam returns one range, so a person hides the wall behind them and leaves a person-shaped shadow in it.
    - Each beam remembers its last static output range, but only if it is not in front of the object detector's empty-scene background, so a person standing still is never remembered as wall.
    - That background starts as the first scan and only learns within 0.3 s that a wall is behind whatever stood there; a remembered range that turns out to be in front of it is replaced by it.
    - Where a moving beam, or any return in front of the empty scene, hides the remembered surface, the surface is drawn too (a little darker), as a second vertex per beam meshed with the wall around it (`render/geometry.ts`: vertex N + i).
    - On both recordings, 99.6–100 % of the hidden wall beams are filled once the wall behind has been seen, with at most 7 beams per scan drawn more than 0.3 m in front of the empty scene.

**Auto mode** (the default) derives all settings from the measured noise floor (the median σ of steady beams). The intensity filter and object detection always stay user-controlled. **Manual mode** keeps its own settings.

**Moving-area metrics** (panel row "Moving areas", `Processor.stats`, `pipeline/metrics.ts`):
- *rough*: median deviation of a moving beam from its same-surface 3×3 neighbours (mm).
- *flicker*: share of moving beams that switched between object and background (the object detector's empty-scene model) since the last scan.

Results on the recorded walk (Auto):
- Wrong or missing moving beams fell from 73% to about 5.6%.
- Static surfaces have about 3.2 mm noise.
- Layer calibration reduces the plane residual from about 26 to 16 mm.

### Moving people (2026-10-14)

Measured headless over two recordings of a person close to the sensor (gesturing, walking), auto mode, after a 3 s warm-up. *Jitter* is the median scan-to-scan range change of beams that stay on the same moving surface.

| Recording | Setting | Rough | Jitter | Flicker | Static noise | ms / scan |
|---|---|---|---|---|---|---|
| `rec_20261014_185611` (16 s) | before | 18.6 mm | 14.6 mm | 8.2 % | 3.0 mm | 16 |
| | moving-area smoothing | 8.3 mm | 7.3 mm | 8.3 % | 3.0 mm | 23 |
| | + radial cells | 8.3 mm | 7.3 mm | 8.3 % | 3.0 mm | 25 |
| `rec_20261014_223527` (39 s) | before | 14.4 mm | 19.1 mm | 10.9 % | 2.7 mm | 17 |
| | moving-area smoothing | 5.2 mm | 12.5 mm | 10.9 % | 2.7 mm | 23 |
| | + radial cells | 5.2 mm | 12.3 mm | 10.8 % | 2.7 mm | 23 |

The share of moving beams is unchanged by both stages (motion detection runs before them).

**Radial cells: what was tried.** Columns of 4 × 2 beams radiating from the sensor, each with up to 4 depth slots (α-β filtered range, OctoMap-style log-odds occupancy with hysteresis).
- *Temporal range correction* (shift a slot's beams by filtered − measured range): jitter got **worse**, 7.3 → 9.9 mm (window 10: 10.5 mm; correcting only steady slots: 8.3 mm). A column mixes surfaces (arm and torso), so its median jumps whenever the mix changes, and the filter turns that into per-column offsets. Removed.
- *Occupancy gate* (drop beams of slots with fewer than `confirm` hits): flicker 8.3 → 6.6 %, but only by erasing the tips of fast-moving arms and hands as they enter new columns. Now a new slot next to a confirmed one at a similar range is confirmed at once; then the gate touches about 1.5 beams per scan and is neutral.
- *Dropout fill*: no effect; temporal smoothing already holds a beam through short dropouts.
- The stage stays as an experiment (user-controlled, off by default, colour by "Radial cell" to see the columns).

**Not done yet: the echo test.** The device runs on the last echo. Record the same walk with `mrs6000 echo-filter first` and with `last` (no `--save`; restore afterwards) and compare *flicker* and the outline. Streaming several echoes (`cola.py` parses them, `stream.py` and `frames.py` only send `echoes[0]`) is only worth it if the difference is large.

**Views:**
- 3D, with Perspective / Top / level Side / Front cameras and the FOV fan.
- 2D map (top-down).
- Range image with square cells. Grey means no return; pink means removed by filters.
- 3D renders on demand (about 10 renders/s with a still camera).
- Defaults: draw **surface + points**, colour by **distance**.

## Object detection and highlighting (work in progress)

**Research basis.** The approach follows the fixed-sensor ("roadside LiDAR") literature:
- Zhao et al. 2019, *Detection and tracking of pedestrians and vehicles using roadside LiDAR sensors*: the background filter → cluster → classify → track pipeline.
- Wu et al., 3D-DSF background filtering.
- Zhao et al., azimuth-height background filtering.
- Bogoslavskyi & Stachniss, IROS 2016 / 2017, *Fast range image-based segmentation of sparse 3D laser scans* ("depth clustering", the angle criterion).
- SORT / AB3DMOT-style Kalman tracking.

Neural detectors (PointPillars, RangeNet++) were rejected: they are trained on 64-beam car data, have a large domain gap and need a GPU.

**What is implemented** (the "Object detection" stage in the Objects panel section):

1. **Slow background.** Each beam learns the range of the empty scene.
   - A nearer surface is adopted only after `learn` s (20 s); a farther one (the background revealed) after 0.3 s.
   - Beams under a tracked, moving object are never adopted.
   - Objects that never moved are released ("static object") after `learn` s.
2. **Foreground**: returns more than `minDiff` (0.15 m) + 3σ + 1% in front of the background.
3. **Segmentation**: BFS on the range image. Neighbours join if `d1 − d2·cosψ ≤ d2·sinψ/tanθ + margin`. The noise margin is needed because the beams (0.13°) are closer together than the range noise.
4. **Merging**: fragments merge when their footprints are less than 0.3 m apart, capped at a 1.6 m footprint.
5. **Tracking**: a constant-velocity Kalman filter on x/y, greedy nearest-neighbour association within a 0.8 m gate, confirmed after 3 hits, kept for 10 scans when lost.
6. **Classification** (rule-based):
   - "person" if visible height ≥ 0.35 m, footprint ≤ 1.3 × 0.9 m, and either it moved or it is ≥ 1 m tall.
   - Otherwise "moving object", "object" or "static object".
   - Objects touching the top or bottom layer are flagged clipped: their height is only a lower bound.

**Display:**
- Highlight colours each object; the background is dimmed.
- 3D boxes, labels and trails; the same overlays on the 2D map and range image.
- An object list; click to select; follow mode.

**Status / next steps.** The Node harness ran over the whole walk recording at about 26 ms/scan. It works, but needs tuning:
- **Too many confirmed objects.** Usually 3–5 are confirmed while only one person walks: 45 distinct confirmed IDs over 150 s.
  - Static clutter (n ≈ 10–60 beams at 1.3 m, 4.5 m and 17 m) becomes foreground. Likely causes: mixed pixels or edges, and the background being initialised from the first frame.
  - Ideas: require foreground for several scans, use the per-beam `alt` (second background mode) as background too, and use a longer or robust background initialisation.
- **The person's cluster is far too big.** n ≈ 1,500 beams with a footprint of about 1.5 × 1.2 m: the person merges with the region they occlude or stand near. Their track also often classifies as "moving object".
  - Check the segmentation margin and theta, and that shadows/occlusions are not counted as foreground.
- Feeding many replay frames per second makes browser processing the bottleneck (about 60 ms per frame in headless Chromium).

## Recording and replay

These run server-side (`backend/src/mrs6000/server/`), with controls on the page.

- **Recording:** the **● Record** button in the panel saves the *live* stream to `recordings/rec_YYYYmmdd_HHMMSS.mrsstream`, about 53 MB per minute. It keeps recording while you watch a replay.
- **Recordings list:** play, download, delete.
- **Transport bar** (shown while replaying):
  - Step back / play-pause / step forward, a seek slider, speed 0.25–4×, loop, and "● Live".
  - Keys: Space = play/pause, ←/→ = step.
- **Epoch:** the server bumps `epoch` on every seek, step back, loop wrap or source switch, and the page then resets its per-beam history and tracks.

**`.mrsstream` format:**
- A JSON header line: `{layers, beams, start_azimuth_deg, step_deg, elev[layers*beams], upside_down?}`.
- Then fixed-size frames: float64 unix time, uint16 distance (12.5 mm units, 0 = invalid), and uint16 RSSI, layer-major.

**HTTP API:**

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/frame?after=<id>` | Long-poll. Three float32 blocks (dist m, rssi, elev); meta is in the `X-Meta` header (incl. `ts`, `source`, `epoch`, `replay`). |
| GET | `/api/status` | REST device values. |
| GET | `/api/state` | Source, replay position, recording progress. |
| GET | `/api/recordings` | List of recordings. |
| GET | `/api/recordings/<name>` | Download. |
| DELETE | `/api/recordings/<name>` | Delete. |
| POST | `/api/record {"action":"start"\|"stop"}` | Start or stop recording. |
| POST | `/api/replay {"file":name}` | Play a recording. |
| POST | `/api/live` | Back to the live sensor. |
| POST | `/api/replay/control {"action":"play\|pause\|toggle\|step\|seek\|speed\|loop","value":…}` | Playback control. |

`recordings/` is gitignored. GitHub rejects files over 100 MB, and a 132 MB recording once blocked a push. The walk recording used for tuning is `recordings/walk_20261014.mrsstream`; it is also on the `backup-before-rewrite` branch.

## Error handling

Nothing crashes on a sensor or network problem; everything retries on its own.

**Terminal (backend):**
- One timestamped line per problem when it starts or changes, e.g. `[21:22:38] sensor (CoLa): timed out (retrying every 3 s)`.
- A reminder once a minute while it persists, and `… ok again` when it clears. No tracebacks.
- **Sensor:** the CoLa stream and the REST status poll reconnect every 3 s. A connection problem aborts a REST batch at once instead of waiting out one timeout per variable.
- **Recording:** a disk error (e.g. disk full) stops the recording with a message; the live stream keeps going.
- **Replay:** if the recording is deleted or unreadable, the viewer returns to live and shows the reason on the page.
- **HTTP:**
  - Bad requests get a short JSON `{"error": …}` with status 400/404.
  - Browsers closing connections are ignored.
  - Unexpected errors give one log line and a 500.
- **Safety net:** each background thread is supervised and restarted if it ever dies.
- **Startup:** a port already in use prints `error: cannot listen on …` and exits. A bad `--replay`/`--record` file is logged and the viewer continues live.

**Browser:**
- One console line per problem (`[server]`, `[sensor]`, `[replay]`, `[processing]`) and one when it clears.
- Active problems are listed in the panel.
- The frame poll retries after 1 s, backing off to every 5 s.
- An exception while processing a frame is reported, but the stream continues.

**CLI (`mrs6000`):** prints `error: <short reason>` and exits with status 1.

## Development notes

- **Environment:** plain Python venv in `backend/.venv` and npm in `frontend/`, nothing system-specific. `shell.nix` is only a convenience for NixOS. There, Playwright's downloaded Chromium does not run, so the system `chromium` is used.
- **Tests:** `make test` runs everything.
  - **Backend:** about 55 pytest tests. They use fake sensors, so no hardware is needed.
  - **Frontend:** about 65 vitest tests on synthetic ray-cast scenes, plus jsdom tests for the panel.
  - **End to end:** a browser test with Playwright and Chrome or Chromium (see Setup). Its screenshots go to `frontend/e2e/artifacts/`.
- **Debugging:** in the browser console, `window.mrs6000` is the app: `processor` holds the grid and objects, `cfg` the settings, `geo` the geometry.
- **Browser storage keys:**
  - `mrs6000.smoothing.v3` (mode and manual settings)
  - `mrs6000.layerbias.v2`
  - `mrs6000.mount.v2`
  - `mrs6000.view`
  - `mrs6000.fillWalls` (remembered walls on/off)
  - `mrs6000.obj.*` (object display toggles)
