"""Several sensors: per-sensor feeds, session recordings (record → list → replay in time order), the rig."""
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from mrs6000.recording import SESSION_FILE, Session, SessionRecorder, list_recordings, recording_path
from mrs6000.rig import load_rig, merge_rig, parse_sensor_arg
from mrs6000.server.app import create_app
from mrs6000.server.hub import Hub, LiveSensor
from mrs6000.server.main import build_parser, sensor_specs
from tests.conftest import make_scan
from tests.test_hub import endless, wait_until

POSE = {"x": 1.0, "y": -2.0, "z": 1.1, "yaw": 30.0, "pitch": 1.5, "roll": -0.5}


def write_session(folder, phases=(0.0, 0.03, 0.07), n=10, complete=True):
    """a session of len(phases) sensors a, b, c... scanning at 10 Hz with the given phases"""
    names = [chr(97 + i) for i in range(len(phases))]
    rec = SessionRecorder(folder.parent, rig=lambda: {"sensors": [{"name": "a", "pose": POSE}]})
    rec.start(names, folder)
    for k in range(n):
        for i, (name, ph) in enumerate(zip(names, phases)):
            rec.write(name, make_scan(dist_mm=lambda l, b, i=i: 1000.0 + 12.5 * (i + l + b)), 1000.0 + ph + 0.1 * k,
                      upside_down=i == 1)
    if complete:
        rec.stop()
    return rec


def test_session_is_one_timeline_over_all_sensors(tmp_path):
    write_session(tmp_path / "s1")
    meta = json.loads((tmp_path / "s1" / SESSION_FILE).read_text())
    assert meta["complete"] and [s["file"] for s in meta["sensors"]] == ["a.tpc.zstd", "b.tpc.zstd", "c.tpc.zstd"]
    assert meta["rig"]["sensors"][0]["pose"] == POSE
    with Session(tmp_path / "s1") as s:
        assert s.count == 30 and s.sensors == ["a", "b", "c"]
        times = [s.time(k) for k in range(s.count)]
        assert times == sorted(times)
        assert [s.frame(k)[0] for k in range(6)] == ["a", "b", "c", "a", "b", "c"]
        name, ts, data, points, hdr = s.frame(4)
        assert (name, hdr["sensor"], hdr["upside_down"]) == ("b", "b", True) and ts == pytest.approx(1000.13)
        assert s.info()["sensors"] == ["a", "b", "c"] and s.info()["seconds"] == pytest.approx(0.97)


def test_a_session_being_recorded_only_grows_at_the_end(tmp_path):
    rec = write_session(tmp_path / "s1", n=30, complete=False)
    for r in rec.recorders.values():                 # flush the first chunk of each sensor (25 scans)
        wait_until(lambda r=r: r.bytes > 0 and r.queue.empty())
    with Session(tmp_path / "s1") as s:
        n = s.count                                  # chunks of 25: everything up to the last common time
        assert n == 25 + 24 + 24 and max(s.time(k) for k in range(n)) <= min(r.time(24) for r in s.recs)
        rec.stop()
        assert s.count == 90


def test_listing_paths_and_sessions(tmp_path):
    write_session(tmp_path / "rec_1")
    (tmp_path / "not_a_session").mkdir()
    assert [r["name"] for r in list_recordings(tmp_path)] == ["rec_1"]
    assert recording_path(tmp_path, "rec_1") == tmp_path / "rec_1"
    for bad in ("not_a_session", "../x", "rec.1"):
        with pytest.raises((ValueError, FileNotFoundError)):
            recording_path(tmp_path, bad)


def test_rig_merge_and_sensor_args(tmp_path):
    rig = merge_rig({"sensors": [{"name": "a", "ip": "10.0.0.1"}]}, {"sensors": [{"name": "a", "pose": POSE, "ip": "x"},
                                                                                 {"name": "b", "time_offset_s": 0.01}]})
    assert rig["sensors"] == [{"name": "a", "ip": "10.0.0.1", "pose": POSE}, {"name": "b", "time_offset_s": 0.01}]
    for bad in ({"sensors": [{"name": "a b"}]}, {"sensors": [{"name": "a", "pose": {"x": 1}}]}, {"sensors": 3}):
        with pytest.raises(ValueError):
            merge_rig(rig, bad)
    assert parse_sensor_arg("left=192.168.0.2").name == "left"
    (tmp_path / "rig.json").write_text(json.dumps({"sensors": [{"name": "a", "ip": "1.2.3.4"}, {"name": "b"}]}))
    rig = load_rig(tmp_path / "rig.json")
    p = build_parser()
    assert [s.name for s in sensor_specs(p.parse_args([]), rig)] == ["a"]                  # the rig's (with an ip)
    assert [s.ip for s in sensor_specs(p.parse_args(["--ip", "9.9.9.9"]), rig)] == ["9.9.9.9"]
    assert [s.name for s in sensor_specs(p.parse_args(["--sensor", "x=1", "--sensor", "y=2"]), rig)] == ["x", "y"]
    with pytest.raises(ValueError):
        sensor_specs(p.parse_args(["--sensor", "x=1", "--sensor", "x=2"]), rig)


