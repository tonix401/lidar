// The rig solve of a calibration (floor → walk → joint ICP, libs/processing/src/fusion/calib/rig.ts) in its own thread:
// about a second of work at full resolution, which would otherwise stall every client. `refine` instead runs only the
// ICP, from the poses given (set by hand on the page).
import { gridCloud } from "@mrs6000/processing/fusion/calib/icp";
import { calibrateRig, refineRig, type CalibInput, type CalibOptions, type SensorCalibration } from "@mrs6000/processing/fusion/calib/rig";
import type { CalibData } from "@mrs6000/server-common/sensor/core";

export interface SolveRequest {
  sensors: { name: string; data: CalibData; walk: CalibInput["walk"] }[];
  options: CalibOptions;
  refine?: SensorCalibration[];
}

const scope = globalThis as unknown as { onmessage: ((e: MessageEvent<SolveRequest>) => void) | null; postMessage(m: unknown): void };

scope.onmessage = ({ data }) => {
  try {
    const inputs = data.sensors.map(s => ({ name: s.name, walk: s.walk, cloud: gridCloud(s.data.bg, s.data.rayX, s.data.rayY, s.data.rayZ, s.data.L, s.data.B) }));
    const result = data.refine ? refineRig(inputs.map(s => s.cloud), data.refine, data.options.origin ?? 0, data.options) : calibrateRig(inputs, data.options);
    scope.postMessage({ ok: true, result });
  } catch (e) {
    scope.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
