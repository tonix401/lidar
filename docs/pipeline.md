# Viewer pipeline (`frontend/src/pipeline/`)

All processing runs in the browser. Object detection is described separately in [objects.md](objects.md).

## Stages

The scan is handled as an organized range image (layer × beam), in this order:

1. **Intensity filter**: RSSI min/max, with a histogram.
2. **Layer calibration**: per-layer distance offsets learned live from leave-own-layer-out plane fits. This removes the horizontal "waves" on walls.
   - The degree-0–2 polynomial modes are projected out. Left free, they drift: a 16° wall tilt after about 12 min, and an 8 cm bow.
   - Storage key `mrs6000.layerbias.v2`.
3. **Motion detection** (adaptive per area), run on the unfiltered scan:
   - A per-beam z-gate of 3σ.
   - The beam model must be established (5 or more scans).
   - Changed beams form clusters; clusters smaller than 8 beams are dropped.
   - Clusters grow into the object up to 12 steps, never into beams that match their own background.
   - Beams stay "moving" for 10 scans (Dynablox-style).
4. **Outlier filter**: neighbour support within the layer, relaxed in moving areas.
5. **Temporal smoothing**: Kalman-style per beam, with learned noise σ, change confirmation, and a second background mode for edges.
6. **History filter**: drops flickering beams using the last 32 scans and adds confidence weights.
7. **Bilateral filter**: the range σ adapts to each beam's noise. Moving beams are left to the next stage.
   - **Moving-area smoothing** (`dynsmooth.ts`): 3D smoothing within one scan for moving beams (people), which the per-beam stages pass through almost raw.
     - Each moving point becomes the weighted mean of the 3D points within `radius` (auto: 3× noise floor, at least 4 cm).
     - The weights are split into across the beam (σ = radius/2) and along it (σ = 2× the beam's range noise). The beams are far closer together (0.13°, about 7 mm at 3 m) than the range noise (about 30 mm), so one isotropic Gaussian mostly weighs noise; that version only got roughness from 18.6 to 15.4 mm.
     - Only moving neighbours or ones in front of the empty-scene background count, so a person never blends into the wall.
     - The mean is projected back onto the beam's own ray, so the grid stays organized.
     - Mixed pixels are dropped: a beam on a depth jump of more than `gap` between its two opposite neighbours that matches neither side. At the outline of an arm the sensor merges arm and wall/torso into one in-between echo.
   - **Radial cells** (`cells.ts`, experimental, off by default, see [below](#radial-cells-what-was-tried)).
8. **Plane flattening**: PCA plane fit per point; the point moves along its ray when the patch is flat within about 2× the noise floor.
9. **Organized mesh**: breaks at depth jumps.
10. **Clean outlines** (`outline.ts`, stage "Clean outlines", on by default):
    - **The known wall wins:** wall a person has just uncovered stays "moving" for 1 s and would be processed almost raw (4.6–6.4 mm scan-to-scan jitter, against 0.2 mm for the rest of the wall). A moving beam whose return matches its remembered wall within 3σ is drawn as that wall.
    - **In front** (`front` mask): in front of the empty scene by the detector's foreground tolerance (~30 cm), or a moving beam more than 3σ in front of its remembered wall (feet on the floor, a hand on the wall), with at least 2 such neighbours (a lone noisy wall beam would cut a hole). "Empty scene" is the object detector's background, else the remembered wall, so no confirmed track is needed.
    - **Mixed pixels, person side:** a beam in front, on the outline, more than `margin` (auto: 4× noise floor, at least 10 cm) + 2 % behind its nearest in-front neighbour lies between person and wall; it is dropped and the remembered wall is drawn there.
    - **Mixed pixels, wall side:** a beam next to the outline that is not in front but more than 3σ in front of its remembered wall is put back onto the wall.
    - **Mesh:** no triangle joins a beam in front to one that isn't (the mesh's own jump threshold, 0.3 m + 3 %, is larger than the gap between a person and the wall right behind them), and a triangle of beams in front seen within ~7° of edge-on (|n·ray| < 0.12) is not drawn: it shows range noise along the beam, not surface (the points stay). The remembered wall is only joined to measured beams that see their remembered wall.
    - Measured as triangles next to objects within ~6° of edge-on (spikes), stage off → on: `rec_20261014_223527` 202 → 70 per scan, `rec_20261014_185611` 371 → 150; in the page at a person walking at 0.9 m/s (0:29), 117 → 7. Object beams still drawn: 96.4 → 93.1 % and 94.7 → 89.0 % (mixed pixels dropped). The wall behind a person: roughness 3.6 → 2.2 mm and 7.0 → 6.4 mm, jitter → 0.
11. **Remembered walls** (`wall.ts`, display option "Walls behind moving objects", on by default):
    - Each beam returns one range, so a person hides the wall behind them and leaves a person-shaped shadow in it.
    - Each beam remembers the average of its static output ranges (up to 20, `wallN`), but only if they are not in front of the object detector's empty-scene background, so a person standing still is never remembered as wall. Averaging matters: a beam the person has just left restarts its temporal average, and remembering only the latest static output made the wall behind people about 3× rougher than the wall itself.
    - That background starts as the first scan and only learns within 0.3 s that a wall is behind whatever stood there; a remembered range that turns out to be in front of it is replaced by it (one raw reading, refined by every later return that matches it).
    - A remembered wall only changes after a new static surface has been seen 5 scans in a row. When drawn, a value that sticks out from its neighbours' memories (5 cm + 1 %) is replaced by their median, and a young memory (fewer than 20 readings) by a plane through its neighbours' memories, intersected with its beam. Single readings at outlines are often mixed pixels, and remembering one draws a spike.
    - Where a moving beam, or any return in front of the empty scene, hides the remembered surface, the surface is drawn too (a little darker), as a second vertex per beam meshed with the wall around it (`render/geometry.ts`: vertex N + i).
    - On both recordings, 99.6–100 % of the hidden wall beams are filled once the wall behind has been seen, with at most 7 beams per scan drawn more than 0.3 m in front of the empty scene.

## Auto and manual mode

**Auto mode** (the default) derives all settings from the measured noise floor (the median σ of steady beams). The intensity filter and object detection always stay user-controlled. **Manual mode** keeps its own settings.

## Metrics and results

**Moving-area metrics** (panel row "Moving areas", `Processor.stats`, `pipeline/metrics.ts`):
- *rough*: median deviation of a moving beam from its same-surface 3×3 neighbours (mm).
- *flicker*: share of moving beams that switched between object and background (the object detector's empty-scene model) since the last scan.

Results on the recorded walk (Auto):
- Wrong or missing moving beams fell from 73% to about 5.6%.
- Static surfaces have about 3.2 mm noise.
- Layer calibration reduces the plane residual from about 26 to 16 mm.

### Moving people (2026-10-14)

Measured headless over two recordings of a person close to the sensor (gesturing, walking), auto mode, after a 3 s warm-up. *Jitter* is the median scan-to-scan range change of beams that stay on the same moving surface.

| Recording | Setting | Rough | Jitter | Flicker | Static noise | ms / scan |
|---|---|---|---|---|---|---|
| `rec_20261014_185611` (16 s) | before | 18.6 mm | 14.6 mm | 8.2 % | 3.0 mm | 16 |
| | moving-area smoothing | 8.3 mm | 7.3 mm | 8.3 % | 3.0 mm | 23 |
| | + radial cells | 8.3 mm | 7.3 mm | 8.3 % | 3.0 mm | 25 |
| `rec_20261014_223527` (39 s) | before | 14.4 mm | 19.1 mm | 10.9 % | 2.7 mm | 17 |
| | moving-area smoothing | 5.2 mm | 12.5 mm | 10.9 % | 2.7 mm | 23 |
| | + radial cells | 5.2 mm | 12.3 mm | 10.8 % | 2.7 mm | 23 |

The share of moving beams is unchanged by both stages (motion detection runs before them).

### Radial cells: what was tried

Columns of 4 × 2 beams radiating from the sensor, each with up to 4 depth slots (α-β filtered range, OctoMap-style log-odds occupancy with hysteresis).
- *Temporal range correction* (shift a slot's beams by filtered − measured range): jitter got **worse**, 7.3 → 9.9 mm (window 10: 10.5 mm; correcting only steady slots: 8.3 mm). A column mixes surfaces (arm and torso), so its median jumps whenever the mix changes, and the filter turns that into per-column offsets. Removed.
- *Occupancy gate* (drop beams of slots with fewer than `confirm` hits): flicker 8.3 → 6.6 %, but only by erasing the tips of fast-moving arms and hands as they enter new columns. Now a new slot next to a confirmed one at a similar range is confirmed at once; then the gate touches about 1.5 beams per scan and is neutral.
- *Dropout fill*: no effect; temporal smoothing already holds a beam through short dropouts.
- The stage stays as an experiment (user-controlled, off by default, colour by "Radial cell" to see the columns).

## Not done yet: the echo test

The device runs on the last echo. Record the same walk with `mrs6000 echo-filter first` and with `last` (no `--save`; restore afterwards) and compare *flicker* and the outline. Streaming several echoes (`cola.py` parses them, `stream.py` and `frames.py` only send `echoes[0]`) is only worth it if the difference is large. Recording more echoes would also need a `.tpc` format change ([recordings.md](recordings.md)).

## Views

- 3D, with Perspective / Top / level Side / Front cameras and the FOV fan.
- 2D map (top-down).
- Range image with square cells. Grey means no return; pink means removed by filters.
- 3D renders on demand (about 10 renders/s with a still camera).
- Defaults: draw **surface + points**, colour by **distance**.
