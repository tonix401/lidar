"""Write one scan losslessly to files: raw telegrams, CSV of every beam, PLY point cloud, JSON context."""
from __future__ import annotations

import csv
import json
import math
import time

from .model import Scan
from .rest import RestClient
from .variables import VARIABLES


def write_scan_files(scan: Scan, prefix: str, rest: RestClient | None = None,
                     upside_down: bool = False) -> list[str]:
    """prefix.cola.txt (one LMDscandata telegram per line, if available), prefix.csv (every beam,
    including invalid ones), prefix.ply (valid points), prefix.json (summary + device values when
    `rest` is given). x/y/z as in Scan.points(). Returns the written paths."""
    paths = []
    s = -1.0 if upside_down else 1.0
    if scan.raw_telegrams:
        with open(prefix + ".cola.txt", "w") as f:
            f.write("\n".join(scan.raw_telegrams) + "\n")
        paths.append(prefix + ".cola.txt")

    rows = []
    for li, layer in enumerate(scan.layers):
        azs, els = layer.azimuths_deg(), layer.elevations_deg()
        for ei, e in enumerate(layer.echoes):
            for bi, d_mm in enumerate(e.distance_mm):
                el, d = els[bi], d_mm / 1000.0
                ce = math.cos(math.radians(el)) * d
                rows.append((li, bi, ei, layer.timestamp_us, layer.elevation_deg, round(azs[bi], 5),
                             round(el, 5), d, e.rssi[bi], d_mm > 0,
                             round(math.cos(math.radians(azs[bi])) * ce, 5),
                             round(math.sin(math.radians(azs[bi])) * ce, 5),
                             round(s * math.sin(math.radians(el)) * d, 5)))
    with open(prefix + ".csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["layer", "beam", "echo", "layer_timestamp_us", "layer_angle_deg", "azimuth_deg",
                    "elevation_deg", "distance_m", "rssi", "valid", "x", "y", "z"])
        w.writerows(rows)
    paths.append(prefix + ".csv")

    valid = [r for r in rows if r[9]]
    with open(prefix + ".ply", "w") as f:
        f.write("ply\nformat ascii 1.0\n"
                f"comment SICK MRS6000 scan, x forward / y left / z up, sensor {'upside down' if upside_down else 'upright'}\n"
                f"element vertex {len(valid)}\nproperty float x\nproperty float y\nproperty float z\n"
                "property float intensity\nproperty uchar layer\nproperty uchar echo\nend_header\n")
        f.writelines(f"{r[10]} {r[11]} {r[12]} {r[8]} {r[0]} {r[2]}\n" for r in valid)
    paths.append(prefix + ".ply")

    meta = {"recorded_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "layers": len(scan.layers),
            "beams_per_layer": scan.layers[0].beam_count, "echoes": len(scan.layers[0].echoes),
            "azimuth_step_deg": scan.layers[0].step_deg, "scan_frequency_hz": scan.scan_frequency_hz,
            "beams_total": len(rows), "valid_returns": len(valid),
            "layer_angles_deg": [l.elevation_deg for l in scan.layers]}
    if rest:
        meta["device"] = rest.get_many(VARIABLES["identity"] + VARIABLES["status"] + VARIABLES["scan_config"])
    with open(prefix + ".json", "w") as f:
        json.dump(meta, f, indent=2)
    paths.append(prefix + ".json")
    return paths
