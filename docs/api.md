# HTTP API

Served by the viewer backend (`backend/src/mrs6000/server/app.py`). Interactive docs are at `http://localhost:8000/docs`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/frame?after=<id>&sensor=<name>` | Long-poll. Three float32 blocks (dist m, rssi, elev); meta is in the `X-Meta` header (incl. `ts`, `source`, `epoch`, `replay`, `sensor`, `upside_down`). Without `sensor`: the current source's first; an unknown one is a 404. |
| GET | `/api/sensors` | The current source's sensors: `name`, `live`, and for live ones `ip`, `error`, `rate`, `clock` (offset, drift), `device`, `upside_down`. |
| GET | `/api/rig` | Their poses ([multisensor.md](multisensor.md)): `rig.json` while live, the session's own while replaying one. |
| PUT | `/api/rig {"sensors":[{"name", "pose":{x,y,z,yaw,pitch,roll}, "time_offset_s", "calibrated", "quality"}]}` | Store calibration results for the current source (a single-sensor recording has no rig). |
| GET | `/api/status?sensor=<name>` | REST device values (without `sensor`: the first sensor's, with every live sensor's error). |
| GET | `/api/state` | Source, `sensors` (the current source's names), replay position, recording progress. |
| GET | `/api/recordings` | List of recordings. |
| GET | `/api/recordings/<name>` | Download (a session folder as `.zip`). |
| DELETE | `/api/recordings/<name>` | Delete. |
| POST | `/api/record {"action":"start"\|"stop"}` | Start or stop recording. |
| POST | `/api/replay {"file":name}` | Play a recording. |
| POST | `/api/live` | Back to the live sensor. |
| POST | `/api/replay/control {"action":"play\|pause\|toggle\|step\|seek\|speed\|loop","value":…}` | Playback control. |

Recording names are plain `*.tpc` or `*.tpc.zstd` file names, or session folder names, inside the recordings folder ([recordings.md](recordings.md)). In `/api/state`, `recording.bytes` counts what is already on disk, so it grows in steps of one chunk (2.5 s).

Errors are short JSON `{"error": …}` responses ([errors.md](errors.md)).
