#!/usr/bin/env python3
"""
Live 3D viewer for the SICK MRS6000, fed by the full-rate CoLa A stream.

  python viewer.py [--ip 192.168.178.200] [--port 8000]
  python viewer.py --record walk.mrsstream          # view live and save the stream
  python viewer.py --replay walk.mrsstream          # replay a recording (looped), no sensor needed
  -> open http://localhost:8000

A background thread reads scans via mrs6000.cola_scans(); the browser long-polls /frame for
each new scan (organized range image: float32 distance/rssi/elevation blocks, layers x beams)
and /status for REST health values. Rendering (three.js) happens in viewer.html.
Stdlib only.
"""
from __future__ import annotations

import argparse
import json
import struct
import threading
import time
import traceback
from array import array
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import mrs6000

HTML = Path(__file__).with_name("viewer.html")
STATUS_VARS = ["CommonDeviceStatus", "KM_SysBoard_Temp", "KM_APDBoard_Temp", "KM_PowerSource_Voltage",
               "KM_MotorRotationPeriod", "KMWindowWarning", "KMWindowError", "DeviceType",
               "SerialNumber", "FirmwareVersion", "UpsideDown"]


def encode(scan: mrs6000.Scan) -> bytes:
    """Pack the first echo as an organized range image (layers x beams, invalid = 0):
    three float32 blocks [distance_m], [rssi], [elevation_deg], each layer-major.
    Azimuth of beam b is start_azimuth_deg + b * step_deg (sent in the meta header)."""
    dist, rssi, elev = array("f"), array("f"), array("f")
    for layer in scan.layers:
        e = layer.echoes[0]
        dist.extend(d / 1000.0 for d in e.distance_mm)
        rssi.extend(e.rssi)
        elev.extend(layer.beam_elevation_deg or [layer.elevation_deg] * layer.beam_count)
    return dist.tobytes() + rssi.tobytes() + elev.tobytes()  # native order = little endian


class Feed:
    """Holds the latest encoded scan; readers block until a newer one arrives."""

    def __init__(self):
        self.cond = threading.Condition()
        self.frame_id = 0
        self.data = b""
        self.meta: dict = {}
        self.status: dict = {}
        self.error = ""

    def publish(self, data: bytes, meta: dict):
        with self.cond:
            self.frame_id += 1
            self.data, self.meta, self.error = data, meta, ""
            self.cond.notify_all()

    def wait(self, after: int, timeout: float = 2.0):
        with self.cond:
            self.cond.wait_for(lambda: self.frame_id > after, timeout)
            return self.frame_id, self.data, dict(self.meta)


# ---- stream recordings (.mrsstream) --------------------------------------------------------
# One JSON header line {layers, beams, start_azimuth_deg, step_deg, elev[layers*beams]}, then per scan:
# float64 unix time, uint16 raw distance (units of 12.5 mm, 0 = invalid), uint16 rssi — layer-major.
# ~88 kB per scan (~53 MB per minute at 10 Hz).

def stream_header(scan: mrs6000.Scan) -> bytes:
    L = scan.layers
    hdr = {"layers": len(L), "beams": L[0].beam_count, "start_azimuth_deg": L[0].start_azimuth_deg,
           "step_deg": L[0].step_deg,
           "elev": [e for l in L for e in (l.beam_elevation_deg or [l.elevation_deg] * l.beam_count)]}
    return (json.dumps(hdr) + "\n").encode()


def stream_frame(scan: mrs6000.Scan, t: float) -> bytes:
    d = array("H", (int(round(x / 12.5)) for l in scan.layers for x in l.echoes[0].distance_mm))
    r = array("H", (min(65535, v) for l in scan.layers for v in l.echoes[0].rssi))
    return struct.pack("<d", t) + d.tobytes() + r.tobytes()


