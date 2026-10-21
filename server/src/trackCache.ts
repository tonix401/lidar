// Fused tracks of a recording, stored once computed: a second objects replay of the same recording with the same
// settings and poses reads them instead of running the sensor workers again.
//
//   <recording>.tracks/<key>.jsonl     one line per scan set: {"k": frame index, "t": time, "seq": …, "objects": [...]}
//
// The key is a hash of the processing settings, the recording's rig and PROCESSING_VERSION, so a changed setting or a
// recalibration simply misses the cache. A cache is only written by a run that played from the first frame to the end
// without a jump (complete and in order); it is written to a .partial file and renamed when complete.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config } from "@mrs6000/processing/config/config";
import type { Rig } from "./rig";
import type { ObjectsTick } from "./sensorSet";

/** bump when the processing's results change on purpose (the golden snapshots of processing/tests are updated) */
export const PROCESSING_VERSION = 1;

/** a fused set and the frame of the replay that completed it */
export type CachedTick = ObjectsTick & { k: number };

export const cacheDir = (recording: string): string => join(dirname(recording), basename(recording) + ".tracks");

export function cacheKey(cfg: Config, rig: Rig): string {
  return createHash("sha256").update(JSON.stringify({ cfg, rig, version: PROCESSING_VERSION })).digest("hex").slice(0, 16);
}

/** the cached ticks of a recording for this key, in frame order; null if none */
export function readCache(recording: string, key: string): CachedTick[] | null {
  const p = join(cacheDir(recording), `${key}.jsonl`);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as CachedTick);
  } catch { return null; }                   // unreadable: compute again
}

export function dropCache(recording: string): void { rmSync(cacheDir(recording), { recursive: true, force: true }); }

/** writes one run's ticks; complete() keeps them, abort() forgets them */
export class CacheWriter {
  private fd: number;
  private path: string;
  done = false;

  constructor(recording: string, readonly key: string) {
    const dir = cacheDir(recording);
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${key}.jsonl`);
    this.fd = openSync(this.path + ".partial", "w");
  }

  add(tick: CachedTick): void { if (!this.done) writeSync(this.fd, JSON.stringify(tick) + "\n"); }

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
