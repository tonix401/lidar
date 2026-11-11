# The sensor

SICK MRS6224R-131001 at `192.168.178.200`.

| | |
|---|---|
| Layers × beams | 24 × 923 per scan, **10 Hz fixed**. More supply voltage does *not* give more scans; the mirror runs at 10 Hz. |
| Azimuth | −60…+60°, step 0.1301°. Azimuth = start/10000 − 90 in the telegram. |
| Elevation | About −13.2…+1.2° (vertical FOV about 15°, so only about 0.8 m of a body is visible at 3 m). Per-beam elevation comes from the VANGL channel. |
| Distance | 12.5 mm quantisation (DIST1 scale 12.5). |
| Echo filter | `FREchoFilter`: 0 first, 1 all, 2 last. The device is on **2 (last)**. |
| Mounting | The device parameter `UpsideDown` is **true**: the sensor is on its head. It already reports azimuth in world left/right, so only **z flips**. Flipping y as well mirrors the scene, which was a bug. The reported elevations count the opposite way from the housing's "up": see [Housing](#housing). |

## Housing

The dimensions come from the MRS6000 operating instructions, figure 20 (Maßzeichnung). They are in mm, measured from the **measurement origin** (⑧), which is where the 3D view's points start. The origin lies on the scan's horizontal axis (④).

| | |
|---|---|
| Origin height | 107.2 above the underside |
| Origin, front to back | 64.5 in front of the rear face, and 88 behind the front, which makes the body 152.5 deep. The rotation axis (③) is 54.5 in front of the rear face, so it sits 10 mm behind the origin. |
| Body | 176 wide, 84 high. Seen from above, the front is a half circle around the origin. The rear corners are cut off at a long angle, down to the narrow back where the connectors are. |
| Head | The scan window slopes up from the body top to a flat top cap, 136.8 above the underside. From behind, the head narrows from about 159 wide at the body to 84 at the top. |
| Depth with connectors | 164.3. Three M12 connectors on the back stick out 11.8: the middle one about 37 above the underside, the outer ones ±22 to the side at about 24.5. Keep 50 behind the sensor free for the cables (⑥). |
| Mounting holes | M6 × 10 on the sides (⑤), 25 apart vertically, the lower one 35.8 above the underside. |
| Horizontal FOV | 120° (①) |

**Elevation sign.** Measured from the housing, the drawing's beam fan rises from about −1.5° to +13.5° above the horizontal axis, with the head up. With the viewer's "upright" mount the device reports −13.19° to +1.19°, mostly downward: the same 14.4° fan, mirrored. So in the data, "upright" means the window is at the bottom, and the viewer's "upside down" (z mirrored, [above](#the-sensor)) means the window is at the top.

**The 3D model** (`clients/debug/src/render/sensorModel.ts`) is a simple housing built to these dimensions, with the head pointing +z. `Scene3D.buildGuides` mirrors it in z by `-mountZSign(mount)` (`pipeline/rays.ts`), the opposite of the rays, because of the elevation sign above. Use a mirror (`scale.z`), not a rotation: the data flips only z. The model is symmetric left to right, so a rotation looks the same, but it is a different transform from the data's. Estimated from the drawing rather than read off it: the window radii (75 at the body top, 42 at the cap), the corner cut-offs and the connector heights.

## Interfaces

- **REST** `http://ip/api/<Var>`
  - `GET` returns `{"header":{status,message},"data":{Var:value}}`.
  - `POST` writes need challenge-response: `getChallenge`, then SHA256 over `user:realm:pw`, `POST:name` and the nonce (see `RestClient.login`).
  - The full variable list is in the SOPASair web UI's `current_msdd` zip (`descriptor.json`).
- **WebSocket** `ws://ip/scan`: MessagePack preview at only about 2 Hz, with big-endian uint16 × 12.5 mm distances. Too slow; not used by the viewer.
- **CoLa B, TCP 2112**: the full-rate source the source server streams from (`source-server/src/cola.ts`, `parseLmdScandataB`).
  - Framing: `02 02 02 02`, uint32 payload length (big endian), payload, XOR of the payload bytes. Commands are their text with binary arguments: `sEN LMDscandata ` + byte `01`.
  - The telegram has the same fields in the same order as CoLa A, as fixed-width big-endian integers: version, device number (uint16), serial (uint32), status (2 × uint8), telegram and scan counter (uint16), time since start-up and time of transmission (uint32, µs), input and output status (2 × uint8 each), layer angle (int16, 1/200°), scan and measurement frequency (uint32); encoders (uint16 count, uint32 + uint16 each); 16-bit channels (uint16 count; each: 5-character name, float32 scale and offset, int32 start angle, uint16 step, uint16 count, the values).
  - About 133 kB per scan against 258 kB in CoLa A, and parsed in about half the time (`0.37` against `0.74` ms per scan on one core at 3.4 GHz).
  - Checked on the device (2026-11-03): 29 scans streamed over CoLa B gave exactly the frames (all 22152 distances and rssi values, and the elevation table) that CoLa A gave for the same scans.
- **CoLa A, TCP 2111**: the same telegrams as ASCII hex tokens. The configuration commands (`ColaClient` login, read, write, save) use it, as their arguments are text; `colaScans(…, "A")` still streams from it.
  - `sEN LMDscandata 1` streams one telegram per **layer**.
  - Channels: DIST1, RSSI1, VANGL (elevation; scale −0.00025, offset 1.5).
  - Layer angle is int16 in 1/200°.
  - Login: `SetAccessMode 04` with the password hashed as MD5, XOR-folded to 4 bytes, little endian.
  - `mEEwriteall` saves permanently; `sMN Run` leaves config mode.
  - Parser pitfall (fixed): after each channel, `i += 6 + n`.

## Several sensors

See [multisensor.md](multisensor.md): each needs its own IP, should stand within 10° of level and see some floor. Cross-talk between sensors facing each other has not been measured yet.

## Quirks

- The sensor hung once (HTTP and CoLa stuck in FIN-WAIT-2). A power cycle fixed it.
- RSSI values stayed at or below 204 in an indoor recording (`rec_20261014_223527`), although the channel is uint16.
