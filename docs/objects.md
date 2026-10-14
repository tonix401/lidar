# Object detection and highlighting (work in progress)

Runs in the browser (`frontend/src/objects/`), after the [pipeline](pipeline.md) stages.

## Research basis

The approach follows the fixed-sensor ("roadside LiDAR") literature:
- Zhao et al. 2019, *Detection and tracking of pedestrians and vehicles using roadside LiDAR sensors*: the background filter → cluster → classify → track pipeline.
- Wu et al., 3D-DSF background filtering.
- Zhao et al., azimuth-height background filtering.
- Bogoslavskyi & Stachniss, IROS 2016 / 2017, *Fast range image-based segmentation of sparse 3D laser scans* ("depth clustering", the angle criterion).
- SORT / AB3DMOT-style Kalman tracking.

Neural detectors (PointPillars, RangeNet++) were rejected: they are trained on 64-beam car data, have a large domain gap and need a GPU.

## What is implemented

The "Object detection" stage in the Processing panel section:

1. **Slow background.** Each beam learns the range of the empty scene.
   - A nearer surface is adopted only after `learn` s (20 s); a farther one (the background revealed) after 0.3 s.
   - Beams under a tracked, moving object are never adopted.
   - Objects that never moved are released ("static object") after `learn` s.
2. **Foreground**: returns more than `minDiff` (0.15 m) + 3σ + 1% in front of the **nearest background among the beam and its 8 neighbours** (neighbourhood background). At a static depth edge a beam alternates between the near and the far surface or returns a mixed range in between, and a beam whose own background is "no return" (dark surface, edge, far away) used to count every sporadic return as foreground: those were most of the ghosts.
3. **Segmentation**: BFS on the range image. Neighbours join if `d1 − d2·cosψ ≤ d2·sinψ/tanθ + margin`. The noise margin is needed because the beams (0.13°) are closer together than the range noise. A segment that lies behind a neighbouring segment (by more than the foreground tolerance) with at least 60 % of its beams within 2 beams (±1 layer) of it is that object's fringe (mixed pixels between a person and the wall, only 1–3 beams thick) and is dropped instead of becoming its own object. The test is thickness, not size: an object partly hidden behind another one has an inside away from the occluder. Its limit is angular: a sliver less than about 4 beams wide (about 3 cm at 3.6 m) beside an occluder counts as fringe.
4. **Merging**: fragments merge when their footprints are less than 0.3 m apart, capped at a 1.6 m footprint.
5. **Tracking**: a constant-velocity Kalman filter on x/y, greedy nearest-neighbour association within a 0.8 m gate, confirmed after 3 hits, kept for 10 scans when lost.
6. **Classification** (rule-based):
   - "person" if visible height ≥ 0.35 m, footprint ≤ 1.7 × 0.9 m (an adult's arm span is about their height), and either it moved or it is ≥ 1 m tall.
   - The per-scan verdict is averaged (EMA 0.25) with hysteresis: a track becomes "person" above 0.6 and stays one down to 0.3, so a gesture doesn't flip the label.
   - Otherwise "moving object", "object" or "static object".
   - Objects touching the top or bottom layer are flagged clipped: their height is only a lower bound.

## Display

- **Highlight** colours each confirmed object in its own colour (golden-ratio hue steps per id).
  - Segmented but not yet confirmed beams are light grey.
  - A static object is drawn paler; with a selection, the other objects are drawn at 45 %.
- **Dim background** darkens everything else while at least one object is confirmed: towards black (12 % of the colour kept) in the dark theme, towards the background (35 % kept) in the light theme (`TintOptions.dimTo`, `ObjectDetector.tintBackground`). It only works with highlighting on.
- 3D boxes, labels and trails; the same overlays on the 2D map; boxes and labels on the range image (no trails there).
- An object list; click a row, a label or the object in a 2D view to select; follow mode keeps the selected object centred (3D and map).

## Measured (2026-10-14)

Over `rec_20261014_223527` (39 s) and `rec_20261014_185611` (16 s), one person each, auto mode, after a 3 s warm-up. Ground truth offline: the empty scene is each beam's 85th-percentile range over the whole recording; a real object is a connected region of at least 150 beams more than 0.4 m in front of it; a confirmed track overlapping it less than 30 % is a ghost.

| | ghosts per scan | distinct ghosts | person found | person track ids | labelled "person" |
|---|---|---|---|---|---|
| `…223527` before → after | 0.59 → 0.03 | 12 → 2 | 100 % → 100 % | 2 → 1 | 85 → 93 % |
| `…185611` before → after | 1.50 → 0.03 | 12 → 1 | 100 % → 99 % | 7 → 3 | 59 → 78 % |

The neighbourhood background alone took ghosts to 0.08 / 0.33 per scan, the fringe rule most of the rest.

**How it was measured** (a throw-away harness, not in the repository):
- The frontend modules (`Processor`, `ObjectDetector`) were bundled for Node with the frontend's own rolldown and fed the raw scans of a recording at its own timestamps. The auto-mode settings were re-derived every 10 scans, as on the page ([development.md](development.md#measuring-on-recordings-offline)).
- After a 3 s warm-up, each confirmed track was compared with the ground truth regions above.
- The same harness gave the outline and wall numbers in [pipeline.md](pipeline.md). It is worth rebuilding when a change needs numbers: the page's own Statistics box only shows one scan at a time.

These two recordings are only a check: no rule or constant refers to them. Thresholds come from the measured noise (σ), the sensor geometry (beam width, layer spacing) or human size, and the unit tests (`tests/objects.test.ts`) cover scenes the recordings do not contain: a static pillar whose edges return mixed ranges plus a dark wall patch with 30 % returns (no track at all, then exactly one for a person walking in), a person at 8 m, and a small object half hidden behind a person.

## Status / next steps

- **Box size:** the person's box is now 0.8 × 0.7 m (median; 1.2 × 0.7 m when gesturing) with about 1,180 beams at 3 m; it used to be about 1.5 × 1.2 m with 1,500 beams.
- **"Person" needs motion** unless at least 1 m is visible: with the 15° vertical field of view, someone closer than about 4 m only counts as a person after moving 0.5 m.
- **A hand or arm can still split off** as its own short track (merging only joins footprints up to 0.3 m apart).
- Feeding many replay frames per second makes browser processing the bottleneck (about 60 ms per frame in headless Chromium).
