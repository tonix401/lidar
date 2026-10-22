# APIs

Three kinds of server, each with an HTTP API under `/api` and a WebSocket at `/ws` ([architecture.md](architecture.md)).
Errors are short JSON `{"error": …}` responses with the usual status codes ([errors.md](errors.md)).

**Guards on every server.** Every API request and WebSocket upgrade must name the server by a name it has: its Host
must be a loopback name (`localhost`, `127.0.0.1`, `[::1]`), this machine's host name (or `<name>.local`), one of its
network addresses, or the host of an origin in its *Other pages allowed to make changes* setting; anything else is
refused (403). Otherwise a page whose own domain was pointed at this machine (DNS rebinding) would count as the
server's own page. A state-changing request (POST, PUT, DELETE) or a WebSocket upgrade from a web page of
another origin is refused (403): a browser sends any site's requests to a server on localhost. Pages of the server's
own origin, and origins in its *Other pages allowed to make changes* setting, are allowed (the `make dev` pages are
proxied with their own address, so they count as the server's own); requests without an Origin (curl, the other
servers) are not a browser's. Request bodies must be `Content-Type: application/json` (a cross-site form cannot send
that). Once a server has an admin token, changes need `Authorization: Bearer <adminToken>`.

**Settings on every server.** `GET /api/settings` (admin) gives the server's own settings as `{fields, values}`: each
field's `key` (a path such as `source.url`), `label`, `type` (text, secret, url, number, port, bool, lines, select,
json), `group` and `help` (`libs/wire/src/settings.ts`). `PUT /api/settings` (admin) with some of the keys checks them,
applies them at once and saves them in the server's SQLite database; an unknown key or a bad value is refused (400) and
changes nothing. The answer is the settings now, plus `moved: {host, port}` when the server listens elsewhere from now
on (it bound the new address before letting the old one go; the request that moved it is still answered on the old
one). The pages draw their settings form from the fields (`libs/web/src/settingsForm.ts`).

## Source server (`source-server`, :8000)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Live sensors (`name`, `ip`, `error`, `rate`, `clock`, `device`, `upside_down`), recording progress, replays (`id`, `recording`, `mode`, `owner`, `consumers`, position), the calibration's target. |
| GET | `/api/status?sensor=<name>` | A live sensor's REST device values. |
| GET | `/api/registry/sensors` | The configured sensors (`name`, `ip`, `enabled`, `mount`, and their pose). POST adds one; PUT/DELETE `/api/registry/sensors/<name>` change or remove one. The live sensors restart (refused while recording). |
| GET | `/api/rig?recording=<name>` | The poses: the live rig, or a recording's (from its files' headers). |
| PUT | `/api/rig?recording=<name>` `{"sensors":[{"name", "pose":{x,y,z,yaw,pitch,roll}, "time_offset_s", "calibrated", "quality"}]}` | Store poses (a single-sensor recording has no rig). Every processing server watching it gets the new rig. |
| GET | `/api/recordings` | List (name, bytes, scans, seconds, created, the sensors of a session). |
| GET | `/api/recordings/<name>` | Download (a session folder as `.zip`). DELETE removes it and ends its replays. |
| POST | `/api/record {"action":"start"\|"stop"}` | Record every live sensor (several: one session folder). |
| GET | `/api/calibration` | The calibration's phase (`idle`, `empty`, `walk`, `done`, `failed`), progress and result. |
| POST | `/api/calibration {"action":"start"\|"cancel"\|"accept"\|"discard", "recording"?, "options"?}` | Calibrate the live sensors, or on a recording; accept stores the poses. |
| GET | `/api/calibration/points` | The result's check: each sensor's empty scene from above in the solved poses (`xy` pairs, m). |
| GET | `/api/consumers` | The connected processing servers (name, the source they watch, `owns`: started that replay, frames sent and dropped). |
| GET | `/api/registry/consumers` | Registered processing servers with their tokens (admin); POST `{"name"}` adds one, DELETE `/api/registry/consumers/<name>`. |
| GET/PUT | `/api/settings` | Address, port, recordings folder (changed: from now on; refused while recording), `open` (unregistered processing servers may connect), admin token, origins. |

