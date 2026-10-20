// A simulated multi-sensor session to develop and try calibration and fusion without the sensors:
// three sensors around a room (tests/helpers/rig.ts), empty for 3 s, then one person walking a loop.
//   make sim-session                  → recordings/sim_rig3/ (45 s, full 923-beam resolution)
//   make sim-session ARGS="out 60 301"   (folder, seconds, beams)
// Replay it with `make run ARGS="--offline --replay recordings/sim_rig3"` and press Calibrate.
import { RIG3, ROOM } from "../tests/helpers/rig";
import { writeSession } from "../tests/helpers/session";

const [dir = "../recordings/sim_rig3", seconds = "45", beams = "923"] = process.argv.slice(2);
const B = Number(beams), rig = RIG3.map((s, k) => ({ ...s, B, step: B === 923 ? 0.1301 : 120 / (B - 1), noise: 0.01, seed: k + 1 }));
const t = performance.now();
writeSession(dir, rig, ROOM, Number(seconds));
console.log(`wrote ${dir}: ${rig.length} sensors × ${seconds} s × ${B} beams in ${((performance.now() - t) / 1000).toFixed(1)} s`);
