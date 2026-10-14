#!/usr/bin/env python3
"""
Live 3D viewer for the SICK MRS6000, fed by the full-rate CoLa A stream.

  python viewer.py [--ip 192.168.178.200] [--port 8000]
  python viewer.py --record walk.mrsstream          # view live and start saving the stream at once
  python viewer.py --replay walk.mrsstream          # start with a recording (looped), no sensor needed
  -> open http://localhost:8000

Recording and playback are also controlled from the page (files in ./recordings/):
  GET  /state                     source, epoch, replay position, recording progress
  GET  /recordings                list (name, bytes, scans, seconds)
  GET  /recordings/<name>         download            DELETE /recordings/<name>   delete
  POST /record   {"action": "start"|"stop"}
  POST /replay   {"file": name}   play a recording    POST /live                  back to the sensor
  POST /replay/ctl {"action": "play"|"pause"|"toggle"|"step"|"seek"|"speed"|"loop", "value": ...}

A background thread reads scans via mrs6000.cola_scans(); the browser long-polls /frame for
each new scan (organized range image: float32 distance/rssi/elevation blocks, layers x beams)
and /status for REST health values. Rendering (three.js) happens in viewer.html.
Stdlib only.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import struct
import threading
import time
import traceback
from array import array
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

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
# One JSON header line {layers, beams, start_azimuth_deg, step_deg, elev[layers*beams], upside_down?},
# then per scan: float64 unix time, uint16 raw distance (units of 12.5 mm, 0 = invalid), uint16 rssi
# — layer-major. Fixed frame size, so frame k sits at header_end + k * frame_size.
# ~88 kB per scan (~53 MB per minute at 10 Hz).

REC_DIR = Path(__file__).with_name("recordings")
NAME_RE = re.compile(r"^[\w.-]+\.mrsstream$")


def stream_header(scan: mrs6000.Scan, upside_down: bool | None = None) -> bytes:
    L = scan.layers
    hdr = {"layers": len(L), "beams": L[0].beam_count, "start_azimuth_deg": L[0].start_azimuth_deg,
           "step_deg": L[0].step_deg,
           "elev": [e for l in L for e in (l.beam_elevation_deg or [l.elevation_deg] * l.beam_count)]}
    if upside_down is not None:
        hdr["upside_down"] = upside_down
    return (json.dumps(hdr) + "\n").encode()


def stream_frame(scan: mrs6000.Scan, t: float) -> bytes:
    d = array("H", (int(round(x / 12.5)) for l in scan.layers for x in l.echoes[0].distance_mm))
    r = array("H", (min(65535, v) for l in scan.layers for v in l.echoes[0].rssi))
    return struct.pack("<d", t) + d.tobytes() + r.tobytes()


class Recording:
    """Random access to a .mrsstream file."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.f = open(self.path, "rb")
        self.hdr = json.loads(self.f.readline())
        self.start = self.f.tell()
        self.L, self.B = self.hdr["layers"], self.hdr["beams"]
        self.frame_size = 8 + 4 * self.L * self.B
        self.elev = array("f", self.hdr["elev"]).tobytes()

    @property
    def count(self) -> int:  # grows while the file is still being recorded
        return max(0, (self.path.stat().st_size - self.start) // self.frame_size)

    def time(self, k: int) -> float:
        self.f.seek(self.start + k * self.frame_size)
        return struct.unpack("<d", self.f.read(8))[0]

    def raw(self, k: int) -> tuple[float, array, array]:
        n = self.L * self.B
        self.f.seek(self.start + k * self.frame_size)
        ts = struct.unpack("<d", self.f.read(8))[0]
        d = array("H"); d.frombytes(self.f.read(2 * n))
        r = array("H"); r.frombytes(self.f.read(2 * n))
        return ts, d, r

    def scan(self, k: int) -> tuple[float, mrs6000.Scan]:
        ts, d, r = self.raw(k)
        L, B, hdr = self.L, self.B, self.hdr
        scan = mrs6000.Scan(scan_frequency_hz=10.0)
        for l in range(L):
            sl = slice(l * B, (l + 1) * B)
            scan.layers.append(mrs6000.Layer(
                elevation_deg=hdr["elev"][l * B + B // 2], start_azimuth_deg=hdr["start_azimuth_deg"],
                step_deg=hdr["step_deg"], beam_elevation_deg=hdr["elev"][sl],
                echoes=[mrs6000.Echo([x * 12.5 for x in d[sl]], list(r[sl]))]))
        return ts, scan

    def encoded(self, k: int) -> tuple[float, bytes, int]:
        """Frame k in the /frame wire format (same as encode()), without building a Scan."""
        ts, d, r = self.raw(k)
        dist = array("f", (x * 0.0125 for x in d))
        return ts, dist.tobytes() + array("f", r).tobytes() + self.elev, sum(1 for x in d if x)

    def info(self) -> dict:
        n = self.count
        dur = self.time(n - 1) - self.time(0) if n > 1 else 0.0
        st = self.path.stat()
        return {"name": self.path.name, "bytes": st.st_size, "scans": n, "seconds": round(dur, 2),
                "created": self.time(0) if n else st.st_mtime}

    def close(self):
        self.f.close()


def replay_scans(path: str, loop: bool = True):
    """Yield (time, Scan) from a .mrsstream file at the recorded pace, looping by default."""
    rec = Recording(path)
    while True:
        t_prev = None
        for k in range(rec.count):
            ts, scan = rec.scan(k)
            if t_prev is not None:
                time.sleep(min(0.5, max(0.0, ts - t_prev)))
            t_prev = ts
            yield ts, scan
        if not loop:
            return


class Recorder:
    """Writes live scans to a .mrsstream file while active."""

    def __init__(self):
        self.lock = threading.Lock()
        self.f = None
        self.path: Path | None = None
        self.scans = 0
        self.t0 = 0.0
        self.upside_down: bool | None = None

    def start(self, path: str | Path | None = None) -> Path:
        with self.lock:
            if self.f:
                return self.path
            if path is None:
                REC_DIR.mkdir(exist_ok=True)
                path = REC_DIR / time.strftime("rec_%Y%m%d_%H%M%S.mrsstream")
            self.path, self.f, self.scans, self.t0 = Path(path), open(path, "wb"), 0, time.time()
            return self.path

    def write(self, scan: mrs6000.Scan, ts: float):
        with self.lock:
            if not self.f:
                return
            if self.f.tell() == 0:
                self.f.write(stream_header(scan, self.upside_down))
            self.f.write(stream_frame(scan, ts))
            self.f.flush()
            self.scans += 1

    def stop(self):
        with self.lock:
            if self.f:
                self.f.close()
            self.f = None

    def state(self) -> dict:
        with self.lock:
            if not self.f:
                return {"active": False}
            return {"active": True, "file": self.path.name, "scans": self.scans,
                    "bytes": self.f.tell(), "seconds": round(time.time() - self.t0, 1)}


def scan_meta(points: int, L: int, B: int, az0: float, step: float, rate: float, ts: float) -> dict:
    """`ts` = acquisition time (unix s; the recorded time for replays), used for velocities."""
    return {"points": points, "layers": L, "beams": B, "start_azimuth_deg": az0, "step_deg": step,
            "rate": rate, "scan_frequency_hz": 10.0, "ts": ts}


class Hub:
    """Chooses what the browser sees: the live sensor or a recording being played back.

    The live CoLa connection always runs (so recording works whatever is on screen); a player thread
    publishes recording frames while source == "replay". `epoch` increments whenever the published
    sequence is not continuous (source switch, seek, step back, loop wrap) so the client can reset
    its per-beam history."""

    SPEEDS = (0.25, 0.5, 1.0, 2.0, 4.0)

    def __init__(self, feed: Feed):
        self.feed = feed
        self.cond = threading.Condition()
        self.source = "live"
        self.rec: Recording | None = None       # recording being played
        self.index = 0                           # next frame to show
        self.shown = -1                          # last frame shown
        self.playing = True
        self.dirty = False                       # show `index` once even while paused
        self.speed = 1.0
        self.loop = True
        self.epoch = 0
        self.last_source = None
        self.live_error = ""
        self.recorder = Recorder()

    # --- publishing ---
    def publish(self, source: str, data: bytes, meta: dict, seq: int):
        with self.cond:
            if source != self.source:
                return
            if source != self.last_source or (source == "replay" and seq != self.shown + 1):
                self.epoch += 1
            self.last_source = source
            meta.update(source=source, epoch=self.epoch)
            if source == "replay":
                self.shown = seq
                meta["replay"] = self.replay_state()
        self.feed.publish(data, meta)

    def replay_state(self) -> dict:
        if not self.rec:
            return {}
        n = self.rec.count
        t0 = self.rec.time(0) if n else 0.0
        cur = max(0, min(self.shown, n - 1))
        return {"file": self.rec.path.name, "index": cur, "count": n,
                "t": round(self.rec.time(cur) - t0, 2) if n else 0.0,
                "duration": round(self.rec.time(n - 1) - t0, 2) if n > 1 else 0.0,
                "playing": self.playing, "speed": self.speed, "loop": self.loop,
                "upside_down": self.rec.hdr.get("upside_down")}

    # --- live sensor ---
    def live_loop(self, ip: str):
        k = 0
        while True:
            try:
                last = time.time()
                for scan in mrs6000.cola_scans(ip):
                    now = time.time()
                    self.live_error = ""
                    self.recorder.upside_down = self.feed.status.get("UpsideDown")
                    self.recorder.write(scan, now)
                    if self.source == "live":
                        L = scan.layers
                        self.publish("live", encode(scan), scan_meta(
                            sum(d > 0 for l in L for d in l.echoes[0].distance_mm), len(L), L[0].beam_count,
                            L[0].start_azimuth_deg, L[0].step_deg, 1.0 / max(now - last, 1e-3), now), k)
                    k += 1
                    last = now
            except Exception as e:
                if f"CoLa: {e}" != self.live_error:   # log each distinct error once, not every retry
                    traceback.print_exc()
                self.live_error = f"CoLa: {e}"
                time.sleep(2)

    # --- playback ---
    def player_loop(self):
        last = time.time()
        while True:
            with self.cond:
                self.cond.wait_for(lambda: self.source == "replay" and self.rec and (self.playing or self.dirty))
                rec, k = self.rec, self.index
                n = rec.count
                if n == 0:
                    self.dirty = False
                    self.cond.wait(0.5)
                    continue
                t_start = time.time()
                k = min(k, n - 1)
                self.dirty = False
                ts, data, points = rec.encoded(k)
                delay, nxt = 0.0, k + 1                  # index always points at the next frame
                if nxt >= n:
                    if self.loop and self.playing:
                        nxt = 0
                    else:
                        nxt, self.playing = k, False
                if self.playing:
                    delay = (min(0.5, max(0.0, rec.time(nxt) - ts)) if nxt == k + 1 else 0.1) / self.speed
                self.index = nxt
            now = time.time()
            self.publish("replay", data, dict(scan_meta(points, rec.L, rec.B, rec.hdr["start_azimuth_deg"],
                                                         rec.hdr["step_deg"], 1.0 / max(now - last, 1e-3), ts),
                                              replay_file=rec.path.name), k)
            last = now
            deadline = t_start + delay             # recorded pace, minus decode time
            with self.cond:   # wait for the next frame, but react at once to pause / seek / source change
                while (rem := deadline - time.time()) > 0 and self.playing and not self.dirty \
                        and self.source == "replay" and self.rec is rec:
                    self.cond.wait(rem)

    # --- control (called from HTTP handlers) ---
    def play_file(self, path: Path):
        rec = Recording(path)
        with self.cond:
            if self.rec:
                self.rec.close()
            self.rec, self.index, self.shown, self.playing, self.dirty = rec, 0, -1, True, True
            self.source = "replay"
            self.cond.notify_all()

    def go_live(self):
        with self.cond:
            self.source = "live"
            if self.rec:
                self.rec.close()
            self.rec = None
            self.cond.notify_all()

    def control(self, action: str, value=None):
        with self.cond:
            if not self.rec:
                raise ValueError("not replaying")
            n = self.rec.count
            if action == "play":
                if not self.loop and self.shown >= n - 1:
                    self.index = 0
                self.playing = True
            elif action == "pause":
                self.playing = False             # index already points at the next frame
            elif action == "toggle":
                return self.control("pause" if self.playing else "play")
            elif action == "step":
                self.playing = False
                self.index = max(0, min(n - 1, self.shown + int(value or 1)))
                self.dirty = True
            elif action == "seek":
                self.index = max(0, min(n - 1, int(value)))
                self.dirty = True
            elif action == "speed":
                self.speed = min(self.SPEEDS, key=lambda s: abs(s - float(value)))
            elif action == "loop":
                self.loop = bool(value)
            else:
                raise ValueError(f"unknown action {action!r}")
            self.cond.notify_all()

    def state(self) -> dict:
        with self.cond:
            return {"source": self.source, "epoch": self.epoch, "replay": self.replay_state(),
                    "recording": self.recorder.state(), "live_error": self.live_error}


def list_recordings() -> list[dict]:
    out = []
    for p in sorted(REC_DIR.glob("*.mrsstream"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            r = Recording(p)
            out.append(r.info())
            r.close()
        except Exception as e:
            out.append({"name": p.name, "bytes": p.stat().st_size, "error": str(e)})
    return out


def recording_path(name: str) -> Path:
    if not NAME_RE.match(name or ""):
        raise ValueError("invalid recording name")
    p = REC_DIR / name
    if not p.is_file():
        raise FileNotFoundError(name)
    return p


def status_loop(ip: str, feed: Feed):
    rest = mrs6000.RestClient(ip)
    while True:
        try:
            feed.status = rest.get_many(STATUS_VARS)
        except Exception as e:
            feed.status = {"error": str(e)}
        time.sleep(2)


def make_handler(feed: Feed, hub: Hub):
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

        def _json(self, obj, code: int = 200):
            self._send(code, json.dumps(obj).encode(), "application/json")

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}") if n else {}

        def _guard(self, fn):
            try:
                fn()
            except (ValueError, KeyError, json.JSONDecodeError) as e:
                self._json({"error": str(e)}, 400)
            except FileNotFoundError as e:
                self._json({"error": f"not found: {e}"}, 404)

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
                err = hub.live_error if hub.source == "live" else ""
                self._json({"device": feed.status, "error": err})
            elif url.path == "/state":
                self._json(hub.state())
            elif url.path == "/recordings":
                self._json(list_recordings())
            elif url.path.startswith("/recordings/"):
                def download():
                    p = recording_path(unquote(url.path[len("/recordings/"):]))
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(p.stat().st_size))
                    self.send_header("Content-Disposition", f'attachment; filename="{p.name}"')
                    self.end_headers()
                    with open(p, "rb") as f:
                        shutil.copyfileobj(f, self.wfile)
                self._guard(download)
            else:
                self._send(404, b"not found", "text/plain")

        def do_POST(self):
            url = urlparse(self.path)

            def handle():
                body = self._body()
                if url.path == "/record":
                    if body.get("action") == "start":
                        hub.recorder.start()
                    elif body.get("action") == "stop":
                        hub.recorder.stop()
                    else:
                        raise ValueError("action must be start or stop")
                elif url.path == "/replay":
                    hub.play_file(recording_path(body.get("file")))
                elif url.path == "/replay/ctl":
                    hub.control(body.get("action"), body.get("value"))
                elif url.path == "/live":
                    hub.go_live()
                else:
                    return self._send(404, b"not found", "text/plain")
                self._json(hub.state())
            self._guard(handle)

        def do_DELETE(self):
            url = urlparse(self.path)

            def delete():
                if not url.path.startswith("/recordings/"):
                    return self._send(404, b"not found", "text/plain")
                p = recording_path(unquote(url.path[len("/recordings/"):]))
                if hub.recorder.state().get("file") == p.name and hub.recorder.path.parent == REC_DIR:
                    raise ValueError("stop the recording first")
                if hub.rec and hub.rec.path.resolve() == p.resolve():
                    hub.go_live()
                p.unlink()
                self._json(list_recordings())
            self._guard(delete)

    return Handler


def main():
    ap = argparse.ArgumentParser(description="Live MRS6000 point cloud viewer (CoLa source)")
    ap.add_argument("--ip", default=mrs6000.DEFAULT_IP)
    ap.add_argument("--host", default="127.0.0.1", help="bind address (0.0.0.0 to share on the LAN)")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--record", metavar="FILE", help="start recording the live stream to FILE (.mrsstream) right away")
    ap.add_argument("--replay", metavar="FILE", help="start by playing a .mrsstream recording (looped) instead of the live sensor")
    args = ap.parse_args()

    feed = Feed()
    hub = Hub(feed)
    if args.record:
        hub.recorder.start(args.record)
    if args.replay:
        hub.play_file(Path(args.replay))
    threading.Thread(target=hub.live_loop, args=(args.ip,), daemon=True).start()
    threading.Thread(target=hub.player_loop, daemon=True).start()
    threading.Thread(target=status_loop, args=(args.ip, feed), daemon=True).start()
    srv = ThreadingHTTPServer((args.host, args.port), make_handler(feed, hub))
    src = f"replaying {args.replay}" if args.replay else f"sensor {args.ip}" + (f", recording to {args.record}" if args.record else "")
    print(f"Viewer on http://{'localhost' if args.host == '127.0.0.1' else args.host}:{args.port}  ({src}, Ctrl+C to quit)")
    print(f"Recordings made in the UI go to {REC_DIR}/")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        hub.recorder.stop()


if __name__ == "__main__":
    main()
