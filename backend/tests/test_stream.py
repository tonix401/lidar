import time
from array import array

import pytest

from mrs6000.server import stream
from mrs6000.server.frames import encode, meta_for_scan
from compression import zstd

from mrs6000.server.stream import (Recorder, Recording, convert, list_recordings, recording_path, stream_chunk,
                                   stream_frame, stream_header, zstd_entry)
from tests.conftest import make_scan


def wait_until(cond, timeout=5.0):
    end = time.time() + timeout
    while not cond():
        if time.time() > end:
            raise AssertionError("condition not reached")
        time.sleep(0.01)


def write_recording(path, n=5, layers=3, beams=5, dt=0.1, t0=1000.0):
    with open(path, "wb") as f:
        for k in range(n):
            scan = make_scan(layers, beams, dist_mm=lambda l, b, k=k: 1000.0 + 12.5 * (k + l + b))
            if k == 0:
                f.write(stream_header(scan, upside_down=True))
            f.write(stream_frame(scan, t0 + k * dt))
    return path


def test_roundtrip_and_random_access(tmp_path):
    p = write_recording(tmp_path / "a.tpc", n=5)
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
    p = write_recording(tmp_path / "a.tpc", n=2)
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
    p = write_recording(tmp_path / "a.tpc", n=3)
    with open(p, "ab") as f:
        f.write(b"\0" * 10)
    with Recording(p) as r:
        assert r.count == 3


def test_bad_files_are_rejected(tmp_path):
    (tmp_path / "bad.tpc").write_text("not json\n")
    with pytest.raises(ValueError, match="not a .tpc recording"):
        Recording(tmp_path / "bad.tpc")
    write_recording(tmp_path / "good.tpc")
    names = {r["name"]: r for r in list_recordings(tmp_path)}
    assert "error" in names["bad.tpc"] and names["good.tpc"]["scans"] == 5
    assert list_recordings(tmp_path / "missing") == []


def test_recording_path_validation(tmp_path):
    write_recording(tmp_path / "ok.tpc")
    assert recording_path(tmp_path, "ok.tpc").name == "ok.tpc"
    write_recording(tmp_path / "ok.tpc.zstd")
    assert recording_path(tmp_path, "ok.tpc.zstd").name == "ok.tpc.zstd"
    for bad in ["../x.tpc", "a/b.tpc", "x.txt", "x.mrsstream", "x.tpc.zst", ""]:
        with pytest.raises(ValueError):
            recording_path(tmp_path, bad)
    with pytest.raises(FileNotFoundError):
        recording_path(tmp_path, "nope.tpc")


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


def test_recorder_stops_on_disk_errors(tmp_path, monkeypatch):
    def full(frames, level):
        raise OSError(28, "No space left on device")
    monkeypatch.setattr(stream, "stream_chunk", full)
    rec = Recorder(tmp_path, chunk_frames=1)
    rec.start()
    rec.write(make_scan(), 1.0)                       # must not raise (the writer thread fails)
    wait_until(lambda: not rec.state()["active"])
    assert rec.state()["error"] == "recording stopped: no space left on device"
    rec.write(make_scan(), 1.1)                       # closes the failed recording
    assert rec.f is None and not rec.active


def test_recorder_stops_when_the_scan_layout_changes(tmp_path):
    rec = Recorder(tmp_path)
    path = rec.start()
    rec.write(make_scan(beams=5), 1.0)
    rec.write(make_scan(beams=6), 1.1)
    assert rec.state() == {"active": False, "error": "recording stopped: ValueError: scan layout changed"}
    with Recording(path) as r:
        assert r.count == 1


def test_recorder_writes_a_zstd_stream_of_the_tpc(tmp_path):
    rec = Recorder(tmp_path, chunk_frames=4)
    path = rec.start()
    assert path.name.endswith(".tpc.zstd")
    scans = [make_scan(dist_mm=lambda l, b, k=k: 1000.0 + 12.5 * (k * l + b)) for k in range(10)]
    for k, scan in enumerate(scans):
        rec.write(scan, 100.0 + k / 10)
    def readable_scans():
        try:
            with Recording(path) as r:
                return r.count
        except ValueError:                            # header not written yet
            return 0
    wait_until(lambda: readable_scans() == 8)         # two full chunks, readable while recording
    rec.stop()                                        # writes the partial third chunk
    with Recording(path) as r:
        assert r.compressed and r.count == 10 and len(r.chunks) == 3
        for k in (9, 0, 5, 4):                        # random access across chunks
            ts, scan = r.scan(k)
            assert ts == pytest.approx(100.0 + k / 10)
            assert [e.distance_mm for l in scan.layers for e in l.echoes] == \
                   [e.distance_mm for l in scans[k].layers for e in l.echoes]
    tpc = stream_header(scans[0]) + b"".join(stream_frame(s, 100.0 + k / 10) for k, s in enumerate(scans))
    assert zstd.decompress(path.read_bytes()) == tpc  # what `zstd -d` gives


def test_compressed_recording_grows_and_ignores_incomplete_chunks(tmp_path):
    with Recording(write_recording(tmp_path / "a.tpc", n=7)) as raw:
        frames, header = raw.frames(0, 7), raw.header
    p = tmp_path / "a.tpc.zstd"
    p.write_bytes(zstd_entry(header) + stream_chunk(frames[:3]))
    second = stream_chunk(frames[3:])
    with Recording(p) as r:
        assert r.count == 3
        with open(p, "ab") as f:
            f.write(second[:-1])                      # being written
        assert r.count == 3
        with open(p, "ab") as f:
            f.write(second[-1:])
        assert r.count == 7 and r.raw(6)[0] == frames[6][0]
        with open(p, "ab") as f:
            f.write(b"JUNK" + b"\0" * 20)
        with pytest.raises(ValueError, match="corrupt"):
            r.count


def test_convert_round_trip(tmp_path, real_scan):
    p = tmp_path / "a.tpc"
    with open(p, "wb") as f:
        f.write(stream_header(real_scan, upside_down=False))
        for k in range(60):
            f.write(stream_frame(real_scan, 1000.0 + k / 10))
    original = p.read_bytes()
    z = tmp_path / "a.tpc.zstd"
    assert convert(p, z) == z.stat().st_size < len(original) / 5
    assert zstd.decompress(z.read_bytes()) == original
    with Recording(z) as r:
        assert r.compressed and r.count == 60 and r.hdr["upside_down"] is False
    convert(z, tmp_path / "b.tpc", compress=False)
    assert (tmp_path / "b.tpc").read_bytes() == original
    assert sorted(x.name for x in tmp_path.iterdir()) == ["a.tpc", "a.tpc.zstd", "b.tpc"]   # no temp files


def test_plain_zstd_without_index_is_explained(tmp_path):
    p = write_recording(tmp_path / "a.tpc")
    (tmp_path / "b.tpc.zstd").write_bytes(zstd.compress(p.read_bytes()))
    with pytest.raises(ValueError, match="without the scan index"):
        Recording(tmp_path / "b.tpc.zstd")
