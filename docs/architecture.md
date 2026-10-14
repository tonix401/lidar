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
  src/mrs6000/            sensor library + CLI
    rest.py cola.py preview.py model.py export.py env.py errors.py variables.py cli.py
    server/               viewer backend
      app.py              HTTP API (FastAPI) + static frontend
      hub.py              live / replay source switching, playback control, epochs
      stream.py           .tpc / .tpc.zstd format, Recording (random access), Recorder
      feed.py frames.py status.py health.py main.py
  tests/                  pytest with a fake CoLa sensor (TCP) and a fake REST sensor (HTTP),
                          plus a real 24-layer scan as a fixture
frontend/
  index.html  src/styles.css  src/main.ts  src/app.ts (wiring)
  src/core/               types, math, colours, formatting
  src/config/             settings schema + presets (config.ts), auto mode, storage
  src/pipeline/           one module per processing stage + Processor (order of stages), metrics.ts
  src/objects/            background, segmentation, Kalman, tracker, ObjectDetector
  src/render/             geometry (pure), scene3d (three.js), sensorModel (housing mesh), view2d (canvas)
  src/api/                typed API client, frame long-poll with retry
  src/ui/                 the panel (see docs/viewer.md, "How the panel is built"):
    stageControls.ts      stage sections generated from STAGES (typed values, changed markers, auto read-only)
    statsPanel.ts         the Statistics box (grouped rows, updated in place)
    views.ts              which controls each view shows (data-views / data-draw)
    info.ts               ⓘ icons and their floating explanation box
    theme.ts              dark / light / system theme, colours for canvas and WebGL
    recordingPanel.ts     Record button, recordings list and ⋯ menu, replay bar
    devicePanel.ts objectsPanel.ts charts.ts problems.ts dom.ts
  tests/                  vitest on synthetic ray-cast scenes (tests/helpers/scene.ts), jsdom for the panel
  e2e/                    real backend (offline, generated recording) + built frontend in headless Chromium
docs/                     this documentation
recordings/               .tpc.zstd recordings (gitignored)
```
