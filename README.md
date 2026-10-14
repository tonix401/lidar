# SICK MRS6224R-131001: data access and live viewer

Tools for a SICK MRS6224R LiDAR: a Python sensor library, CLI and viewer server (`backend/`), and a browser viewer with smoothing, object detection, 3D / 2D / range-image views and recording/replay (`frontend/`).

```sh
make run                                              # viewer on http://localhost:8000
make run ARGS="--offline --replay recordings/<file>.tpc.zstd"   # replay without the sensor
make test
```

Needs Python ≥ 3.14, Node.js 22.22+ or 24.15+, make and git.

**Documentation is in [`docs/`](docs/README.md):** [setup](docs/setup.md) · [architecture](docs/architecture.md) · [sensor](docs/sensor.md) · [pipeline](docs/pipeline.md) · [objects](docs/objects.md) · [recordings](docs/recordings.md) · [API](docs/api.md) · [errors](docs/errors.md) · [development](docs/development.md)
