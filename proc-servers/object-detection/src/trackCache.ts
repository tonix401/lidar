// Fused tracks of a recording, stored once computed: a second replay of the same recording with the same settings and
// poses reads them instead of processing it again. Each server keeps its own (its settings are its own):
//
//   <cache>/<recording>/<key>.jsonl     one line per scan set: {"t": time, "seq": …, "k": frame index, "sensors", "objects"}
//
// The key is a hash of the processing settings, the recording's rig, its frame count and PROCESSING_VERSION, so a
// changed setting, a recalibration or a recording that grew simply misses the cache. A cache is only written by a run
// that went from the first frame to the last without a jump; it is written to a .partial file and renamed when complete.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "@mrs6000/processing/config/config";
import type { ObjectsTick } from "@mrs6000/server-common/sensorSet";
import type { Rig } from "@mrs6000/wire/rig";

/** bump when the processing's results change on purpose (the golden snapshots of libs/processing/tests are updated) */
export const PROCESSING_VERSION = 1;

export const cacheDir = (root: string, recording: string): string => join(root, recording.replace(/[^\p{L}\p{N}_.-]/gu, "_"));

export function cacheKey(cfg: Config, rig: Rig, count: number): string {
  return createHash("sha256").update(JSON.stringify({ cfg, rig, count, version: PROCESSING_VERSION })).digest("hex").slice(0, 16);
}

/** the cached ticks for this key, in frame order; null if none */
export function readCache(dir: string, key: string): ObjectsTick[] | null {
  const p = join(dir, `${key}.jsonl`);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as ObjectsTick);
  } catch { return null; }                   // unreadable: compute again
}

export const hasCache = (dir: string, key: string): boolean => existsSync(join(dir, `${key}.jsonl`));

export function dropCache(dir: string): void { rmSync(dir, { recursive: true, force: true }); }

/** writes one run's ticks; complete() keeps them, abort() forgets them */
export class CacheWriter {
  private fd: number;
  private path: string;
  done = false;

  constructor(dir: string, readonly key: string) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${key}.jsonl`);
    this.fd = openSync(this.path + ".partial", "w");
  }

  add(tick: ObjectsTick): void { if (!this.done) writeSync(this.fd, JSON.stringify(tick) + "\n"); }

  complete(): void {
    if (this.done) return;
    this.done = true;
    closeSync(this.fd);
    renameSync(this.path + ".partial", this.path);
  }

  abort(): void {
    if (this.done) return;
    this.done = true;
    closeSync(this.fd);
    rmSync(this.path + ".partial", { force: true });
  }
}
