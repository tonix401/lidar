// The rig solve of a calibration (floor → walk → joint ICP, libs/processing/src/fusion/calib/rig.ts) in its own thread:
// about a second of work at full resolution, which would otherwise stall every client.
import { gridCloud } from "@mrs6000/processing/fusion/calib/icp";
import { calibrateRig, type CalibInput } from "@mrs6000/processing/fusion/calib/rig";
import type { CalibData } from "@mrs6000/server-common/sensor/core";

export interface SolveRequest { sensors: { name: string; data: CalibData; walk: CalibInput["walk"] }[] }

const scope = globalThis as unknown as { onmessage: ((e: MessageEvent<SolveRequest>) => void) | null; postMessage(m: unknown): void };

scope.onmessage = ({ data }) => {
  try {
    const inputs = data.sensors.map(s => ({ name: s.name, walk: s.walk, cloud: gridCloud(s.data.bg, s.data.rayX, s.data.rayY, s.data.rayZ, s.data.L, s.data.B) }));
    scope.postMessage({ ok: true, result: calibrateRig(inputs) });
  } catch (e) {
    scope.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
