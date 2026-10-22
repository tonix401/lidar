# Several sensors

Several MRS6224R around a shared area, so that people and objects are seen from all sides: their scans on one
timeline, each sensor's pose found automatically, and the scene and its objects shown in one world frame.

**Status (2026-10-20):** built and tested on simulated sensors only; the real sensors are not here yet. What
was measured and what is still open is [at the end](#measured-2026-10-20).

## Setup

- **Addresses:** every sensor needs its own IP. New units all ship with the same one; set it with SOPAS or the
  web UI for now (a set-ip tool is not written yet, see [open](#not-done-yet)).
- **Placement:** fixed, looking into the shared area from different sides, **within 10° of level** and each
  **seeing some floor** (the lowest layer looks down 13°, so about 4 m out at 1 m height). Overlap between
  sensors is what calibration and fusion use: the more of the floor and walls two sensors share, the better.
- **Starting:** run `make run` and add them on the source server's page (**Sensors**: name, address, mount); the live
  sensors restart with the new list, and the source server keeps it in its database (`source-server/data/source.db`,
  gitignored). Names: letters, digits, `_` and `-`. With none added, it connects one sensor at the default address.
- **Without sensors:** `make sim-session` writes a simulated 3-sensor session to `recordings/sim_rig3/`
  (45 s: 3 s empty, then one person walking a loop). With `make run ARGS="--offline"`, calibrate it on the source
  server's page (**Calibration**, target "recording sim_rig3") and replay it in the viewer. Each file's header holds
  its sensor's true pose under `truth`, to compare with.

## Time: one clock for all sensors

`source-server/src/clock.ts` (the source server; each sensor's loop in `live/loop.ts`). Every CoLa layer telegram carries the device time (`time_since_startup_us`,
µs since power-on). The client stamps each telegram with the host time it arrived (`Layer.received_s`).

- host time − device time = clock offset + network delay, and the delay is never negative. So the **lower
  envelope** of those differences is the offset, and its slope the drift between the two crystals.
- Per 1 s bucket the smallest difference is kept; the offset line is the edge of the **lower convex hull** of
  those minima above their mean time (the line under every point with the least total gap; Moon et al. 1999).
  Late telegrams (jitter, a stalled connection) only add points above the hull, so they never move it.
- Scan time = device time of its first layer + offset. That replaces the host receive time in recordings and
  in the frame meta, for every sensor, so all sensors' scans share the host clock.
- The device counter is taken as uint32 µs and unwrapped (it wraps every ~71.6 min; the field width is
  (inferred) from the telegram layout, not tested on the device). A power cycle (device time jumps back) or a
  difference far off the envelope starts the estimate over.
- **Measured** on simulated telegrams (24 per scan, 0.5 ms + exponential 3 ms delay, 1 % 50 ms spikes, 40 ppm
  drift): mapped times within 0.52 ms of the truth, 0.50 ms of it the smallest delay (the same for every sensor
  on the LAN, so it cancels between them); the same through the uint32 wrap and a 5 s stall; 1.3 µs per telegram.
- Whether the MRS6000 firmware offers NTP is unverified; this needs nothing on the sensors.
- The mirrors are not phase-locked: two sensors' scans are up to 50 ms apart. The static scene doesn't care;
  moving objects are moved to a common time in the fusion ([below](#objects-fused-from-all-sensors)).

`/api/sensors` shows each live sensor's offset and drift.

## Calibration: where each sensor stands

`libs/processing/src/fusion/calib/`, run by the source server (`source-server/src/calibration.ts`, on its page:
**Calibration**), guided by `calibrator.ts`, on the live sensors or on a recorded session (from its first frame, as
fast as the sensor workers go):
1. **Empty scene:** nobody in the area until every sensor has its empty scene and 2 s passed without a moving
   object.
2. **Walk:** one person walks a wide loop through the area all sensors see, for at least 30 s (and until every
   sensor tracked them at least 100 times).
3. **Solve** (about a second, in its own thread) and check: the page shows every sensor's empty scene from above
   in the solved poses, where walls seen by several sensors should lie on top of each other. **Use these poses**
   stores them (the live sensors' in the source server's database, a recording's in its files' headers), or **Discard**. Every
   processing server watching gets the new rig at once, and the viewer reloads it.

The world frame is the first sensor's levelled frame: z up, origin on the floor below it, x its forward
direction. The solve has three steps, each fixing what the one before can't:

1. **Floor → tilt and height** (`floor.ts`). RANSAC on the empty-scene points below the sensor whose own normals
   are near-vertical, then a PCA refit over the inliers. The floor normal in the sensor frame is the world's
   "up" as the sensor sees it: pitch = asin(−nₓ), roll = atan2(n_y, n_z), height = the plane's distance. A
   plane only counts if at least 3 layers see it (one layer's beams lie on a cone, and part of a cone passes
   for a tilted plane: this picked an 11.5° "floor" through wall hits before) and almost nothing lies more than
   0.1 m below it. Points' own normals keep out the foot of a wall that the lowest layer hits a few cm up.
2. **Walk → position and turn** (`walk.ts`). Each sensor tracks the person in its levelled frame; the tracks are
   the same curve, rotated and shifted. Pair the samples by time, fit the 2D rigid transform (Kabsch: the angle
   has a closed form), RANSAC over the pairs against moments where one track was wrong.
   - A detection's centroid is the middle of the side the sensor sees, about 2r/π ≈ 0.1 m in front of the
     body's axis; sensors on different sides see different halves, so each sample is pushed back 0.1 m
     (`VISIBLE_SIDE_OFFSET`). On the simulated cylinder (r = 0.2 m) the centroid sat 0.15 m out; what is left
     over is up to ~10 cm, which step 3 removes.
   - Time offsets between −0.3 and 0.3 s are searched for the smallest trimmed residual. The result is only
     applied beyond 25 ms (then with a warning to check the clock sync): on a loop a time shift partly looks
     like a turn, so the walk's offset is only good to ~10 ms, worse than the clock sync.
   - Sensors are placed one by one, each against the placed sensor it shares the most of the walk with.
3. **Static scene → all six degrees of freedom** (`icp.ts`). Point-to-plane ICP on the empty scenes: each
   point is matched to the nearest point of the other sensors and pulled onto its tangent plane; Gauss–Newton
   on the linearised motion, over match distances 0.5 → 0.25 → 0.1 m, the closest 80 % of matches kept.
   - **All sensors at once** (`jointIcp`): refining one sensor at a time let two sensors that overlap each other
     well slide as a block against a third that pins them only weakly (6–7 cm off with 2–7 mm residuals).
   - **Normals** by PCA over ±4 beams and ±1 layer, and some neighbours must be in another layer: beams of one
     layer alone lie on a line, whose "normal" is any direction around it. Across layers the same-surface
     tolerance is 10 % of the range, since on a floor seen at a grazing angle the next layer lands ~0.3 m
     further out. Getting this wrong cost 1.4 cm and 0.13° of bias at 3 mm noise.
   - **Unconstrained directions** (along a corridor; between sensors whose floor patches don't overlap) show as
     eigenvalues of the 6×6 normal matrix below 0.003 per match. They are left out of the step, so they keep
     the walk's estimate, and the panel names them.
   - A result more than 0.5 m or 8° from the walk's estimate is not used.

Each result lists the walk's residual, the scene's median residual and overlap, and any problem in words.

## Objects fused from all sensors

`libs/processing/src/fusion/objects.ts`. Every sensor keeps detecting and tracking in its own range image
([objects.md](objects.md)). With several sensors:
- each sensor's tracked objects become world points (`observe`, from the ranges the detector segmented: the
  smoothed output draws an object's mixed pixels at the wall behind it, metres away),
- they are moved to one common time by their own track's velocity,
- observations whose footprints are less than 0.3 m apart merge (never beyond 1.6 m, as within one sensor),
- and one world tracker (the same Kalman tracker) tracks the merged detections: one track per real object,
  with its box and height from every sensor's points and its centre from each view's centroid pushed back by
  0.1 m.
The fusion runs once per drawn set of scans ([below](#the-page-with-several-sensors)). The page highlights every sensor's beams of an object in
that object's colour; **Colour by → Sensor** shows which sensor saw what.

## The page with several sensors

- **3D:** each sensor is drawn where it stands (its own group in the scene, `render/scene3d.ts`), with its
  housing and field of view; range rings around the world origin.
- **All sensors update together** (`fusion/sync.ts`): each scan is processed when it arrives, but drawn as part
  of a set, once every sensor still sending has a new scan (or 150 ms after the set's first, so a stalled sensor
  never freezes the others). Without it, the view updated sensor by sensor, a third of a scan apart. The objects
  are fused at the set's newest scan time, and each tracked object's points are moved along its velocity to
  that time too (a set's scans are up to ~70 ms apart, ~7 cm at walking speed). In the e2e test every set held
  all three sensors, updated within ~8 ms of each other, ~10 sets/s.
- **Sensors** section (only with several sensors): a row per sensor (rate, calibrated or not, show/hide); a
  click on a row makes it the **primary** sensor, which the range image, the map, the statistics and the
  charts show. The map shows the fused objects moved into that sensor's frame.
- **One wall where sensors overlap** (Display, on by default; `fusion/surfaces.ts`): where several sensors see
  the same static surface, each one's mesh lies a few mm to a cm off the others' and the two interleave. About
  once a second, from each sensor's remembered wall (else its empty scene):
  1. *interpolate*: per 15 cm voxel, each sensor's mean point and normal estimate the surface there; every point
     moves along its own beam onto the weighted mean of those estimates (weight (|n·u| / distance)²: close,
     frontal views count most). All sensors' points then lie on one surface, so the seam has no step.
  2. *show it once*: each spot is drawn by the sensor that sees it best (that weight, computed exactly from each
     sensor's position, so the handover is a smooth line); the others hide their beams there, except a one-beam
     band along the seam so the two triangulations leave no crack.
  Only beams that still see their static surface take part: a person in front is drawn as measured. Beams without
  a normal of their own (edges) borrow their voxel's; beams seen nearly edge-on are hidden or kept, never moved.
  Measured (`tests/surfaces.test.ts`): a back wall seen by two sensors, one placed 1.5 cm off, from 14.8 mm apart
  to 0.5 mm; on that wall 19 % of 10 cm cells are drawn by both (the seam band), none by neither; 85 ms for three
  sensors at 24 × 923. Left over: a few streaks of floor that a far sensor sees at a grazing angle. Where the
  owning sensor's view of a wall is blocked by a person, its remembered wall ("Walls behind moving objects")
  fills it; with that off, the spot stays empty.
- **Colour by → Distance to main sensor**: every point coloured by its distance from the primary sensor, on one scale for all sensors, so overlapping surfaces don't clash ([viewer.md](viewer.md#views)).
- Processing settings are shared; layer calibration is stored per sensor name.

## The other sensors in the processing

Each sensor's pipeline runs on its own range image, but the other sensors can tell it which of its returns are
not real: **Cross-check with other sensors** (`pipeline/crosscheck.ts`, a stage in Processing, on by default).

- **The idea:** a ghost (a mixed pixel between a person's outline and the wall behind, dust) floats in space
  that a sensor looking from elsewhere sees as empty: its beams around that point all return clearly farther away.
- **The test:** project the point into each other sensor's range image (`OtherSensor`: this sensor's frame →
  theirs, their latest ranges); it is seen through if every one of their beams around it returns more than
  0.15 m + 1 % farther. Around it = the two layers bracketing its elevation (on a floor seen at a grazing angle
  the lower one lands in front) and ±1 beam beside it. "No return" never counts (dark surfaces).
- **Moving objects:** the other scan is up to a scan old and the object has moved since, sideways too, so the
  other sensor's beams pass beside its real edge. On moving beams the window widens by the angle the object can
  have moved (2 m/s × the scan's age) and the margin by that distance. Without this, 13 real points per scan were
  cut from people's edges and the ghosts *increased* (the temporal model filled the gaps with stale ranges).
- **Twice:** on the new scan after the outlier filter (so the temporal model, history, background, object
  detector and remembered walls never learn from a ghost), and on the final output after clean outlines (what
  the smoothing still shows although another sensor sees through it: a range held through a dropout, a person
  the temporal model has not let go of yet). Each output value is judged on its own: a beam dropped from the
  scan usually holds the right surface (the wall behind a mixed pixel), and that stays; dropping it as well
  cost 6.7 real points per scan.
- Only between calibrated sensors and never while calibrating: with wrong poses they would "see through" each
  other everywhere. Statistics → Removed by filters → "Seen through by another sensor" counts both passes.
- **Measured** (`tests/crosscheck.test.ts`: the simulated rig with mixed echoes at 40 % of outlines and 1 cm
  noise, the same scans with the stage off and on, 50 s of scans per sensor after a warm-up), per scan and sensor:

  | | off | on |
  |---|---|---|
  | ghosts (> 0.2 m off the true surface) in the input | 55.1 | 55.1 |
  | … after outlier filter / cross-check (what the models learn from) | 33.2 | 20.5 |
  | … in the output (what is drawn) | 21.6 | 16.1 |
  | real points the check removed | – | 0.06 |
  | correct points only this run shows (the runs drift apart a little) | 0.8 | 5.2 |
  | confirmed tracks | 1 | 1 |

  The simulation has no dust or multipath, and its walker made no ghost tracks without the stage either; on the
  real sensors the mixed pixels are the thing to compare (see "Not done yet").

## Recording and replay

All live sensors record together into a session folder ([recordings.md](recordings.md#sessions)); a session
replays as one timeline, each scan to its sensor's feed, with the poses it was recorded or calibrated with.

## Measured (2026-10-20)

On the simulated rig (`libs/processing/sim/rig.ts`: three sensors around an 8.5 × 6.2 m room with furniture,
1–1.2 m up, tilted up to 2.5°; 24 × 301 beams; tests in `tests/calib.test.ts`, `tests/fusion-objects.test.ts`):

| | result |
|---|---|
| floor: tilt, height | within 0.1°, 1 cm (all three) |
| walk alone (ideal detections, 2 cm noise) | 3 cm, 0.3°; time offset to ~10 ms |
| ICP, b against a ∪ c, from 20 cm / 5° off | 0.5 mm, 0.004° at 3 mm noise |
| whole rig from the pipeline's own background and tracks (1 cm noise) | b 1.3 cm / 0.10°, c 1.05 cm / 0.08° (walk alone: 9–11 cm) |
| in the browser (e2e, 24 × 181 beams) | within 5 cm / 0.5° (asserted) |
| fused objects | one world track in 100 % of ticks (3 per-sensor tracks), median 2.4 cm from the true axis, 90 % within 3.8 cm |

**Speed** (2026-10-20, 12-thread desktop, RTX 2060; `make profile` and headless Chromium replaying
`recordings/sim_rig3`, three sensors at the real 24 × 923 beams, 30 scans/s in all):

| | before | now |
|---|---|---|
| pipeline per scan and sensor (Node, `make profile`) | 55 ms | 29 ms |
| of it: planes · cross-check (both passes) · moving-area smoothing · spatial | 14 · 12.5 · 7.6 · 4.8 ms | 6.1 · 2.9 · 3.9 · 3.0 ms |
| shared-surface merge (once a second) | 57 ms | 19 ms |
| scans processed in the page, of 30/s (software GPU, SwiftShader) | 13 | 28.8 |
| scans processed in the page, of 30/s (the RTX 2060) | — | 29.8 |
| scan sets drawn per second, of 10 | — | 9.8 |
| frame rate · main thread in long tasks | — | 59 fps · 3 % |

Each sensor's pipeline runs in its own Web Worker (`clients/debug/src/worker/host.ts`), so the three are processed in
parallel. The page keeps a mirror of each Processor's grid and objects, filled after every scan from one packed
buffer that it hands back for the next scan (`clients/debug/src/worker/snapshot.ts`), and the main thread only builds the
geometry and draws. A worker that is still busy keeps just the newest waiting scan. With the workers off (same
GPU), 26 of the 30 scans/s are processed and the page draws 24 fps.

The pipeline got faster without changing its output: the golden checksums are byte-identical. Each beam's
point is computed once instead of once per window it falls in (planes, moving-area smoothing), constant terms
are hoisted out of the inner loops (bilateral), the eigenvector solver no longer allocates, the rays are only
recomputed when the scan geometry changes, and the 3 × 3 minimum of the background is taken separably. The
cross-check uses a binary search for the layer and no `Math.hypot`, which is slow in V8. Its counts are
unchanged to two decimals. The surface merge keeps its voxels in an open-addressing table instead of a `Map`
keyed by numbers above 2³¹, which V8 hashes as heap numbers; its output is identical to the old one. The 3D
view uploads only the parts it draws, and of those only the used range.

## Not done yet

- **Drift watch:** re-checking the static residual every ~30 s to flag a sensor that was bumped.
- **Setting a sensor's address** from here (a Bun tool or the source server's page): (left out until it can be tried on a device; a wrong
  network write can make a unit unreachable).
- **On the real sensors:** cross-talk between sensors facing each other (outliers and ghosts with the other one
  on vs. off), the walk calibration, the doubled-wall thickness and the fused person's height against the real
  one. Before they arrive: record the static room from 2–3 spots with the one sensor and calibrate those
  against each other (floor + ICP; the walk needs simultaneous sensors).
- Colour by height uses each sensor's own frame, not the world's.
- Other uses of the other sensors in the processing, not built: confirmation raising a beam's confidence where
  another sensor sees the same surface; the background (empty scene) of a spot one sensor never sees empty,
  taken from another that does; motion detection confirmed by a second view.
