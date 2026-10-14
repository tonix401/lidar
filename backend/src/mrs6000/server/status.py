"""Polls the sensor's REST status variables for the device panel."""
from __future__ import annotations

import threading

from ..rest import RestClient
from .feed import Feed
from .health import Health

STATUS_VARS = ["CommonDeviceStatus", "KM_SysBoard_Temp", "KM_APDBoard_Temp", "KM_PowerSource_Voltage",
               "KM_MotorRotationPeriod", "KMWindowWarning", "KMWindowError", "DeviceType",
               "SerialNumber", "FirmwareVersion", "UpsideDown"]


def status_loop(rest: RestClient, feed: Feed, stop: threading.Event, period_s: float = 2.0, retry_s: float = 3.0):
    health = Health("sensor (REST status)", retry_s)
    while not stop.is_set():
        try:
            feed.status = rest.get_many(STATUS_VARS)
            health.ok()
        except Exception as e:
            feed.status = {"error": health.fail(e)}
        stop.wait(period_s if not health.error else retry_s)
