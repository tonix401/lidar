import socket
import subprocess
import sys
import time
import urllib.request

from tests.conftest import free_port
from tests.test_stream import write_recording


def test_server_starts_offline_with_a_replay_and_serves_the_api(tmp_path):
    rec = write_recording(tmp_path / "r.mrsstream", n=10)
    port = free_port()
    p = subprocess.Popen([sys.executable, "-m", "mrs6000.server", "--offline", "--port", str(port),
                          "--recordings", str(tmp_path), "--replay", str(rec)],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for _ in range(100):
            try:
                body = urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=1).read()
                break
            except OSError:
                time.sleep(0.1)
        assert b'"source":"replay"' in body
    finally:
        p.terminate()
        out = p.communicate(timeout=5)[0]
    assert "replaying r.mrsstream" in out and "Traceback" not in out


def test_port_in_use_exits_with_a_short_message(tmp_path):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        port = s.getsockname()[1]
        r = subprocess.run([sys.executable, "-m", "mrs6000.server", "--offline", "--port", str(port),
                            "--recordings", str(tmp_path)], capture_output=True, text=True, timeout=20)
    assert r.returncode == 1
    assert "Traceback" not in r.stdout + r.stderr
    assert "address already in use" in (r.stdout + r.stderr).lower()
