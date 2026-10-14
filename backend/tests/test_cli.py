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