@pytest.fixture
def two(tmp_path):
    rec_dir = tmp_path / "recs"
    hub = Hub(rec_dir, [LiveSensor("a", endless(), ip="10.0.0.1"), LiveSensor("b", endless(), ip="10.0.0.2")],
              retry_s=0.05, rig={"sensors": [{"name": "a", "ip": "10.0.0.1"}]}, rig_path=tmp_path / "rig.json")
    hub.start()
    yield TestClient(create_app(hub, rec_dir, None), raise_server_exceptions=False), hub, rec_dir
    hub.stop()


def test_each_live_sensor_has_its_own_feed(two):
    client, hub, _ = two
    wait_until(lambda: hub.feed("a").frame_id >= 2 and hub.feed("b").frame_id >= 2)
    for name in ("a", "b"):
        meta = json.loads(client.get(f"/api/frame?sensor={name}").headers["x-meta"])
        assert meta["sensor"] == name and meta["source"] == "live"
    assert json.loads(client.get("/api/frame").headers["x-meta"])["sensor"] == "a"       # default: the first
    assert client.get("/api/frame?sensor=zz").status_code == 404
    info = client.get("/api/sensors").json()
    assert [(s["name"], s["ip"], s["live"]) for s in info] == [("a", "10.0.0.1", True), ("b", "10.0.0.2", True)]
    assert client.get("/api/state").json()["sensors"] == ["a", "b"]


def test_live_errors_name_the_sensor(tmp_path):
    def down():
        raise TimeoutError()
    hub = Hub(tmp_path, [LiveSensor("a", endless()), LiveSensor("b", down)], retry_s=0.05)
    hub.start()
    try:
        wait_until(lambda: hub.live_error() == "sensor b: timed out")
    finally:
        hub.stop()


def test_record_and_replay_a_session(two):
    client, hub, rec_dir = two
    st = client.post("/api/record", json={"action": "start"}).json()
    assert st["recording"]["active"] and st["recording"]["sensors"] == ["a", "b"]
    wait_until(lambda: all(r.scans >= 30 for r in hub.recorder.recorders.values()))
    name = client.post("/api/record", json={"action": "stop"}).json() and hub.recorder.path.name
    lst = client.get("/api/recordings").json()
    assert lst[0]["name"] == name and lst[0]["sensors"] == ["a", "b"] and lst[0]["scans"] >= 60

    z = zipfile.ZipFile(io.BytesIO(client.get(f"/api/recordings/{name}").content))
    assert sorted(z.namelist()) == [f"{name}/a.tpc.zstd", f"{name}/b.tpc.zstd", f"{name}/{SESSION_FILE}"]

    client.post("/api/replay", json={"file": name})
    wait_until(lambda: hub.feed("a").meta.get("source") == "replay" and hub.feed("b").meta.get("source") == "replay")
    assert client.get("/api/sensors").json() == [{"name": "a", "live": False}, {"name": "b", "live": False}]

    # calibrating a replay stores the poses in the session, not in rig.json
    r = client.put("/api/rig", json={"sensors": [{"name": "b", "pose": POSE}]})
    assert r.status_code == 200 and r.json()["sensors"][1]["pose"] == POSE
    assert json.loads((rec_dir / name / SESSION_FILE).read_text())["rig"]["sensors"][-1]["pose"] == POSE
    assert not (rec_dir.parent / "rig.json").exists()
    assert client.put("/api/rig", json={"sensors": [{"name": "zz", "pose": POSE}]}).status_code == 400

    client.delete(f"/api/recordings/{name}")
    assert not (rec_dir / name).exists() and client.get("/api/state").json()["source"] == "live"


def test_live_rig_is_saved(two, tmp_path):
    client, hub, _ = two
    assert client.get("/api/rig").json() == {"sensors": [{"name": "a", "ip": "10.0.0.1"}, {"name": "b"}]}
    client.put("/api/rig", json={"sensors": [{"name": "a", "pose": POSE, "time_offset_s": 0.002}]})
    saved = json.loads((tmp_path / "rig.json").read_text())
    assert saved["sensors"] == [{"name": "a", "ip": "10.0.0.1", "pose": POSE, "time_offset_s": 0.002}]
    assert client.put("/api/rig", json={"sensors": [{"name": "a", "pose": {"x": "far"}}]}).status_code == 400
