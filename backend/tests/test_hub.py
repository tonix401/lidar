import time

import pytest

from mrs6000.server.feed import Feed
from mrs6000.server.hub import Hub
from tests.conftest import make_scan
from tests.test_stream import write_recording


def wait_until(cond, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.01)
    raise AssertionError("condition not reached")


@pytest.fixture
def hub(tmp_path):
    hubs = []

    def make(source=None, **kw):
        h = Hub(Feed(), tmp_path / "recs", source, retry_s=0.05, **kw)
        h.start()
        hubs.append(h)
        return h
    yield make
    for h in hubs:
        h.stop()


def endless(scan_factory=make_scan, dt=0.01):
    def gen():
        while True:
            yield scan_factory()
            time.sleep(dt)
    return gen


def test_live_frames_are_published_and_recorded(hub):
    h = hub(endless())
    wait_until(lambda: h.feed.frame_id >= 3)
    fid, data, meta = h.feed.wait(0)
    assert meta["source"] == "live" and meta["layers"] == 3 and meta["epoch"] == 1
    h.recorder.start()
    wait_until(lambda: h.recorder.state().get("scans", 0) >= 3)
    h.recorder.stop()
    assert len(list((h.recorder.rec_dir).glob("*.tpc.zstd"))) == 1


def test_live_source_failures_are_retried_and_reported(hub):
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise ConnectionRefusedError(111, "refused")
        return endless()()
    h = hub(flaky)
    wait_until(lambda: h.feed.frame_id >= 1)
    assert len(calls) == 3 and h.live_error == "" and h.cola.error == ""


def test_live_error_is_kept_while_failing(hub):
    def down():
        raise TimeoutError()
    h = hub(down)
    wait_until(lambda: h.live_error == "sensor: timed out")
    assert h.state()["live_error"] == "sensor: timed out"


def test_replay_play_pause_step_seek_speed_and_epochs(hub, tmp_path):
    p = write_recording(tmp_path / "r.tpc", n=20, dt=0.05)
    h = hub()
    h.play_file(p)
    wait_until(lambda: h.feed.meta.get("replay", {}).get("index", 0) >= 3)
    m = h.feed.meta
    assert m["source"] == "replay" and m["replay"]["count"] == 20 and m["replay"]["upside_down"] is True
    first_epoch = m["epoch"]

    h.control("pause")
    time.sleep(0.15)
    idx = h.feed.meta["replay"]["index"]
    time.sleep(0.15)
    assert h.feed.meta["replay"]["index"] == idx and not h.state()["replay"]["playing"]

    h.control("step", 1)                              # continuous: same epoch
    wait_until(lambda: h.feed.meta["replay"]["index"] == idx + 1)
    assert h.feed.meta["epoch"] == first_epoch
    h.control("step", -1)                             # jump back: new epoch
    wait_until(lambda: h.feed.meta["replay"]["index"] == idx)
    assert h.feed.meta["epoch"] == first_epoch + 1
    h.control("seek", 15)
    wait_until(lambda: h.feed.meta["replay"]["index"] == 15)
    h.control("speed", 3.1)
    assert h.speed == 4.0
    h.control("toggle")
    assert h.playing
    with pytest.raises(ValueError):
        h.control("fly")


def test_replay_loops_or_stops_at_the_end(hub, tmp_path):
    p = write_recording(tmp_path / "r.tpc", n=4, dt=0.01)
    h = hub()
    h.play_file(p)
    h.control("loop", False)
    wait_until(lambda: not h.playing)
    assert h.feed.meta["replay"]["index"] == 3
    epoch = h.epoch
    h.control("play")                                 # restarts from the beginning
    wait_until(lambda: h.epoch > epoch)


def test_deleted_recording_falls_back_to_live(hub, tmp_path):
    p = write_recording(tmp_path / "r.tpc", n=50, dt=0.02)
    h = hub()
    h.play_file(p)
    wait_until(lambda: h.feed.frame_id >= 2)
    p.unlink()
    wait_until(lambda: h.source == "live")
    assert "r.tpc" in h.replay_error and "back to live" in h.replay_error


def test_control_without_replay_is_an_error(hub):
    with pytest.raises(ValueError, match="not replaying"):
        hub().control("play")
