"""The recording format: temporal point clouds.

x.tpc: one JSON header line {layers, beams, start_azimuth_deg, step_deg, elev[layers*beams], upside_down?},
then fixed-size scans: float64 unix time, uint16 raw distance (units of 12.5 mm, 0 = invalid), uint16 rssi
— layer-major, little endian. Scan k sits at header_end + k * frame_size. ~88 kB per scan (~53 MB per
minute at 10 Hz).

x.tpc.zstd (what the recorder writes): a standard zstd stream that decompresses to x.tpc (`zstd -d`).
Its zstd frames hold the header line, then chunks of up to CHUNK_FRAMES scans. Each is preceded by an
index entry in a skippable frame (which zstd ignores): b"TPC1", uint32 scans m, uint32 length of the zstd
frame that follows, the m float64 scan times (m = 0 for the header). Chunks are written whole, so readers
index complete chunks only. ~13 kB per scan (~7.5 MB per minute, indoor scene)."""
from __future__ import annotations

import json
import struct
from array import array
from compression import zstd

from ..model import Scan

DIST_UNIT_MM = 12.5
CHUNK_FRAMES = 25            # 2.5 s at 10 Hz: what a crash can lose, how far a file being recorded lags
LEVEL = 19                   # ~14 ms per scan on a desktop core, in the writer thread
FAST_LEVEL = 3               # used while the writer falls behind (slow machine)
SKIP_MAGIC = 0x184D2A5E      # zstd skippable frame
ZSTD_MAGIC = 0xFD2FB528      # zstd data frame
INDEX = struct.Struct("<II4sII")   # skippable magic, content size, b"TPC1", scans, zstd frame length
INDEX_TAG = b"TPC1"

Frame = tuple[float, bytes, bytes]   # time, distances, rssi (uint16 bytes)


def stream_header(scan: Scan, upside_down: bool | None = None) -> bytes:
    L = scan.layers
    hdr = {"layers": len(L), "beams": L[0].beam_count, "start_azimuth_deg": L[0].start_azimuth_deg,
           "step_deg": L[0].step_deg, "elev": [e for l in L for e in l.elevations_deg()]}
    if upside_down is not None:
        hdr["upside_down"] = upside_down
    return (json.dumps(hdr) + "\n").encode()


def frame_values(scan: Scan) -> tuple[bytes, bytes]:
    d = array("H", (min(65535, int(round(x / DIST_UNIT_MM))) for l in scan.layers for x in l.echoes[0].distance_mm))
    r = array("H", (min(65535, max(0, int(v))) for l in scan.layers for v in l.echoes[0].rssi))
    return d.tobytes(), r.tobytes()


def stream_frame(scan: Scan, t: float) -> bytes:
    """One .tpc scan."""
    d, r = frame_values(scan)
    return struct.pack("<d", t) + d + r


def zstd_entry(data: bytes, times: list[float] = (), level: int = LEVEL) -> bytes:
    """`data` as one zstd frame, preceded by its index entry."""
    z = zstd.compress(data, level=level)
    return (INDEX.pack(SKIP_MAGIC, 12 + 8 * len(times), INDEX_TAG, len(times), len(z))
            + struct.pack(f"<{len(times)}d", *times) + z)


def stream_chunk(frames: list[Frame], level: int = LEVEL) -> bytes:
    """One .tpc.zstd chunk."""
    return zstd_entry(b"".join(struct.pack("<d", t) + d + r for t, d, r in frames), [f[0] for f in frames], level)
