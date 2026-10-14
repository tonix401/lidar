#!/usr/bin/env python3
"""
Access a SICK MRS6000 (tested: MRS6224R-131001, FW 2.1.0.1663R).

The sensor exposes three interfaces, all usable without login for reading:

  1. REST API      http://<ip>/api/<VariableName>   (GET, JSON)        -> config / status
                   POST /api/<Method>  with challenge-response auth   -> write / call
  2. WebSocket     ws://<ip>/scan                   (MessagePack)      -> preview point cloud, ~2 Hz
  3. CoLa A (TCP)  <ip>:2111  "sEN LMDscandata 1"   (ASCII telegrams)  -> full-rate scans, 10 Hz x 24 layers

Usage:
  python mrs6000.py info                     # identity + network
  python mrs6000.py status                   # temperatures, voltage, IO, LEDs ...
  python mrs6000.py get KM_SysBoard_Temp OpHours
  python mrs6000.py dump > all.json          # every known variable as JSON
  python mrs6000.py scan                     # 1 full-rate scan via CoLa, summary
  python mrs6000.py scan -n 10 --csv out.csv # x,y,z,... for 10 scans
  python mrs6000.py record [prefix]          # one full-resolution scan -> .cola.txt .csv .ply .json
  python mrs6000.py scan --source ws         # preview stream via WebSocket (needs websocket-client + msgpack)

Dependencies: stdlib only, except the WebSocket source (pip install websocket-client msgpack).
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import socket
import struct
import sys
import time
import urllib.request
from dataclasses import dataclass, field
import hashlib
from hashlib import sha256
from typing import Iterator

DEFAULT_IP = "192.168.178.200"

# Variables found in the device description (SOPASair "current_msdd" -> descriptor.json),
# all verified readable via GET /api/<name>.
VARIABLES: dict[str, list[str]] = {
    "identity": [
        "DeviceIdent", "DeviceType", "SerialNumber", "OrderNumber", "FirmwareVersion",
        "Manufacturer", "LocationName",
    ],
    "network": [
        "EtherIPAddress", "EtherIPMask", "EtherIPGateAddress", "EtherMACAddress",
        "InternalEtherIPAddress", "InternalEtherIPMask", "InternalEtherIPGateAddress",
        "KMEtherIPAddress", "KMEtherIPMask", "KMEtherIPGateAddress", "KM_EthConnectionSpeed",
    ],
    "status": [
        "CommonDeviceStatus", "OpHours", "DailyOpHours", "PowerOnCnt",
        "KM_SysBoard_Temp", "KM_APDBoard_Temp", "KM_PowerSource_Voltage",
        "KM_MotorRotationPeriod", "KM_MotorRotationTime",
        "KMWindowWarning", "KMWindowError", "LinkToMeasurementModule",
        "LED_1_RED", "LED_2_ORANGE", "LED_3_YELLOW",
    ],
    "measurement_module": ["KM_LidarModel", "KM_ROM_Revision", "KM_FPGA_REV", "KM_FW_REV"],
    "io": [f"DI{i}" for i in range(1, 9)] + [f"DO{i}" for i in range(1, 9)] + ["PortConfiguration"],
    "scan_config": [
        "AutoStartMeasure", "ScanDataConfig", "DataOutputRange", "EnableLongRangeMode",
        "UpsideDown", "DistanceRange", "IntensityRange", "SickApplicationActive",
    ],
    "angle_data": [
        "AngleDataConfig", "AngleData", "AngleDataStatistic", "AngleDataStatisticExtended",
        "EnergyDataStatistic",
    ],
    "production": ["ProdIOTestState", "ProdIOTestLog"],
}

# Methods referenced by the web UI (need POST + auth): mStartMeasure, mStopMeasure, WriteEeprom,
# EthernetUpdate, ResetAppCounter, UpdateKmDiagData, changePassword.

DEVICE_STATUS = {0: "unknown", 1: "startup", 2: "service mode", 3: "normal operation",
                 4: "suspended operation", 5: "service recommended", 6: "service required",
                 7: "recoverable error", 8: "fatal error"}


# --------------------------------------------------------------------------------------------
# REST
# --------------------------------------------------------------------------------------------

class RestError(RuntimeError):
    pass


class RestClient:
    """GET variables; POST variables/methods using SICK's challenge-response auth."""

    USER_LEVELS = ("Run", "Operator", "Maintenance", "AuthorizedClient", "Service")

    def __init__(self, ip: str = DEFAULT_IP, timeout: float = 5.0):
        self.base = f"http://{ip}/api/"
        self.timeout = timeout
        self.user = "Run"
        self.password = ""
        # never route the sensor through an HTTP proxy
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _request(self, name: str, body: dict | None = None) -> dict:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + name, data=data, method="GET" if body is None else "POST")
        with self._opener.open(req, timeout=self.timeout) as r:
            return json.loads(r.read())

    def get(self, name: str):
        """Read one variable and return its value."""
        res = self._request(name)
        if res["header"]["status"] != 0:
            raise RestError(f"{name}: {res['header']['message']} (status {res['header']['status']})")
        return res["data"][name]

    def get_many(self, names: list[str]) -> dict:
        out = {}
        for n in names:
            try:
                out[n] = self.get(n)
            except Exception as e:  # keep going, report per variable
                out[n] = f"<error: {e}>"
        return out

    # --- authenticated POST ---------------------------------------------------------------

    def login(self, user: str, password: str) -> bool:
        """Set user level for subsequent POSTs. Default passwords of SICK LiDARs are typically
        'client' (AuthorizedClient) and 'servicelevel' (Service)."""
        self.user, self.password = user, password
        res = self._post("checkCredentials", None)
        ok = res["header"]["status"] == 0
        if not ok:
            self.user, self.password = "Run", ""
        return ok

    def write(self, name: str, value) -> dict:
        return self._post(name, {name: value})

    def call(self, method: str, args: dict | None = None) -> dict:
        return self._post(method, args)

    def _post(self, name: str, data) -> dict:
        ch = self._request("getChallenge", {"data": {"user": self.user}})["challenge"]
        h1 = (self.user + ":" + ch["realm"] + ":").encode() + bytes(ord(c) % 256 for c in self.password)
        if "salt" in ch:
            h1 += b":" + bytes(ch["salt"])
        hash1 = sha256(h1).hexdigest()
        hash2 = sha256(f"POST:{name}".encode()).hexdigest()
        header = {"user": self.user, "realm": ch["realm"], "nonce": ch["nonce"], "opaque": ch["opaque"],
                  "response": sha256(f"{hash1}:{ch['nonce']}:{hash2}".encode()).hexdigest()}
        body = {"header": header}
        if data is not None:
            body["data"] = data
        return self._request(name, body)


