// A folder as a .zip stream (stored, no compression: the recordings are compressed already), for downloading a
// session. Each file's CRC is computed first, then the archive streams in 1 MB pieces, never held in memory.
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** a file's bytes in pieces of `size` */
function* pieces(path: string, size = 1 << 20): Generator<Uint8Array> {
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const b = new Uint8Array(size), n = readSync(fd, b, 0, size, null);
      if (n <= 0) return;
      yield n === size ? b : b.subarray(0, n);
    }
  } finally { closeSync(fd); }
}

interface Entry { path: string; name: Uint8Array; size: number; crc: number }

/** a local (30 bytes) or central (46 bytes) file header */
function header(f: Entry, central: boolean, offset: number): Uint8Array {
  const b = new Uint8Array((central ? 46 : 30) + f.name.length), v = new DataView(b.buffer);
  let i = 0;
  const u32 = (x: number) => { v.setUint32(i, x, true); i += 4; }, u16 = (x: number) => { v.setUint16(i, x, true); i += 2; };
  u32(central ? 0x02014b50 : 0x04034b50);
  if (central) u16(20);                                 // version made by
  u16(20); u16(0x0800); u16(0); u16(0); u16(0x21);      // version needed, flags (UTF-8 names), stored, time, date 1980-01-01
  u32(f.crc); u32(f.size); u32(f.size); u16(f.name.length); u16(0);
  if (central) { u16(0); u16(0); u16(0); u32(0); u32(offset); }
  b.set(f.name, i);
  return b;
}

/** the files directly in `folder`, as entries "<folder name>/<file>" */
export function zipFolder(folder: string): ReadableStream<Uint8Array> {
  const prefix = basename(folder);
  const files: Entry[] = readdirSync(folder).sort().map(f => join(folder, f)).filter(p => statSync(p).isFile()).map(p => {
    let crc = 0;
    for (const b of pieces(p)) crc = crc32(b, crc);
    return { path: p, name: new TextEncoder().encode(`${prefix}/${basename(p)}`), size: statSync(p).size, crc };
  });
  function* archive(): Generator<Uint8Array> {
    let offset = 0;
    const offsets: number[] = [];
    for (const f of files) {
      offsets.push(offset);
      const h = header(f, false, 0);
      yield h; offset += h.length;
      for (const b of pieces(f.path)) { yield b; offset += b.length; }
    }
    const start = offset;
    for (const [k, f] of files.entries()) { const h = header(f, true, offsets[k]); yield h; offset += h.length; }
    const end = new Uint8Array(22), v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true); v.setUint16(8, files.length, true); v.setUint16(10, files.length, true);
    v.setUint32(12, offset - start, true); v.setUint32(16, start, true);
    yield end;
  }
  const it = archive();
  return new ReadableStream({
    pull(ctl) { const r = it.next(); if (r.done) ctl.close(); else ctl.enqueue(r.value); },
    cancel() { it.return(undefined); },
  });
}
