"""Wire format of GET /api/frame: an organized range image of the first echo.

Body: three little-endian float32 blocks, each layers x beams, layer-major:
[distance_m (0 = invalid)] [rssi] [elevation_deg]. Azimuth of beam b = start_azimuth_deg + b * step_deg.
Meta (JSON in the X-Meta header): see scan_meta()."""
from __future__ import annotations

from array import array

from ..model import Scan


def encode(scan: Scan) -> bytes:
    dist, rssi, elev = array("f"), array("f"), array("f")
    for layer in scan.layers:
        e = layer.echoes[0]
        dist.extend(d / 1000.0 for d in e.distance_mm)
        rssi.extend(e.rssi)
        elev.extend(layer.elevations_deg())
    return dist.tobytes() + rssi.tobytes() + elev.tobytes()  # native order = little endian on x86/ARM


def scan_meta(points: int, layers: int, beams: int, az0: float, step: float, rate: float, ts: float) -> dict:
    """`ts` = acquisition time (unix s; the recorded time for replays), used for velocities."""
    return {"points": points, "layers": layers, "beams": beams, "start_azimuth_deg": az0, "step_deg": step,
            "rate": rate, "scan_frequency_hz": 10.0, "ts": ts}


def meta_for_scan(scan: Scan, rate: float, ts: float) -> dict:
    L = scan.layers
    return scan_meta(sum(d > 0 for l in L for d in l.echoes[0].distance_mm), len(L), L[0].beam_count,
                     L[0].start_azimuth_deg, L[0].step_deg, rate, ts)