# --------------------------------------------------------------------------------------------
# Scan data model
# --------------------------------------------------------------------------------------------

DIST_INVALID_MAX_RAW = 15  # raw distances <= 15 are invalid (per SICK web UI)


@dataclass
class Echo:
    distance_mm: list[float]          # 0.0 = invalid
    rssi: list[int]


@dataclass
class Layer:
    elevation_deg: float              # nominal layer angle
    start_azimuth_deg: float          # azimuth of first beam, 0 = straight ahead, +left
    step_deg: float
    echoes: list[Echo]
    beam_elevation_deg: list[float] | None = None  # per-beam elevation (CoLa VANGL channel)
    timestamp_us: int | None = None   # sensor time since power-on (CoLa only)

    @property
    def beam_count(self) -> int:
        return len(self.echoes[0].distance_mm) if self.echoes else 0

    def azimuths_deg(self) -> list[float]:
        return [self.start_azimuth_deg + i * self.step_deg for i in range(self.beam_count)]


@dataclass
class Scan:
    layers: list[Layer] = field(default_factory=list)
    scan_frequency_hz: float | None = None
    raw_telegrams: list[str] = field(default_factory=list)  # CoLa A source only, one per layer

    def points(self, echo: int | None = None, upside_down: bool = False) -> Iterator[tuple]:
        """Yield (x, y, z, distance_m, rssi, layer_idx, echo_idx) for every valid return.

        Frame: x forward, y left, z up, metres, for a sensor standing upright (negative
        elevation = downwards). upside_down=True (sensor on its head, device parameter
        UpsideDown set) flips only z: the device already reports azimuth in world left/right.
        """
        s = -1.0 if upside_down else 1.0
        for li, layer in enumerate(self.layers):
            azs = layer.azimuths_deg()
            for ei, e in enumerate(layer.echoes):
                if echo is not None and ei != echo:
                    continue
                for bi, d_mm in enumerate(e.distance_mm):
                    if d_mm <= 0:
                        continue
                    d = d_mm / 1000.0
                    el = math.radians(layer.beam_elevation_deg[bi] if layer.beam_elevation_deg
                                      else layer.elevation_deg)
                    az = math.radians(azs[bi])
                    yield (math.cos(az) * math.cos(el) * d, math.sin(az) * math.cos(el) * d,
                           s * math.sin(el) * d, d, e.rssi[bi], li, ei)


