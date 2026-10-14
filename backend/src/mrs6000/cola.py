"""CoLa A client (TCP 2111, ASCII telegrams framed by STX/ETX): full-rate scans and configuration."""
from __future__ import annotations

import hashlib
import socket
import struct
from typing import Iterator

from .model import DIST_INVALID_MAX_RAW, Echo, Layer, Scan
from .variables import DEFAULT_IP

ECHO_FILTERS = {"first": 0, "all": 1, "last": 2}   # FREchoFilter values
COLA_USER_LEVELS = {"Maintenance": 2, "AuthorizedClient": 3, "Service": 4}


def _hex_i(tok: str, bits: int) -> int:
    v = int(tok, 16)
    return v - (1 << bits) if v >= 1 << (bits - 1) else v


def _hex_f(tok: str) -> float:
    return struct.unpack(">f", int(tok, 16).to_bytes(4, "big"))[0]


def parse_lmdscandata(tokens: list[str]) -> tuple[Layer, dict]:
    """Parse one LMDscandata telegram (tokens after "sSN LMDscandata") into a Layer.

    Layout: header fields (counters, times, layer angle in 1/200°, scan frequency), encoder block,
    then 16-bit channels DIST1..n, RSSI1..n, VANGL, each: name, scale (float), offset (float),
    start angle (int32, 1e-4°), step (1e-4°), count, values.
    """
    t = tokens
    meta = {
        "telegram_counter": int(t[5], 16),
        "scan_counter": int(t[6], 16),
        "time_since_startup_us": int(t[7], 16),
        "time_of_transmission_us": int(t[8], 16),
        "layer_angle_deg": _hex_i(t[13], 16) / 200.0,
        "scan_frequency_hz": int(t[14], 16) / 100.0,
        "measurement_frequency_hz": int(t[15], 16) * 100,
    }
    i = 16
    n_enc = int(t[i], 16)
    i += 1 + 2 * n_enc
    channels = {}
    n_chan = int(t[i], 16)
    i += 1
    for _ in range(n_chan):
        name = t[i]
        scale, offset = _hex_f(t[i + 1]), _hex_f(t[i + 2])
        start = _hex_i(t[i + 3], 32) / 10000
        step = int(t[i + 4], 16) / 10000
        n = int(t[i + 5], 16)
        raw = [int(x, 16) for x in t[i + 6: i + 6 + n]]
        channels[name] = (scale, offset, start, step, raw)
        i += 6 + n
    dist_names = sorted(k for k in channels if k.startswith("DIST"))
    if not dist_names:
        raise ValueError("LMDscandata telegram without distance channel")
    echoes = []
    for dn in dist_names:
        scale, offset, _, _, raw = channels[dn]
        rssi = channels.get("RSSI" + dn[4:], (1, 0, 0, 0, [0] * len(raw)))[4]
        echoes.append(Echo([r * scale + offset if r > DIST_INVALID_MAX_RAW else 0.0 for r in raw], rssi))
    _, _, start, step, _ = channels[dist_names[0]]
    vangl = None
    if "VANGL" in channels:
        s, o, _, _, raw = channels["VANGL"]
        vangl = [r * s + o for r in raw]
    layer = Layer(elevation_deg=meta["layer_angle_deg"], start_azimuth_deg=start - 90, step_deg=step,
                  echoes=echoes, beam_elevation_deg=vangl, timestamp_us=meta["time_since_startup_us"])
    return layer, meta


def cola_password_hash(password: str) -> int:
    """SICK CoLa A/B password hash: MD5 of ISO-8859-15 bytes, XOR-folded to 4 bytes, LE uint32."""
    digest = hashlib.md5(password.encode("iso8859_15")).digest()
    folded = bytes(digest[i] ^ digest[i + 4] ^ digest[i + 8] ^ digest[i + 12] for i in range(4))
    return int.from_bytes(folded, "little")


class ColaClient:
    """Minimal CoLa A client. Use as a context manager."""

    def __init__(self, ip: str = DEFAULT_IP, port: int = 2111, timeout: float = 5.0):
        self.sock = socket.create_connection((ip, port), timeout=timeout)
        self._buf = b""

    def close(self):
        self.sock.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def send(self, cmd: str):
        self.sock.sendall(b"\x02" + cmd.encode("latin-1") + b"\x03")

    def recv(self) -> str:
        while b"\x03" not in self._buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("sensor closed connection")
            self._buf += chunk
        end = self._buf.index(b"\x03")
        start = self._buf.rfind(b"\x02", 0, end)
        frame, self._buf = self._buf[start + 1:end], self._buf[end + 1:]
        return frame.decode("latin-1")

    def request(self, cmd: str) -> str:
        """Send a command and return the matching reply (skips interleaved scan telegrams)."""
        self.send(cmd)
        name = cmd.split()[1]
        while True:
            r = self.recv()
            if r.split(" ", 2)[1:2] == [name] or r.startswith("sFA"):
                return r

    # --- configuration (needs login) -------------------------------------------------------

    def login(self, user: str, password: str):
        """SetAccessMode with SICK's CoLa password hash; raises PermissionError when rejected."""
        level = COLA_USER_LEVELS[user]
        r = self.request(f"sMN SetAccessMode {level:02X} {cola_password_hash(password):08X}")
        if r.split()[-1] != "1":
            raise PermissionError(f"CoLa login as {user} rejected ({r})")

    def read(self, var: str) -> list[str]:
        r = self.request(f"sRN {var}")
        if r.startswith("sFA"):
            raise RuntimeError(f"sRN {var}: error {r}")
        return r.split()[2:]

    def write(self, var: str, *values):
        r = self.request(f"sWN {var} " + " ".join(str(v) for v in values))
        if not r.startswith("sWA"):
            raise RuntimeError(f"sWN {var}: error {r}")

    def save_permanent(self):
        """Store current parameters in EEPROM (otherwise lost on power cycle)."""
        r = self.request("sMN mEEwriteall")
        if r.split()[-1] != "1":
            raise RuntimeError(f"mEEwriteall failed ({r})")

    def run(self):
        """Leave configuration mode / log out (back to user level Run)."""
        self.request("sMN Run")

    # --- scan stream ---------------------------------------------------------------------------

    def scans(self) -> Iterator[Scan]:
        """Subscribe to LMDscandata and yield complete multi-layer scans."""
        self.send("sEN LMDscandata 1")
        current, last_angle, freq = Scan(), None, None
        try:
            while True:
                frame = self.recv()
                tok = frame.split()
                if len(tok) < 2 or tok[1] != "LMDscandata" or tok[0] not in ("sSN", "sRA"):
                    continue
                layer, meta = parse_lmdscandata(tok[2:])
                # layers arrive bottom-to-top; a non-increasing angle starts a new revolution
                if last_angle is not None and layer.elevation_deg <= last_angle and current.layers:
                    current.scan_frequency_hz = freq
                    yield current
                    current = Scan()
                current.layers.append(layer)
                current.raw_telegrams.append(frame)
                last_angle, freq = layer.elevation_deg, meta["scan_frequency_hz"]
        finally:
            try:
                self.send("sEN LMDscandata 0")
            except OSError:
                pass


def cola_scans(ip: str = DEFAULT_IP, layers: int = 24, port: int = 2111, timeout: float = 5.0) -> Iterator[Scan]:
    """Full-rate scans with all `layers` layers (drops the partial first revolution)."""
    with ColaClient(ip, port, timeout) as c:
        for scan in c.scans():
            if len(scan.layers) == layers:
                yield scan