Its database is `source-server/data/source.db` (`--db`): the sensors with their poses, the registered processing
servers and the settings. A new one starts as a copy of the committed `source-server/empty.db` (the defaults).

### The source protocol (`/ws`, version 1)

Types in `libs/wire/src/source.ts`. One connection watches one source: the live sensors, a replay of its own (which
only it controls, and which ends when the connection closes), or another connection's stream replay, watched by its id
(listed in the source's `/api/state` with its `owner`, the name the creating server said hello with). A watcher gets
the same frames at the same moment; the timeline stays the owner's. So far only the debug server offers watching.

| Direction | Message | |
|---|---|---|
| → source | `{"type":"hello","role":"processing","name","token"?}` | first |
| → source | `{"type":"subscribe","source":"live"}` | the live sensors |
| → source | `{"type":"replay","recording","mode":"stream"\|"pull"}` | a replay of its own |
| → source | `{"type":"join","source"}` | watch another connection's stream replay (a pull replay is refused) |
| → source | `{"type":"control","action","value"?}` | stream mode, own replay only: play, pause, toggle, step, seek, speed, loop |
| → source | `{"type":"credit","n"}` | pull mode: send `n` more frames |
| ← source | `welcome`, `subscribed {source, sensors, mode, recording?, count?, owner?, controls?}` | a replay's owner, and whether this connection controls it; for live, again whenever the live sensors change (the registry): start afresh with the new sensor list |
| ← source | `rig {source, version, rig}` | after subscribing and whenever it changes |
| ← source | `layout {source, sensor, hdr}` | before a sensor's first frame and when its layout changes |
| ← source | binary frame | uint32 n (LE), n bytes of JSON meta `{type:"frame", source, sensor, k, t, rate, epoch}` (padded to 4 bytes), uint16 distances (12.5 mm units, 0 = none), uint16 rssi; layer-major |
| ← source | `state {source, replay, error}` | stream mode: on changes and about four times a second while playing |
| ← source | `status {sensors}` | the live sensors, about once a second |
| ← source | `end {source}`, `closed {source, reason}`, `error {message}` | pull mode done; the replay is gone (WebSocket close code 4004); a refusal (4001: unknown consumer) |

`k` is a live sensor's scan counter, or a replayed frame's index in the recording; `t` is the host clock (live) or as
recorded. `epoch` increments whenever a replay's sequence is not continuous (seek, step back, loop wrap). Live and
stream frames are dropped while a consumer's send buffer holds more than 8 MB (counted in `/api/consumers`); pull
mode never drops: the consumer's credit bounds it. A scan is about 89 KB (24 × 923 beams), so one sensor at 10 Hz is
about 0.9 MB/s per consumer.

## Debug server (`proc-servers/debug`, :8010)

What the viewer calls. A *view* is the live sensors, or with `?session=<id>` a replay of the page's own.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/frame?after=<id>&sensor=<name>&session=<id>` | Long-poll. Three float32 blocks (dist m, rssi, elev); meta in the `X-Meta` header (`ts`, `source`, `epoch`, `replay`, `sensor`, `scan`, `upside_down`). Without `sensor`: the view's first; an unknown one is a 404. |
| GET | `/api/sensors?session=` | The view's sensors: `name`, `live`, and for live ones `ip`, `error`, `rate`, `clock`, `device`, `upside_down`. |
| GET | `/api/rig?session=` | Their poses, as the source sends them (calibrate on the source server). |
| GET | `/api/status?sensor=` | A live sensor's REST device values, from the source. |
| GET | `/api/state?session=` | The view, its `epoch`, `sensors`, replay position, the source's recording, errors, `rig_version`, `source_url`, `controls` (false: another server's replay, only watched), `owner`. |
| GET | `/api/objects?session=` | The server's own fused objects of the view's latest scans. |
| POST | `/api/sessions {"recording"}` | A replay of the page's own: `{id, recording, sensors, owner, controls: true}`. The id (32 hex digits, never listed) is what controls it. |
| POST | `/api/sessions {"join": <replay id>}` | Watch another processing server's replay (from `/api/sources`): `{…, owner, controls: false}`. Its controls are refused (400); it ends when its owner's replay does. |
| GET | `/api/sources` | The other processing servers' stream replays at the source: `id`, `recording`, `owner`, `sensors`, `consumers`, position. |
| POST | `/api/sessions/<id>/control {"action","value"}` | play, pause, toggle, step, seek, speed, loop. |
| DELETE | `/api/sessions/<id>` | End it (a replay nobody asked about for 30 s ends by itself). |
| GET | `/api/recordings` | The source's recordings. |
| GET/PUT | `/api/config` | Its own processing settings (for `/api/objects`). |
| GET/PUT | `/api/settings` | The source server's URL and its token there, its name, a replay every page opens first, address, port, its own objects on or off and their processing settings, admin token, origins. Another source, token, name or objects setting starts every view afresh (the pages' replays end). |

