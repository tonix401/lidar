from array import array

import pytest

from mrs6000.server.frames import encode, meta_for_scan
from mrs6000.server.stream import Recorder, Recording, list_recordings, recording_path, stream_frame, stream_header
from tests.conftest import make_scan


def write_recording(path, n=5, layers=3, beams=5, dt=0.1, t0=1000.0):
    with open(path, "wb") as f:
        for k in range(n):
            scan = make_scan(layers, beams, dist_mm=lambda l, b, k=k: 1000.0 + 12.5 * (k + l + b))
            if k == 0:
                f.write(stream_header(scan, upside_down=True))
            f.write(stream_frame(scan, t0 + k * dt))
    return path


def test_roundtrip_and_random_access(tmp_path):
    p = write_recording(tmp_path / "a.mrsstream", n=5)
    with Recording(p) as r:
        assert (r.count, r.L, r.B) == (5, 3, 5)
        assert r.hdr["upside_down"] is True
        assert r.time(3) == pytest.approx(1000.3)
        ts, scan = r.scan(2)
        assert scan.layers[1].echoes[0].distance_mm[4] == 1000.0 + 12.5 * (2 + 1 + 4)
        assert scan.layers[0].beam_elevation_deg == pytest.approx([-5.0 + 0.01 * b for b in range(5)])
        info = r.info()
        assert info["scans"] == 5 and info["seconds"] == pytest.approx(0.4)
        with pytest.raises(IndexError):
            r.raw(5)


def test_encoded_frame_equals_encoding_the_scan(tmp_path):
    p = write_recording(tmp_path / "a.mrsstream", n=2)
    with Recording(p) as r:
        ts, data, points = r.encoded(1)
        _, scan = r.scan(1)
    assert data == encode(scan)
    assert points == meta_for_scan(scan, 10, ts)["points"] == 15


def test_encode_layout():
    scan = make_scan(2, 3)
    f = array("f"); f.frombytes(encode(scan))
    assert len(f) == 3 * 6
    assert f[0] == pytest.approx(1.0) and f[6 + 4] == 11 and f[12] == pytest.approx(-5.0)


def test_partial_frames_are_not_counted(tmp_path):
    p = write_recording(tmp_path / "a.mrsstream", n=3)
    with open(p, "ab") as f:
        f.write(b"\0" * 10)
    with Recording(p) as r:
        assert r.count == 3


def test_bad_files_are_rejected(tmp_path):
    (tmp_path / "bad.mrsstream").write_text("not json\n")
    with pytest.raises(ValueError, match="not a .mrsstream"):
        Recording(tmp_path / "bad.mrsstream")
    write_recording(tmp_path / "good.mrsstream")
    names = {r["name"]: r for r in list_recordings(tmp_path)}
    assert "error" in names["bad.mrsstream"] and names["good.mrsstream"]["scans"] == 5
    assert list_recordings(tmp_path / "missing") == []


def test_recording_path_validation(tmp_path):
    write_recording(tmp_path / "ok.mrsstream")
    assert recording_path(tmp_path, "ok.mrsstream").name == "ok.mrsstream"
    for bad in ["../x.mrsstream", "a/b.mrsstream", "x.txt", ""]:
        with pytest.raises(ValueError):
            recording_path(tmp_path, bad)
    with pytest.raises(FileNotFoundError):
        recording_path(tmp_path, "nope.mrsstream")


def test_recorder(tmp_path):
    rec = Recorder(tmp_path / "recs")
    assert rec.state() == {"active": False, "error": ""}
    rec.write(make_scan(), 1.0)                       # inactive: ignored
    path = rec.start()
    assert rec.start() == path                        # idempotent
    rec.upside_down = False
    for k in range(4):
        rec.write(make_scan(), 1.0 + k / 10)
    st = rec.state()
    assert st["active"] and st["scans"] == 4 and st["file"] == path.name
    rec.stop()
    with Recording(path) as r:
        assert r.count == 4 and r.hdr["upside_down"] is False


def test_recorder_stops_on_disk_errors(tmp_path):
    rec = Recorder(tmp_path)
    rec.start()

    class Broken:
        def tell(self): return 1
        def write(self, b): raise OSError(28, "No space left on device")
        def close(self): pass
    rec.f = Broken()
    rec.write(make_scan(), 1.0)                       # must not raise
    st = rec.state()
    assert not st["active"] and st["error"] == "recording stopped: no space left on device"
