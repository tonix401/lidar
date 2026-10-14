import { $ } from "./dom";

const STATUS: Record<number, string> = { 0: "unknown", 1: "startup", 2: "service mode", 3: "normal", 4: "suspended",
  5: "service recommended", 6: "service required", 7: "recoverable error", 8: "fatal error" };

const num = (v: unknown, digits: number, unit: string) => typeof v === "number" ? v.toFixed(digits) + unit : "–";

/** device section of the panel from REST status values */
export function renderDevice(d: Record<string, unknown>): void {
  const code = (d.CommonDeviceStatus as { Status?: number } | undefined)?.Status;
  $("devStatus").textContent = code != null ? STATUS[code] ?? String(code) : "–";
  $("devDot").className = "dot " + (code === 3 ? "ok" : code != null && code >= 7 ? "err" : code != null ? "warn" : "");
  $("temps").textContent = `${num(d.KM_SysBoard_Temp, 1, " °C")} / ${num(d.KM_APDBoard_Temp, 1, " °C")}`;
  $("volt").textContent = num(d.KM_PowerSource_Voltage, 2, " V");
  $("mirror").textContent = typeof d.KM_MotorRotationPeriod === "number" ? (1000 / d.KM_MotorRotationPeriod).toFixed(2) + " Hz" : "–";
  $("window").textContent = d.KMWindowError ? "error" : d.KMWindowWarning ? "warning" : d.KMWindowError === false ? "clean" : "–";
}