# --------------------------------------------------------------------------------------------
# WebSocket source (ws://ip/scan, MessagePack, preview rate)
# --------------------------------------------------------------------------------------------

def ws_scans(ip: str = DEFAULT_IP, timeout: float = 10.0) -> Iterator[Scan]:
    """Yield complete 24-layer scans from the web UI's websocket (~2 Hz, decimated).

    Message: {"version": 2, "layer": [{"verticalAngle": float deg, "startAngle": int 1e-4 deg,
              "angularResolution": int 1e-4 deg, "pulses": [{"scanBeamCount": n,
              "distance": bytes BE uint16 * 12.5 mm, "rssi": bytes BE uint16}]}]}
    """
    import msgpack
    import websocket

    ws = websocket.create_connection(f"ws://{ip}/scan", timeout=timeout)
    try:
        while True:
            msg = msgpack.unpackb(ws.recv(), raw=False)
            if msg.get("version") != 2:
                raise ValueError(f"unsupported scan format version {msg.get('version')}")
            scan = Scan()
            for L in msg["layer"]:
                echoes = []
                for p in L["pulses"]:
                    n = p["scanBeamCount"]
                    dist = struct.unpack(f">{n}H", p["distance"][: 2 * n])
                    rssi = struct.unpack(f">{n}H", p["rssi"][: 2 * n])
                    echoes.append(Echo([d * 12.5 if d > DIST_INVALID_MAX_RAW else 0.0 for d in dist],
                                       list(rssi)))
                scan.layers.append(Layer(
                    elevation_deg=float(L["verticalAngle"]),
                    start_azimuth_deg=L["startAngle"] / 10000 - 90,
                    step_deg=L["angularResolution"] / 10000,
                    echoes=echoes))
            yield scan
    finally:
        ws.close()


# --------------------------------------------------------------------------------------------
# CoLa A source (TCP 2111, full rate)
# --------------------------------------------------------------------------------------------

def _hex_i(tok: str, bits: int) -> int:
    v = int(tok, 16)
    return v - (1 << bits) if v >= 1 << (bits - 1) else v


def _hex_f(tok: str) -> float:
    return struct.unpack(">f", int(tok, 16).to_bytes(4, "big"))[0]


def parse_lmdscandata(tokens: list[str]) -> tuple[Layer, dict]:
    """Parse one CoLa A LMDscandata telegram (tokens after the command name) into a Layer."""
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
    for _ in range(n_chan):                  # 16-bit channels: DIST1..n, RSSI1..n, VANGL
        name = t[i]
        scale, offset = _hex_f(t[i + 1]), _hex_f(t[i + 2])
        start = _hex_i(t[i + 3], 32) / 10000
        step = int(t[i + 4], 16) / 10000
        n = int(t[i + 5], 16)
        raw = [int(x, 16) for x in t[i + 6: i + 6 + n]]
        channels[name] = (scale, offset, start, step, raw)
        i += 6 + n
    dist_names = sorted(k for k in channels if k.startswith("DIST"))
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


class ColaClient:
    """Minimal CoLa A (ASCII, STX/ETX framed) client on TCP 2111."""

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

    COLA_USER_LEVELS = {"Maintenance": 2, "AuthorizedClient": 3, "Service": 4}

    def login(self, user: str, password: str):
        """SetAccessMode with SICK's CoLa password hash; raises on wrong credentials."""
        level = self.COLA_USER_LEVELS[user]
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


ECHO_FILTERS = {"first": 0, "all": 1, "last": 2}   # FREchoFilter values


def cola_password_hash(password: str) -> int:
    """SICK CoLa A/B password hash: MD5 of ISO-8859-15 bytes, XOR-folded to 4 bytes, LE uint32."""
    digest = hashlib.md5(password.encode("iso8859_15")).digest()
    folded = bytes(digest[i] ^ digest[i + 4] ^ digest[i + 8] ^ digest[i + 12] for i in range(4))
    return int.from_bytes(folded, "little")


def load_env(path: str = ".env") -> dict[str, str]:
    """Minimal KEY=VALUE reader (USERNAME / PASSWORD for the sensor login)."""
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip("'\"")
    except FileNotFoundError:
        pass
    return env


