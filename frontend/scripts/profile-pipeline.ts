// Where the time goes per scan: the simulated three-sensor rig (processing/sim/rig.ts) at full resolution,
// calibrated (so the cross-check runs), with a person walking; every pipeline step, the geometry build and the
// fusion timed separately. Scans are cast up front, so only the page's own work is measured.
//   make profile                     → 24 × 923 beams, 60 scans per sensor after 40 of warm-up
//   make profile ARGS="301 100"      (beams, scans)
import { defaultConfig } from "@mrs6000/processing/config/config";
import { apply, compose, invert, type Pose } from "@mrs6000/processing/fusion/pose";
import { mergeSurfaces } from "@mrs6000/processing/fusion/surfaces";
import { ObjectFusion, observe } from "@mrs6000/processing/fusion/objects";
import type { OtherSensor } from "@mrs6000/processing/pipeline/crosscheck";
import { Processor } from "@mrs6000/processing/pipeline/processor";
import { PIPELINE } from "@mrs6000/processing/pipeline/steps";
import { buildGeometry, createGeometry } from "../src/render/geometry";
import { RIG3, ROOM, scanFrame, scanTime, simGeometry, simMeta } from "@mrs6000/processing/sim/rig";

const [beams = "923", scans = "60"] = process.argv.slice(2);
const B = Number(beams), K = Number(scans), WARM = 40;
const rig = RIG3.map((s, k) => ({ ...s, B, step: B === 923 ? 0.1301 : 120 / (B - 1), noise: 0.01, mixed: 0.4, seed: k + 1 }));
const poses: Pose[] = rig.map(s => s.pose);

const ms = new Map<string, number[]>();
const time = <T>(name: string, f: () => T): T => {
  const t0 = performance.now(), r = f();
  (ms.get(name) ?? ms.set(name, []).get(name)!).push(performance.now() - t0);
  return r;
};
for (const s of PIPELINE) { const run = s.run; s.run = (c, g, scan) => time(`${s.phase}: ${s.name}`, () => run(c, g, scan)); }

process.stdout.write(`casting ${rig.length} × ${WARM + K} scans of 24 × ${B} … `);
const t0 = performance.now();
const frames = rig.map(s => Array.from({ length: WARM + K }, (_, k) => scanFrame(s, ROOM, scanTime(s, k), k)));
console.log(`${((performance.now() - t0) / 1000).toFixed(1)} s`);

const cfg = defaultConfig(), procs = rig.map(() => new Processor(cfg)), ts = rig.map(() => 0);
const geos = rig.map(s => createGeometry(24 * simGeometry(s).B)), fusion = new ObjectFusion();
const others = (j: number, t: number): OtherSensor[] => rig.flatMap((o, m) => {
  const g = procs[m].grid;
  if (m === j || !g) return [];
  const T = compose(invert(poses[m]), poses[j]), { az0, step } = simGeometry(o);
  return [{ R: T.R, t: T.t, L: g.L, B: g.B, az0, step, range: g.out, age: t - ts[m],
            layerSin: Float32Array.from({ length: g.L }, (_, l) => g.rayZ[l * g.B + (g.B >> 1)]) }];
});

for (let k = 0; k < WARM + K; k++) {
  if (k === WARM) ms.clear();
  rig.forEach((s, j) => {
    const t = scanTime(s, k), p = procs[j];
    p.others = others(j, t);
    const g = time("total: ingest (all steps)", () => p.ingest(frames[j][k], simMeta(s, t, k + 1)));
    ts[j] = t;
    time("objects: observe", () => observe(j, poses[j], t, p.objects!, g));
    time("render: buildGeometry", () => buildGeometry(g, g.out, geos[j], {
      colorBy: "mainDist", sensor: j, layer: -1, maxRange: 60, origin: apply(invert(poses[j]), poses[0].t),
      jump: cfg.mesh.jump, jumpRel: cfg.mesh.jumpRel, fill: g.fill, front: g.front, seesWall: g.seesWall }));
  });
  time("fusion: objects", () => fusion.update(procs.flatMap((p, j) => observe(j, poses[j], ts[j], p.objects!, p.grid!)), Math.max(...ts), cfg.objects));
  if (k % 10 === 0) time("fusion: mergeSurfaces (1/s)", () => mergeSurfaces(procs.map((p, j) => {
    const g = p.grid!, bg = p.objects!.bgModel, range = new Float32Array(g.N);
    for (let i = 0; i < g.N; i++) range[i] = g.wallN[i] > 0 ? g.wall[i] : bg.ready ? bg.bg[i] : 0;
    return { pose: poses[j], L: g.L, B: g.B, rayX: g.rayX, rayY: g.rayY, rayZ: g.rayZ, range };
  })));
}

const q = (a: number[], f: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(f * a.length))];
const rows = [...ms].map(([name, a]) => ({ name, mean: a.reduce((s, v) => s + v, 0) / a.length, p90: q(a, 0.9), n: a.length }));
const per = rows.find(r => r.name.startsWith("total"))!.mean;
console.log(`\n24 × ${B} beams, ${K} scans × ${rig.length} sensors; ms per call (mean, 90 %)`);
for (const r of rows.sort((a, b) => b.mean - a.mean))
  console.log(`${r.name.padEnd(34)} ${r.mean.toFixed(2).padStart(7)} ${r.p90.toFixed(2).padStart(7)}  ${r.name.startsWith("ingest") || r.name.startsWith("refine") || r.name.startsWith("learn") ? `${(100 * r.mean / per).toFixed(0).padStart(3)} %` : ""}`);
