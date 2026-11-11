# Architecture

Tools for SICK MRS6224R LiDARs (`192.168.178.200` by default). Since 2026-10-21 they are independent projects in
one repository: one **source server** that owns the sensors and their recordings, **processing servers** that each
turn the source's raw scans into what their clients need, and the **clients**.

```text
sensors ──CoLa──▶ source-server ──/ws (source protocol)──▶ proc-servers/debug ─────────▶ clients/debug (the viewer)
  (REST status)   live loops, clock,                     ├▶ proc-servers/object-detection ▶ clients/object-detection
                  recorder, archive, replays,            └▶ (more object-detection servers, one per configuration)
                  rig + calibration, its own page
```

- **The source server is the only one that talks to the sensors.** It connects every sensor (CoLa B for the scans,
  REST for its status), maps each sensor's clock onto the host's, records on request, keeps the recordings and serves
  them for download, and replays them for the processing servers. It owns the **rig** (where the sensors are) and
  **calibrates** it, on its own small page.
- **Processing servers only talk to the source**, never to each other. Each has its own settings and clients. A
  processing server may start replays at the source and drive their timelines; another may watch such a replay by its
  id (so far the debug server, for its page), getting the same frames while the owner keeps the timeline:
  - `proc-servers/debug` relays the raw frames to the debug page (which runs the whole pipeline itself, stage by stage)
    and keeps its own fused objects of the same frames next to them.
  - `proc-servers/object-detection` runs the objects-only pipeline and serves fused world tracks (position,
    velocity, box, class) over a WebSocket. One process per configuration: several run side by side.
- **Clients** talk to their processing server: `clients/debug` is the viewer (3D, map, range image, every stage's
  settings); `clients/object-detection` is a reference page for the objects protocol (a floor map).
- **Libraries** (`libs/`) are what the projects share. Projects import only libraries and their own files, never each
  other; libraries never import a project. `tests/layers.test.ts` (`make test-layers`) enforces it.
- **One Bun workspace** (`package.json` with every project and library, `bun.lock` at the root): one `bun install`.
- The old Python package (`backend/`: sensor library, command-line tool, the first viewer server) was removed on
  2026-10-22. Its command-line tools are not ported: the echo filter, reading device variables by name, converting
  `.tpc` ↔ `.tpc.zstd`, and CSV / PLY export.

The protocols are in [api.md](api.md): the source protocol between the source and the processing servers (one
WebSocket per source watched, binary frames), and each server's HTTP API and client protocol.

## Projects and libraries

| Folder | Package | What it is | Port (first start) |
|---|---|---|---|
| `source-server/` | `@mrs6000/source-server` | sensors, recordings, replays, rig, calibration; `web/`: its page | 8000 |
| `proc-servers/debug/` | `@mrs6000/proc-debug` | raw frames for the viewer, plus its own fused objects | 8010 |
| `proc-servers/object-detection/` | `@mrs6000/proc-objects` | fused world tracks for clients, track cache; one process per settings database `data/<name>.db` | 8020 |
| `clients/debug/` | `@mrs6000/client-debug` | the viewer (Vite + TypeScript + three.js) | (served by the debug server) |
| `clients/object-detection/` | `@mrs6000/client-objects` | the reference objects page (Vite + TypeScript, canvas) | (served by an object-detection server) |
| `libs/processing/` | `@mrs6000/processing` | the processing model, no DOM: pipeline, objects, fusion, calibration, simulator (`sim/`) | |
| `libs/wire/` | `@mrs6000/wire` | the protocols: frame codec, `Header`, rig, source messages, `WorldObject` and client options; no dependencies | |
| `libs/server-common/` | `@mrs6000/server-common` | what the servers share: the sensor workers and `SensorSet`, the source connection and pipeline, HTTP helpers and guards, the settings database (`settings.ts`, `bun:sqlite`) and a listener that can move (`listener.ts`), errors, logging | |
| `libs/web/` | `@mrs6000/web` | what the pages share: the settings form (drawn from the fields a server describes) | |

**Settings.** Each server keeps its settings in its own SQLite database (`<project>/data/`, gitignored; `--db` names
another; a new one starts as a copy of the committed `<project>/empty.db`) and edits them on its page through
`GET`/`PUT /api/settings`: the server describes its fields
(`libs/wire/src/settings.ts`), the page draws them (`libs/web`), and a change applies at once (another address or port
rebinds, another source reconnects). The only command-line options are `--db` and the source's `--offline`.

## Layout

