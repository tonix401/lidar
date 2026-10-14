import pytest

from mrs6000 import ColaClient, cola_password_hash, cola_scans, parse_lmdscandata
from tests.conftest import FakeCola, build_telegram


def test_password_hash_matches_sick_reference():
    # sick_scan uses "sMN SetAccessMode 03 F4724744" for the AuthorizedClient password "client"
    assert cola_password_hash("client") == 0xF4724744


def test_parse_synthetic_telegram():
    t = build_telegram(-2.5, [0, 15, 16, 80], rssi=[1, 2, 3, 4], start_deg=30.0, step_deg=0.1301,
                       vangl_raw=[6000, 6000, 4000, 0])
    layer, meta = parse_lmdscandata(t.split()[2:])
    assert meta["layer_angle_deg"] == -2.5
    assert meta["scan_frequency_hz"] == 10.0
    assert layer.start_azimuth_deg == pytest.approx(-60.0)
    assert layer.step_deg == pytest.approx(0.1301)
    assert layer.echoes[0].distance_mm == [0.0, 0.0, 200.0, 1000.0]    # raw <= 15 is invalid
    assert layer.echoes[0].rssi == [1, 2, 3, 4]
    assert layer.beam_elevation_deg == pytest.approx([0.0, 0.0, 0.5, 1.5], abs=1e-6)  # raw * -0.00025 + 1.5


def test_parse_without_rssi_or_vangl():
    layer, _ = parse_lmdscandata(build_telegram(1.0, [100, 200]).split()[2:])
    assert layer.echoes[0].rssi == [0, 0] and layer.beam_elevation_deg is None


def test_parse_rejects_telegram_without_distance():
    tokens = build_telegram(1.0, [100]).split()[2:]
    i = tokens.index("DIST1")
    tokens[i] = "OTHER"
    with pytest.raises(ValueError):
        parse_lmdscandata(tokens)


def test_parse_real_scan(real_scan):
    assert len(real_scan.layers) == 24
    first, last = real_scan.layers[0], real_scan.layers[-1]
    assert first.beam_count == 923
    assert first.start_azimuth_deg == pytest.approx(-60.0)
    assert first.step_deg == pytest.approx(0.1301)
    assert first.elevation_deg < last.elevation_deg                      # bottom to top
    assert len(first.beam_elevation_deg) == 923
    valid = [d for d in first.echoes[0].distance_mm if d > 0]
    assert len(valid) > 800 and all(d % 12.5 == 0 for d in valid)
    assert max(first.echoes[0].rssi) > 0                                  # (was 0 before the parser fix)


def test_client_groups_layers_into_scans_and_drops_partial_first(telegrams):
    sensor = FakeCola(telegrams[5:] + telegrams)    # starts mid-revolution, then whole scans
    try:
        scans = cola_scans("127.0.0.1", port=sensor.port)
        got = [next(scans) for _ in range(2)]
        assert all(len(s.layers) == 24 for s in got)
        assert len(got[0].raw_telegrams) == 24
        scans.close()                                # unsubscribes
        assert "sEN LMDscandata 1" in sensor.commands
    finally:
        sensor.close()


def test_login_read_write_save(fake_cola):
    with ColaClient("127.0.0.1", fake_cola.port) as c:
        assert c.read("FREchoFilter") == ["2"]
        with pytest.raises(RuntimeError):
            c.write("FREchoFilter", 1)               # not logged in
        with pytest.raises(PermissionError):
            c.login("Service", "wrong")
        c.login("Service", "secret")
        c.write("FREchoFilter", 1)
        c.save_permanent()
        c.run()
        assert c.read("FREchoFilter") == ["1"]
        with pytest.raises(RuntimeError):
            c.read("Unknown")


def test_closed_connection_raises(telegrams):
    sensor = FakeCola(telegrams, max_scans=1)
    try:
        with pytest.raises(ConnectionError):
            for _ in cola_scans("127.0.0.1", port=sensor.port):
                pass
    finally:
        sensor.close()
