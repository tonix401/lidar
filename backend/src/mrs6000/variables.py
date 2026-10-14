"""Device constants: default address and the variables known to be readable via REST."""

DEFAULT_IP = "192.168.178.200"

# Variables found in the device description (SOPASair "current_msdd" -> descriptor.json),
# all verified readable via GET /api/<name>.
VARIABLES: dict[str, list[str]] = {
    "identity": [
        "DeviceIdent", "DeviceType", "SerialNumber", "OrderNumber", "FirmwareVersion",
        "Manufacturer", "LocationName",
    ],
    "network": [
        "EtherIPAddress", "EtherIPMask", "EtherIPGateAddress", "EtherMACAddress",
        "InternalEtherIPAddress", "InternalEtherIPMask", "InternalEtherIPGateAddress",
        "KMEtherIPAddress", "KMEtherIPMask", "KMEtherIPGateAddress", "KM_EthConnectionSpeed",
    ],
    "status": [
        "CommonDeviceStatus", "OpHours", "DailyOpHours", "PowerOnCnt",
        "KM_SysBoard_Temp", "KM_APDBoard_Temp", "KM_PowerSource_Voltage",
        "KM_MotorRotationPeriod", "KM_MotorRotationTime",
        "KMWindowWarning", "KMWindowError", "LinkToMeasurementModule",
        "LED_1_RED", "LED_2_ORANGE", "LED_3_YELLOW",
    ],
    "measurement_module": ["KM_LidarModel", "KM_ROM_Revision", "KM_FPGA_REV", "KM_FW_REV"],
    "io": [f"DI{i}" for i in range(1, 9)] + [f"DO{i}" for i in range(1, 9)] + ["PortConfiguration"],
    "scan_config": [
        "AutoStartMeasure", "ScanDataConfig", "DataOutputRange", "EnableLongRangeMode",
        "UpsideDown", "DistanceRange", "IntensityRange", "SickApplicationActive",
    ],
    "angle_data": [
        "AngleDataConfig", "AngleData", "AngleDataStatistic", "AngleDataStatisticExtended",
        "EnergyDataStatistic",
    ],
    "production": ["ProdIOTestState", "ProdIOTestLog"],
}

# Methods referenced by the web UI (need POST + auth): mStartMeasure, mStopMeasure, WriteEeprom,
# EthernetUpdate, ResetAppCounter, UpdateKmDiagData, changePassword.

DEVICE_STATUS = {0: "unknown", 1: "startup", 2: "service mode", 3: "normal operation",
                 4: "suspended operation", 5: "service recommended", 6: "service required",
                 7: "recoverable error", 8: "fatal error"}
