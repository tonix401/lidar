import pytest

from mrs6000 import cli
from tests.conftest import free_port


@pytest.fixture
def rest_at(monkeypatch):
    def use(url):
        orig = cli.RestClient
        monkeypatch.setattr(cli, "RestClient", lambda ip: orig(base_url=url, timeout=1))
    return use


def test_status_and_info(rest_at, fake_rest, capsys):
    rest_at(fake_rest.url)
    cli.main(["status"])
    out = capsys.readouterr().out
    assert "normal operation" in out and "12.25 V" in out and "10.00 Hz" in out
    cli.main(["info"])
    out = capsys.readouterr().out
    assert "192.168.178.200" in out and "00:06:77:01:02:03" in out


def test_get_and_dump(rest_at, fake_rest, capsys):
    rest_at(fake_rest.url)
    cli.main(["get", "UpsideDown", "Nope"])
    cap = capsys.readouterr()
    assert "UpsideDown = true" in cap.out and "Nope" in cap.err


def test_connection_error_is_one_short_line(rest_at):
    rest_at(f"http://127.0.0.1:{free_port()}/api/")
    with pytest.raises(SystemExit) as e:
        cli.main(["status"])
    assert e.value.code == "error: connection refused"


def test_echo_filter_with_fake_sensor(fake_cola, tmp_path, monkeypatch, capsys):
    env = tmp_path / ".env"
    env.write_text("USERNAME=Service\nPASSWORD=secret\n")
    orig = cli.ColaClient
    monkeypatch.setattr(cli, "ColaClient", lambda ip: orig("127.0.0.1", fake_cola.port))
    cli.main(["echo-filter", "first", "--env", str(env)])
    out = capsys.readouterr().out
    assert "currently 2 (last)" in out and "now 0 (first)" in out


def test_fmt_value():
    assert cli.fmt_value([192, 168, 0, 1]) == "192.168.0.1"
    assert cli.fmt_value(1.234) == "1.23"
    assert cli.fmt_value({"a": 1}) == '{"a": 1}'


def test_compress_and_decompress(tmp_path, capsys):
    from mrs6000.recording import Recording
    from tests.test_stream import write_recording
    p = write_recording(tmp_path / "a.tpc", n=30)
    raw = p.read_bytes()
    cli.main(["compress", str(p)])
    assert capsys.readouterr().out.startswith(f"{p}.zstd: ")
    with Recording(f"{p}.zstd") as r:
        assert r.compressed and r.count == 30
    p.unlink()
    cli.main(["decompress", f"{p}.zstd"])
    assert p.read_bytes() == raw
    cli.main(["decompress", f"{p}.zstd", "-o", str(tmp_path / "b.tpc")])
    assert (tmp_path / "b.tpc").read_bytes() == raw
    with pytest.raises(SystemExit) as e:
        cli.main(["compress", f"{p}.zstd"])
    assert e.value.code == f"error: ValueError: {p}.zstd: expected a .tpc file"
    with pytest.raises(SystemExit) as e:
        cli.main(["decompress", f"{p}.zstd", f"{p}.zstd", "-o", str(tmp_path / "c.tpc")])
    assert e.value.code == "error: ValueError: --output needs a single input file"
