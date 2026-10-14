"""Command line interface:

  mrs6000 info                     # identity + network
  mrs6000 status                   # temperatures, voltage, IO, LEDs ...
  mrs6000 get KM_SysBoard_Temp OpHours
  mrs6000 dump > all.json          # every known variable as JSON
  mrs6000 scan [-n 10] [--csv out.csv] [--source ws]
  mrs6000 record [prefix] [--mount auto|upright|upside-down]
  mrs6000 echo-filter [first|all|last] [--save] [--env .env]
  mrs6000 compress recordings/*.tpc              # x.tpc -> x.tpc.zstd (keeps x.tpc)
  mrs6000 decompress rec.tpc.zstd [-o out.tpc]   # same result as zstd -d
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time

from .cola import ECHO_FILTERS, ColaClient, cola_scans
from .env import load_env
from .errors import describe_error
from .export import write_scan_files
from .rest import RestClient, RestError
from .server.stream import convert
from .variables import DEFAULT_IP, DEVICE_STATUS, VARIABLES


def fmt_value(v) -> str:
    if isinstance(v, list) and len(v) in (4, 6) and all(isinstance(x, int) for x in v):
        return (":".join(f"{x:02x}" for x in v)) if len(v) == 6 else ".".join(map(str, v))
    if isinstance(v, float):
        return f"{v:.2f}"
    return json.dumps(v) if isinstance(v, (dict, list)) else str(v)


def cmd_info(rest: RestClient, _args):
    for group in ("identity", "network", "measurement_module"):
        print(f"[{group}]")
        for k, v in rest.get_many(VARIABLES[group]).items():
            print(f"  {k:28s} {fmt_value(v)}")


def cmd_status(rest: RestClient, _args):
    s = rest.get_many(VARIABLES["status"] + VARIABLES["io"][:16] + ["AutoStartMeasure", "UpsideDown"])
    st = s["CommonDeviceStatus"]
    code = st.get("Status") if isinstance(st, dict) else st
    print(f"Device status        : {DEVICE_STATUS.get(code, code)}")
    print(f"System board temp    : {s['KM_SysBoard_Temp']:.1f} °C")
    print(f"APD board temp       : {s['KM_APDBoard_Temp']:.1f} °C")
    print(f"Supply voltage       : {s['KM_PowerSource_Voltage']:.2f} V")
    print(f"Mirror period        : {s['KM_MotorRotationPeriod']:.2f} ms "
          f"({1000 / s['KM_MotorRotationPeriod']:.2f} Hz)")
    print(f"Operating hours      : {s['OpHours'] / 10:.1f} h   (power-ons: {s['PowerOnCnt']})")
    print(f"Window warning/error : {s['KMWindowWarning']} / {s['KMWindowError']}")
    print(f"LEDs red/orange/yel  : {s['LED_1_RED']} / {s['LED_2_ORANGE']} / {s['LED_3_YELLOW']}")
    print("Digital in  1-8      : " + " ".join("1" if s[f"DI{i}"] else "0" for i in range(1, 9)))
    print("Digital out 1-8      : " + " ".join("1" if s[f"DO{i}"] else "0" for i in range(1, 9)))
    print(f"Autostart / upside-dn: {s['AutoStartMeasure']} / {s['UpsideDown']}")


def cmd_get(rest: RestClient, args):
    for name in args.names:
        try:
            print(f"{name} = {json.dumps(rest.get(name))}")
        except RestError as e:
            print(e, file=sys.stderr)


def cmd_dump(rest: RestClient, _args):
    json.dump({g: rest.get_many(v) for g, v in VARIABLES.items()}, sys.stdout, indent=2)
    print()


def cmd_scan(_rest, args):
    if args.source == "cola":
        src = cola_scans(args.ip)
    else:
        from .preview import ws_scans
        src = ws_scans(args.ip)
    writer, fh, n = None, None, -1
    if args.csv:
        fh = open(args.csv, "w", newline="")
        writer = csv.writer(fh)
        writer.writerow(["scan", "x", "y", "z", "distance_m", "rssi", "layer", "echo"])
    t0 = time.time()
    try:
        for n, scan in enumerate(src):
            pts = list(scan.points())
            beams = sum(l.beam_count for l in scan.layers)
            dists = [p[3] for p in pts]
            first = scan.layers[0]
            print(f"scan {n}: {len(scan.layers)} layers "
                  f"({first.elevation_deg:+.2f}..{scan.layers[-1].elevation_deg:+.2f}°), "
                  f"{first.beam_count} beams/layer "
                  f"({first.start_azimuth_deg:+.1f}..{first.azimuths_deg()[-1]:+.1f}°, step {first.step_deg:.4f}°), "
                  f"{len(pts)}/{beams} valid, range {min(dists, default=0):.2f}..{max(dists, default=0):.2f} m")
            if writer:
                writer.writerows((n, *(round(v, 4) for v in p[:4]), *p[4:]) for p in pts)
            if n + 1 >= args.count:
                break
    finally:
        if fh:
            fh.close()
    print(f"{n + 1} scans in {time.time() - t0:.2f} s")


def cmd_record(rest: RestClient, args):
    prefix = args.prefix or time.strftime("scan_%Y%m%d_%H%M%S")
    upside_down = {"upright": False, "upside-down": True}.get(args.mount)
    if upside_down is None:                        # auto: follow the device's UpsideDown parameter
        try:
            upside_down = bool(rest.get("UpsideDown"))
        except Exception:
            upside_down = False
    for n, scan in enumerate(cola_scans(args.ip)):
        p = prefix if args.count == 1 else f"{prefix}_{n:03d}"
        for path in write_scan_files(scan, p, rest, upside_down=upside_down):
            print("wrote", path)
        if n + 1 >= args.count:
            break


def cmd_echo_filter(_rest, args):
    env = load_env(args.env)
    with ColaClient(args.ip) as c:
        old = int(c.read("FREchoFilter")[0])
        names = {v: k for k, v in ECHO_FILTERS.items()}
        print(f"FREchoFilter currently {old} ({names.get(old, '?')})")
        if args.mode is None:
            return
        if "USERNAME" not in env or "PASSWORD" not in env:
            raise ValueError(f"USERNAME / PASSWORD missing in {args.env}")
        c.login(env["USERNAME"], env["PASSWORD"])
        try:
            c.write("FREchoFilter", ECHO_FILTERS[args.mode])
            if args.save:
                c.save_permanent()
        finally:
            c.run()
        new = int(c.read("FREchoFilter")[0])
        print(f"FREchoFilter now {new} ({names.get(new, '?')})" + (", saved permanently" if args.save else
              " (not saved: reverts on power cycle, use --save)"))


def cmd_convert(_rest, args):
    compress = args.cmd == "compress"
    src_suffix = ".tpc" if compress else ".tpc.zstd"
    if args.output and len(args.files) > 1:
        raise ValueError("--output needs a single input file")
    for src in args.files:
        if not src.endswith(src_suffix):
            raise ValueError(f"{src}: expected a {src_suffix} file")
        dst = args.output or (src + ".zstd" if compress else src.removesuffix(".zstd"))
        size = convert(src, dst, compress=compress)
        print(f"{dst}: {size / 1e6:.1f} MB")


COMMANDS = {"info": cmd_info, "status": cmd_status, "get": cmd_get, "dump": cmd_dump, "scan": cmd_scan,
            "record": cmd_record, "echo-filter": cmd_echo_filter, "compress": cmd_convert, "decompress": cmd_convert}


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="mrs6000", description="SICK MRS6000 data access")
    ap.add_argument("--ip", default=DEFAULT_IP)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("info", help="identity, network, firmware")
    sub.add_parser("status", help="temperatures, voltage, IO, LEDs")
    g = sub.add_parser("get", help="read variables by name")
    g.add_argument("names", nargs="+")
    sub.add_parser("dump", help="all known variables as JSON")
    e = sub.add_parser("echo-filter", help="show or set which echoes are output (CoLa login from .env)")
    e.add_argument("mode", nargs="?", choices=tuple(ECHO_FILTERS), help="first | all | last")
    e.add_argument("--save", action="store_true", help="store permanently (EEPROM)")
    e.add_argument("--env", default=".env")
    r = sub.add_parser("record", help="save full-resolution scan(s): raw telegrams, CSV, PLY, JSON")
    r.add_argument("prefix", nargs="?", help="output file prefix (default scan_<timestamp>)")
    r.add_argument("-n", "--count", type=int, default=1)
    r.add_argument("--mount", choices=("auto", "upright", "upside-down"), default="auto",
                   help="sensor mounting for x/y/z (auto: read the device's UpsideDown parameter)")
    for name, what in (("compress", "x.tpc -> x.tpc.zstd"), ("decompress", "x.tpc.zstd -> x.tpc")):
        c = sub.add_parser(name, help=f"recordings {what} (keeps the input)")
        c.add_argument("files", nargs="+")
        c.add_argument("-o", "--output", help="output file (one input only)")
    s = sub.add_parser("scan", help="receive point clouds")
    s.add_argument("--source", choices=("cola", "ws"), default="cola",
                   help="cola: TCP 2111, full rate (default); ws: web UI preview stream")
    s.add_argument("-n", "--count", type=int, default=1)
    s.add_argument("--csv", help="write points to CSV")
    return ap


def main(argv: list[str] | None = None):
    args = build_parser().parse_args(argv)
    rest = RestClient(args.ip)
    try:
        COMMANDS[args.cmd](rest, args)
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:                       # short message instead of a traceback
        sys.exit(f"error: {describe_error(e)}")


if __name__ == "__main__":
    main()
