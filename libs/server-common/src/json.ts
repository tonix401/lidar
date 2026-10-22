// JSON files a server keeps (its registry, a session's metadata), readable and editable by hand.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ValueError } from "./errors";

/** write through a temporary file, so a crash never leaves half a file */
export function saveJson(path: string, obj: unknown): void {
  writeFileSync(path + ".tmp", JSON.stringify(obj, null, 2) + "\n");
  renameSync(path + ".tmp", path);
}

/** a JSON object from `path` (null when there is no such file) */
export function loadJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const d = JSON.parse(readFileSync(path, "utf8"));
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new ValueError(`${path}: expected a JSON object`);
  return d as Record<string, unknown>;
}

const SENSOR_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function checkName(name: unknown): string {
  if (typeof name !== "string" || !SENSOR_NAME_RE.test(name))
    throw new ValueError(`invalid sensor name ${JSON.stringify(name ?? null)} (letters, digits, _ and -, at most 32)`);
  return name;
}
