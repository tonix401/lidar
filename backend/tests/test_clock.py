import random

import pytest

from mrs6000.clock import WRAP_US, DeviceClock, scan_time
from tests.conftest import make_scan


def telegrams(seconds, boot=1000.0, start_raw=5_000_000, drift_ppm=40.0, t0=2_000_000_000.0, seed=1,
              stall=None):
    """(raw device µs, host receive time, true time): 24 layer telegrams per 0.1 s scan, network delay
    0.5 ms + exponential jitter (mean 3 ms) and occasional 50 ms spikes; `stall` = (start, end) of a
    period where everything arrives late (TCP retransmits) up to its end."""
    r = random.Random(seed)
    out = []
    for k in range(int(seconds * 240)):
        t = t0 + k / 240
        dev = start_raw + (t - t0) * (1 + drift_ppm * 1e-6) * 1e6
        delay = 0.0005 + r.expovariate(1 / 0.003) + (0.05 if r.random() < 0.01 else 0.0)
        h = t + delay
        if stall and stall[0] <= t - t0 < stall[1]:
            h = t0 + stall[1] + delay
        out.append((int(dev) % WRAP_US, h, t))
    return out


def worst_error(clock, tel, skip_s=5.0):
    worst = 0.0
    t0 = tel[0][2]
    for raw, h, t in tel:
        clock.add(raw, h)
        if t - t0 > skip_s:
            worst = max(worst, abs(clock.to_host(raw) - t))
    return worst


def test_maps_device_time_to_host_time_within_a_millisecond():
    tel = telegrams(120)
    c = DeviceClock()
    # the mapped time is the true time plus the smallest network delay (0.5 ms), whatever the jitter
    assert worst_error(c, tel) < 0.0007
    assert c.state()["drift_ppm"] == pytest.approx(-40.0, abs=5)
    assert c.resets == 0


def test_continuous_across_the_uint32_wrap():
    tel = telegrams(30, start_raw=WRAP_US - 10_000_000)          # wraps after 10 s
    assert any(a[0] < b[0] for b, a in zip(tel, tel[1:]))
    c = DeviceClock()
    assert worst_error(c, tel) < 0.0007
    assert c.wraps == 1 and c.resets == 0


def test_starts_over_after_a_power_cycle():
    a = telegrams(30, start_raw=900_000_000)
    b = telegrams(30, start_raw=2_000_000, t0=a[-1][2] + 20, seed=2)   # rebooted: device time back near 0
    c = DeviceClock()
    worst_error(c, a)
    assert worst_error(c, b) < 0.0007 and c.resets == 1


def test_a_network_stall_does_not_move_the_offset():
    c = DeviceClock()
    assert worst_error(c, telegrams(60, stall=(20, 25))) < 0.0007
    assert c.resets == 0


def test_scan_time_uses_the_first_layer_or_falls_back():
    c = DeviceClock()
    scan = make_scan()
    assert scan_time(c, scan, 123.0) == 123.0                      # no device times (other sources)
    for i, layer in enumerate(scan.layers):
        layer.timestamp_us, layer.received_s = 10_000_000 + 4000 * i, 500.0 + 0.004 * i + 0.001
    assert scan_time(c, scan, 0.0) == pytest.approx(500.001, abs=1e-6)