def cola_scans(ip: str = DEFAULT_IP, layers: int = 24) -> Iterator[Scan]:
    """Full-rate scans; drops the first partial revolution."""
    with ColaClient(ip) as c:
        for scan in c.scans():
            if len(scan.layers) == layers:
                yield scan


# --------------------------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------------------------

def _fmt(v) -> str:
    if isinstance(v, list) and len(v) in (4, 6) and all(isinstance(x, int) for x in v):
        return (":".join(f"{x:02x}" for x in v)) if len(v) == 6 else ".".join(map(str, v))
    if isinstance(v, float):
        return f"{v:.2f}"
    return json.dumps(v) if isinstance(v, (dict, list)) else str(v)


def cmd_info(rest: RestClient, _args):
    for group in ("identity", "network", "measurement_module"):
        print(f"[{group}]")
        for k, v in rest.get_many(VARIABLES[group]).items():
            print(f"  {k:28s} {_fmt(v)}")


def cmd_status(rest: RestClient, _args):
    s = rest.get_many(VARIABLES["status"] + VARIABLES["io"][:16] + ["AutoStartMeasure", "UpsideDown"])
    st = s["CommonDeviceStatus"]
    code = st.get("Status") if isinstance(st, dict) else st
    print(f"Device status        : {DEVICE_STATUS.get(code, code)}")
    print(f"System board temp    : {s['KM_SysBoard_Temp']:.1f} °C")
    print(f"APD board temp       : {s['KM_APDBoard_Temp']:.1f} °C")
    print(f"Supply voltage       : {s['KM_PowerSource_Voltage']:.2f} V")
    print(f"Mirror period        : {s['KM_MotorRotationPeriod']:.2f} ms "
          f"({1000 / s['KM_MotorRotationPeriod']:.2f} Hz)")
    print(f"Operating hours      : {s['OpHours'] / 10:.1f} h   (power-ons: {s['PowerOnCnt']})")
    print(f"Window warning/error : {s['KMWindowWarning']} / {s['KMWindowError']}")
    print(f"LEDs red/orange/yel  : {s['LED_1_RED']} / {s['LED_2_ORANGE']} / {s['LED_3_YELLOW']}")
    print("Digital in  1-8      : " + " ".join("1" if s[f"DI{i}"] else "0" for i in range(1, 9)))
    print("Digital out 1-8      : " + " ".join("1" if s[f"DO{i}"] else "0" for i in range(1, 9)))
    print(f"Autostart / upside-dn: {s['AutoStartMeasure']} / {s['UpsideDown']}")


def cmd_get(rest: RestClient, args):
    for name in args.names:
        try:
            print(f"{name} = {json.dumps(rest.get(name))}")
        except RestError as e:
            print(e, file=sys.stderr)


def cmd_dump(rest: RestClient, _args):
    json.dump({g: rest.get_many(v) for g, v in VARIABLES.items()}, sys.stdout, indent=2)
    print()


def cmd_scan(_rest, args):
    src = cola_scans(args.ip) if args.source == "cola" else ws_scans(args.ip)
    writer, fh = None, None
    if args.csv:
        fh = open(args.csv, "w", newline="")
        writer = csv.writer(fh)
        writer.writerow(["scan", "x", "y", "z", "distance_m", "rssi", "layer", "echo"])
    t0 = time.time()
    try:
        for n, scan in enumerate(src):
            pts = list(scan.points())
            beams = sum(l.beam_count for l in scan.layers)
            dists = [p[3] for p in pts]
            print(f"scan {n}: {len(scan.layers)} layers "
                  f"({scan.layers[0].elevation_deg:+.2f}..{scan.layers[-1].elevation_deg:+.2f}°), "
                  f"{scan.layers[0].beam_count} beams/layer "
                  f"({scan.layers[0].start_azimuth_deg:+.1f}..{scan.layers[0].azimuths_deg()[-1]:+.1f}°, "
                  f"step {scan.layers[0].step_deg:.4f}°), "
                  f"{len(pts)}/{beams} valid, range {min(dists, default=0):.2f}..{max(dists, default=0):.2f} m")
            if writer:
                writer.writerows((n, *(round(v, 4) for v in p[:4]), *p[4:]) for p in pts)
            if n + 1 >= args.count:
                break
    finally:
        if fh:
            fh.close()
    print(f"{n + 1} scans in {time.time() - t0:.2f} s")


