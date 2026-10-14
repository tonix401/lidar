import math

from tests.conftest import make_scan


def test_layer_angles_and_counts():
    scan = make_scan(layers=2, beams=4)
    layer = scan.layers[0]
    assert layer.beam_count == 4
    assert layer.azimuths_deg() == [-60.0, -59.5, -59.0, -58.5]
    assert layer.elevations_deg()[1] == -5.0 + 0.01


def test_points_geometry_and_upside_down_flips_only_z():
    scan = make_scan(layers=1, beams=1, dist_mm=lambda l, b: 2000.0)
    (x, y, z, d, rssi, li, ei), = scan.points()
    az, el = math.radians(-60), math.radians(-5)
    assert math.isclose(x, math.cos(az) * math.cos(el) * 2, rel_tol=1e-9)
    assert math.isclose(y, math.sin(az) * math.cos(el) * 2, rel_tol=1e-9)
    assert z < 0 and d == 2.0 and (li, ei) == (0, 0)
    (x2, y2, z2, *_), = scan.points(upside_down=True)
    assert (x2, y2, z2) == (x, y, -z)


def test_points_skip_invalid_and_filter_echo():
    scan = make_scan(layers=1, beams=3, dist_mm=lambda l, b: 0.0 if b == 1 else 1000.0)
    assert len(list(scan.points())) == 2
    assert list(scan.points(echo=1)) == []
