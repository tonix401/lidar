"""Short console logging: one line when a problem starts/changes, a reminder once a minute,
one line when it is gone, never a traceback per retry."""
from __future__ import annotations

import threading
import time
from typing import Callable

from ..errors import describe_error


def log(msg: str):
    print(time.strftime("[%H:%M:%S] ") + msg, flush=True)


class Health:
    """Error state of one subsystem."""

    REMIND_S = 60.0

    def __init__(self, name: str, retry_s: float | None = None, logger: Callable[[str], None] = log):
        self.name, self.retry_s, self.log = name, retry_s, logger
        self.error, self.since, self.reminded = "", 0.0, 0.0

    def fail(self, e: BaseException | str) -> str:
        """Record a failure; returns the short message."""
        msg = e if isinstance(e, str) else describe_error(e)
        now = time.time()
        if msg != self.error:
            self.log(f"{self.name}: {msg}" + (f" (retrying every {self.retry_s:g} s)" if self.retry_s else ""))
            self.since = self.reminded = now
        elif now - self.reminded >= self.REMIND_S:
            self.log(f"{self.name}: still failing after {int(now - self.since)} s: {msg}")
            self.reminded = now
        self.error = msg
        return msg

    def ok(self):
        if self.error:
            self.log(f"{self.name}: ok again")
            self.error = ""


def supervised(name: str, fn: Callable[[], None], stop: threading.Event, restart_s: float = 3.0):
    """Run a thread's loop until `stop`; if it ever raises or returns early, log one line and restart."""
    health = Health(name)
    while not stop.is_set():
        try:
            fn()
            if not stop.is_set():
                health.fail("loop ended unexpectedly, restarting")
        except Exception as e:
            health.fail(f"crashed ({describe_error(e)}), restarting")
        stop.wait(restart_s)