def record(scan: Scan, prefix: str, rest: RestClient | None = None, upside_down: bool = False) -> list[str]:
    """Write one scan losslessly: raw telegrams (.cola.txt), every beam (.csv), point cloud (.ply),
    plus device context (.json). x/y/z as in Scan.points(). Returns the written paths."""
    paths = []
    s = -1.0 if upside_down else 1.0
    if scan.raw_telegrams:
        with open(prefix + ".cola.txt", "w") as f:
            f.write("\n".join(scan.raw_telegrams) + "\n")   # one LMDscandata telegram per line
        paths.append(prefix + ".cola.txt")

    rows = []  # every beam, including invalid ones (distance 0)
    for li, layer in enumerate(scan.layers):
        azs = layer.azimuths_deg()
        for ei, e in enumerate(layer.echoes):
            for bi, d_mm in enumerate(e.distance_mm):
                el = layer.beam_elevation_deg[bi] if layer.beam_elevation_deg else layer.elevation_deg
                d = d_mm / 1000.0
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


def cmd_record(rest: RestClient, args):
    prefix = args.prefix or time.strftime("scan_%Y%m%d_%H%M%S")
    upside_down = {"upright": False, "upside-down": True}.get(args.mount)
    if upside_down is None:                        # auto: follow the device's UpsideDown parameter
        try:
            upside_down = bool(rest.get("UpsideDown"))
        except Exception:
            upside_down = False
    for n, scan in enumerate(cola_scans(args.ip)):
        p = prefix if args.count == 1 else f"{prefix}_{n:03d}"
        for path in record(scan, p, rest, upside_down=upside_down):
            print("wrote", path)
        if n + 1 >= args.count:
            break


def cmd_echo_filter(_rest, args):
    env = load_env(args.env)
    with ColaClient(args.ip) as c:
        old = int(c.read("FREchoFilter")[0])
        names = {v: k for k, v in ECHO_FILTERS.items()}
        print(f"FREchoFilter currently {old} ({names.get(old, '?')})")
        if args.mode is None:
            return
        if "USERNAME" not in env or "PASSWORD" not in env:
            sys.exit(f"USERNAME / PASSWORD missing in {args.env}")
        c.login(env["USERNAME"], env["PASSWORD"])
        try:
            c.write("FREchoFilter", ECHO_FILTERS[args.mode])
            if args.save:
                c.save_permanent()
        finally:
            c.run()
        new = int(c.read("FREchoFilter")[0])
        print(f"FREchoFilter now {new} ({names.get(new, '?')})" + (", saved permanently" if args.save else
              " (not saved: reverts on power cycle, use --save)"))


def main():
    ap = argparse.ArgumentParser(description="SICK MRS6000 data access")
    ap.add_argument("--ip", default=DEFAULT_IP)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info", help="identity, network, firmware")
    sub.add_parser("status", help="temperatures, voltage, IO, LEDs")
    g = sub.add_parser("get", help="read variables by name")
    g.add_argument("names", nargs="+")
    sub.add_parser("dump", help="all known variables as JSON")
    e = sub.add_parser("echo-filter", help="show or set which echoes are output (CoLa login from .env)")
    e.add_argument("mode", nargs="?", choices=tuple(ECHO_FILTERS), help="first | all | last")
    e.add_argument("--save", action="store_true", help="store permanently (EEPROM)")
    e.add_argument("--env", default=".env")
    r = sub.add_parser("record", help="save full-resolution scan(s): raw telegrams, CSV, PLY, JSON")
    r.add_argument("prefix", nargs="?", help="output file prefix (default scan_<timestamp>)")
    r.add_argument("-n", "--count", type=int, default=1)
    r.add_argument("--mount", choices=("auto", "upright", "upside-down"), default="auto",
                   help="sensor mounting for x/y/z (auto: read the device's UpsideDown parameter)")
    s = sub.add_parser("scan", help="receive point clouds")
    s.add_argument("--source", choices=("cola", "ws"), default="cola",
                   help="cola: TCP 2111, full rate (default); ws: web UI preview stream")
    s.add_argument("-n", "--count", type=int, default=1)
    s.add_argument("--csv", help="write points to CSV")
    args = ap.parse_args()

    rest = RestClient(args.ip)
    {"info": cmd_info, "status": cmd_status, "get": cmd_get, "dump": cmd_dump, "scan": cmd_scan, "record": cmd_record, "echo-filter": cmd_echo_filter}[args.cmd](rest, args)


if __name__ == "__main__":
    main()
