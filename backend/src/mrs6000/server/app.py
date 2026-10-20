"""HTTP API (all under /api) and the built frontend (frontend/dist) at /.

  GET    /api/frame?after=<id>&sensor=<name>   long-poll: a sensor's newest frame (binary, see frames.py),
                                             meta in X-Meta; without `sensor` the current source's first
  GET    /api/sensors               the current source's sensors (name, live, ip, error, rate, clock)
  GET    /api/rig                   their poses (rig.py); PUT stores calibration results
  GET    /api/status?sensor=<name>  REST device values + sensor error
  GET    /api/state                 source, epoch, sensors, replay position, recording progress, errors
  GET    /api/recordings            list (name, bytes, scans, seconds, created, sensors of a session)
  GET    /api/recordings/{name}     download (a session folder as .zip)
  DELETE /api/recordings/{name}     delete
  POST   /api/record                {"action": "start" | "stop"}
  POST   /api/replay                {"file": name}
  POST   /api/replay/control        {"action": play|pause|toggle|step|seek|speed|loop, "value": ...}
  POST   /api/live                  back to the live sensor
Interactive docs: /docs."""
from __future__ import annotations

import json
import os
import tempfile
import zipfile
from pathlib import Path
from typing import Literal, Union

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.background import BackgroundTask

from ..errors import describe_error
from .health import log
from .hub import Hub
from ..recording import list_recordings, recording_path


class RecordRequest(BaseModel):
    action: Literal["start", "stop"]


class ReplayRequest(BaseModel):
    file: str


class ControlRequest(BaseModel):
    action: Literal["play", "pause", "toggle", "step", "seek", "speed", "loop"]
    value: Union[bool, int, float, None] = None


NO_FRONTEND = """<!doctype html><meta charset="utf-8"><title>MRS6000 viewer</title>
<body style="font:14px system-ui;background:#0e1116;color:#d7dde5;padding:2em">
<h1>Frontend not built</h1><p>Run <code>make build</code> (or <code>cd frontend && npm run build</code>),
or use the dev server: <code>make dev</code> → http://localhost:5173.</p><p>API docs: <a href="/docs" style="color:#4aa3ff">/docs</a></p>"""


def zip_session(folder: Path) -> Path:
    """A session folder as a temporary .zip (stored: the recordings are already compressed)."""
    fd, tmp = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
        for f in sorted(folder.iterdir()):
            if f.is_file():
                z.write(f, f"{folder.name}/{f.name}")
    return Path(tmp)


def create_app(hub: Hub, rec_dir: Path, frontend_dir: Path | None = None) -> FastAPI:
    app = FastAPI(title="MRS6000 viewer API", version="0.2.0")

    @app.exception_handler(ValueError)
    async def bad_request(_req: Request, e: ValueError):
        return JSONResponse({"error": str(e) or type(e).__name__}, status_code=400)

    @app.exception_handler(FileNotFoundError)
    async def not_found(_req: Request, e: FileNotFoundError):
        return JSONResponse({"error": f"not found: {e.args[0] if e.args else e}"}, status_code=404)

    @app.exception_handler(Exception)
    async def server_error(req: Request, e: Exception):
        msg = describe_error(e)
        log(f"http {req.method} {req.url.path}: {msg}")
        return JSONResponse({"error": msg}, status_code=500)

    def known(sensor: str | None) -> str | None:
        if sensor is not None and sensor not in hub.sensors():
            raise FileNotFoundError(f"sensor {sensor}")
        return sensor

    @app.get("/api/frame")
    def frame(after: int = 0, sensor: str | None = None):   # sync: runs in the threadpool, may block up to 2 s
        fid, data, meta = hub.feed(known(sensor)).wait(after)
        meta["id"] = fid
        return Response(data, media_type="application/octet-stream",
                        headers={"X-Meta": json.dumps(meta), "Cache-Control": "no-store"})

    @app.get("/api/sensors")
    def sensors():
        return hub.sensor_info()

    @app.get("/api/rig")
    def rig():
        return hub.current_rig()

    @app.put("/api/rig")
    def put_rig(update: dict):
        return hub.set_rig(update)

    @app.get("/api/status")
    def status(sensor: str | None = None):
        s = hub.live_sensor(known(sensor))
        if sensor is None:                       # every live sensor's error
            return {"device": s.status if s else {}, "error": hub.status_error()}
        return {"device": s.status if s else {}, "error": s.error if s and hub.source == "live" else ""}

    @app.get("/api/state")
    def state():
        return hub.state()

    @app.get("/api/recordings")
    def recordings():
        return list_recordings(rec_dir)

    @app.get("/api/recordings/{name}")
    def download(name: str):
        p = recording_path(rec_dir, name)
        if p.is_dir():
            z = zip_session(p)
            return FileResponse(z, media_type="application/zip", filename=p.name + ".zip",
                                background=BackgroundTask(z.unlink, missing_ok=True))
        return FileResponse(p, media_type="application/octet-stream", filename=p.name)

    @app.delete("/api/recordings/{name}")
    def delete(name: str):
        hub.delete_recording(recording_path(rec_dir, name))
        return list_recordings(rec_dir)

    @app.post("/api/record")
    def record(req: RecordRequest):
        if req.action == "start":
            hub.start_recording()
        else:
            hub.stop_recording()
        return hub.state()

    @app.post("/api/replay")
    def replay(req: ReplayRequest):
        hub.play_file(recording_path(rec_dir, req.file))
        return hub.state()

    @app.post("/api/replay/control")
    def control(req: ControlRequest):
        hub.control(req.action, req.value)
        return hub.state()

    @app.post("/api/live")
    def live():
        hub.go_live()
        return hub.state()

    if frontend_dir and (Path(frontend_dir) / "index.html").is_file():
        app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")
    else:
        @app.get("/", response_class=HTMLResponse)
        def index():
            return NO_FRONTEND

    return app
