"""The playback state machine on its own: no threads, no timing."""
import pytest

from mrs6000.recording import Recording
from mrs6000.server.player import Player
from tests.test_stream import write_recording


@pytest.fixture
def player(tmp_path):
    p = Player()
    p.load(Recording(write_recording(tmp_path / "a.tpc", n=4, dt=0.1)))
    yield p
    p.unload()


def show(p: Player):
    """What the Hub does per frame: take the next one and mark it shown."""
    k, delay = p.next_frame()
    p.shown = k
    return k, delay


def test_plays_at_the_recorded_pace_and_speed(player):
    assert player.due
    assert show(player) == (0, pytest.approx(0.1))
    player.control("speed", 3.5)                          # nearest of SPEEDS
    assert player.speed == 4.0
    assert show(player) == (1, pytest.approx(0.025))


def test_loops_or_stops_at_the_end(player):
    for k in range(4):
        assert show(player)[0] == k
    assert player.index == 0 and player.playing           # loop: wraps, short pause before frame 0
    player.control("loop", False)
    player.index = 3
    assert show(player) == (3, 0.0)
    assert not player.playing and not player.due
    player.control("play")                                # at the end without loop: starts over
    assert player.index == 0 and player.playing


def test_pause_step_seek(player):
    show(player)
    player.control("toggle")
    assert not player.playing and not player.due
    player.control("step", 2)                             # from the shown frame
    assert player.index == 2 and player.due
    assert show(player) == (2, 0.0) and not player.due    # paused: shown once
    player.control("step", -10)
    assert player.index == 0
    player.control("seek", 99)
    assert player.index == 3


def test_state_and_errors(tmp_path, player):
    show(player)
    st = player.state()
    assert st["file"] == "a.tpc" and st["count"] == 4 and st["index"] == 0 and st["duration"] == pytest.approx(0.3)
    assert st["upside_down"] is True
    for action, value in [("seek", None), ("speed", None), ("jump", 1)]:
        with pytest.raises(ValueError):
            player.control(action, value)
    player.unload()
    assert player.state() == {} and not player.due
    with pytest.raises(ValueError, match="not replaying"):
        player.control("play")
