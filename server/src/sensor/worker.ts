// A sensor's processing in its own thread (started by runner.ts): its CoLa connection and the pipeline, or the
// pipeline on frames sent from a replay. Messages in and out are the types below.
import type { Config } from "@mrs6000/processing/config/config";
import type { Pose } from "@mrs6000/processing/fusion/pose";
import { colaScans } from "../cola";
import { describeError } from "../errors";
import { Stop } from "../health";
import type { Header } from "../recording/format";
import { liveLoop, SensorCore, type CalibData, type MountSetting, type OtherScan, type SensorFrame, type SensorOutput, type SensorStatus } from "./core";

/** a frame between the threads: its header only when it changed (the elevation table is large) */
export type WireFrame = Omit<SensorFrame, "hdr"> & { hdr?: Header };

export type SensorInput = { kind: "cola"; ip: string; port?: number; layers?: number } | { kind: "frames" };

export type ToSensor =
  | { type: "init"; name: string; label: string; index: number; cfg: Config; mount: MountSetting; input: SensorInput; retryS: number }
  | { type: "frame"; frame: WireFrame }
  | { type: "other"; index: number; scan: OtherScan | null }
  | { type: "cfg"; cfg: Config }
  | { type: "pose"; pose: Pose }
  | { type: "mount"; mount: MountSetting }
  | { type: "upsideDown"; value: boolean | null }
  | { type: "reset" }
  | { type: "calib"; id: number }
  | { type: "stop" };

export type FromSensor =
  | { type: "frame"; frame: WireFrame }
  | { type: "output"; output: SensorOutput }
  | { type: "status"; status: SensorStatus }
  | { type: "calib"; id: number; data: CalibData | null }
  | { type: "error"; message: string };

interface WorkerScope { onmessage: ((e: MessageEvent<ToSensor>) => void) | null; postMessage(m: FromSensor, transfer?: ArrayBufferLike[]): void; close(): void }
const scope = globalThis as unknown as WorkerScope;         // in a worker, globalThis is the worker scope (self)

let core: SensorCore | null = null, upsideDown: boolean | null = null, sentHdr: Header | null = null, gotHdr: Header | null = null;
const stop = new Stop();

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
    case "init": {
      core = new SensorCore(m.name, m.index, m.cfg, m.mount);
      const input = m.input;
      if (input.kind === "cola")
        void liveLoop(m.name, () => colaScans(input.ip, input.layers ?? 24, input.port ?? 2111), stop, m.retryS, () => upsideDown,
                      f => {
                        process(f);                    // then hand the frame over (recording, debug clients)
                        const hdr = f.hdr === sentHdr ? undefined : (sentHdr = f.hdr);
                        scope.postMessage({ type: "frame", frame: { ...f, hdr } }, [f.d.buffer, f.r.buffer]);
                      },
                      s => scope.postMessage({ type: "status", status: s }), m.label);
      break;
    }
    case "frame": gotHdr = m.frame.hdr ?? gotHdr; process({ ...m.frame, hdr: gotHdr! }); break;
    case "other": core!.setOther(m.index, m.scan); break;
    case "cfg": core!.cfg = m.cfg; break;
    case "pose": core!.pose = m.pose; break;
    case "mount": core!.mount = m.mount; break;
    case "upsideDown": upsideDown = m.value; break;
    case "reset": core!.reset(); break;
    case "calib": scope.postMessage({ type: "calib", id: m.id, data: core?.calibData() ?? null }); break;
    case "stop": stop.set(); scope.close(); break;
  }
};
