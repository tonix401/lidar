# Development notes

- **Environment:** plain Python venv in `backend/.venv` and npm in `frontend/`, nothing system-specific. `shell.nix` is only a convenience for NixOS. There, Playwright's downloaded Chromium does not run, so the system `chromium` is used. Python must be 3.14 or newer for the standard-library `compression.zstd` ([setup.md](setup.md)).
- **Tests:** `make test` runs everything.
  - **Backend:** about 60 pytest tests. They use fake sensors, so no hardware is needed.
  - **Frontend:** about 65 vitest tests on synthetic ray-cast scenes, plus jsdom tests for the panel.
  - **End to end:** a browser test with Playwright and Chrome or Chromium (see [setup.md](setup.md)). It writes its own `.tpc` recording and replays it through the real backend. Its screenshots go to `frontend/e2e/artifacts/`.
  - `make test-e2e` rebuilds the frontend first; `cd frontend && npm run test:e2e` uses the existing `frontend/dist`.
- **Debugging:** in the browser console, `window.mrs6000` is the app: `processor` holds the grid and objects, `cfg` the settings, `geo` the geometry.
- **Browser storage keys:**
  - `mrs6000.smoothing.v3` (mode and manual settings)
  - `mrs6000.layerbias.v2`
  - `mrs6000.mount.v2`
  - `mrs6000.view`
  - `mrs6000.fillWalls` (remembered walls on/off)
  - `mrs6000.obj.*` (object display toggles)
- **Documentation:** lives in `docs/`, one file per topic, indexed in [README.md](README.md). The top-level `README.md` only points here.
