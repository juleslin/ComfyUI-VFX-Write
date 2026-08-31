# ComfyUI VFX Write — Stage 1

Non-destructive, versioned output. The counterpart to `ComfyUI-VFX-Read` —
and, for video, it can also work like Read on its own output: extract a
specific frame back out of the file it just wrote, as a real `IMAGE` other
nodes can use.

## Included

- Destination is split into two fields, matched to how you actually pick
  them: `path` (a folder — set by the "Choose destination" browser, which
  only ever picks a folder) and `file_name` (typed by hand, carries the
  `v##` version token and, for an image sequence, a `####` frame token).
  The two are joined into one pattern internally.
- `v##` version token — `#` count sets the zero-padding width. The node
  scans the target folder and always resolves to the next free version.
  Existing versions are never overwritten.
- `####` frame token (optional) — only for an image sequence (a
  multi-frame image batch). Not a priority use case right now but the
  code is left in place and working, untouched by everything below.
- Separate `image` and `video` inputs (connect only one at a time).
  - `image`: written as a single file, or a numbered sequence if a batch
    with more than one frame is connected (requires a `####` token in
    `file_name`). Always written as RGB — alpha is dropped on write (some
    targets like JPEG cannot hold it).
  - `video`: expected to already be an encoded `VIDEO` object from an
    upstream node; saved via ComfyUI's `VideoInput.save_to()` — this node
    does not encode frames itself.
- **Frame extraction for video**: after writing a video, `write()` also
  extracts the frame numbered by the `frame` input (via ffmpeg, the same
  approach `ComfyUI-VFX-Read` uses to read a movie frame) and returns it
  as the node's `image` output — a real execution result other nodes can
  connect to, not just a preview. `first`/`last` auto-fill from the
  video's real frame count (via ffprobe) purely as reference display, so
  you know the valid range before typing `frame`; they are not sent to
  `write()` and never clamp `frame` themselves (see the code comment on
  `clampFrameToRange` for why an earlier version of this did clamp it,
  and why that was a bug). For an image write, `frame` is unused and the
  `image` output stays a plain pass-through, same as before.
- Widget order top to bottom: Choose destination -> path -> file_name ->
  frame_start (hidden — see below) -> Preview version -> frame -> first ->
  last -> preview (canvas for image/sequence, or an embedded video player
  for video — see below). Controls on top, preview filling the rest of
  the node — same shape as core nodes like Load Image — and preview is
  the very last widget so nothing can ever sit where it might overlap.
- `frame_start` is hidden (zero height), not removed — still used for
  numbering a new image sequence's frames (default 1001), just not shown.
- "Preview version" picker (dropdown) to browse past versions without
  re-running the graph. Browsing never changes what the next run writes,
  and — separately — never changes what the next run would extract either
  (`frame` is independent of whichever version you're currently looking
  at; see above).
- Preview:
  - **Image / image sequence**: a resizable canvas (grows and shrinks
    correctly, all the way to a true minimum), plus a real DOM
    `<button>` ("⛶ Fullscreen") row above it — not drawn on the canvas.
    An earlier version drew play/loop/fullscreen as hand-rolled buttons
    on the canvas itself; those proved unreliable through LiteGraph's own
    event dispatch (the same issue that made the old video controls not
    respond), and only fullscreen was wanted for the image case anyway,
    so it's now a genuine clickable element with no custom hit-testing to
    get wrong. The underlying play/loop/scrub functions
    (`togglePlay`/`startPlay`/etc.) are left in place and still work if
    ever called, just not exposed in this UI — sequences aren't a
    priority right now but the code wasn't touched, per request.
    `clampFrameToRange`'s scrub-clamping (frame stepping through the
    active `first`-`last` range) still applies whenever a real
    multi-frame sequence is actually loaded.
    - Fullscreen opens the browser's real Fullscreen API (not just a
      full-viewport overlay) and loads the **full-resolution** source via
      a new `/vfx-write/image` route — not the small (max 640×420)
      thumbnail the in-node preview uses, which is what previously made
      the fullscreen image render small and centered instead of filling
      the screen (an `<img>` sized only by `max-width/max-height` never
      grows past its own intrinsic size). Web-native formats (png/jpg/
      webp/gif/bmp) are served as a raw passthrough; anything else (e.g.
      EXR/TIFF) is converted to full-resolution PNG on the fly
      (`full_image_png`). The image itself uses `width/height: 100%` +
      `object-fit: contain`, which — unlike max-width/max-height — also
      scales a smaller-than-screen source *up* to fill the view.
      Scroll-wheel zooms (clamped 1x–12x) and drag pans once zoomed in,
      both via a CSS transform on the image; double-click resets. A
      dedicated "✕ Close" button handles closing now that the image fills
      the whole overlay (Escape still works too). Confirmed live in
      automated testing: the route returns the real full-resolution image
      (2912×1440 for a test file, not the 640-wide thumbnail), the CSS
      fills the overlay, and wheel-zoom/drag-pan/double-click-reset/close
      all produce the expected transform and DOM changes.
  - **Video**: a real, persistent `<video controls loop>` element (served
    by `/vfx-write/video`) instead of a canvas — real play/pause, volume,
    scrub bar, and fullscreen all come from the browser itself, no custom
    drawing or hit-testing to get wrong. It and the image canvas are
    simple opposites of each other (whichever matches the current mode
    reports normal height, the other reports zero), so they never both
    claim space and neither can create a resize feedback loop. Confirmed
    live that the container tracks node resize correctly.
