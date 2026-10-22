// Recordings as files: the folder listing, safe names from the API, format conversion.
import { closeSync, existsSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { describeError, NotFoundError, ValueError } from "@mrs6000/server-common/errors";
import { CHUNK_FRAMES, chunkData, LEVEL, zstdEntry, zstdEntryAsync } from "./format";
import { Recording, type RecordingInfo } from "./reader";
import { isSession, openRecording } from "./session";

export const NAME_RE = /^[\p{L}\p{N}_.-]+\.tpc(\.zstd)?$/u;
export const SESSION_RE = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u;      // session folders: no dots, so never a file name

/** Write a recording as .tpc.zstd (compress) or .tpc; returns the new size. Goes through a temporary file, so dst
 *  may be src. Chunks compress in parallel off the main thread. */
export async function convert(src: string, dst: string, compress = true, level = LEVEL): Promise<number> {
  const tmp = dst + ".tmp";
  const rec = new Recording(src);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "w");
    const n = rec.count, batches: number[] = [];
    for (let k = 0; k < n; k += CHUNK_FRAMES) batches.push(k);
    if (compress) {
      writeSync(fd, zstdEntry(rec.header, [], level));
      const width = Math.max(2, navigator.hardwareConcurrency ?? 2);
      for (let b = 0; b < batches.length; b += width) {             // a few chunks at a time: bounded memory
        const parts = await Promise.all(batches.slice(b, b + width).map(k => {
          const frames = rec.frames(k, Math.min(n, k + CHUNK_FRAMES));
          return zstdEntryAsync(chunkData(frames), frames.map(f => f.t), level);
        }));
        for (const p of parts) writeSync(fd, p);
      }
    } else {
      writeSync(fd, rec.header);
      for (const k of batches) writeSync(fd, chunkData(rec.frames(k, Math.min(n, k + CHUNK_FRAMES))));
    }
    closeSync(fd); fd = null;
    rec.close();
    renameSync(tmp, dst);
  } finally {
    if (fd !== null) closeSync(fd);
    rec.close();
    rmSync(tmp, { force: true });
  }
  return statSync(dst).size;
}

/** newest first; unreadable files are listed with an `error` */
export function listRecordings(recDir: string): (RecordingInfo | { name: string; bytes: number; error: string })[] {
  if (!existsSync(recDir) || !statSync(recDir).isDirectory()) return [];
  const entries = readdirSync(recDir).map(name => join(recDir, name)).filter(p => {
    const name = p.slice(recDir.length + 1);
    return (NAME_RE.test(name) && statSync(p).isFile()) || (SESSION_RE.test(name) && isSession(p));
  });
  return entries.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).map(p => {
    const name = p.slice(recDir.length + 1);
    try {
      const r = openRecording(p);
      try { return r.info(); } finally { r.close(); }
    } catch (e) {
      const size = statSync(p).isDirectory() ? readdirSync(p).reduce((s, f) => s + statSync(join(p, f)).size, 0) : statSync(p).size;
      return { name, bytes: size, error: describeError(e) };
    }
  });
}

/** a recording name from the API → its path: a plain *.tpc / *.tpc.zstd file or a session folder in recDir */
export function recordingPath(recDir: string, name: string): string {
  const file = NAME_RE.test(name ?? "");
  if (!file && !SESSION_RE.test(name ?? "")) throw new ValueError("invalid recording name");
  const p = join(recDir, name);
  if (!(file ? existsSync(p) && statSync(p).isFile() : isSession(p))) throw new NotFoundError(name);
  return p;
}
