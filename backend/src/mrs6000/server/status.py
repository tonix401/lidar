"""Polls a sensor's REST status variables for the device panel."""
from __future__ import annotations

import threading

from ..rest import RestClient
from .health import Health
from .hub import LiveSensor

STATUS_VARS = ["CommonDeviceStatus", "KM_SysBoard_Temp", "KM_APDBoard_Temp", "KM_PowerSource_Voltage",
               "KM_MotorRotationPeriod", "KMWindowWarning", "KMWindowError", "DeviceType",
               "SerialNumber", "FirmwareVersion", "UpsideDown"]


def status_loop(rest: RestClient, sensor: LiveSensor, stop: threading.Event, period_s: float = 2.0,
                retry_s: float = 3.0):
    health = Health(f"{sensor.label} (REST status)", retry_s)
    while not stop.is_set():
        try:
            sensor.status = rest.get_many(STATUS_VARS)
            health.ok()
        except Exception as e:
            sensor.status = {"error": health.fail(e)}
        stop.wait(period_s if not health.error else retry_s)
