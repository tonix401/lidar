# Documentation

Tools for SICK MRS6224R LiDARs: a source server (the sensors, recordings, calibration), processing servers (debug,
object detection) and their clients (the viewer, a reference objects page).

| Document | What's in it |
|---|---|
| [setup.md](setup.md) | Prerequisites per distribution, `make` targets, common fixes, running without `make` |
| [architecture.md](architecture.md) | The projects (source server, processing servers, clients) and libraries, what each does, where each part lives |
| [sensor.md](sensor.md) | The MRS6224R: scan geometry, mounting, housing dimensions and the 3D model, REST / WebSocket / CoLa A interfaces and their quirks |
| [pipeline.md](pipeline.md) | The viewer's processing stages, auto and manual mode, presets, metrics and measurements |
| [viewer.md](viewer.md) | The page: the three views, draw modes, the panel and its controls, keys, theme, and how the panel is built |
| [objects.md](objects.md) | Object detection, tracking, classification and highlighting (work in progress) |
| [multisensor.md](multisensor.md) | Several sensors: setup, one clock, calibration (floor, walk, ICP), fused objects, what was measured, what is open |
| [recordings.md](recordings.md) | Recording and replay, the `.tpc` / `.tpc.zstd` format and multi-sensor sessions, why it is compressed this way |
| [api.md](api.md) | Each server's HTTP API, the source protocol between the servers, the objects protocol for clients |
| [errors.md](errors.md) | How the servers, browser and CLI report and recover from problems |
| [development.md](development.md) | Environment, tests, debugging, browser storage keys, rules for general thresholds, measuring on recordings, visual checks, e2e pitfalls |

Measurements are dated; they were taken on the recordings named next to them.