Its database is `proc-servers/debug/data/debug.db` (`--db`); a new one starts as a copy of the committed `empty.db`.

## Object-detection server (`proc-servers/object-detection`, :8020)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Its name, the source connection, the live sensors, their status and rig, replays, background jobs. |
| GET/PUT | `/api/config` | The processing settings (PUT: admin). |
| GET | `/api/recordings` | The source's recordings. |
| POST/GET | `/api/recordings/<name>/process` | Compute a recording's tracks in the background into the track cache (pull mode); its progress. |
| DELETE | `/api/recordings/<name>/cache` | Forget a recording's cached tracks. |
| GET | `/api/clients` | The registered clients with their tokens (admin). POST `{"name", "options"}` adds one; PUT/DELETE `/api/clients/<id>`. |
| GET | `/api/connections`, `/api/replays` | Who is connected, and the replays (admin). |
| GET/PUT | `/api/settings` | The source server's URL and token, its name, address, port, replays with their own processing at once (`maxSessions`), track cache folder, processing settings, `open` (unknown clients may connect), admin token, origins. Another source, token or name ends the replays and the background jobs and starts the live processing afresh. |

Each server has its own database, `data/<name>.db` (`--db`; the name is the file's, until it is changed): the settings
and the registered clients. A new one starts as a copy of the committed `empty.db` (the defaults without a name: the
server's name is its file's).

### The objects protocol (`/ws`, version 1)

Types in `libs/wire/src/objects.ts`; `clients/object-detection` is a working client.

| Direction | Message | |
|---|---|---|
| → server | `{"type":"hello","token"?,"name"?,"options"?}` | a registered client's token (its stored options apply), or anonymous while `open` |
| → server | `{"type":"subscribe","source":"live"\|<replay id>}` | |
| → server | `{"type":"options","options":{rate?, classes?, region?, transform?, trails?}}` | at most `rate` messages/s; only these classes; only inside a floor polygon; in its own frame `{x, y, yaw}`; with trails |
| → server | `{"type":"replay","recording"}` | a replay of its own, subscribed to once it is ready (it ends when its last client leaves) |
| → server | `{"type":"control","action","value"?}` | its own replay only |
| ← server | `welcome {server, client, options, sensors}`, `subscribed {source, sensors, rig, replay, owner}` | |
| ← server | `objects {source, t, seq, objects: WorldObject[]}` | per set of scans (about 10 per second) |
| ← server | `track {source, event: "start"\|"end", id, cls?, t}` | |
| ← server | `state {source, replay, error}`, `closed {source, reason}`, `error {message}` | |

A `WorldObject` is `{id, cls, x, y, vx, vy, speed, box: {len, wid, yaw, z0, z1}, sensors, age, moved, trail?}` in the
rig's world frame (x, y on the floor, z up; m, m/s, degrees), rounded to mm and 0.1°: about 200 bytes each.

Recording names are plain `*.tpc` or `*.tpc.zstd` file names, or session folder names, inside the source's
recordings folder ([recordings.md](recordings.md)). In the source's `/api/state`, `recording.bytes` counts what is
already on disk, so it grows in steps of one chunk (2.5 s).
