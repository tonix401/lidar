# Documentation

Tools for a SICK MRS6224R LiDAR: a Python sensor library, CLI and viewer server (`backend/`), and a browser viewer (`frontend/`).

| Document | What's in it |
|---|---|
| [setup.md](setup.md) | Prerequisites per distribution, `make` targets, common fixes, running without `make` |
| [architecture.md](architecture.md) | What the backend and frontend do, and where each part lives |
| [sensor.md](sensor.md) | The MRS6224R: scan geometry, mounting, housing dimensions and the 3D model, REST / WebSocket / CoLa A interfaces and their quirks |
| [pipeline.md](pipeline.md) | The viewer's processing stages, auto and manual mode, presets, metrics and measurements |
| [viewer.md](viewer.md) | The page: the three views, draw modes, the panel and its controls, keys, theme, and how the panel is built |
| [objects.md](objects.md) | Object detection, tracking, classification and highlighting (work in progress) |
| [recordings.md](recordings.md) | Recording and replay, the `.tpc` / `.tpc.zstd` format, why it is compressed this way |
| [api.md](api.md) | The viewer's HTTP API |
| [errors.md](errors.md) | How the backend, browser and CLI report and recover from problems |
| [development.md](development.md) | Environment, tests, debugging, browser storage keys, rules for general thresholds, measuring on recordings, visual checks, e2e pitfalls |

Measurements are dated; they were taken on the recordings named next to them.
