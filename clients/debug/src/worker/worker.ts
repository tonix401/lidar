// A sensor's Processor in its own thread (started by host.ts): messages in, one snapshot (snapshot.ts) out per
// processed scan or re-run of the spatial stages. Errors are reported, never thrown away: a bad frame must
// not stop the stream.
import type { Config } from "@mrs6000/processing/config/config";
import type { FrameMeta, Mount } from "@mrs6000/processing/core/types";
import type { OtherSensor } from "@mrs6000/processing/pipeline/crosscheck";
import { Processor } from "@mrs6000/processing/pipeline/processor";
import { snapshotBytes, takeSnapshot, type Snapshot } from "./snapshot";

export type ToWorker =
  | { type: "init"; cfg: Config; mount: Mount; bias: Float32Array | null }
  | { type: "ingest"; gen: number; data: Float32Array; meta: FrameMeta; cfg: Config; others: OtherSensor[] }
  | { type: "refine"; gen: number; cfg: Config }
  | { type: "reset"; gen: number }
  | { type: "mount"; mount: Mount }
  | { type: "bias"; bias: Float32Array }
  | { type: "recycle"; buf: ArrayBuffer };

export type FromWorker =
  | { type: "scan" | "refine"; gen: number; meta: FrameMeta; snap: Snapshot }
  | { type: "error"; gen: number; message: string };

interface WorkerScope { onmessage: ((e: MessageEvent<ToWorker>) => void) | null; postMessage(m: FromWorker, transfer: Transferable[]): void }
const scope = self as unknown as WorkerScope;

let p: Processor | null = null, biasChanged = false, sentGrid: object | null = null, sentRays = "";
const spare: ArrayBuffer[] = [];

function reply(type: "scan" | "refine", gen: number): void {
  const g = p!.grid!, need = snapshotBytes(g);
  let buf = spare.pop();
  while (buf && buf.byteLength < need) buf = spare.pop();     // buffers of a smaller grid: dropped
  buf ??= new ArrayBuffer(need);
  const rays = sentGrid !== g || sentRays !== g.rayKey;       // a new grid, or other rays
  const snap = takeSnapshot(p!, buf, rays, biasChanged);
  sentGrid = g; sentRays = g.rayKey; biasChanged = false;
  scope.postMessage({ type, gen, meta: p!.meta!, snap }, [buf]);
}

scope.onmessage = ({ data: m }) => {
  try {
    switch (m.type) {
      case "init":
        p = new Processor(m.cfg, m.mount);
        if (m.bias) p.setLayerBias(m.bias);
        p.onLayerBias = () => { biasChanged = true; };
        break;
      case "ingest":
        p!.cfg = m.cfg; p!.others = m.others;
        p!.ingest(m.data, m.meta);
        reply("scan", m.gen);
        break;
      case "refine":
        p!.cfg = m.cfg;
        if (p!.grid) { p!.refine(); reply("refine", m.gen); }
        break;
      case "reset": p!.reset(); break;
      case "mount": p!.setMount(m.mount); break;
      case "bias": p!.setLayerBias(m.bias); break;
      case "recycle": spare.push(m.buf); break;
    }
  } catch (e) {
    const gen = "gen" in m ? m.gen : -1;
    scope.postMessage({ type: "error", gen, message: e instanceof Error ? e.message : String(e) }, []);
  }
};
