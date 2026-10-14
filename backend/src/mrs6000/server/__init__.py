"""Viewer backend: live sensor stream + recordings, served to the browser frontend by FastAPI.

  feed.py    latest frame + long-poll wait
  frames.py  wire format of /api/frame (float32 blocks + meta)
  stream.py  .mrsstream recordings (format, random access, recorder)
  hub.py     source switching (live sensor / replay), playback control
  status.py  REST status poller
  health.py  short console logging, retry/restart helpers
  app.py     HTTP API (FastAPI) + static frontend
  main.py    command line entry point
"""
