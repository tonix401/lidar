// A live sensor's CoLa connection in its own thread (started by live.ts): its frames and connection state go to the
// main thread, which records and publishes them.
import { Stop } from "@mrs6000/server-common/health";
import type { SensorFrame } from "@mrs6000/server-common/sensor/core";
import type { Header } from "@mrs6000/wire/frame";
import { colaScans } from "../cola";
import { liveLoop, type LoopStatus } from "./loop";

/** a frame between the threads: its header only when it changed (the elevation table is large) */
export type WireFrame = Omit<SensorFrame, "hdr"> & { hdr?: Header };

export type ToLive =
  | { type: "init"; name: string; label: string; ip: string; port?: number; layers?: number; retryS: number }
  | { type: "upsideDown"; value: boolean | null }
  | { type: "stop" };

export type FromLive = { type: "frame"; frame: WireFrame } | { type: "status"; status: LoopStatus };

interface WorkerScope { onmessage: ((e: MessageEvent<ToLive>) => void) | null; postMessage(m: FromLive, transfer?: ArrayBufferLike[]): void; close(): void }
const scope = globalThis as unknown as WorkerScope;

const stop = new Stop();
let upsideDown: boolean | null = null, sentHdr: Header | null = null;

scope.onmessage = ({ data: m }) => {
  switch (m.type) {
    case "init":
      void liveLoop(m.name, () => colaScans(m.ip, m.layers ?? 24, m.port ?? 2111), stop, m.retryS, () => upsideDown,
                    f => {
                      const hdr = f.hdr === sentHdr ? undefined : (sentHdr = f.hdr);
                      scope.postMessage({ type: "frame", frame: { ...f, hdr } }, [f.d.buffer, f.r.buffer]);
                    },
                    s => scope.postMessage({ type: "status", status: s }), m.label);
      break;
    case "upsideDown": upsideDown = m.value; break;
    case "stop": stop.set(); scope.close(); break;
  }
};
