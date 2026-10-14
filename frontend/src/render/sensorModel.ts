// Simplified MRS6000 housing after the datasheet dimension drawing (Maßzeichnung, figure 20), in the
// sensor frame (x forward, y left, z up) with the measurement origin (⑧) at (0, 0, 0). Dimensions in mm;
// the group is scaled to metres. Parts: the base body (176 wide, 84 high, rounded front), the scan window
// (sloped frustum around the rotation axis), the rear block and flat top cap ("handle"), and the three
// connectors on the back. The origin is 107.2 mm above the bottom and 64.5 mm in front of the rear face.
// Housing frame: z up through the head; the 3D view mirrors it to match the data (see Scene3D.buildGuides).
import * as THREE from "three";

const BOTTOM = -107.2;              // underside, relative to the measurement origin
const BODY_TOP = BOTTOM + 84;
const HEAD_TOP = BOTTOM + 136.8;
const CAP_BASE = 21;                // where the window slope meets the flat top
const BACK = -64.5;                 // rear face of the body (152.5 deep: the front is at +88)
const HALF_W = 88;                  // 176 wide

function extrude(shape: THREE.Shape, z0: number, z1: number): THREE.ExtrudeGeometry {
  const g = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false, curveSegments: 24 });
  g.translate(0, 0, z0);
  return g;
}

/** a six-sided solid from 8 corners: bottom face 0..3 then top face 4..7, both counter-clockwise from above */
function hexa(c: [number, number, number][]): THREE.BufferGeometry {
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const pos: number[] = [];
  for (const [a, b, cc, d] of quads) for (const k of [a, b, cc, a, cc, d]) pos.push(...c[k]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export function buildSensorModel(markMat: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const housing = new THREE.MeshLambertMaterial({ color: 0x8c939d });
  const glass = new THREE.MeshLambertMaterial({ color: 0x1b2027, transparent: true, opacity: 0.8, side: THREE.DoubleSide });
  const dark = new THREE.MeshLambertMaterial({ color: 0x30353d });

  // base body: half circle at the front (centred on the rotation axis), long chamfers towards the narrow back
  const foot = new THREE.Shape();
  foot.moveTo(0, -HALF_W);
  foot.absarc(0, 0, HALF_W, -Math.PI / 2, Math.PI / 2, false);
  foot.lineTo(-23, HALF_W); foot.lineTo(-60, 35); foot.lineTo(BACK, 30);
  foot.lineTo(BACK, -30); foot.lineTo(-60, -35); foot.lineTo(-23, -HALF_W);
  group.add(new THREE.Mesh(extrude(foot, BOTTOM, BODY_TOP), housing));

  // scan window: frustum from r 75 at the body top to r 42 at the cap, open towards the back (±115° around +x)
  const winH = CAP_BASE - BODY_TOP, span = 4.0;
  const win = new THREE.CylinderGeometry(42, 75, winH, 48, 1, true, Math.PI / 2 - span / 2, span);
  win.rotateX(Math.PI / 2);           // cylinder axis y → z; theta π/2 points forward
  win.translate(0, 0, (BODY_TOP + CAP_BASE) / 2);
  group.add(new THREE.Mesh(win, glass));

  // rear block behind the window, narrowing upwards (159 → 84 wide in the rear view)
  const z0 = BODY_TOP, z1 = CAP_BASE;
  group.add(new THREE.Mesh(hexa([
    [BACK + 2, -35, z0], [-25, -65, z0], [-25, 65, z0], [BACK + 2, 35, z0],
    [BACK + 2, -42, z1], [-15, -42, z1], [-15, 42, z1], [BACK + 2, 42, z1],
  ]), housing));

  // flat top cap: round over the window, running back to the rear
  const cap = new THREE.Shape();
  cap.moveTo(BACK + 2, -42); cap.lineTo(0, -42);
  cap.absarc(0, 0, 42, -Math.PI / 2, Math.PI / 2, false);
  cap.lineTo(BACK + 2, 42);
  group.add(new THREE.Mesh(extrude(cap, CAP_BASE, HEAD_TOP), housing));

  // three M12 connectors on the rear face, 22 mm apart, sticking out 11.8 mm
  for (const [y, h] of [[-22, 24.5], [0, 37], [22, 24.5]]) {
    const plug = new THREE.CylinderGeometry(8, 8, 11.8, 16);
    plug.rotateZ(Math.PI / 2);
    plug.translate(BACK - 5.9, y, BOTTOM + h);
    group.add(new THREE.Mesh(plug, dark));
  }

  // measurement origin, visible through the window
  group.add(new THREE.Mesh(new THREE.SphereGeometry(6, 12, 8), markMat));

  group.scale.setScalar(0.001);
  return group;
}
