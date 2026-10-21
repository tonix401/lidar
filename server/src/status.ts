// Polls a sensor's REST status variables for the device panel.
import { Health, type Stop } from "./health";
import type { LiveSensor } from "./hub";
import type { RestClient } from "./rest";

export const STATUS_VARS = ["CommonDeviceStatus", "KM_SysBoard_Temp", "KM_APDBoard_Temp", "KM_PowerSource_Voltage", "KM_MotorRotationPeriod",
                            "KMWindowWarning", "KMWindowError", "DeviceType", "SerialNumber", "FirmwareVersion", "UpsideDown"];

export async function statusLoop(rest: RestClient, sensor: LiveSensor, stop: Stop, periodS = 2, retryS = 3): Promise<void> {
  const health = new Health(`${sensor.label} (REST status)`, retryS);
  while (!stop.isSet) {
    try {
      sensor.status = await rest.getMany(STATUS_VARS);
      health.ok();
    } catch (e) {
      sensor.status = { error: health.fail(e) };
    }
    await stop.wait(health.error ? retryS : periodS);
  }
}
