import threading
import time

from mrs6000.server.health import Health, supervised


def test_logs_once_per_problem_and_on_recovery():
    lines = []
    h = Health("sensor", retry_s=3, logger=lines.append)
    for _ in range(5):
        assert h.fail(ConnectionRefusedError()) == "connection refused"
    h.fail("timed out")
    h.ok()
    h.ok()
    assert lines == ["sensor: connection refused (retrying every 3 s)", "sensor: timed out (retrying every 3 s)",
                     "sensor: ok again"]


def test_reminds_while_a_problem_persists(monkeypatch):
    lines = []
    h = Health("x", logger=lines.append)
    h.REMIND_S = 0
    h.fail("down")
    h.fail("down")
    assert lines[0] == "x: down" and lines[1].startswith("x: still failing after")


def test_supervised_restarts_a_crashing_loop(capsys):
    stop, calls = threading.Event(), []

    def loop():
        calls.append(1)
        if len(calls) >= 3:
            stop.set()
            return
        raise RuntimeError("boom")

    t = threading.Thread(target=supervised, args=("worker", loop, stop, 0.01))
    t.start()
    t.join(2)
    assert not t.is_alive() and len(calls) == 3
    assert "worker: crashed (boom), restarting" in capsys.readouterr().out
