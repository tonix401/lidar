"""A sensor's own clock mapped onto the host clock, so that scans of several sensors share one timeline.

Every CoLa telegram carries the device time (µs since power-on, uint32: wraps every ~71.6 min). For each
telegram, host receive time − device time = clock offset + network delay, and the delay is never
negative. So the lower envelope of those differences is the offset, and its slope the drift (crystals
differ by tens of ppm, ms per minute): per 1 s bucket the smallest difference, then the lower convex hull
of those minima, and of its edges the one above the minima's mean time (the line under every point with
the least total gap, as in Moon et al. 1999, "Estimation and removal of clock skew from network delay
measurements"). Late telegrams (jitter, a stalled connection) only add points above the hull, so they
never move it. Scan time = device time + offset (docs/multisensor.md)."""
from __future__ import annotations

from collections import deque

from .model import Scan

WRAP_US = 1 << 32


class DeviceClock:
    def __init__(self, window_s: float = 300.0, bucket_s: float = 1.0, stall_s: float = 30.0):
        self.window_s, self.bucket_s, self.stall_s = window_s, bucket_s, stall_s
        self.buckets: deque[list[float]] = deque()      # [bucket start, device s and value of its smallest host − device]
        self.last_raw: int | None = None
        self.wraps = 0
        self.a = self.b = 0.0                            # offset(d) = a + b · (d − d_ref)
        self.d_ref = 0.0
        self.samples = 0
        self.resets = 0

    def unwrap(self, raw_us: int) -> float:
        """device time in seconds, continuous across the uint32 wrap"""
        if self.last_raw is not None and raw_us < self.last_raw - WRAP_US // 2:
            self.wraps += 1
        self.last_raw = raw_us
        return (raw_us + self.wraps * WRAP_US) / 1e6

    def add(self, raw_us: int, host_s: float):
        """one (device time, host receive time) pair"""
        back = self.last_raw is not None and self.last_raw - WRAP_US // 2 <= raw_us < self.last_raw - 1_000_000
        d = self.unwrap(raw_us)
        diff = host_s - d
        dev = diff - self.offset(d) if self.samples else 0.0
        # start over after a power cycle (device time jumps back), or when the pair can't be a delay: far
        # below the envelope (host clock stepped back) or far above it (no stall lasts that long)
        if back or dev < -0.5 or dev > self.stall_s:
            resets = self.resets
            self.__init__(self.window_s, self.bucket_s, self.stall_s)
            self.resets = resets + 1
            d = self.unwrap(raw_us)
            diff = host_s - d
        self.samples += 1
        last = self.buckets[-1] if self.buckets else None
        if last and d - last[0] < self.bucket_s:
            if diff >= last[2]:
                return                                   # above the envelope: changes nothing
            last[1], last[2] = d, diff
        else:
            self.buckets.append([d, d, diff])
        while d - self.buckets[0][0] > self.window_s:
            self.buckets.popleft()
        self._fit()

    def _fit(self):
        pts = [(b[1], b[2]) for b in self.buckets]
        hull: list[tuple[float, float]] = []             # lower hull (monotone chain; pts are in time order)
        for p in pts:
            while len(hull) >= 2 and ((hull[-1][0] - hull[-2][0]) * (p[1] - hull[-2][1])
                                      - (hull[-1][1] - hull[-2][1]) * (p[0] - hull[-2][0])) <= 0:
                hull.pop()
            hull.append(p)
        self.d_ref = pts[-1][0]
        if len(hull) == 1:
            self.a, self.b = hull[0][1], 0.0
            return
        mx = sum(p[0] for p in pts) / len(pts)
        i = next((i for i in range(len(hull) - 1) if hull[i + 1][0] >= mx), len(hull) - 2)
        (x0, y0), (x1, y1) = hull[i], hull[i + 1]
        self.b = (y1 - y0) / (x1 - x0)
        self.a = y0 + self.b * (self.d_ref - x0)

    def offset(self, d: float) -> float:
        return self.a + self.b * (d - self.d_ref)

    def to_host(self, raw_us: int) -> float:
        """host time of a device time (call after add() for the same or an earlier telegram)"""
        w = self.wraps
        if self.last_raw is not None and raw_us < self.last_raw - WRAP_US // 2:
            w += 1                                       # already past the next wrap
        elif self.last_raw is not None and raw_us > self.last_raw + WRAP_US // 2:
            w -= 1                                       # still before the last wrap
        d = (raw_us + w * WRAP_US) / 1e6
        return d + self.offset(d)

    def state(self) -> dict:
        return {"offset_s": round(self.a, 6), "drift_ppm": round(self.b * 1e6, 2), "samples": self.samples,
                "resets": self.resets}


def scan_time(clock: DeviceClock, scan: Scan, fallback: float) -> float:
    """Feed the scan's telegrams to `clock` and return the host time of its first layer; `fallback` (the
    host receive time) for scans without device times (other sources, tests)."""
    timed = [l for l in scan.layers if l.timestamp_us is not None and l.received_s is not None]
    if not timed:
        return fallback
    for l in timed:
        clock.add(l.timestamp_us, l.received_s)
    return clock.to_host(scan.layers[0].timestamp_us) if scan.layers[0].timestamp_us is not None else fallback
