# SICK MRS6224R-131001: data access, processing servers and viewers

Tools for SICK MRS6224R LiDARs, as independent projects ([architecture](docs/architecture.md)): a **source server**
that connects the sensors, records them, keeps the recordings and calibrates the rig (`source-server/`, with its own
page); **processing servers** that turn the raw scans into what their clients need (`proc-servers/debug`,
`proc-servers/object-detection`); and their **clients**, the viewer with smoothing, object detection and 3D / 2D /
range-image views (`clients/debug`) and a reference page for the fused objects (`clients/object-detection`).

```sh
make run                          # first start: source :8000 (its page), debug viewer :8010, object detection :8020
make run ARGS="--offline"         # no sensors: replay recordings from the viewer
make sim-session                  # a simulated 3-sensor session to try that without them
make test
```

Needs Bun 1.4+, make and git. Every server keeps its settings (sensors, addresses and ports, tokens, processing) in
its own SQLite database and edits them on its page, applied at once ([setup](docs/setup.md#configuration)).

**Documentation is in [`docs/`](docs/README.md):** [setup](docs/setup.md) · [architecture](docs/architecture.md) · [sensor](docs/sensor.md) · [pipeline](docs/pipeline.md) · [objects](docs/objects.md) · [several sensors](docs/multisensor.md) · [recordings](docs/recordings.md) · [APIs](docs/api.md) · [errors](docs/errors.md) · [development](docs/development.md)
