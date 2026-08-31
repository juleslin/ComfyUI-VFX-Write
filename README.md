# ComfyUI VFX Write

Non-destructive, versioned output. The counterpart to `ComfyUI-VFX-Read`.
A terminal node — it has no outputs, only the side effect of writing to
disk.

## Features

- **Versioned by default**: type a destination with a `v##` token (the `#`
  count sets the zero-padding width, e.g. `v##` → `v01`) and Write always
  resolves to the next free version on disk. Existing versions are never
  overwritten.
- **Single destination field** ("Choose destination") — type a full path
  directly, or use the folder icon to browse to a destination folder. The
  file name (with its `v##` token, and a `####` token for an image
  sequence) is just whatever comes after the last `/`.
- Separate `image` and `video` inputs (connect only one at a time).
  - `image`: written as a single file, or a numbered sequence if a batch
    with more than one frame is connected (requires a `####` token in the
    file name). Always written as RGB — alpha is dropped on write (some
    targets like JPEG cannot hold it).
  - `video`: expected to already be an encoded `VIDEO` object from an
    upstream node.
- **Version picker** — browse past versions already on disk without
  re-running the graph, for both a `v##` token in the file name and a
  `v##` token in the destination folder's own name (e.g. sequences kept in
  per-version folders like `.../shot_010_v01/`, `.../shot_010_v02/`, with
  no version token in the filename itself). Browsing never affects what
  the next run writes.
- **Scrub bar + transport controls** (play, previous/next frame, loop,
  fullscreen) for reviewing an already-written image sequence, and a real
  embedded `<video controls>` player for a written video — same shared
  transport row either way.
- Fullscreen review with the real Fullscreen API, wheel-zoom, and
  drag-to-pan for images/sequences; the video path reparents the real
  `<video>` element into the same fullscreen overlay.

## Path pattern examples

```text
Choose destination: F:/comfyUI/output/shot_010_comp_v##.mov
Choose destination: F:/comfyUI/output/shot_010_comp_v##.####.exr   (image sequence)
```

First run with nothing on disk yet → `v01`. Run again with the same
destination → `v02`, and so on. `v01` is left untouched.

## Installation

From the ComfyUI root:

```bat
call venv\Scripts\activate.bat
python -m pip install -r custom_nodes\ComfyUI-VFX-Write\requirements.txt
```

Restart ComfyUI. Add **Write** from the **VFX / IO** category.

## Known limitation

- **EXR write does not currently work** in this environment. `imageio`
  has no working EXR encoder installed here (no `OpenEXR` module, and the
  `pyav` plugin incorrectly claims `.exr` and fails). PNG and other common
  imageio-native formats write correctly. To enable EXR, install an EXR
  backend (e.g. `pip install OpenEXR` or an imageio plugin that actually
  supports it).
