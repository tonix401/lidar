"""Shared fixtures: a real recorded scan, synthetic scans, a fake CoLa sensor and a fake REST sensor."""
from __future__ import annotations

import gzip
import json
import socket
import socketserver
import threading
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from mrs6000 import Echo, Layer, Scan, cola_password_hash, parse_lmdscandata

FIXTURES = Path(__file__).parent / "fixtures"


def real_telegrams() -> list[str]:
    """24 LMDscandata telegrams (one scan) recorded from the MRS6224R on 2026-10-14."""
    with gzip.open(FIXTURES / "scan_20261014.cola.txt.gz", "rt") as f:
        return [l.rstrip("\n") for l in f if l.strip()]


@pytest.fixture(scope="session")
def telegrams() -> list[str]:
    return real_telegrams()


@pytest.fixture(scope="session")
def real_scan(telegrams) -> Scan:
    scan = Scan(scan_frequency_hz=10.0)
    for t in telegrams:
        layer, _ = parse_lmdscandata(t.split()[2:])
        scan.layers.append(layer)
    return scan


def make_scan(layers: int = 3, beams: int = 5, dist_mm=lambda l, b: 1000.0 + 100 * l + b * 12.5,
              rssi=lambda l, b: 10 * l + b) -> Scan:
    """Small synthetic scan with exactly representable distances (multiples of 12.5 mm)."""
    scan = Scan(scan_frequency_hz=10.0)
    for l in range(layers):
        scan.layers.append(Layer(elevation_deg=-5.0 + l, start_azimuth_deg=-60.0, step_deg=0.5,
                                 beam_elevation_deg=[-5.0 + l + 0.01 * b for b in range(beams)],
                                 echoes=[Echo([dist_mm(l, b) for b in range(beams)], [rssi(l, b) for b in range(beams)])]))
    return scan


def hex32f(x: float) -> str:
    import struct
    return struct.pack(">f", x).hex().upper()


def build_telegram(layer_angle_deg: float, dist_raw: list[int], rssi: list[int] | None = None,
                   start_deg: float = 30.0, step_deg: float = 0.1301, vangl_raw: list[int] | None = None,
                   counter: int = 1) -> str:
    """Synthesize an LMDscandata telegram in the layout parse_lmdscandata expects."""
    def i16(v): return f"{v & 0xFFFF:X}"
    def i32(v): return f"{v & 0xFFFFFFFF:X}"
    head = ["sSN", "LMDscandata", "1", "1", "155CC02", "0", "0", f"{counter:X}", f"{counter:X}", "E356EF3",
            "E3801AF", "0", "0", "0", "0", i16(round(layer_angle_deg * 200)), "3E8", "229", "0"]
    chans = [("DIST1", 12.5, 0.0, dist_raw)]
    if rssi is not None:
        chans.append(("RSSI1", 1.0, 0.0, rssi))
    if vangl_raw is not None:
        chans.append(("VANGL", -0.00025, 1.5, vangl_raw))
    body = [f"{len(chans):X}"]
    for name, scale, offset, raw in chans:
        body += [name, hex32f(scale), hex32f(offset), i32(round(start_deg * 10000)), f"{round(step_deg * 10000):X}",
                 f"{len(raw):X}"] + [f"{v:X}" for v in raw]
    return " ".join(head + body)


# ---- fake CoLa sensor (TCP) ----------------------------------------------------------------

