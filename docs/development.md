# Development notes

- **Environment:** plain Python venv in `backend/.venv` and one Bun workspace (`processing/`, `clients/debug/`; `bun.lock` at the root), nothing system-specific. Bun is also the runtime of the tools and tests (`bun --bun run …`). `shell.nix` is only a convenience for NixOS. There, Playwright's downloaded Chromium does not run, so the system `chromium` is used. Python must be 3.14 or newer for the standard-library `compression.zstd` ([setup.md](setup.md)).
- **Tests:** `make test` runs everything (counts as of 2026-10-22).
  - **Source server** (`source-server/tests/`, 53): a fake CoLa sensor (TCP) and a fake REST sensor (HTTP), so no hardware is needed; the recording format against files the Python backend wrote; live and replay consumers over a real port; the guards; the settings (applied, saved, a refused change changing nothing); calibrating a simulated recorded rig.
  - **Processing servers** (`proc-servers/*/tests/`): each against a real source server started as its own process (`startSource`, `libs/server-common/src/testing.ts`, with a settings database of its own seeded first), since the projects never import each other; each also changes its settings live.
  - **Libraries:** `libs/wire` (the frame codec, client options), `libs/server-common` (the sensor workers, `SensorSet`, errors and health, the settings database and checks, moving where a server listens), `libs/web` (the settings form, happy-dom).
  - **The import rules** (`tests/layers.test.ts`, `bun test ./tests/layers.test.ts`; the `./` matters: without it Bun treats `tests` as a filter and runs every test file of the repository in its own runner).
  - **Backend:** 79 pytest tests, while `backend/` exists.
  - **Processing** (`libs/processing/tests/`): vitest on synthetic ray-cast scenes (`libs/processing/sim/scene.ts`, a multi-sensor rig in `sim/rig.ts`) for the pipeline, objects, fusion and calibration.
  - **Frontend** (`clients/debug/tests/`): geometry, the worker mirror, and happy-dom tests for the panel (`tests/ui.test.ts` loads the real `index.html`; jsdom does not run under Bun).
    - `libs/processing/tests/golden.test.ts` snapshots checksums of the whole pipeline's output on a synthetic walk (5 configurations). A refactor must leave them unchanged; update them (`bun --bun x vitest run -u` in `processing/`) only for an intended change in behaviour, and say so in the commit.
    - `libs/processing/tests/layers.test.ts` and `clients/debug/tests/layers.test.ts` enforce which folder may import which inside the processing model and the viewer ([architecture.md](architecture.md#layers-inside-the-processing-model)); `tests/layers.test.ts` which project may import which.
  - **End to end** (`clients/debug/e2e/`): 14 browser tests with Playwright and Chrome or Chromium (see [setup.md](setup.md)). They write their own recordings (a person walking past a wall; the simulated 3-sensor rig), start a source server and the debug server on them, and drive the viewer; the rig test calibrates on the source server and checks that the page picks up the poses; the watch test starts an object-detection server and a client replaying through it, and watches that replay in the viewer. Screenshots go to `clients/debug/e2e/artifacts/`.
  - `make test-e2e` rebuilds the pages first; `cd clients/debug && bun --bun run test:e2e` uses the existing `clients/debug/dist`.
- **Testing without the sensor:** everything can be checked on recordings, e.g. `make run ARGS="--offline"`, then replay one in the viewer (or set the viewer's *Replay every page opens first* setting). Don't leave the sensor streaming for tests.
- **Changing the servers without changing the tracks:** `make tracks ARGS="sim_rig3 before.jsonl"` before, the same after, then `cmp`. It runs every sensor on the main thread and every frame in order through a source server of its own, so the output is the same to the byte on every run (with sensor workers it is not: which worker finishes first decides how scans group into sets). The split into these projects was checked this way on 2026-10-21: `sim_rig3` and `rec_20261015_112456` gave byte-identical tracks before and after.
- **Debugging:** in the browser console, `window.mrs6000` is the app: `processor` holds the grid and objects, `cfg` the settings in effect (`settings` the auto/manual state), `ui` the display settings, `geo` the geometry.
- **Checking three.js code on its own:** while `bun run dev` is running, the browser console can import any source module, e.g. `await import('/src/render/sensorModel.ts')`. For `three` itself, use the pre-bundled path that Vite rewrote into that module (`/node_modules/.vite/deps/three.js?v=…`; fetch the module's source to find it). Render the module into a separate `WebGLRenderer` canvas to look at it from fixed cameras without touching the app's scene.
- **Browser storage keys** (`clients/debug/src/ui/storage.ts`; every access is guarded, so blocked storage just means defaults):
  - `mrs6000.smoothing.v3`: mode and manual settings (merged onto the defaults on load, so old or partial settings still work).
  - `mrs6000.layerbias.v2`: the learned per-layer offsets.
  - `mrs6000.mount.v2`: only once chosen; otherwise the device's or the recording's `UpsideDown` is followed.
  - `mrs6000.gridStyle`: range rings or square grid; `mrs6000.mergeSurfaces`: one wall where sensors overlap.
  - `mrs6000.view`.
  - `mrs6000.fillWalls`: drawing remembered walls behind objects (the memory itself is the "walls" stage in the settings).
  - `mrs6000.maxRange`, `mrs6000.theme`, `mrs6000.panelWidth`.
  - `mrs6000.obj.*`: the object display toggles.
  - `mrs6000.open.*`: the fold state of each status box and section, and `mrs6000.open.panel` for the whole panel.
- **Documentation:** lives in `docs/`, one file per topic, indexed in [README.md](README.md). The top-level `README.md` only points here.

## Rules that keep the processing general

- **No constant comes from a recording.** Thresholds follow the measured noise (σ, noise floor), the sensor geometry (beam step 0.13°, layer spacing about 0.6°) or physical sizes (a person's height and arm span). The recordings are only a check, and every rule gets a unit test on a synthetic scene that the recordings don't contain ([objects.md](objects.md#measured-2026-10-14)).
- **Measure before and after** on at least two recordings, and keep a change only if it helps on both. Write the numbers into the docs with the date and the recording names. Record what didn't work as well (radial cells, [pipeline.md](pipeline.md#radial-cells-what-was-tried)).

## Several sensors without the sensors

`libs/processing/sim/rig.ts` ray-casts a room with furniture and a walking person from any sensor pose (`RIG3`: three sensors around it), `sim/calib.ts` builds calibration inputs with known truth from it, and `sim/session.ts` writes `.tpc` files and session folders (the page's tests import them as `@mrs6000/processing/sim/…`). `make sim-session` (`libs/processing/scripts/simulate-session.ts`, run by Bun directly) writes one to `recordings/sim_rig3/` to replay in the page; `e2e/rig.e2e.ts` calibrates one in headless Chromium.

## Measuring speed

- **`make profile`** (`clients/debug/scripts/profile-pipeline.ts`, in Bun; `make profile-node` runs the same in Node) runs the three simulated sensors at full resolution (24 × 923, a person walking, the cross-check on) and prints the ms per call of every pipeline step, the geometry build and the fusion. `ARGS="301 100"` for other beams and scans. Scans are cast before the clock starts. For a per-function breakdown, run `make profile-node` once and then its bundle (`clients/debug/node_modules/.cache/profile-pipeline.mjs`) with `node --cpu-prof`, and sum the self time per function.
- **Keep the output identical:** the golden checksums hash the exact bytes of the output, so an optimization that keeps the same arithmetic in the same order (precomputed per-beam points, hoisted constant terms, no allocations) passes them unchanged. For untracked stages, compare against the old function on the same inputs before deleting it.
- **In the browser:** replay `recordings/sim_rig3` (`make sim-session`), count `scene.update` calls per sensor (scans drawn) and the processed scans, and take a CPU profile over CDP (`Profiler.start`; build with `--minify false` for names). Headless Chromium renders with SwiftShader, a software GPU, so its frame rate says nothing about a real one. With `--enable-gpu --ignore-gpu-blocklist --use-angle=vulkan` (or `gl-egl`) it uses the machine's GPU.

## Measuring on recordings offline

The numbers in [pipeline.md](pipeline.md) and [objects.md](objects.md) came from a small Node script (not kept in the repository) that runs the browser pipeline on a recording:
- **Script:** a TypeScript file that imports `Processor`, `autoConfig` and `estimateNoise` from `@mrs6000/processing` (plus `foreground`/`fgTol` for ground truth), run with `bun replay.ts` from inside the workspace.
- **Read** the recording: an uncompressed `.tpc` (decompress with `mrs6000 decompress` first). Parse the JSON header line, then each scan: float64 time, uint16 distances × 12.5 mm, uint16 RSSI ([recordings.md](recordings.md)). Build the frame `[distance m | rssi | elevation deg]` that `Processor.ingest` takes, and pass the scan's own timestamp as `meta.ts`.
- **Run auto mode like the page:** start with `autoConfig(defaults, 0.02)`, and every 10 scans re-derive it from `estimateNoise(grid)`, keeping the user stages.
- **Score after a 3 s warm-up**, e.g. ghosts against offline ground truth (the empty scene = each beam's 85th-percentile range over the whole recording), roughness and flicker (`Processor.stats`), or spikes (triangles within ~6° of edge-on next to objects, from `buildGeometry`).
- **Look at the result:** write small PPM images of the range image (a few lines of code, no dependencies) to see where a rule fires.

## Checking the page visually

- Start an offline source server and the debug server on spare ports, each with a database of its own written first: `bun libs/server-common/scripts/seed.ts /tmp/s.db '{"port": 8113, "recordings": "recordings"}'` and `bun libs/server-common/scripts/seed.ts /tmp/d.db '{"port": 8013, "source": {"url": "http://127.0.0.1:8113", "token": ""}, "replay": "<name>"}'`, then `bun source-server/src/main.ts --offline --db /tmp/s.db` and `bun proc-servers/debug/src/main.ts --db /tmp/d.db`. Run `make build` first, since they serve the built pages. (The test helpers `startSource` and `seedDb` in `libs/server-common/src/testing.ts`, and `startServers` in `clients/debug/e2e/browser.ts`, do this on free ports.)
- Drive headless Chromium with `playwright-core` (resolved from `clients/debug/node_modules`) and screenshot the page itself (`page.screenshot`, optionally with a `clip`), never the desktop. A tall viewport (e.g. 1440 × 2600) shows the whole panel in one picture. A 390 × 844 viewport shows the phone layout.
- WebGL needs `--enable-unsafe-swiftshader --use-angle=swiftshader` in headless Chromium (as in `e2e/smoke.e2e.ts`).
- Stop the server afterwards by its PID, not with a pattern.

## End-to-end test pitfalls

- **Presets restart the beam histories:** after a preset or "Reset to defaults", the next few scans are empty or raw. Wait for data (`page.waitForFunction`) instead of reading it once.
- **Folded content is not clickable:** a stage's parameters are inside a closed `<details>`, so Playwright waits until it times out. Open the stage first (click its summary's name, not the checkbox).
- **Server state arrives by polling** every 500 ms (`/api/state`): after a replay action, wait for the page to show it (e.g. the stream summary) rather than asserting at once.
- **`fill()` on a range input is already the seek:** it fires `input` and `change`. An extra `dispatchEvent("change")` seeks a second time, to wherever a state poll set the slider meanwhile, and the test waits forever for the first target (the smoke test failed so about once in six suite runs until 2026-10-21).
- **The tests share one page and run in order:** a failure early in one test can leave the page in another view or mode and fail the next tests too. Fix the first failure first.