- `image` / `video` pass-through outputs (see the frame-extraction note
  above for how `image` differs when the last write was a video), plus
  the resolved `path` as a string, for downstream nodes.
- Survives a ComfyUI restart / workflow reload: `path`, `file_name`,
  `frame_start`, and `frame` are all restored by name (not by widget
  position, which the "Choose destination" button being first would
  otherwise break — see the design note at the top of `write_stage1.js`),
  and the preview re-populates automatically once the real saved values
  are back.

## Not yet included

- Video encoding from a raw image/frame batch (Phase 2, if needed).
- Explicit color-space / bit-depth / alpha controls.

## Path pattern examples

```text
path:      F:/comfyUI/output
file_name: shot_010_comp_v##.mov
file_name: shot_010_comp_v##.####.exr   (image sequence)
```

First run with nothing on disk yet -> `v01`. Run again with the same
`path`/`file_name` -> `v02`, and so on. `v01` is left untouched.

## Installation

From the ComfyUI root:

```bat
call venv\Scripts\activate.bat
python -m pip install -r custom_nodes\ComfyUI-VFX-Write\requirements.txt
```

Restart ComfyUI. Add `Write` from `VFX / IO`.

## Validated so far

- Path-pattern parsing, version resolution (including collision-skipping,
  e.g. v01/v02/v05 on disk correctly resolves next to v06), and the
  never-overwrite guarantee: confirmed live, queued twice against the
  same `path`/`file_name`, produced `v01` then `v02`, `v01` left
  untouched.
- Frame extraction end to end: a real `LoadVideo -> Write` run (an actual
  written .mp4, not a placeholder) with `frame` set to two different
  values produced genuinely different extracted pixel content (confirmed
  by direct tensor comparison, not just "it didn't error"). Confirmed the
  extracted frame is truly usable downstream by connecting Write's
  `image` output straight into a core `PreviewImage` node and getting a
  real ~3MB PNG out the other end.
- The `frame`-should-not-be-clamped fix: confirmed a real bug where
  setting `frame` on a fresh node (before any version had ever been
  loaded, so `first`/`last` were still their generic 1/1 defaults) got
  silently reset back to 1 by the old clamp-on-every-edit logic. Fixed by
  scoping clamping to only when a real multi-frame sequence is loaded
  (`state.frameList.length > 1`); confirmed setting `frame = 30` on a
  fresh node now holds, and that it's still preserved (not reset) after
  loading a video version that populates `first`/`last`.
- Destination browser: confirmed folder-only (no filename step) — picks a
  folder via `/vfx-write/browse`, sets `path`, leaves `file_name`
  untouched, closes correctly.
- Video preview: confirmed the embedded `<video controls>` widget and the
  canvas widget are perfect opposites of each other's `computeSize()`
  (`[w,0]` / `[w,120]` depending on mode) so exactly one is ever active;
  confirmed `first`/`last` auto-fill with the real ffprobe-derived frame
  count (matched a known 97-frame test file exactly) when browsing a
  video version.
- Node resize (grow AND shrink, all the way to the true minimum, no
  drift) and restart/reload survival (including the new `file_name` and
  `frame` fields): reconfirmed unaffected by all of the above changes,
  via the same live-drag-simulation and serialize/clear/configure tests
  used throughout this node's development.
- Fullscreen fill + full-resolution source: confirmed the `/vfx-write/image`
  route returns real full-resolution bytes (a 2912×1440 test file, not the
  640-wide thumbnail), and that the fullscreen `<img>` picks it up and
  fills the overlay via `width/height:100%; object-fit:contain`.
- Zoom/pan/reset/close in fullscreen: confirmed live — mouse-wheel zoom
  produces the expected scale transform (clamped), drag-while-zoomed pans
  via translate, double-click resets to `scale(1)`, and the dedicated
  Close button removes the overlay cleanly.

## Known limitation

- **EXR write does not currently work** in this environment. `imageio`
  has no working EXR encoder installed here (no `OpenEXR` module, and the
  `pyav` plugin incorrectly claims `.exr` and fails). PNG and other common
  imageio-native formats write correctly. To enable EXR, install an EXR
  backend (e.g. `pip install OpenEXR` or an imageio plugin that actually
  supports it) and re-validate.
