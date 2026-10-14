"""WebSocket preview source (ws://ip/scan, MessagePack, ~2 Hz decimated). Needs the `preview` extra."""
from __future__ import annotations

import struct
from typing import Iterator

from .model import DIST_INVALID_MAX_RAW, Echo, Layer, Scan
from .variables import DEFAULT_IP


def decode_preview(msg: dict) -> Scan:
    """Message: {"version": 2, "layer": [{"verticalAngle": float deg, "startAngle": int 1e-4 deg,
    "angularResolution": int 1e-4 deg, "pulses": [{"scanBeamCount": n,
    "distance": bytes BE uint16 * 12.5 mm, "rssi": bytes BE uint16}]}]}"""
    if msg.get("version") != 2:
        raise ValueError(f"unsupported scan format version {msg.get('version')}")
    scan = Scan()
    for L in msg["layer"]:
        echoes = []
        for p in L["pulses"]:
            n = p["scanBeamCount"]
            dist = struct.unpack(f">{n}H", p["distance"][: 2 * n])
            rssi = struct.unpack(f">{n}H", p["rssi"][: 2 * n])
            echoes.append(Echo([d * 12.5 if d > DIST_INVALID_MAX_RAW else 0.0 for d in dist], list(rssi)))
        scan.layers.append(Layer(elevation_deg=float(L["verticalAngle"]),
                                 start_azimuth_deg=L["startAngle"] / 10000 - 90,
                                 step_deg=L["angularResolution"] / 10000, echoes=echoes))
    return scan


def ws_scans(ip: str = DEFAULT_IP, timeout: float = 10.0) -> Iterator[Scan]:
    import msgpack
    import websocket

    ws = websocket.create_connection(f"ws://{ip}/scan", timeout=timeout)
    try:
        while True:
            yield decode_preview(msgpack.unpackb(ws.recv(), raw=False))
    finally:
        ws.close()
