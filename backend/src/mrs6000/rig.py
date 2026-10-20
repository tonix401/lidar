"""The rig: which sensors there are (name, address) and where they are (pose in the world frame, residual
clock offset, how it was calibrated). Stored as JSON (rig.json for the live sensors, the `rig` key of a
session's session.json for a recording), readable and editable by hand:

  {"sensors": [{"name": "a", "ip": "192.168.178.200",
                "pose": {"x": 0, "y": 0, "z": 1.1, "yaw": 0, "pitch": 0, "roll": 0},
                "time_offset_s": 0.0, "calibrated": "2026-10-20T12:00:00", "quality": {...}}]}

Positions in m, angles in degrees (yaw about z, then pitch, then roll; see frontend/src/fusion/pose.ts).
Calibration happens in the browser; the backend only stores what it is sent."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

SENSOR_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
POSE_KEYS = ("x", "y", "z", "yaw", "pitch", "roll")
SENSOR_KEYS = ("pose", "time_offset_s", "calibrated", "quality")     # what a PUT may change


@dataclass(frozen=True)
class SensorSpec:
    name: str
    ip: str


def check_name(name: str) -> str:
    if not SENSOR_NAME_RE.match(name or ""):
        raise ValueError(f"invalid sensor name {name!r} (letters, digits, _ and -, at most 32)")
    return name


def parse_sensor_arg(arg: str) -> SensorSpec:
    """--sensor NAME=IP"""
    name, sep, ip = arg.partition("=")
    if not sep or not ip:
        raise ValueError(f"--sensor {arg!r}: expected NAME=IP")
    return SensorSpec(check_name(name), ip)


def load_rig(path: Path | None) -> dict:
    if not path or not Path(path).is_file():
        return {"sensors": []}
    rig = json.loads(Path(path).read_text())
    if not isinstance(rig, dict) or not isinstance(rig.get("sensors", []), list):
        raise ValueError(f"{path}: expected {{\"sensors\": [...]}}")
    rig.setdefault("sensors", [])
    for s in rig["sensors"]:
        check_name(s.get("name"))
    return rig


def save_json(path: Path, obj: dict):
    """Write through a temporary file, so a crash never leaves half a file."""
    tmp = Path(path).with_name(Path(path).name + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2) + "\n")
    os.replace(tmp, path)


def check_pose(pose) -> dict:
    if not isinstance(pose, dict) or set(pose) != set(POSE_KEYS):
        raise ValueError(f"a pose needs exactly {', '.join(POSE_KEYS)}")
    out = {}
    for k in POSE_KEYS:
        v = pose[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or abs(v) > 1e4:
            raise ValueError(f"pose {k}: expected a number")
        out[k] = float(v)
    return out


def merge_rig(rig: dict, update: dict) -> dict:
    """The rig with `update`'s sensors applied by name (only SENSOR_KEYS; others are kept as they are)."""
    sensors = {s["name"]: dict(s) for s in rig.get("sensors", [])}
    order = [s["name"] for s in rig.get("sensors", [])]
    items = update.get("sensors")
    if not isinstance(items, list):
        raise ValueError("expected {\"sensors\": [...]}")
    for u in items:
        name = check_name(u.get("name") if isinstance(u, dict) else None)
        s = sensors.setdefault(name, {"name": name})
        if name not in order:
            order.append(name)
        for k in SENSOR_KEYS:
            if k in u:
                s[k] = check_pose(u[k]) if k == "pose" else u[k]
    return {**rig, "sensors": [sensors[n] for n in order]}


def rig_for(rig: dict, names: list[str]) -> dict:
    """The entries of `names`, in that order (sensors without one get just their name)."""
    by_name = {s["name"]: s for s in rig.get("sensors", [])}
    return {"sensors": [by_name.get(n, {"name": n}) for n in names]}
