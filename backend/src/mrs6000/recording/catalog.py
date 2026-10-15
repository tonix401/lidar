"""Recordings as files: the folder listing, safe names from the API, format conversion."""
from __future__ import annotations

import os
import re
import struct
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ..errors import describe_error
from .format import CHUNK_FRAMES, LEVEL, stream_chunk, zstd_entry
from .reader import Recording

NAME_RE = re.compile(r"^[\w.-]+\.tpc(\.zstd)?$")


def convert(src: str | Path, dst: str | Path, compress: bool = True, level: int = LEVEL) -> int:
    """Write a recording as .tpc.zstd (compress) or .tpc; returns the new size. Goes through a temporary
    file, so dst may be src."""
    dst = Path(dst)
    tmp = dst.with_name(dst.name + ".tmp")
    workers = os.cpu_count() or 1
    try:
        with Recording(src) as rec, open(tmp, "wb") as f, ThreadPoolExecutor(workers) as pool:
            n = rec.count
            batches = (rec.frames(k, min(n, k + CHUNK_FRAMES)) for k in range(0, n, CHUNK_FRAMES))
            if compress:                         # zstd releases the GIL: chunks compress in parallel
                f.write(zstd_entry(rec.header, level=level))
                for chunk in pool.map(lambda fr: stream_chunk(fr, level), batches, buffersize=2 * workers):
                    f.write(chunk)
            else:
                f.write(rec.header)
                for frames in batches:
                    f.write(b"".join(struct.pack("<d", ts) + d + r for ts, d, r in frames))
        tmp.replace(dst)
    finally:
        tmp.unlink(missing_ok=True)
    return dst.stat().st_size


def list_recordings(rec_dir: Path) -> list[dict]:
    """Newest first; unreadable files are listed with an `error`."""
    out = []
    if not Path(rec_dir).is_dir():
        return out
    files = [p for p in Path(rec_dir).iterdir() if NAME_RE.match(p.name) and p.is_file()]
    for p in sorted(files, key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            with Recording(p) as r:
                out.append(r.info())
        except Exception as e:
            out.append({"name": p.name, "bytes": p.stat().st_size, "error": describe_error(e)})
    return out


def recording_path(rec_dir: Path, name: str) -> Path:
    """Resolve a recording name from the API; only plain *.tpc / *.tpc.zstd names inside rec_dir."""
    if not NAME_RE.match(name or ""):
        raise ValueError("invalid recording name")
    p = Path(rec_dir) / name
    if not p.is_file():
        raise FileNotFoundError(name)
    return p
