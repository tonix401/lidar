# Architecture

Tools for a SICK MRS6224R LiDAR at `192.168.178.200`:
- **`backend/`:** a Python package `mrs6000`.
  - The sensor library and a CLI: REST, CoLa A, recording a single scan.
  - The viewer server (FastAPI): live stream, recordings, replay.
- **`frontend/`:** the browser viewer (Vite + TypeScript + three.js). It covers smoothing, object detection and highlighting, the 3D view, the 2D map and the range image, and recording/replay controls.

The server streams raw scans; all processing ([pipeline.md](pipeline.md), [objects.md](objects.md)) runs in the browser. Recording and replay run server-side ([recordings.md](recordings.md)).

## Layout

```text
backend/
  src/mrs6000/            sensor library + CLI (never imports server/)
    rest.py cola.py preview.py model.py export.py env.py errors.py variables.py log.py cli.py
    recording/            .tpc / .tpc.zstd recordings
      format.py           the file format (header, scans, zstd chunks with their index)
      reader.py           Recording (random access, grows while being recorded)
      recorder.py         Recorder (live scans → .tpc.zstd, writer thread)
      catalog.py          the recordings folder, safe names from the API, convert
    server/               viewer backend
      app.py              HTTP API (FastAPI) + static frontend; routes only call Hub methods
      hub.py              live / replay source switching, publishing, epochs, threads
      player.py           playback position and transport controls (no threads, no locks)
      feed.py frames.py status.py health.py main.py
  tests/                  pytest with a fake CoLa sensor (TCP) and a fake REST sensor (HTTP),
                          plus a real 24-layer scan as a fixture
frontend/
  index.html  src/styles.css  src/main.ts
  src/app.ts              composition root: builds the parts, wires their callbacks, rebuild()
  src/core/               types, math, colours, formatting
  src/config/
    types.ts              StageDef: what a stage declares (panel section, defaults, auto/preset role)
    stages.ts             STAGES (panel order), Config, defaultConfig()
    presets.ts            off / light / medium / strong
    config.ts             the public face of config/, stored-settings and typed-value helpers
    state.ts              ConfigState: auto / manual, what is stored (no DOM)
    auto.ts storage.ts mesh.ts
  src/pipeline/           one module per stage: its StageDef, its per-beam state, its functions
    steps.ts              PIPELINE: the order of the stages (ingest / refine / learn)
    processor.ts          runs PIPELINE, owns the long-lived state
    grid.ts beamState.ts  the range image, composed of each stage's declared state
  src/objects/            background, segmentation, Kalman, tracker, ObjectDetector (+ its StageDef)
  src/render/             geometry (pure), describe (beam tooltip), scene3d (three.js), sensorModel, view2d (canvas)
  src/api/                typed API client, frame long-poll with retry, poller
  src/ui/                 the panel, one controller per part (see docs/viewer.md, "How the panel is built")
  tests/                  vitest on synthetic ray-cast scenes (tests/helpers/scene.ts), jsdom for the panel,
                          golden pipeline output, layering rules
  e2e/                    real backend (offline, generated recording) + built frontend in headless Chromium
docs/                     this documentation
recordings/               .tpc.zstd recordings (gitignored)
```

## Layers

Lower layers never import higher ones, so the processing runs and is tested without a DOM, three.js or the
server. Tests enforce it: `frontend/tests/layers.test.ts` and `backend/tests/test_layers.py`.

| Folder | May import |
|---|---|
| `core/` | nothing |
| `config/`, `pipeline/`, `objects/` (the processing model) | each other, `core/` |
| `render/` | the model, `core/` |
| `api/` | `core/` |
| `ui/` | the model, `render/`, `core/`; `api/` only as types |
| `app.ts`, `main.ts` | everything |
| `backend/src/mrs6000/` (library, `recording/`) | never `mrs6000.server` |

## Where a change goes

- **A pipeline stage:** one module (see [pipeline.md](pipeline.md#adding-a-stage)).
- **A panel control:** the markup in `index.html`, the controller in `ui/` that owns that part of the panel, and a callback in `app.ts` if other parts must react.
- **An API endpoint:** a `Hub` method (`server/hub.py`), a route in `server/app.py` that calls it, and the client in `frontend/src/api/client.ts`.
