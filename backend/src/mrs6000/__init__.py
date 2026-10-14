"""Access a SICK MRS6000 LiDAR (tested: MRS6224R-131001, FW 2.1.0.1663R).

The sensor exposes three interfaces, all readable without login:

  1. REST API      http://<ip>/api/<VariableName>   (GET, JSON)        -> config / status   (rest.py)
                   POST /api/<Method>  with challenge-response auth   -> write / call
  2. WebSocket     ws://<ip>/scan                   (MessagePack)      -> preview, ~2 Hz     (preview.py)
  3. CoLa A (TCP)  <ip>:2111  "sEN LMDscandata 1"   (ASCII telegrams)  -> full rate, 10 Hz x 24 layers (cola.py)
"""
from .cola import ECHO_FILTERS, ColaClient, cola_password_hash, cola_scans, parse_lmdscandata
from .env import load_env
from .errors import describe_error
from .export import write_scan_files
from .model import Echo, Layer, Scan
from .rest import RestClient, RestError
from .variables import DEFAULT_IP, DEVICE_STATUS, VARIABLES

__all__ = ["ECHO_FILTERS", "ColaClient", "cola_password_hash", "cola_scans", "parse_lmdscandata", "load_env",
           "describe_error", "write_scan_files", "Echo", "Layer", "Scan", "RestClient", "RestError",
           "DEFAULT_IP", "DEVICE_STATUS", "VARIABLES"]