def replay_scans(path: str, loop: bool = True):
    """Yield (time, Scan) from a .mrsstream file at the recorded pace, looping by default."""
    with open(path, "rb") as f:
        hdr = json.loads(f.readline())
        start = f.tell()
        L, B = hdr["layers"], hdr["beams"]
        while True:
            f.seek(start)
            t_prev = None
            while (t := f.read(8)) and len(t) == 8:
                ts = struct.unpack("<d", t)[0]
                d = array("H"); d.frombytes(f.read(2 * L * B))
                r = array("H"); r.frombytes(f.read(2 * L * B))
                if t_prev is not None:
                    time.sleep(min(0.5, max(0.0, ts - t_prev)))
                t_prev = ts
                scan = mrs6000.Scan(scan_frequency_hz=10.0)
                for l in range(L):
                    sl = slice(l * B, (l + 1) * B)
                    scan.layers.append(mrs6000.Layer(
                        elevation_deg=hdr["elev"][l * B + B // 2], start_azimuth_deg=hdr["start_azimuth_deg"],
                        step_deg=hdr["step_deg"], beam_elevation_deg=hdr["elev"][sl],
                        echoes=[mrs6000.Echo([x * 12.5 for x in d[sl]], list(r[sl]))]))
                yield ts, scan
            if not loop:
                return


def scan_loop(ip: str, feed: Feed, record: str | None = None, replay: str | None = None):
    rec = open(record, "wb") if record else None
    while True:
        try:
            last = time.time()
            source = replay_scans(replay) if replay else ((time.time(), s) for s in mrs6000.cola_scans(ip))
            for ts, scan in source:
                now = time.time()
                if rec:
                    if rec.tell() == 0:
                        rec.write(stream_header(scan))
                    rec.write(stream_frame(scan, ts))
                data = encode(scan)
                feed.publish(data, {"points": sum(d > 0 for l in scan.layers for d in l.echoes[0].distance_mm),
                                    "layers": len(scan.layers),
                                    "beams": scan.layers[0].beam_count,
                                    "start_azimuth_deg": scan.layers[0].start_azimuth_deg,
                                    "step_deg": scan.layers[0].step_deg,
                                    "rate": 1.0 / max(now - last, 1e-3),
                                    "scan_frequency_hz": scan.scan_frequency_hz,
                                    "replay": bool(replay)})
                last = now
        except Exception as e:
            feed.error = f"CoLa: {e}"
            traceback.print_exc()
            time.sleep(2)


def status_loop(ip: str, feed: Feed):
    rest = mrs6000.RestClient(ip)
    while True:
        try:
            feed.status = rest.get_many(STATUS_VARS)
        except Exception as e:
            feed.status = {"error": str(e)}
        time.sleep(2)


def make_handler(feed: Feed):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, code: int, body: bytes, ctype: str, headers: dict | None = None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            url = urlparse(self.path)
            if url.path in ("/", "/index.html"):
                self._send(200, HTML.read_bytes(), "text/html; charset=utf-8")
            elif url.path == "/frame":
                after = int(parse_qs(url.query).get("after", ["0"])[0])
                fid, data, meta = feed.wait(after)
                meta["id"] = fid
                self._send(200, data, "application/octet-stream", {"X-Meta": json.dumps(meta)})
            elif url.path == "/status":
                body = json.dumps({"device": feed.status, "error": feed.error}).encode()
                self._send(200, body, "application/json")
            else:
                self._send(404, b"not found", "text/plain")

    return Handler


def main():
    ap = argparse.ArgumentParser(description="Live MRS6000 point cloud viewer (CoLa source)")
    ap.add_argument("--ip", default=mrs6000.DEFAULT_IP)
    ap.add_argument("--host", default="127.0.0.1", help="bind address (0.0.0.0 to share on the LAN)")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--record", metavar="FILE", help="also save the live stream to FILE (.mrsstream) for later replay")
    ap.add_argument("--replay", metavar="FILE", help="play a .mrsstream recording (looped) instead of the live sensor")
    args = ap.parse_args()

    feed = Feed()
    threading.Thread(target=scan_loop, args=(args.ip, feed, args.record, args.replay), daemon=True).start()
    if not args.replay:
        threading.Thread(target=status_loop, args=(args.ip, feed), daemon=True).start()
    srv = ThreadingHTTPServer((args.host, args.port), make_handler(feed))
    src = f"replaying {args.replay}" if args.replay else f"sensor {args.ip}" + (f", recording to {args.record}" if args.record else "")
    print(f"Viewer on http://{'localhost' if args.host == '127.0.0.1' else args.host}:{args.port}  ({src}, Ctrl+C to quit)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
