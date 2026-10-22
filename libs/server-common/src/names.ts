// Sensor names, as the registry, the rig and the recordings use them.
import { ValueError } from "./errors";

const SENSOR_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function checkName(name: unknown): string {
  if (typeof name !== "string" || !SENSOR_NAME_RE.test(name))
    throw new ValueError(`invalid sensor name ${JSON.stringify(name ?? null)} (letters, digits, _ and -, at most 32)`);
  return name;
}
