// A sensor's processing in its own thread (started by runner.ts): the pipeline on the frames sent to it. Messages in
// and out are the types below.
import type { Config } from "@mrs6000/processing/config/config";
import type { Pose } from "@mrs6000/processing/fusion/pose";
import type { Header } from "@mrs6000/wire/frame";
import { describeError } from "../errors";
import { SensorCore, type CalibData, type MountSetting, type OtherScan, type SensorFrame, type SensorOutput } from "./core";

/** a frame between the threads: its header only when it changed (the elevation table is large) */
export type WireFrame = Omit<SensorFrame, "hdr"> & { hdr?: Header };

export type ToSensor =
  | { type: "init"; name: string; label: string; index: number; cfg: Config; mount: MountSetting }
  | { type: "frame"; frame: WireFrame }
  | { type: "other"; index: number; scan: OtherScan | null }
  | { type: "cfg"; cfg: Config }
  | { type: "pose"; pose: Pose }
  | { type: "mount"; mount: MountSetting }
  | { type: "reset" }
  | { type: "calib"; id: number }
  | { type: "stop" };

export type FromSensor =
  | { type: "output"; output: SensorOutput }
  | { type: "calib"; id: number; data: CalibData | null }
  | { type: "error"; message: string };

interface WorkerScope { onmessage: ((e: MessageEvent<ToSensor>) => void) | null; postMessage(m: FromSensor, transfer?: ArrayBufferLike[]): void; close(): void }
const scope = globalThis as unknown as WorkerScope;         // in a worker, globalThis is the worker scope (self)

let core: SensorCore | null = null, gotHdr: Header | null = null;

function process(f: SensorFrame): void {
  try {
    const out = core!.process(f);
    scope.postMessage({ type: "output", output: out }, [out.raw.buffer]);
  } catch (e) {
    scope.postMessage({ type: "error", message: `${core!.name}: processing: ${describeError(e)}` });
  }
}

scope.onmessage = ({ data: m }) => {
  switch (m.type) {
    case "init": core = new SensorCore(m.name, m.index, m.cfg, m.mount); break;
    case "frame": gotHdr = m.frame.hdr ?? gotHdr; process({ ...m.frame, hdr: gotHdr! }); break;
    case "other": core!.setOther(m.index, m.scan); break;
    case "cfg": core!.cfg = m.cfg; break;
    case "pose": core!.pose = m.pose; break;
    case "mount": core!.mount = m.mount; break;
    case "reset": core!.reset(); break;
    case "calib": scope.postMessage({ type: "calib", id: m.id, data: core?.calibData() ?? null }); break;
    case "stop": scope.close(); break;
  }
};
