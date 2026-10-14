"""Scan data model: one Scan = all layers of one mirror revolution."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Iterator

DIST_INVALID_MAX_RAW = 15  # raw distances <= 15 are invalid (per SICK web UI)


@dataclass
class Echo:
    distance_mm: list[float]          # 0.0 = invalid
    rssi: list[int]


@dataclass
class Layer:
    elevation_deg: float              # nominal layer angle
    start_azimuth_deg: float          # azimuth of first beam, 0 = straight ahead, +left
    step_deg: float
    echoes: list[Echo]
    beam_elevation_deg: list[float] | None = None  # per-beam elevation (CoLa VANGL channel)
    timestamp_us: int | None = None   # sensor time since power-on (CoLa only)

    @property
    def beam_count(self) -> int:
        return len(self.echoes[0].distance_mm) if self.echoes else 0

    def azimuths_deg(self) -> list[float]:
        return [self.start_azimuth_deg + i * self.step_deg for i in range(self.beam_count)]

    def elevations_deg(self) -> list[float]:
        return self.beam_elevation_deg or [self.elevation_deg] * self.beam_count


@dataclass
class Scan:
    layers: list[Layer] = field(default_factory=list)
    scan_frequency_hz: float | None = None
    raw_telegrams: list[str] = field(default_factory=list)  # CoLa A source only, one per layer

    def points(self, echo: int | None = None, upside_down: bool = False) -> Iterator[tuple]:
        """Yield (x, y, z, distance_m, rssi, layer_idx, echo_idx) for every valid return.

        Frame: x forward, y left, z up, metres, for a sensor standing upright (negative
        elevation = downwards). upside_down=True (sensor on its head, device parameter
        UpsideDown set) flips only z: the device already reports azimuth in world left/right.
        """
        s = -1.0 if upside_down else 1.0
        for li, layer in enumerate(self.layers):
            azs, els = layer.azimuths_deg(), layer.elevations_deg()
            for ei, e in enumerate(layer.echoes):
                if echo is not None and ei != echo:
                    continue
                for bi, d_mm in enumerate(e.distance_mm):
                    if d_mm <= 0:
                        continue
                    d = d_mm / 1000.0
                    el, az = math.radians(els[bi]), math.radians(azs[bi])
                    yield (math.cos(az) * math.cos(el) * d, math.sin(az) * math.cos(el) * d,
                           s * math.sin(el) * d, d, e.rssi[bi], li, ei)