class FakeCola:
    """Answers the CoLa commands the client uses and streams the given telegrams in a loop once
    LMDscandata is enabled. Password for SetAccessMode: `password`."""

    def __init__(self, telegrams: list[str], password: str = "secret", echo_filter: int = 2, max_scans: int | None = None):
        self.telegrams, self.password, self.echo_filter, self.max_scans = telegrams, password, echo_filter, max_scans
        self.commands: list[str] = []
        self.logged_in = False
        outer = self

        class Handler(socketserver.BaseRequestHandler):
            def handle(self):
                buf = b""
                streaming = False
                sent = 0
                self.request.settimeout(0.01)
                while True:
                    try:
                        chunk = self.request.recv(4096)
                        if not chunk:
                            return
                        buf += chunk
                    except socket.timeout:
                        pass
                    except OSError:
                        return
                    while b"\x03" in buf:
                        end = buf.index(b"\x03")
                        cmd = buf[buf.index(b"\x02") + 1:end].decode("latin-1")
                        buf = buf[end + 1:]
                        outer.commands.append(cmd)
                        reply = outer.reply(cmd)
                        if cmd == "sEN LMDscandata 1":
                            streaming = True
                        elif cmd == "sEN LMDscandata 0":
                            streaming = False
                        if reply and not self.send(reply):
                            return
                    if streaming:
                        for t in outer.telegrams:
                            if not self.send(t):
                                return
                        sent += 1
                        if outer.max_scans is not None and sent >= outer.max_scans:
                            return               # drop the connection (sensor gone)

            def send(self, msg: str) -> bool:
                try:
                    self.request.sendall(b"\x02" + msg.encode("latin-1") + b"\x03")
                    return True
                except OSError:
                    return False

        self.server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def reply(self, cmd: str) -> str | None:
        parts = cmd.split()
        if parts[:2] == ["sEN", "LMDscandata"]:
            return f"sEA LMDscandata {parts[2]}"
        if parts[:2] == ["sMN", "SetAccessMode"]:
            self.logged_in = int(parts[3], 16) == cola_password_hash(self.password)
            return f"sAN SetAccessMode {1 if self.logged_in else 0}"
        if parts[:2] == ["sRN", "FREchoFilter"]:
            return f"sRA FREchoFilter {self.echo_filter}"
        if parts[:2] == ["sWN", "FREchoFilter"]:
            if not self.logged_in:
                return "sFA 2"
            self.echo_filter = int(parts[2])
            return "sWA FREchoFilter"
        if parts[:2] == ["sMN", "mEEwriteall"]:
            return "sAN mEEwriteall 1"
        if parts[:2] == ["sMN", "Run"]:
            self.logged_in = False
            return "sAN Run 1"
        return "sFA 5"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def fake_cola(telegrams):
    s = FakeCola(telegrams)
    yield s
    s.close()


# ---- fake REST sensor (HTTP) ---------------------------------------------------------------

class FakeRest:
    """GET /api/<var> from `values`; getChallenge + checkCredentials / writes with SHA256 auth."""

    REALM, NONCE = "SICK", "abc123"

    def __init__(self, values: dict, passwords: dict | None = None):
        self.values, self.passwords = values, passwords or {"Service": "servicelevel"}
        self.posts: list[tuple[str, dict]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, obj):
                body = json.dumps(obj).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                name = self.path.removeprefix("/api/")
                if name in outer.values:
                    self._json({"header": {"status": 0, "message": "Ok"}, "data": {name: outer.values[name]}})
                else:
                    self._json({"header": {"status": 3, "message": "Variable unknown"}, "data": {}})

            def do_POST(self):
                name = self.path.removeprefix("/api/")
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.posts.append((name, body))
                if name == "getChallenge":
                    return self._json({"challenge": {"realm": outer.REALM, "nonce": outer.NONCE, "opaque": "o"}})
                h = body["header"]
                pw = outer.passwords.get(h["user"])
                ok = pw is not None and h["response"] == outer.expected(h["user"], pw, name)
                if ok and "data" in body:
                    outer.values.update(body["data"])
                self._json({"header": {"status": 0 if ok else 4, "message": "Ok" if ok else "denied"}})

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/api/"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def expected(self, user: str, password: str, name: str) -> str:
        h1 = sha256(f"{user}:{self.REALM}:{password}".encode()).hexdigest()
        h2 = sha256(f"POST:{name}".encode()).hexdigest()
        return sha256(f"{h1}:{self.NONCE}:{h2}".encode()).hexdigest()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


STATUS_VALUES = {
    "CommonDeviceStatus": {"Status": 3}, "OpHours": 1234, "DailyOpHours": 5, "PowerOnCnt": 7,
    "KM_SysBoard_Temp": 41.5, "KM_APDBoard_Temp": 35.7, "KM_PowerSource_Voltage": 12.25,
    "KM_MotorRotationPeriod": 100.0, "KM_MotorRotationTime": 1, "KMWindowWarning": False, "KMWindowError": False,
    "LinkToMeasurementModule": True, "LED_1_RED": False, "LED_2_ORANGE": False, "LED_3_YELLOW": True,
    **{f"DI{i}": False for i in range(1, 9)}, **{f"DO{i}": i == 2 for i in range(1, 9)},
    "AutoStartMeasure": True, "UpsideDown": True, "DeviceType": "MRS6224R-131001", "SerialNumber": "123",
    "FirmwareVersion": "2.1.0", "EtherIPAddress": [192, 168, 178, 200], "EtherMACAddress": [0, 6, 119, 1, 2, 3],
}


@pytest.fixture
def fake_rest():
    s = FakeRest(dict(STATUS_VALUES))
    yield s
    s.close()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
