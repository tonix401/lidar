"""Minimal .env reader (USERNAME / PASSWORD for configuration changes)."""
from __future__ import annotations


def load_env(path: str = ".env") -> dict[str, str]:
    """KEY=VALUE lines; blank lines and # comments ignored, surrounding quotes stripped.
    A missing file gives an empty dict."""
    env: dict[str, str] = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip("'\"")
    except FileNotFoundError:
        pass
    return env
