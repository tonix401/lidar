"""Viewer backend entry point.

  mrs6000-viewer                                   # live sensor → http://localhost:8000
  mrs6000-viewer --replay recordings/walk.mrsstream
  mrs6000-viewer --offline --replay x.mrsstream    # no sensor connection at all (tests, demos)
"""
from __future__ import annotations

import argparse
import socket
import sys
import threading
from pathlib import Path

from ..cola import cola_scans
from ..errors import describe_error
from ..rest import RestClient
from ..variables import DEFAULT_IP
from .app import create_app
from .feed import Feed
from .health import log, supervised
from .hub import Hub
from .status import status_loop

REPO = Path(__file__).resolve().parents[4]          # backend/src/mrs6000/server/main.py → repo root
DEFAULT_REC_DIR = REPO / "recordings"
DEFAULT_FRONTEND = REPO / "frontend" / "dist"


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="mrs6000-viewer", description="MRS6000 live viewer backend")
    ap.add_argument("--ip", default=DEFAULT_IP, help="sensor address")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (0.0.0.0 to share on the LAN)")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--recordings", type=Path, default=DEFAULT_REC_DIR, help="folder for .mrsstream recordings")
    ap.add_argument("--frontend", type=Path, default=DEFAULT_FRONTEND, help="built frontend to serve at /")
    ap.add_argument("--record", metavar="FILE", help="start recording the live stream to FILE right away")
    ap.add_argument("--replay", metavar="FILE", help="start by playing a .mrsstream recording")
    ap.add_argument("--offline", action="store_true", help="never connect to the sensor (replay only)")
    return ap


def main(argv: list[str] | None = None):
    import uvicorn

    args = build_parser().parse_args(argv)
    try:                                       # bind first: a busy port is reported in one line, nothing started
        sock = socket.socket(socket.AF_INET6 if ":" in args.host else socket.AF_INET)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((args.host, args.port))
    except OSError as e:
        sys.exit(f"error: cannot listen on {args.host}:{args.port}: {describe_error(e)}")
    feed = Feed()
    source = None if args.offline else (lambda: cola_scans(args.ip))
    hub = Hub(feed, args.recordings, source)
    if args.record:
        try:
            hub.recorder.start(args.record)
        except OSError as e:
            log(f"cannot record to {args.record}: {describe_error(e)}")
    if args.replay:
        try:
            hub.play_file(Path(args.replay))
        except Exception as e:
            log(f"cannot replay {args.replay}: {describe_error(e)}" + ("" if args.offline else "; showing the live sensor"))
    hub.start()
    if not args.offline:
        rest = RestClient(args.ip, timeout=3.0)
        threading.Thread(target=supervised, args=("status poll", lambda: status_loop(rest, feed, hub.stop_event),
                                                  hub.stop_event), daemon=True).start()

    app = create_app(feed, hub, args.recordings, args.frontend)
    src = f"replaying {args.replay}" if hub.source == "replay" else "offline" if args.offline else f"sensor {args.ip}"
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
