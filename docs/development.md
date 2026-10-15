# Development notes

- **Environment:** plain Python venv in `backend/.venv` and npm in `frontend/`, nothing system-specific. `shell.nix` is only a convenience for NixOS. There, Playwright's downloaded Chromium does not run, so the system `chromium` is used. Python must be 3.14 or newer for the standard-library `compression.zstd` ([setup.md](setup.md)).
- **Tests:** `make test` runs everything (counts as of 2026-10-15).
  - **Backend:** 66 pytest tests. They use fake sensors, so no hardware is needed.
  - **Frontend:** 112 vitest tests: synthetic ray-cast scenes (`tests/helpers/scene.ts`) for the pipeline, objects and geometry, and jsdom tests for the panel (`tests/ui.test.ts` loads the real `index.html`).
    - `tests/golden.test.ts` snapshots checksums of the whole pipeline's output on a synthetic walk (5 configurations). A refactor must leave them unchanged; update them (`npx vitest run -u`) only for an intended change in behaviour, and say so in the commit.
    - `tests/layers.test.ts` (and `backend/tests/test_layers.py`) enforce which folder may import which ([architecture.md](architecture.md#layers)).
  - **End to end:** 8 browser tests with Playwright and Chrome or Chromium (see [setup.md](setup.md)). The test writes its own `.tpc` recording (a person walking past a wall) and replays it through the real backend. Its screenshots go to `frontend/e2e/artifacts/` (3d, map, range-image, grid-lines, light, recording-menu).
  - `make test-e2e` rebuilds the frontend first; `cd frontend && npm run test:e2e` uses the existing `frontend/dist`.
- **Testing without the sensor:** everything can be checked on recordings, e.g. `make run ARGS="--offline --replay recordings/<file>.tpc.zstd"`. Don't leave the sensor streaming for tests.
- **Debugging:** in the browser console, `window.mrs6000` is the app: `processor` holds the grid and objects, `cfg` the settings in effect (`settings` the auto/manual state), `ui` the display settings, `geo` the geometry.
- **Checking three.js code on its own:** while `npm run dev` is running, the browser console can import any source module, e.g. `await import('/src/render/sensorModel.ts')`. For `three` itself, use the pre-bundled path that Vite rewrote into that module (`/node_modules/.vite/deps/three.js?v=…`; fetch the module's source to find it). Render the module into a separate `WebGLRenderer` canvas to look at it from fixed cameras without touching the app's scene.
- **Browser storage keys** (`config/storage.ts`; every access is guarded, so blocked storage just means defaults):
  - `mrs6000.smoothing.v3`: mode and manual settings (merged onto the defaults on load, so old or partial settings still work).
  - `mrs6000.layerbias.v2`: the learned per-layer offsets.
  - `mrs6000.mount.v2`: only once chosen; otherwise the device's or the recording's `UpsideDown` is followed.
  - `mrs6000.view`.
  - `mrs6000.fillWalls`: drawing remembered walls behind objects (the memory itself is the "walls" stage in the settings).
  - `mrs6000.maxRange`, `mrs6000.theme`, `mrs6000.panelWidth`.
  - `mrs6000.obj.*`: the object display toggles.
  - `mrs6000.open.*`: the fold state of each status box and section, and `mrs6000.open.panel` for the whole panel.
- **Documentation:** lives in `docs/`, one file per topic, indexed in [README.md](README.md). The top-level `README.md` only points here.

## Rules that keep the processing general

- **No constant comes from a recording.** Thresholds follow the measured noise (σ, noise floor), the sensor geometry (beam step 0.13°, layer spacing about 0.6°) or physical sizes (a person's height and arm span). The recordings are only a check, and every rule gets a unit test on a synthetic scene that the recordings don't contain ([objects.md](objects.md#measured-2026-10-14)).
- **Measure before and after** on at least two recordings, and keep a change only if it helps on both. Write the numbers into the docs with the date and the recording names. Record what didn't work as well (radial cells, [pipeline.md](pipeline.md#radial-cells-what-was-tried)).

## Measuring on recordings offline

The numbers in [pipeline.md](pipeline.md) and [objects.md](objects.md) came from a small Node script (not kept in the repository) that runs the browser pipeline on a recording:
- **Bundle:** a TypeScript file that imports `Processor`, `autoConfig` and `estimateNoise` from `frontend/src` (plus `foreground`/`fgTol` for ground truth), bundled with the frontend's own rolldown:
  `node frontend/node_modules/rolldown/bin/cli.mjs replay.ts --platform node --format esm -o replay.mjs`
- **Read** the recording: an uncompressed `.tpc` (decompress with `mrs6000 decompress` first). Parse the JSON header line, then each scan: float64 time, uint16 distances × 12.5 mm, uint16 RSSI ([recordings.md](recordings.md)). Build the frame `[distance m | rssi | elevation deg]` that `Processor.ingest` takes, and pass the scan's own timestamp as `meta.ts`.
- **Run auto mode like the page:** start with `autoConfig(defaults, 0.02)`, and every 10 scans re-derive it from `estimateNoise(grid)`, keeping the user stages.
- **Score after a 3 s warm-up**, e.g. ghosts against offline ground truth (the empty scene = each beam's 85th-percentile range over the whole recording), roughness and flicker (`Processor.stats`), or spikes (triangles within ~6° of edge-on next to objects, from `buildGeometry`).
- **Look at the result:** write small PPM images of the range image (a few lines of code, no dependencies) to see where a rule fires.

## Checking the page visually

- Start an offline replay on a spare port, e.g. `backend/.venv/bin/python -m mrs6000.server --offline --port 8013 --frontend frontend/dist --replay recordings/<file>.tpc.zstd`. Run `npm run build` first, since it serves `frontend/dist`.
- Drive headless Chromium with `playwright-core` (resolved from `frontend/node_modules`) and screenshot the page itself (`page.screenshot`, optionally with a `clip`), never the desktop. A tall viewport (e.g. 1440 × 2600) shows the whole panel in one picture. A 390 × 844 viewport shows the phone layout.
- WebGL needs `--enable-unsafe-swiftshader --use-angle=swiftshader` in headless Chromium (as in `e2e/smoke.e2e.ts`).
- Stop the server afterwards by its PID, not with a pattern.

## End-to-end test pitfalls

- **Presets restart the beam histories:** after a preset or "Reset to defaults", the next few scans are empty or raw. Wait for data (`page.waitForFunction`) instead of reading it once.
- **Folded content is not clickable:** a stage's parameters are inside a closed `<details>`, so Playwright waits until it times out. Open the stage first (click its summary's name, not the checkbox).
- **Server state arrives by polling** every 500 ms (`/api/state`): after a replay action, wait for the page to show it (e.g. the stream summary) rather than asserting at once.
- **The tests share one page and run in order:** a failure early in one test can leave the page in another view or mode and fail the next tests too. Fix the first failure first.