```text
source-server/
  src/
    main.ts               --db and --offline, starts everything
    live.ts live/         a live sensor: its CoLa loop in its own worker (live/worker.ts, live/loop.ts), its state
    cola.ts rest.ts clock.ts status.ts model.ts variables.ts   the sensor's interfaces, its clock on the host's
    recording/            .tpc / .tpc.zstd recordings and multi-sensor sessions (format, reader, recorder, catalog)
    replay.ts player.ts   a consumer's replay: stream (paced, transport) or pull (every frame, by credit)
    hub.ts                live sensors, replays, recorder, the rig, the calibration
    calibration.ts calibWorker.ts   calibrating live or on a recording, the solve in its own thread
    ws.ts                 the processing servers' connections (the source protocol)
    http.ts store.ts settings.ts rig.ts zip.ts   the HTTP API, the settings database (sensors, consumers, the rest)
                          and changing it live, rig merging, session downloads
  data/                   source.db, its settings (gitignored); empty.db: the committed empty one a new one starts from
  scripts/                empty-db.ts (writes empty.db from the defaults), migrate-sessions.ts (session.json → headers)
  web/                    the page: sensors, recordings, calibration (with the result from above), the active sources and who watches
                          them, the registered processing servers, the settings
  tests/                  vitest with a fake CoLa sensor (TCP) and a fake REST sensor (HTTP), real-scan fixtures
proc-servers/debug/
  src/ main.ts hub.ts view.ts feed.ts http.ts store.ts settings.ts   a View per watched source (frames → Feeds for the long-poll)
  data/debug.db           its settings (gitignored), a copy of the committed empty.db at first
proc-servers/object-detection/
  src/ main.ts hub.ts replay.ts batch.ts trackCache.ts ws.ts http.ts store.ts settings.ts
  scripts/tracks.ts       a recording's tracks, the same to the byte on every run (make tracks)
  data/<name>.db          one settings database per server (gitignored), a copy of empty.db at first
clients/debug/            the viewer (see docs/viewer.md): src/app.ts, sensorView.ts, worker/, render/, api/, ui/; e2e/
clients/object-detection/ src/main.ts (connection, panel), map.ts (the floor map), model.ts (the messages, tested)
libs/processing/          src/core config pipeline objects fusion; sim/; tests/ (golden checksums, layer rules); scripts/
libs/wire/                src/frame.ts rig.ts source.ts objects.ts settings.ts
libs/server-common/       src/sensor/ (core, runner, worker), sensorSet.ts, sourceClient.ts, pipeline.ts, http.ts, settings.ts,
                          listener.ts, …; scripts/ seed.ts (write settings into a database) and listen.ts (a database's address)
libs/web/                 src/settingsForm.ts (+ .css)
tests/layers.test.ts      the import rules between projects and libraries
docs/                     this documentation
recordings/               the source server's recordings (gitignored)
```

## How the processing is split

- **Per sensor first, then fusion.** Each sensor's scans go through the range-image pipeline on their own (in a
  worker per sensor, `libs/server-common/src/sensor/`, or in the page's workers); fusion combines their outputs in
  world coordinates ([multisensor.md](multisensor.md)).
- **The same code everywhere.** A processing server feeds a `SensorSet` from a `SourcePipeline`
  (`libs/server-common/src/pipeline.ts`) whether it watches the live sensors or a replay, so replayed tracks equal
  live ones. The source's calibration runs the same `SensorSet` on live frames or on a recording.
- **Reproducible to the byte** with every sensor on the main thread (`threaded: false`) and every frame in order
  (pull mode): `make tracks` gives the same output on every run. With workers, how the scans of the sensors group into
  sets depends on which worker finishes first, so two runs differ in a few sets (measured 2026-10-21 on `sim_rig3`:
  444 vs 441 sets).

## Layers inside the processing model

Lower layers never import higher ones, so the processing runs and is tested without a DOM, three.js or a server.
`libs/processing/tests/layers.test.ts` (the package imports no other package and has no DOM types) and
`clients/debug/tests/layers.test.ts` (the page imports the model only as the package) enforce it.

| Folder | May import |
|---|---|
| `libs/processing/src/core/` | nothing |
| `libs/processing/src/{config,pipeline,objects}/` (the processing model) | each other, `core/` |
| `libs/processing/src/fusion/` (several sensors) | the model, `core/` |
| `libs/processing/sim/` | all of `libs/processing/src/` (never the other way round) |
| `clients/debug/src/render/`, `clients/debug/src/worker/` | the processing package |
| `clients/debug/src/api/` | the package's `core/` |
| `clients/debug/src/ui/` | the processing package, `render/`; `api/` only as types |
| `app.ts`, `sensorView.ts`, `main.ts` | everything |

## Where a change goes

- **A pipeline stage:** one module in `libs/processing/src/pipeline/` (see [pipeline.md](pipeline.md#adding-a-stage)).
- **A panel control of the viewer:** the markup in `clients/debug/index.html`, the controller in `ui/` that owns that
  part of the panel, and a callback in `app.ts` if other parts must react.
- **The viewer reads another grid array** (a view, tooltip, auto mode, fusion): add it to `MIRRORED` in
  `clients/debug/src/worker/snapshot.ts`. The page sees only a mirror of each Processor, filled after every scan.
- **Something about the sensors, recordings or the rig:** the source server (`hub.ts` method, a route in `http.ts`,
  and its page in `web/`); if the processing servers need it, a message in `libs/wire/src/source.ts`.
- **Another kind of client output:** a new processing server in `proc-servers/`, built on `SourcePipeline`, with
  its own client protocol in `libs/wire/` if others are to use it.
- **A new client:** a folder in `clients/` that talks to one processing server.
