"""Short, human-readable error messages (one line, no traceback)."""
from __future__ import annotations

import os.path
import socket
import urllib.error


def describe_error(e: BaseException) -> str:
    """One short line for an exception, e.g. 'connection refused' or 'timed out'."""
    if isinstance(e, urllib.error.HTTPError):
        return f"HTTP {e.code} {e.reason}"
    if isinstance(e, urllib.error.URLError):
        e = e.reason if isinstance(e.reason, BaseException) else RuntimeError(str(e.reason))
    if isinstance(e, (socket.timeout, TimeoutError)):
        return "timed out"
    if isinstance(e, ConnectionRefusedError):
        return "connection refused"
    if isinstance(e, ConnectionResetError):
        return "connection reset"
    if isinstance(e, socket.gaierror):
        return "host not found"
    if isinstance(e, OSError) and e.strerror:
        return e.strerror.lower() + (f": {os.path.basename(str(e.filename))}" if e.filename else "")
    msg = str(e).strip().splitlines()[0] if str(e).strip() else ""
    plain = isinstance(e, (ConnectionError, RuntimeError))       # message already says what happened
    text = msg if msg and plain else f"{type(e).__name__}: {msg}" if msg else type(e).__name__
    return text if len(text) <= 120 else text[:117] + "..."
