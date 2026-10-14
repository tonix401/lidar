"""Latest published frame; readers block until a newer one arrives (long-poll)."""
from __future__ import annotations

import threading


class Feed:
    def __init__(self):
        self.cond = threading.Condition()
        self.frame_id = 0
        self.data = b""
        self.meta: dict = {}
        self.status: dict = {}           # latest REST device values (see status.py)

    def publish(self, data: bytes, meta: dict):
        with self.cond:
            self.frame_id += 1
            self.data, self.meta = data, meta
            self.cond.notify_all()

    def wait(self, after: int, timeout: float = 2.0) -> tuple[int, bytes, dict]:
        """Return the newest frame once its id is > `after`, or the current one after `timeout`."""
        with self.cond:
            self.cond.wait_for(lambda: self.frame_id > after, timeout)
            return self.frame_id, self.data, dict(self.meta)
