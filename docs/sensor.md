# The sensor

SICK MRS6224R-131001 at `192.168.178.200`.

| | |
|---|---|
| Layers × beams | 24 × 923 per scan, **10 Hz fixed**. More supply voltage does *not* give more scans; the mirror runs at 10 Hz. |
| Azimuth | −60…+60°, step 0.1301°. Azimuth = start/10000 − 90 in the telegram. |
| Elevation | About −13.2…+1.2° (vertical FOV about 15°, so only about 0.8 m of a body is visible at 3 m). Per-beam elevation comes from the VANGL channel. |
| Distance | 12.5 mm quantisation (DIST1 scale 12.5). |
| Echo filter | `FREchoFilter`: 0 first, 1 all, 2 last. The device is on **2 (last)**. |
| Mounting | The device parameter `UpsideDown` is **true**: the sensor is on its head. It already reports azimuth in world left/right, so only **z flips**. Flipping y as well mirrors the scene, which was a bug. |

## Interfaces

- **REST** `http://ip/api/<Var>`
  - `GET` returns `{"header":{status,message},"data":{Var:value}}`.
  - `POST` writes need challenge-response: `getChallenge`, then SHA256 over `user:realm:pw`, `POST:name` and the nonce (see `RestClient.login`).
  - The full variable list is in the SOPASair web UI's `current_msdd` zip (`descriptor.json`).
- **WebSocket** `ws://ip/scan`: MessagePack preview at only about 2 Hz, with big-endian uint16 × 12.5 mm distances. Too slow; not used by the viewer.
- **CoLa A, TCP 2111**: the full-rate source.
  - `sEN LMDscandata 1` streams one telegram per **layer**.
  - Channels: DIST1, RSSI1, VANGL (elevation; scale −0.00025, offset 1.5).
  - Layer angle is int16 in 1/200°.
  - Login: `SetAccessMode 04` with the password hashed as MD5, XOR-folded to 4 bytes, little endian.
  - `mEEwriteall` saves permanently; `sMN Run` leaves config mode.
  - Parser pitfall (fixed): after each channel, `i += 6 + n`.

## Quirks

- The sensor hung once (HTTP and CoLa stuck in FIN-WAIT-2). A power cycle fixed it.
- RSSI values stayed at or below 204 in an indoor recording (`rec_20261014_223527`), although the channel is uint16.
