# HTTP API

Served by the viewer backend (`backend/src/mrs6000/server/app.py`). Interactive docs are at `http://localhost:8000/docs`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/frame?after=<id>` | Long-poll. Three float32 blocks (dist m, rssi, elev); meta is in the `X-Meta` header (incl. `ts`, `source`, `epoch`, `replay`). |
| GET | `/api/status` | REST device values. |
| GET | `/api/state` | Source, replay position, recording progress. |
| GET | `/api/recordings` | List of recordings. |
| GET | `/api/recordings/<name>` | Download. |
| DELETE | `/api/recordings/<name>` | Delete. |
| POST | `/api/record {"action":"start"\|"stop"}` | Start or stop recording. |
| POST | `/api/replay {"file":name}` | Play a recording. |
| POST | `/api/live` | Back to the live sensor. |
| POST | `/api/replay/control {"action":"play\|pause\|toggle\|step\|seek\|speed\|loop","value":…}` | Playback control. |

Recording names are plain `*.tpc` or `*.tpc.zstd` file names inside the recordings folder ([recordings.md](recordings.md)). In `/api/state`, `recording.bytes` counts what is already on disk, so it grows in steps of one chunk (2.5 s).

Errors are short JSON `{"error": …}` responses ([errors.md](errors.md)).
