# Recording and replay

The source server records and keeps them (`source-server/src/recording/` for the format, reading and recording;
`replay.ts` and `player.ts` for playback), with controls on its page; the viewer replays them through the debug
server, and an object-detection server computes their tracks (pull mode, [api.md](api.md#the-source-protocol-ws-version-1)).

- **Recording:** the **● Record** button on the source server's page saves the *live* stream to `recordings/rec_YYYYmmdd_HHMMSS.tpc.zstd`, zstd-compressed (lossless) to about 7.5 MB per minute. It keeps recording while you watch a replay.
  - A writer thread compresses in chunks of 25 scans (2.5 s), so the live stream never waits on it. A file being recorded can be replayed up to its last complete chunk, and a crash loses at most the last 2.5 s.
- **Compress / decompress files:** `zstd -d x.tpc.zstd` gives `x.tpc`, and replay reads both. There is no command to compress a `.tpc` with the seek index any more (the Python `mrs6000 compress` was removed on 2026-10-22; the source server has the function, `convert` in `recording/catalog.ts`, but nothing calls it); an uncompressed `.tpc` replays as it is.
- **Recordings list:** on the source server's page with length, size, sensors and date, Download and Delete; in the
  viewer, name and duration, ▶ to play (or click the row), the size in its tooltip ([viewer.md](viewer.md#panel)).
- **Transport bar** (shown while replaying):
  - Step back / play-pause / step forward, a seek slider, speed 0.25–4×, loop, and "● Live".
  - Keys: Space = play/pause, ←/→ = step.
- **Epoch:** the server bumps `epoch` on every seek, step back, loop wrap or source switch, and the page then resets its per-beam history and tracks.

The HTTP endpoints for all of this are in [api.md](api.md).

## Sessions

With several live sensors, **● Record** (on the source server's page) records all of them into one folder (`source-server/src/recording/session.ts`):

```text
rec_20261020_120000/
  a.tpc.zstd  b.tpc.zstd  ...
```

- Each file is an ordinary recording whose header also says what the session needs about its sensor (see Format below): its `sensor` name, its `index` in the session (0: the first sensor, the world's origin), `created`, and its `rig` entry (pose, time offset, calibration date and quality). The scan times of all files are on one clock ([multisensor.md](multisensor.md#time-one-clock-for-all-sensors)). There is no other file: a session is the folder of them.
- The rig entries are the poses at record time, so a replay is self-contained. Calibrating on a recording stores the new poses in its headers: each file is written anew through a temporary file, its scans copied as they are (refused while it is being recorded).
- **Replay** merges the files into one timeline (frame k = the k-th scan in time over all sensors) and publishes each scan to its sensor's feed. While the source server is still recording a session, only scans up to the last time every sensor has reached are shown, so frames are only ever appended.
- Sessions recorded before 2026-10-22 kept this in a `session.json`; `bun source-server/scripts/migrate-sessions.ts recordings` moves it into the headers.
- The list shows a session with its sensor count; Download gives a `.zip` of the folder. One sensor still records a plain file.

## Storage

`recordings/` is gitignored. GitHub rejects files over 100 MB, and a 132 MB recording once blocked a push. The walk recording used for tuning is `recordings/walk_20261014.mrsstream` (rename it to `.tpc` to replay it); it is also on the `backup-before-rewrite` branch.

## Format

`.tpc` (temporal point cloud) is project-specific, not a standard. Its building blocks are: JSON, little-endian integers and floats, and standard zstd.

- **`.tpc`:** a JSON header line `{layers, beams, start_azimuth_deg, step_deg, elev[layers*beams], upside_down?, sensor?, index?, created?, rig?, truth?}` (the last four: a session's, `truth` only in simulated ones; `RecordingMeta` in `format.ts`), then fixed-size scans: float64 unix time, uint16 distance (12.5 mm units, 0 = invalid), and uint16 RSSI, layer-major, little endian. Scan k sits at `header_end + k × (8 + 4 × layers × beams)`; about 88 kB per scan, 53 MB per minute.
- **`.tpc.zstd`** (what the recorder writes): a standard zstd stream that decompresses to the `.tpc`.
  - Its zstd frames hold the header, then chunks of up to 25 scans.
  - Before each one, a zstd *skippable frame* (magic `0x184D2A5E`, which `zstd -d` ignores) holds the seek index: `b"TPC1"`, uint32 scan count, uint32 length of the following zstd frame, and the scans' float64 times. The header's entry has a scan count of 0.
  - Each entry and its frame are written in one piece, so a reader indexes complete chunks only and simply ignores a chunk still being written.
  - A file compressed with plain `zstd` lacks that index and is rejected with a hint: `zstd -d` it back to a `.tpc`.
- Older `.mrsstream` files are not read. Their content is the `.tpc` layout, so renaming one to `.tpc` converts it.
- Only the first echo is stored (`echoes[0]`); see the echo test in [pipeline.md](pipeline.md).

Standard formats that could be added as exports if recordings need to open elsewhere: **MCAP** (ROS 2's default, opens in Foxglove, also compresses in zstd chunks), **pcap** of the raw CoLa TCP stream (readers still need a SICK decoder), and **PLY / PCD / LAS** for single scans (the removed Python `mrs6000 record` wrote PLY).

## Compression: what was measured (2026-10-14)

All on `rec_20261014_223527`: 383 scans, 38.2 s, 34.4 MB as `.tpc`, an indoor scene with one person. Only 0.2 % of the beams were invalid and RSSI stayed at or below 204. Expect different ratios for scenes with more motion.

**Generic compressors on the whole file:**

| Tool | Size | Ratio | Time |
|---|---|---|---|
| gzip -6 (zip) | 7.08 MB | 4.9× | 1.4 s |
| zstd -3 | 7.09 MB | 4.9× | 0.1 s |
| brotli -q 9 | 5.37 MB | 6.4× | 3.2 s |
| zstd -19 | 4.42 MB | 7.8× | 17.5 s |
| zstd --ultra -22 --long=27 | 4.32 MB | 8.0× | 19.8 s |
| xz -9 | 3.71 MB | 9.3× | 23.7 s |

**Rearranging the data first** (zstd -19, whole file):
- Distances and RSSI in separate blocks: 4.10 MB. Additionally splitting each uint16 into a low-byte plane and a high-byte plane: 3.90 MB (8.8×), the best zstd result.
- Storing each scan as its difference from the previous one made it **worse** (5.06 MB): sensor noise makes the differences as random as the values, and zstd already finds the repetition in a static scene by itself. Differences along the beam: 4.54 MB, also worse.
- RSSI is the larger part of the compressed data: about 2.4 MB, against about 1.5 MB for distances. Dropping RSSI would be the biggest single saving.

**Chunking** (needed for seeking and for writing while recording; byte planes, per-chunk zstd):

| Scans per chunk | Level 3 | Level 9 | Level 15 | Level 19 | Level 19: time per scan / slowest chunk |
|---|---|---|---|---|---|
| 1 (each scan alone) | | | | 5.63 MB | |
| 10 | 5.84 MB | 5.43 MB | 5.26 MB | 4.68 MB | 13.9 ms / 147 ms |
| 25 | 5.65 MB | 5.22 MB | 4.96 MB | 4.43 MB | 13.5 ms / 345 ms |
| 50 | 5.56 MB | 5.10 MB | 4.77 MB | 4.27 MB | 14.3 ms / 722 ms |
| 100 | 5.49 MB | 5.00 MB | 4.61 MB | 4.13 MB | 15.9 ms / 1.6 s |

A zstd dictionary trained on the recording barely helped single scans (5.54 MB).

**What was chosen:** chunks of 25 scans at level 19, in a writer thread (falls back to level 3 when two or more chunks are waiting). The scans keep the plain `.tpc` layout instead of byte planes, so that `zstd -d` gives a usable `.tpc`. That costs about 9 %: 4.81 MB of chunks instead of 4.43 MB. The JSON header (22,152 beam elevations, 0.44 MB as text) is compressed too, so the file comes to 4.89 MB (7.0×).

**Speed** (desktop, 12 threads): replay decodes a scan in 4.8 ms, against 4.7 ms for `.tpc`; a random seek (a chunk not in the 2-chunk cache) takes 3.7 ms. The Python `mrs6000 compress` (removed 2026-10-22) took about 1 s for this file, compressing chunks in parallel (5.6 s on one thread).

**Video codecs were ruled out:**
- H.264/H.265 are lossy and 8–10 bit. Distances span 16 bits in 12.5 mm steps; squeezed into 8 bits, a step is 3.2 m. The codecs also blur sharp edges, which turns a person in front of a wall into ghost points floating between the two.
- Lossless FFV1 (16-bit grey) works and decodes exactly, but came to 1.64 MB for the distances alone, more than zstd on byte planes (about 1.5 MB). Not worth the dependency.
