# Architecture

Tools for a SICK MRS6224R LiDAR at `192.168.178.200`:
- **`backend/`:** a Python package `mrs6000`.
  - The sensor library and a CLI: REST, CoLa A, recording a single scan.
  - The viewer server (FastAPI): live stream, recordings, replay.
- **`frontend/`:** the browser viewer (Vite + TypeScript + three.js). It covers smoothing, object detection and highlighting, the 3D view, the 2D map and the range image, and recording/replay controls.
- **Several sensors** ([multisensor.md](multisensor.md)): the backend runs one connection and feed per sensor on one clock; the browser runs the whole pipeline per sensor and combines the results (calibration, fused objects) in `frontend/src/fusion/`.

The server streams raw scans; all processing ([pipeline.md](pipeline.md), [objects.md](objects.md)) runs in the browser. Recording and replay run server-side ([recordings.md](recordings.md)).

## Layout

```text
backend/
  src/mrs6000/            sensor library + CLI (never imports server/)
    rest.py cola.py preview.py model.py export.py env.py errors.py variables.py log.py cli.py
    clock.py              DeviceClock: a sensor's own clock mapped onto the host's (several sensors, one timeline)
    rig.py                the rig: sensor names, addresses, poses (rig.json, session.json)
    recording/            .tpc / .tpc.zstd recordings
      format.py           the file format (header, scans, zstd chunks with their index)
      reader.py           Recording (random access, grows while being recorded)
      recorder.py         Recorder (live scans → .tpc.zstd, writer thread)
      catalog.py          the recordings folder, safe names from the API, convert
      session.py          multi-sensor sessions: Session (one timeline over the files), SessionRecorder
    server/               viewer backend
      app.py              HTTP API (FastAPI) + static frontend; routes only call Hub methods
      hub.py              live sensors (LiveSensor, one feed each) / replay source switching, publishing, epochs, the rig
      player.py           playback position and transport controls (no threads, no locks)
      feed.py frames.py status.py health.py main.py
  tests/                  pytest with a fake CoLa sensor (TCP) and a fake REST sensor (HTTP),
                          plus a real 24-layer scan as a fixture
frontend/
  index.html  src/styles.css  src/main.ts
  src/app.ts              composition root: builds the parts, wires their callbacks, rebuild()
  src/sensorView.ts       one sensor in the page: frame stream, its Processor (in a worker), Geometry, pose
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
    host.ts worker.ts     each sensor's Processor in its own Web Worker; the page reads a mirror of it
    snapshot.ts           what the mirror gets after each scan (MIRRORED: the grid arrays the page reads)
    grid.ts beamState.ts  the range image, composed of each stage's declared state
  src/objects/            background, segmentation, Kalman, tracker, ObjectDetector (+ its StageDef)
  src/fusion/             several sensors: pose math, fused objects (objects.ts), calibration (calib/: floor,
                          walk, ICP, the rig solve, the guided Calibrator)
  src/render/             geometry (pure), describe (beam tooltip), scene3d (three.js), sensorModel, view2d (canvas)
  src/api/                typed API client, frame long-poll with retry, poller
  src/ui/                 the panel, one controller per part (see docs/viewer.md, "How the panel is built")
  tests/                  vitest on synthetic ray-cast scenes (tests/helpers/scene.ts; a multi-sensor rig in
                          rig.ts), jsdom for the panel, golden pipeline output, layering rules
  scripts/                simulate-session.ts (make sim-session), profile-pipeline.ts (make profile)
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
| `fusion/` (several sensors) | the model, `core/` |
| `render/` | the model, `fusion/`, `core/` |
| `api/` | `core/` |
| `ui/` | the model, `fusion/`, `render/`, `core/`; `api/` only as types |
| `app.ts`, `sensorView.ts`, `main.ts` | everything |
| `backend/src/mrs6000/` (library, `recording/`) | never `mrs6000.server` |

## Where a change goes

- **A pipeline stage:** one module (see [pipeline.md](pipeline.md#adding-a-stage)).
- **A panel control:** the markup in `index.html`, the controller in `ui/` that owns that part of the panel, and a callback in `app.ts` if other parts must react.
- **The page reads another grid array** (a view, tooltip, auto mode, fusion): add it to `MIRRORED` in `pipeline/snapshot.ts`. The page sees only a mirror of each Processor, filled after every scan, because the Processor itself runs in a worker. Settings travel with each request, and calls that change state go through `ProcessorHost` (`setMount`, `setLayerBias`, `reset`), never by writing into the mirror.
- **An API endpoint:** a `Hub` method (`server/hub.py`), a route in `server/app.py` that calls it, and the client in `frontend/src/api/client.ts`.
