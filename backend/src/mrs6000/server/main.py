"""Viewer backend entry point.

  mrs6000-viewer                                   # live sensor(s) → http://localhost:8000
  mrs6000-viewer --sensor a=192.168.178.200 --sensor b=192.168.178.201      # several sensors
  mrs6000-viewer --replay recordings/walk.tpc
  mrs6000-viewer --offline --replay x.tpc    # no sensor connection at all (tests, demos)

The sensors are --sensor NAME=IP, else those with an "ip" in the rig file (rig.json), else one sensor
"sensor" at --ip."""
from __future__ import annotations

import argparse
import socket
import sys
import threading
from pathlib import Path

from ..cola import cola_scans
from ..errors import describe_error
from ..rest import RestClient
from ..rig import SensorSpec, load_rig, parse_sensor_arg
from ..variables import DEFAULT_IP
from .app import create_app
from .health import log, supervised
from .hub import Hub, LiveSensor
from .status import status_loop

REPO = Path(__file__).resolve().parents[4]          # backend/src/mrs6000/server/main.py → repo root
DEFAULT_REC_DIR = REPO / "recordings"
DEFAULT_FRONTEND = REPO / "frontend" / "dist"
DEFAULT_RIG = REPO / "rig.json"


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="mrs6000-viewer", description="MRS6000 live viewer backend")
    ap.add_argument("--ip", help=f"address of a single sensor (default {DEFAULT_IP})")
    ap.add_argument("--sensor", action="append", default=[], metavar="NAME=IP",
                    help="a sensor of a multi-sensor rig (repeat for each)")
    ap.add_argument("--rig", type=Path, default=DEFAULT_RIG, help="sensor names, addresses and poses (JSON)")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (0.0.0.0 to share on the LAN)")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--recordings", type=Path, default=DEFAULT_REC_DIR, help="folder for .tpc / .tpc.zstd recordings")
    ap.add_argument("--frontend", type=Path, default=DEFAULT_FRONTEND, help="built frontend to serve at /")
    ap.add_argument("--record", metavar="FILE", help="start recording the live stream to FILE right away")
    ap.add_argument("--replay", metavar="FILE", help="start by playing a recording (.tpc, .tpc.zstd or a session folder)")
    ap.add_argument("--offline", action="store_true", help="never connect to the sensor (replay only)")
    return ap


def sensor_specs(args, rig: dict) -> list[SensorSpec]:
    if args.sensor:
        if args.ip:
            raise ValueError("use either --ip or --sensor")
        specs = [parse_sensor_arg(a) for a in args.sensor]
        if len({s.name for s in specs}) != len(specs):
            raise ValueError("--sensor: names must differ")
        return specs
    in_rig = [SensorSpec(s["name"], s["ip"]) for s in rig["sensors"] if s.get("ip")]
    if in_rig and not args.ip:
        return in_rig
    return [SensorSpec("sensor", args.ip or DEFAULT_IP)]


def main(argv: list[str] | None = None):
    import uvicorn

    args = build_parser().parse_args(argv)
    try:
        rig = load_rig(args.rig)
        specs = [] if args.offline else sensor_specs(args, rig)
    except (OSError, ValueError) as e:
        sys.exit(f"error: {describe_error(e)}")
    try:                                       # bind first: a busy port is reported in one line, nothing started
        sock = socket.socket(socket.AF_INET6 if ":" in args.host else socket.AF_INET)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((args.host, args.port))
    except OSError as e:
        sys.exit(f"error: cannot listen on {args.host}:{args.port}: {describe_error(e)}")
    sensors = [LiveSensor(s.name, (lambda ip=s.ip: cola_scans(ip)), ip=s.ip) for s in specs]
    hub = Hub(args.recordings, sensors, rig=rig, rig_path=args.rig)
    if args.record:
        try:
            hub.start_recording(args.record)
        except (OSError, ValueError) as e:
            log(f"cannot record to {args.record}: {describe_error(e)}")
    if args.replay:
        try:
            hub.play_file(Path(args.replay))
        except Exception as e:
            log(f"cannot replay {args.replay}: {describe_error(e)}" + ("" if args.offline else "; showing the live sensor"))
    hub.start()
    for s in sensors:
        rest = RestClient(s.ip, timeout=3.0)
        threading.Thread(target=supervised, args=(f"{s.label} status poll",
                                                  lambda rest=rest, s=s: status_loop(rest, s, hub.stop_event),
                                                  hub.stop_event), daemon=True).start()

    app = create_app(hub, args.recordings, args.frontend)
    live = ", ".join(f"{s.name} {s.ip}" for s in specs) if len(specs) > 1 else f"sensor {specs[0].ip}" if specs else ""
    src = f"replaying {args.replay}" if hub.source == "replay" else "offline" if args.offline else live
    shown = "localhost" if args.host == "127.0.0.1" else args.host
    log(f"viewer on http://{shown}:{args.port}  ({src}; recordings in {args.recordings}; API docs /docs)")
    config = uvicorn.Config(app, host=args.host, port=args.port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    try:
        server.run(sockets=[sock])
    except KeyboardInterrupt:
        pass
    finally:
        hub.stop()


if __name__ == "__main__":
    main()
