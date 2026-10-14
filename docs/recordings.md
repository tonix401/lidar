# Recording and replay

These run server-side (`backend/src/mrs6000/server/`: `stream.py` for the format, `hub.py` for playback), with controls on the page.

- **Recording:** the **● Record** button in the panel saves the *live* stream to `recordings/rec_YYYYmmdd_HHMMSS.tpc.zstd`, zstd-compressed (lossless) to about 7.5 MB per minute. It keeps recording while you watch a replay.
  - A writer thread compresses in chunks of 25 scans (2.5 s), so the live stream never waits on it. A file being recorded can be replayed up to its last complete chunk, and a crash loses at most the last 2.5 s.
- **Compress / decompress files:** `mrs6000 decompress x.tpc.zstd` (or plain `zstd -d`) gives `x.tpc`; `mrs6000 compress x.tpc` gives `x.tpc.zstd` again. Both keep the input. Replay reads both.
- **Recordings list:** play, download, delete.
- **Transport bar** (shown while replaying):
  - Step back / play-pause / step forward, a seek slider, speed 0.25–4×, loop, and "● Live".
  - Keys: Space = play/pause, ←/→ = step.
- **Epoch:** the server bumps `epoch` on every seek, step back, loop wrap or source switch, and the page then resets its per-beam history and tracks.

The HTTP endpoints for all of this are in [api.md](api.md).

## Storage

`recordings/` is gitignored. GitHub rejects files over 100 MB, and a 132 MB recording once blocked a push. The walk recording used for tuning is `recordings/walk_20261014.mrsstream` (rename it to `.tpc` to replay it); it is also on the `backup-before-rewrite` branch.

## Format

`.tpc` (temporal point cloud) is project-specific, not a standard. Its building blocks are: JSON, little-endian integers and floats, and standard zstd.

- **`.tpc`:** a JSON header line `{layers, beams, start_azimuth_deg, step_deg, elev[layers*beams], upside_down?}`, then fixed-size scans: float64 unix time, uint16 distance (12.5 mm units, 0 = invalid), and uint16 RSSI, layer-major, little endian. Scan k sits at `header_end + k × (8 + 4 × layers × beams)`; about 88 kB per scan, 53 MB per minute.
- **`.tpc.zstd`** (what the recorder writes): a standard zstd stream that decompresses to the `.tpc`.
  - Its zstd frames hold the header, then chunks of up to 25 scans.
  - Before each one, a zstd *skippable frame* (magic `0x184D2A5E`, which `zstd -d` ignores) holds the seek index: `b"TPC1"`, uint32 scan count, uint32 length of the following zstd frame, and the scans' float64 times. The header's entry has a scan count of 0.
  - Each entry and its frame are written in one piece, so a reader indexes complete chunks only and simply ignores a chunk still being written.
  - A file compressed with plain `zstd` lacks that index and is rejected with a hint; use `mrs6000 compress`.
- Older `.mrsstream` files are not read. Their content is the `.tpc` layout, so renaming one to `.tpc` converts it.
- Only the first echo is stored (`echoes[0]`); see the echo test in [pipeline.md](pipeline.md).

Standard formats that could be added as exports if recordings need to open elsewhere: **MCAP** (ROS 2's default, opens in Foxglove, also compresses in zstd chunks), **pcap** of the raw CoLa TCP stream (readers still need a SICK decoder), and **PLY / PCD / LAS** for single scans (`mrs6000 record` already writes PLY).

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

**Speed** (desktop, 12 threads): replay decodes a scan in 4.8 ms, against 4.7 ms for `.tpc`; a random seek (a chunk not in the 2-chunk cache) takes 3.7 ms. `mrs6000 compress` takes about 1 s for this file, compressing chunks in parallel (5.6 s on one thread).

**Video codecs were ruled out:**
- H.264/H.265 are lossy and 8–10 bit. Distances span 16 bits in 12.5 mm steps; squeezed into 8 bits, a step is 3.2 m. The codecs also blur sharp edges, which turns a person in front of a wall into ghost points floating between the two.
- Lossless FFV1 (16-bit grey) works and decodes exactly, but came to 1.64 MB for the distances alone, more than zstd on byte planes (about 1.5 MB). Not worth the dependency.
