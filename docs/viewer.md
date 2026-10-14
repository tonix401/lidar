# The viewer page (`frontend/`)

What the page shows and how its controls behave, then how the panel is built ([below](#how-the-panel-is-built)). The processing behind it is in [pipeline.md](pipeline.md) and [objects.md](objects.md).

## Views

The three views are tabs near the top of the panel (keys **1 / 2 / 3**):
- **3D:**
  - Perspective / Top / level Side / Front cameras.
  - Range rings, the ±60° field of view and the vertical fan of the lowest and highest layer.
  - It renders on demand: about 10 renders/s with a still camera, one per scan.
  - A model of the sensor housing sits at the origin. It is mirrored with the mount setting, so with "upside down" the window is at the top ([sensor.md](sensor.md#housing)).
- **2D map:**
  - Top-down, with the sensor at the bottom looking up.
  - Range rings and a scale bar.
  - Hover inspects a point, click selects an object.
- **Range image:** the organized scan itself, layers as rows and beams as columns (left = +60°, the sensor's left).
  - Grey means no return; pink means removed by filters.
  - It always shows every layer and range, ignoring the Layer and Max range settings. Hidden beams would otherwise look "removed by filters".
  - **Angle-true cells:** rows are as tall as the layers are apart in angle (about 0.6°, or 4.6 beam steps of 0.13°). With 923 beams, square cells made the image a 24 px strip at 1 px per beam; now it is about 110 px tall, and shapes keep their proportions. The header shows the cell size, e.g. "cell 1 × 5 px".
  - **Mounting:** the top row is the highest layer in the world, so the rows flip with an upside-down mount (the sensor's layer 0 is then on top). Columns don't flip: the device already reports left/right in world terms ([sensor.md](sensor.md)). The elevation axis and the hover tooltip show world elevation (the sensor's elevation, negated when upside down).

**Draw modes** (3D and the map; `drawParts()` in `render/scene3d.ts`):

| Mode | What it draws |
|---|---|
| surface | the mesh |
| surface + points (default) | the mesh and the points |
| points | the points only |
| layer lines | each layer joined beam to beam |
| vertical lines | each beam joined to the same beam one layer down (`Geometry.vIdx`) |
| layer + vertical lines | both, a grid |
| points + layer lines | the points and the layer lines |

Lines break at the same depth jumps as the surface (Display → Mesh / lines). Seen from above (map), a surface is drawn as its layer lines, and vertical lines become short radial strokes.

**Colour by:** uniform (shaded), RSSI, distance (default), height, layer, noise σ, confidence, area class, radial cell. The legend under the selector shows the range; area class and radial cell show counts instead.

## Panel

From top to bottom:
1. **Title**: device type, plus serial number and firmware (or "replaying <file>"; hover for the full name). The ‹ button (or **H**) folds the whole panel to this line.
2. **Status boxes.** Each folds on its own, starts folded and remembers its state:
   - **Stream** `24×923 @ 10.0 Hz` (the dot: green = data, amber = paused, red = no data).
   - **Device**: connected / disconnected / no sensor (offline).
   - **Statistics** `NN ms per scan`: every number computed live, grouped. Groups without rows are hidden:
     - *Timing*: processing ms; renders/s (3D); triangles (3D with a surface).
     - *Scene*: noise floor and share of moving beams (auto mode only, from its noise estimate).
     - *Removed by filters*: one row per active filter (intensity, outliers, flicker, mixed pixels, spikes, at outlines).
     - *Moving areas (people)*: roughness and flicker ([pipeline.md](pipeline.md#metrics-and-results)).
     - *Objects*: count (people), foreground beams, detection time.
3. **Recording & replay**: the source and **● Record**. Recordings are listed by name and duration, with ▶ and ⋯.
   - Clicking the row plays it too.
   - ⋯ opens a menu with the size, scan count and date, Download and Delete…; Delete asks first. Click outside or on ⋯ again to close it.
   - The playing recording has a blue left edge; one being recorded has a red dot.
4. **View tabs**, with **Pause** for the live view. Pause is hidden during a replay, where the replay bar has play/pause.
5. **Display**: visual settings only, and only those that change something in the current view (below).
6. **Objects**: the object list (click to select), with a count badge in the heading.
7. **Processing**: what changes the data, the same in every view.
   - Mounting, auto / manual, the preset (manual only).
   - "Filters & smoothing": the stages, including Remembered walls, Clean outlines and Object detection.
   - Reset to defaults (manual only).

Recording & replay, Display, Objects and Processing fold by their headings (remembered; open by default). Problems (server, sensor, processing, failed actions) are listed at the bottom of the panel, which stays visible when the panel is folded.

**Display settings per view:**

| Control | 3D | 2D map | Range image |
|---|---|---|---|
| Draw | ✓ | ✓ | – |
| Colour by, legend | ✓ | ✓ | ✓ (uniform → distance) |
| Walls behind moving objects | ✓ (only while Remembered walls is on) | – | – |
| Layer, Max range | ✓ | ✓ | – |
| Point size | ✓ with points | ✓ with points | – |
| Mesh / lines (break at jump) | ✓ with surface or lines | ✓ with surface or lines | – |
| highlight, dim background, boxes, labels | ✓ | ✓ | ✓ |
| trails, follow selected | ✓ | ✓ | – |
| Perspective / Top / Side / Front | ✓ | – | – |
| Fit view (or double-click the view) | – | ✓ | ✓ |
| Theme | ✓ | ✓ | ✓ |

"Dim background" is disabled while "highlight objects" is off, since it only applies to highlighting.

**Stage controls** (Processing, and Mesh / lines under Display):
- The checkbox switches a stage on or off. ⓘ explains it, and ▸ opens its parameters.
- **Typing exact values:** click a parameter's value (or Tab to it and press Enter) to type a number. Enter (or leaving the field) applies it; Esc cancels.
  - The number is in the units shown next to the field: mm for the noise floor, % for shares and "% of range" growth rates, σ, scans, or the parameter's own unit.
  - It is clamped to the slider's range, and whole-step parameters are rounded. Values between slider steps are kept as typed (a gate of 0.83 m).
- **Changed from the default:** a blue dot marks a parameter that differs from the defaults (`defaultConfig()`: the medium preset), and the same dot sits on its stage. A changed stage shows "Reset stage to defaults".
- **Auto mode:** the stages that auto sets stay visible but read-only, greyed and tagged "auto", showing the values auto chose. What stays yours in auto mode:
  - the intensity filter, radial cells, remembered walls and object detection (fully);
  - the on/off switch of Clean outlines (auto still tunes its margin).

**Other controls:**
- **Max range** is a number field: type a value and press Enter. It is clamped to 1–250 m and remembered.
- **Point size** shows its value next to the label.
- **Panel width:** drag the panel's right edge (240–640 px, remembered); double-click it for the default 280 px. The replay bar and the 2D views follow it. Only the panel body scrolls, so the title row stays in place.
- **Theme** (Display): dark (default), light, or follow the system.
  - It applies to the panel, the 3D scene (background, rings, fan, sensor) and both 2D views.
  - The light theme is meant for screenshots on paper. "Dim background" fades the scene towards the background colour there (35 % of the colour kept) instead of darkening it towards black (12 % kept); towards black, the walls turned near-black on white.
- **Explanations** are behind ⓘ icons, not in the panel text. Hover to read, click to pin, click elsewhere or Esc to close. They cover the stages, the mode, mounting, max range, walls, the object toggles, recording, the mouse and key controls per view (Display ⓘ), and the statistics.

**Keys** (only while the page itself has focus, not a field):

| Key | Action |
|---|---|
| 1 / 2 / 3 | 3D / 2D map / range image |
| H | hide or show the panel |
| Space | pause the live view, or play/pause a replay |
| ← / → | step through a replay |

## How the panel is built

- **Markup and wiring:** `index.html` holds the static panel. `src/app.ts` wires it to the processor and views; `ui/dom.ts`'s `$()` throws when an id is missing. A unit test checks that every id the code looks up exists.
- **Per-view relevance** (`ui/views.ts`) is declared in the markup:
  - `data-views="3d top"` lists the views a control belongs to.
  - `data-draw="points"` / `"mesh"` makes it depend on the draw mode.
  - `applyViews()` runs on every view or draw change and sets the class `offview` (`display:none !important`). Hiding never uses the `hidden` attribute, which auto mode and other state already use, so the two can't fight.
- **Folding:**
  - Status boxes are `<details class="fold">`; sections are `<details class="sect">` with the `<h2>` inside the `<summary>`.
  - Each `<details>` remembers its state under `mrs6000.open.<id>`, and the whole panel under `mrs6000.open.panel` (class `min` on `#panel`).
  - Setting `details.open` from code fires `toggle` asynchronously, so its handler must not assume the first scan has arrived.
- **Info icons** (`ui/info.ts`):
  - `info(text)` creates one, `setInfo(icon, text)` changes it, and static ones in `index.html` are `<span class="info" data-tip="…">`.
  - `bindInfoIcons()` adds delegated listeners once. Hovering shows a single `position: fixed` box (`#infoTip`), so the scrolling panel never clips it; a click pins it.
  - The click handler runs in the capture phase and calls `preventDefault`, so an icon inside a `<summary>` or `<label>` doesn't fold the section or toggle the checkbox.
- **Statistics** (`ui/statsPanel.ts`): the groups are created in a fixed order at start-up, so a group that appears later (e.g. Scene after the first noise estimate) doesn't end up last.
  - Rows are keyed by label and updated in place, so an open ⓘ survives the ~10 updates per second. A row left out of an update is hidden.
  - The rows are only computed while the box is open.
- **Stage controls** (`ui/stageControls.ts`) are generated from `STAGES` in `config/config.ts`:
  - `Stage.host` puts a stage in the objects or display slot instead of the stage list; `Stage.views` limits it to some views.
  - `editable(key, auto)` decides what is editable: `all`, `toggle` (USER_TOGGLES) or `none`.
  - `Param.edit` gives the typed-in scale and unit (`editSpec`), and `parseParam` clamps and rounds.
  - `fmtParam` shows a typed-in value with all its digits when it has more than the slider step.
- **Theme** (`ui/theme.ts`, tokens in `styles.css`):
  - Every colour is a CSS variable on `:root`, redefined for `[data-theme="light"]` and for `[data-theme="system"]` under `prefers-color-scheme: light`. Don't hard-code a colour in CSS or canvas code.
  - Canvas and WebGL code can't use CSS variables, so `themeColors()` reads them, and `App.setTheme` hands them to `Scene3D.setTheme`, `View2D.setTheme` and the charts.
  - The data colours (turbo, track colours) are the same in both themes.
- **Layering:** the panel and replay bar are `z-index: 5`, above the 3D object labels (`#labels`); the info box and the recording menu are at 20.
- **Panel width:** the CSS variable `--panel-w` on `:root` sets it (`#panel` width, `#transport` left edge). The 2D views ask for the panel's actual width (`panelWidth()` callback: `offsetWidth` + margin; 0 when folded or narrower than 600 px).
- **Recording menu** (`ui/recordingPanel.ts`): a `position: fixed` element on `<body>`, closed by a capture-phase `pointerdown` outside it.
  - It stays open across list refreshes (every 2–10 s) and only closes by itself when its recording disappears.
  - A `pointerdown` on any row's ⋯ doesn't count as outside; the click then decides between closing and switching to that row.
