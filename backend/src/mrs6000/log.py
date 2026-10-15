"""One-line console log with a timestamp (the server and the recorder)."""
import time


def log(msg: str):
    print(time.strftime("[%H:%M:%S] ") + msg, flush=True)
