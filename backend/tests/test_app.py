import json
import time

import pytest
from fastapi.testclient import TestClient

from mrs6000.server.app import create_app
from mrs6000.server.feed import Feed
from mrs6000.server.hub import Hub
from tests.test_hub import endless, wait_until
from tests.test_stream import write_recording


@pytest.fixture
def setup(tmp_path):
    rec_dir = tmp_path / "recs"
    rec_dir.mkdir()
    write_recording(rec_dir / "walk.mrsstream", n=30, dt=0.05)
    feed = Feed()
    hub = Hub(feed, rec_dir, endless(), retry_s=0.05)
    hub.start()
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<h1>frontend</h1>")
    client = TestClient(create_app(feed, hub, rec_dir, dist), raise_server_exceptions=False)
    yield client, hub, rec_dir
    hub.stop()


def test_frame_long_poll(setup):
    client, hub, _ = setup
    r = client.get("/api/frame?after=0")
    assert r.status_code == 200 and r.headers["content-type"] == "application/octet-stream"
    meta = json.loads(r.headers["x-meta"])
    assert meta["layers"] == 3 and meta["source"] == "live" and len(r.content) == 4 * 3 * 15
    r2 = client.get(f"/api/frame?after={meta['id']}")
    assert json.loads(r2.headers["x-meta"])["id"] > meta["id"]


def test_state_status_and_frontend(setup):
    client, hub, _ = setup
    st = client.get("/api/state").json()
    assert st["source"] == "live" and st["recording"]["active"] is False and st["sensor"] is True
    assert client.get("/api/status").json() == {"device": {}, "error": ""}
    assert "frontend" in client.get("/").text
    assert client.get("/docs").status_code == 200


def test_recordings_list_download_delete(setup):
    client, hub, rec_dir = setup
    lst = client.get("/api/recordings").json()
    assert [r["name"] for r in lst] == ["walk.mrsstream"] and lst[0]["scans"] == 30
    dl = client.get("/api/recordings/walk.mrsstream")
    assert dl.status_code == 200 and len(dl.content) == (rec_dir / "walk.mrsstream").stat().st_size
    assert client.get("/api/recordings/nope.mrsstream").status_code == 404
    assert client.get("/api/recordings/..%2Fx.mrsstream").status_code in (400, 404)
    assert client.delete("/api/recordings/walk.mrsstream").json() == []


def test_record_start_stop(setup):
    client, hub, rec_dir = setup
    st = client.post("/api/record", json={"action": "start"}).json()
    assert st["recording"]["active"]
    wait_until(lambda: hub.recorder.state().get("scans", 0) >= 2)
    name = hub.recorder.state()["file"]
    assert client.delete(f"/api/recordings/{name}").status_code == 400   # still recording
    st = client.post("/api/record", json={"action": "stop"}).json()
    assert not st["recording"]["active"]
    assert client.post("/api/record", json={"action": "pause"}).status_code == 422


def test_replay_control_and_back_to_live(setup):
    client, hub, _ = setup
    st = client.post("/api/replay", json={"file": "walk.mrsstream"}).json()
    assert st["source"] == "replay"
    st = client.post("/api/replay/control", json={"action": "seek", "value": 20}).json()
    wait_until(lambda: hub.feed.meta.get("replay", {}).get("index", 0) >= 20)
    r = client.post("/api/replay/control", json={"action": "fly"})
    assert r.status_code == 422
    assert client.post("/api/replay", json={"file": "missing.mrsstream"}).status_code == 404
    assert client.post("/api/live").json()["source"] == "live"
    r = client.post("/api/replay/control", json={"action": "play"})
    assert r.status_code == 400 and r.json() == {"error": "not replaying"}


def test_deleting_the_playing_recording_goes_live(setup):
    client, hub, _ = setup
    client.post("/api/replay", json={"file": "walk.mrsstream"})
    client.delete("/api/recordings/walk.mrsstream")
    assert client.get("/api/state").json()["source"] == "live"


def test_unexpected_errors_are_short_500s(setup, capsys):
    client, hub, _ = setup
    hub.state = lambda: 1 / 0
    r = client.get("/api/state")
    assert r.status_code == 500 and r.json() == {"error": "ZeroDivisionError: division by zero"}
    assert "http GET /api/state: ZeroDivisionError" in capsys.readouterr().out


def test_offline_hub_refuses_recording(tmp_path):
    feed, hub = Feed(), Hub(Feed(), tmp_path, None)
    client = TestClient(create_app(feed, hub, tmp_path, None))
    r = client.post("/api/record", json={"action": "start"})
    assert r.status_code == 400 and "offline" in r.json()["error"]
    assert "Frontend not built" in client.get("/").text
