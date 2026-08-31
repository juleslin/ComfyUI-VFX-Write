import io
import re
from pathlib import Path

import av
import imageio.v3 as iio
import numpy as np
import torch
from PIL import Image


MOVIE_EXTENSIONS = {
    ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".gif"
}

# A path pattern must contain exactly one version token (v## / v### / ...).
# The number of '#' characters sets the zero-padding width.
VERSION_TOKEN = re.compile(r"v(#+)", re.IGNORECASE)

# A run of '#' characters not belonging to the version token is the frame
# token, used only for image sequences (e.g. name_v##.####.exr).
FRAME_TOKEN = re.compile(r"#+")

# For scanning REAL on-disk names (folders, already-written files) for a
# version number — distinct from VERSION_TOKEN above, which matches the '#'
# placeholder in a not-yet-substituted pattern string. Mirrors
# ComfyUI-VFX-Read's own token finder.
_VERSION_TOKEN_LITERAL = re.compile(r"[vV](\d{1,2})(?!\d)")


def _find_version_token_literal(name):
    matches = list(_VERSION_TOKEN_LITERAL.finditer(name))
    return matches[-1] if matches else None


# Trailing digit run right before the extension — same shape
# ComfyUI-VFX-Read's own FRAME_PATTERN uses to find a real frame number in
# an actual on-disk filename (as opposed to VERSION_TOKEN/FRAME_TOKEN
# above, which match the '#' placeholder in a not-yet-substituted pattern
# string).
_FRAME_PATTERN_LITERAL = re.compile(r"^(.*?)(\d+)(\.[^.]+)$")


def _is_movie(path):
    return path.suffix.lower() in MOVIE_EXTENSIONS


def group_files(folder):
    """Groups a folder's files into individual entries or, for a run of
    2+ files sharing the same (prefix, digit padding, suffix), one
    collapsed sequence entry (e.g. 90 'shot_test_v01.NNNN.jpg' frames
    become one 'shot_test_v01.0001-0090.jpg' row) — same grouping
    ComfyUI-VFX-Read's own browse dialog uses, so the destination browser
    doesn't force scrolling through hundreds of individual frame rows.
    Padding < 3 is treated as a version token (v01, v02...), not a frame
    number, and left standalone — same cutoff Read uses. A sequence
    group's `path` is its first frame, which the caller (the browse route)
    uses as the representative file to detect a v##/#### pattern from."""
    physical_files = sorted(
        (item for item in folder.iterdir() if item.is_file()),
        key=lambda item: item.name.lower(),
    )

    buckets = {}
    standalone = []

    for item in physical_files:
        if _is_movie(item):
            standalone.append(item)
            continue

        match = _FRAME_PATTERN_LITERAL.match(item.name)

        if not match:
            standalone.append(item)
            continue

        prefix, digits, suffix = match.groups()
        padding = len(digits)

        if padding < 3:
            standalone.append(item)
            continue

        buckets.setdefault((prefix, padding, suffix), {})[int(digits)] = item

    groups = []

    for (prefix, padding, suffix), frames in buckets.items():
        if len(frames) < 2:
            standalone.extend(frames.values())
            continue

        first = min(frames)
        last = max(frames)

        groups.append(
            {
                "kind": "sequence",
                "path": str(frames[first]),
                "label": f"{prefix}{first:0{padding}d}-{last:0{padding}d}{suffix}",
                "first": first,
                "last": last,
            }
        )

    for item in standalone:
        groups.append(
            {
                "kind": "file",
                "path": str(item),
                "label": item.name,
                "first": 1,
                "last": 1,
            }
        )

    groups.sort(key=lambda g: g["label"].lower())
    return groups


# ---------------------------------------------------------------------------
# path + file_name combination
# ---------------------------------------------------------------------------

def combine_path(path, file_name):
    """Join a destination folder and a filename pattern into one pattern.

    UI-level split (folder chosen via the browse dialog, filename typed
    with its own v##/#### tokens) — the rest of this module still works
    with a single combined pattern string, same as before the split.
    """
    folder = (path or "").strip().strip('"').replace("\\", "/").rstrip("/")
    name = (file_name or "").strip().strip('"').replace("\\", "/")

    if not folder:
        raise ValueError("Write node needs a destination folder (path).")

    if not name:
        raise ValueError(
            "Write node needs a file name pattern, for example:\n"
            "shot_010_comp_v##.mov"
        )

    return f"{folder}/{name}"


# ---------------------------------------------------------------------------
# path pattern parsing
# ---------------------------------------------------------------------------

def _split_pattern(pattern):
    """Split a path pattern into its directory and filename-pattern parts.

    Tokens (v##, ####) are only recognized in the filename part. Matching
    against files on disk is done with the filename alone, since
    Path.iterdir() yields bare names, not full paths.
    """
    full = Path(pattern)
    return full.parent, full.name


def _build_matchers(filename_pattern):
    version_match = VERSION_TOKEN.search(filename_pattern)

    if not version_match:
        raise ValueError(
            "Path pattern must include a version token in the filename, "
            "for example 'v##' (the number of # characters sets the "
            "zero-padding width):\n" + filename_pattern
        )

    v_start, v_end = version_match.span(1)
    pad_v = v_end - v_start

    frame_match = None

    for candidate in FRAME_TOKEN.finditer(filename_pattern):
        if candidate.start() == v_start and candidate.end() == v_end:
            continue

        frame_match = candidate
        break

    pad_f = (frame_match.end() - frame_match.start()) if frame_match else None

    return version_match, pad_v, frame_match, pad_f


def _compile_scanner(pattern, version_match, pad_v, frame_match, pad_f):
    spans = [(version_match.span(1), "version")]

    if frame_match:
        spans.append((frame_match.span(), "frame"))

    spans.sort(key=lambda item: item[0][0])

    parts = []
    cursor = 0

    for (start, end), kind in spans:
        parts.append(re.escape(pattern[cursor:start]))

        if kind == "version":
            parts.append(rf"(?P<version>\d{{{pad_v}}})")
        else:
            parts.append(rf"\d{{{pad_f}}}")

        cursor = end

    parts.append(re.escape(pattern[cursor:]))

    return re.compile("^" + "".join(parts) + "$")


def _substitute(
    pattern,
    version_match,
    pad_v,
    version_number,
    frame_match=None,
    pad_f=None,
    frame_number=None,
):
    spans = [(version_match.span(1), f"{version_number:0{pad_v}d}")]

    if frame_match is not None and frame_number is not None:
        spans.append((frame_match.span(), f"{frame_number:0{pad_f}d}"))

    spans.sort(key=lambda item: item[0][0], reverse=True)

    result = pattern

    for (start, end), replacement in spans:
        result = result[:start] + replacement + result[end:]

    return result


def _next_version(directory, scanner):
    existing = []

    if directory.exists():
        for candidate in directory.iterdir():
            if not candidate.is_file():
                continue

            found = scanner.match(candidate.name)

            if found:
                existing.append(int(found.group("version")))

    return (max(existing) + 1) if existing else 1


def resolve_pattern(pattern):
    """Parse a path pattern and resolve the next free version number.

    Returns (directory, filename_pattern, version_match, pad_v,
    frame_match, pad_f, version_number).
    """
    directory, filename_pattern = _split_pattern(pattern)

    version_match, pad_v, frame_match, pad_f = _build_matchers(filename_pattern)
    scanner = _compile_scanner(filename_pattern, version_match, pad_v, frame_match, pad_f)

    version_number = _next_version(directory, scanner)

    return directory, filename_pattern, version_match, pad_v, frame_match, pad_f, version_number


def _folder_version_shape(directory):
    """If `directory`'s own name carries a version token (e.g.
    'shot_010_v01'), returns (prefix, suffix, padding) describing how to
    find/build sibling version folders. None if there's no token."""
    match = _find_version_token_literal(directory.name)

    if not match:
        return None

    digits = match.group(1)
    padding = len(digits)
    start, end = match.span(1)

    return directory.name[:start], directory.name[end:], padding


def _split_version_and_frame_spans(filename_pattern):
    """Locates the version token's and frame token's spans within a
    filename pattern that may carry EITHER token, BOTH, or neither.
    Frame-token detection always excludes the version token's own span —
    same exclusion _build_matchers already does for the filename-level
    scanner — so a pattern with both tokens (e.g. "name_v##.####.exr")
    doesn't have its frame search mistake the version's own "##" for the
    real "####" frame token. Confirmed live as a real bug: without this
    exclusion, a real production destination with both tokens (version
    AND frame both present in the filename, which then turned out
    file-level-ambiguous per _resolve_versions) produced a folder-fallback
    scanner requiring literal "#" characters in real filenames — matching
    nothing, silently hiding every sibling version. Returns
    (version_span_or_None, frame_span_or_None)."""
    version_match = VERSION_TOKEN.search(filename_pattern)
    version_span = version_match.span(1) if version_match else None

    frame_span = None
    for candidate in FRAME_TOKEN.finditer(filename_pattern):
        if version_span and candidate.span() == version_span:
            continue
        frame_span = candidate.span()
        break

    return version_span, frame_span


def _build_literal_scanner(filename_pattern, version_span, frame_span, capture_frame):
    """Compiles a regex matching a real on-disk filename against
    `filename_pattern`: the version span (if any) becomes a plain digit
    wildcard (its exact value isn't needed — the sibling folder we're
    scanning already identifies the version), and the frame span (if any)
    becomes either a wildcard or a named capture group, per
    `capture_frame`. Falls back to matching `filename_pattern` literally
    when neither span exists."""
    spans = []
    if version_span:
        spans.append((version_span, "version"))
    if frame_span:
        spans.append((frame_span, "frame"))
    spans.sort(key=lambda item: item[0][0])

    parts = []
    cursor = 0

    for (start, end), kind in spans:
        parts.append(re.escape(filename_pattern[cursor:start]))
        width = end - start

        if kind == "frame" and capture_frame:
            parts.append(rf"(?P<frame>\d{{{width}}})")
        else:
            parts.append(rf"\d{{{width}}}")

        cursor = end

    parts.append(re.escape(filename_pattern[cursor:]))

    return re.compile("^" + "".join(parts) + "$")


def _folder_version_info(directory, filename_pattern):
    """Fallback used when the filename-level version match is missing or
    ambiguous (see _resolve_versions): looks for a version token in the
    destination FOLDER's own name instead (e.g. '.../shot_010_v01/
    render.png', or a sequence split across '.../shot_010_v01/',
    '.../shot_010_v02/'), and scans sibling folders of the same shape for
    a matching filename. Mirrors ComfyUI-VFX-Read's
    _sequence_folder_versions, adapted for Write's simpler case."""
    shape = _folder_version_shape(directory)

    if not shape:
        return None

    prefix, suffix, padding = shape
    folder_matcher = re.compile(
        "^" + re.escape(prefix) + rf"(\d{{{padding}}})" + re.escape(suffix) + "$"
    )

    version_span, frame_span = _split_version_and_frame_spans(filename_pattern)
    file_scanner = (
        _build_literal_scanner(filename_pattern, version_span, frame_span, capture_frame=False)
        if (version_span or frame_span)
        else None
    )

    if not directory.parent.exists():
        return None

    versions = {}

    for sibling in directory.parent.iterdir():
        if not sibling.is_dir():
            continue

        found = folder_matcher.match(sibling.name)

        if not found:
            continue

        version = int(found.group(1))

        if file_scanner:
            match_file = next(
                (
                    candidate
                    for candidate in sorted(sibling.iterdir(), key=lambda c: c.name.lower())
                    if candidate.is_file() and file_scanner.match(candidate.name)
                ),
                None,
            )
        else:
            candidate = sibling / filename_pattern
            match_file = candidate if candidate.is_file() else None

        if match_file:
            versions[version] = match_file

    return versions


def _folder_version_directory(directory, version):
    """The sibling version folder for `version`, given _folder_version_shape."""
    shape = _folder_version_shape(directory)

    if not shape:
        return None

    prefix, suffix, padding = shape
    return directory.parent / f"{prefix}{version:0{padding}d}{suffix}"


def _filename_versions(directory, filename_pattern, version_match, pad_v, frame_match, pad_f):
    """All versions found via a filename-level v## token, scanning
    `directory` only. Returns {version: path}."""
    scanner = _compile_scanner(filename_pattern, version_match, pad_v, frame_match, pad_f)
    found = {}

    if directory.exists():
        for candidate in sorted(directory.iterdir(), key=lambda item: item.name.lower()):
            if not candidate.is_file():
                continue

            match = scanner.match(candidate.name)

            if match:
                found.setdefault(int(match.group("version")), candidate)

    return found


def _resolve_versions(directory, filename_pattern):
    """Returns (found: {version: path}, used_folder_fallback: bool) —
    chooses between a filename-level v## token and a folder-level one,
    same two-tier approach and same ambiguity fix as
    ComfyUI-VFX-Read's own list_versions: a filename-level match of only
    ONE entry is ambiguous for a real image sequence — every frame inside
    a per-version folder trivially "matches itself" under this pattern
    (same prefix/suffix, since the frame number is part of the fixed
    suffix), regardless of whether a genuine per-FILE version convention
    applies. That would otherwise mask the folder-level convention that
    actually applies when a sequence is split across per-version folders
    (confirmed live against a real production folder: a single-frame
    filename match hid every sibling version living in its own folder).

    Critically, ambiguous does NOT mean "distrust it outright": the
    folder-level convention is only actually evidence of something when it
    finds real sibling folders. Without that check, the very first
    sequence ever written under a plain "path/name_v##.####.ext" layout —
    genuinely only one version on disk, version correctly in the filename,
    no folder convention involved at all — would find nothing (no version
    token in the destination folder's own name) and wrongly report zero
    versions instead of the one that's really there (confirmed live: a
    freshly-written first-version sequence failed to preview for exactly
    this reason). So: try the folder convention first when ambiguous, and
    only prefer it over the filename match if it actually found something;
    otherwise fall back to trusting the filename match after all — it's
    the best (and correct) answer once the alternative comes up empty.
    Only trust a single-entry filename-level match outright for a
    non-sequence file (no frame token) — a genuinely standalone still."""
    try:
        version_match, pad_v, frame_match, pad_f = _build_matchers(filename_pattern)
    except ValueError:
        version_match = None

    found = {}
    is_sequence = False

    if version_match:
        is_sequence = frame_match is not None
        found = _filename_versions(directory, filename_pattern, version_match, pad_v, frame_match, pad_f)

    ambiguous = bool(found) and len(found) < 2 and is_sequence

    if found and not ambiguous:
        return found, False

    folder_found = _folder_version_info(directory, filename_pattern)

    if folder_found:
        return folder_found, True

    if found:
        return found, False

    return {}, True


def list_versions(pattern):
    """Return [{"version": int, "path": str}, ...] for versions already on
    disk. Note this only affects PREVIEWING already-written versions;
    write()'s own next-version numbering still requires v## in file_name,
    unchanged."""
    directory, filename_pattern = _split_pattern(pattern)
    found, _ = _resolve_versions(directory, filename_pattern)

    return [
        {"version": version, "path": str(found[version])}
        for version in sorted(found.keys())
    ]


def list_frames_in_folder(pattern):
    """Frames matching a #### token within the destination's OWN folder —
    no version convention required at all. Used to preview exactly the
    sequence just picked in the browse dialog: a destination with no v##
    anywhere (filename or folder) has no "version" for list_versions/
    list_frames to key off of, so the browse dialog's own pick() previews
    would otherwise show nothing (confirmed live: a plain, unversioned
    sequence/file picked in the dialog left the canvas empty — filename
    and version DID get set correctly, only the preview stayed blank).
    Empty list for a single file (no frame token) — the caller shows that
    one file directly instead, no listing needed."""
    directory, filename_pattern = _split_pattern(pattern)
    _version_span, frame_span = _split_version_and_frame_spans(filename_pattern)

    if not frame_span:
        return []

    scanner = _build_literal_scanner(filename_pattern, _version_span, frame_span, capture_frame=True)

    found = {}

    if directory.exists():
        for candidate in directory.iterdir():
            if not candidate.is_file():
                continue

            match = scanner.match(candidate.name)

            if match:
                found[int(match.group("frame"))] = str(candidate)

    return [
        {"frame": frame, "path": found[frame]}
        for frame in sorted(found.keys())
    ]


def _compile_frame_scanner(filename_pattern, version_match, pad_v, version_number, frame_match, pad_f):
    spans = [
        (version_match.span(1), "version"),
        (frame_match.span(), "frame"),
    ]
    spans.sort(key=lambda item: item[0][0])

    parts = []
    cursor = 0

    for (start, end), kind in spans:
        parts.append(re.escape(filename_pattern[cursor:start]))

        if kind == "version":
            parts.append(re.escape(f"{version_number:0{pad_v}d}"))
        else:
            parts.append(rf"(?P<frame>\d{{{pad_f}}})")

        cursor = end

    parts.append(re.escape(filename_pattern[cursor:]))

    return re.compile("^" + "".join(parts) + "$")


def list_frames(pattern, version):
    """Return [{"frame": int, "path": str}, ...] for one version's sequence.

    Empty list for a version that has no frame token (a single image or
    video, not a sequence) — the caller falls back to list_versions' single
    path for that case. Uses the SAME filename-vs-folder decision
    _resolve_versions made for list_versions (rather than re-deciding
    independently), so it always looks in the right place for whichever
    convention list_versions actually detected for this destination.
    """
    directory, filename_pattern = _split_pattern(pattern)
    found_versions, used_folder = _resolve_versions(directory, filename_pattern)

    if version not in found_versions:
        return []

    if not used_folder:
        try:
            version_match, pad_v, frame_match, pad_f = _build_matchers(filename_pattern)
        except ValueError:
            return []

        if not frame_match:
            return []

        scanner = _compile_frame_scanner(
            filename_pattern, version_match, pad_v, version, frame_match, pad_f
        )
        target_dir = directory
    else:
        target_dir = _folder_version_directory(directory, version)
        _version_span, frame_span = _split_version_and_frame_spans(filename_pattern)

        if not target_dir or not frame_span:
            return []

        scanner = _build_literal_scanner(filename_pattern, _version_span, frame_span, capture_frame=True)

    found = {}

    if target_dir.exists():
        for candidate in target_dir.iterdir():
            if not candidate.is_file():
                continue

            match = scanner.match(candidate.name)

            if match:
                found[int(match.group("frame"))] = str(candidate)

    return [
        {"frame": frame, "path": found[frame]}
        for frame in sorted(found.keys())
    ]


# ---------------------------------------------------------------------------
# image conversion / writing
# ---------------------------------------------------------------------------

def _from_comfy_image(tensor):
    pixels = tensor.detach().cpu().numpy()
    pixels = np.clip(pixels, 0.0, 1.0)
    return (pixels * 255).astype(np.uint8)


def _write_image(tensor, path):
    array = _from_comfy_image(tensor)

    # Write RGB only. Some targets (JPEG) cannot hold alpha, and the
    # pipeline does not need per-format alpha handling right now.
    if array.ndim == 3 and array.shape[-1] == 4:
        array = array[..., :3]

    try:
        iio.imwrite(path, array)
    except Exception as error:
        raise RuntimeError(
            f"Could not write image:\n{path}\n\n{error}"
        ) from error


def _write_video(video, path):
    # VideoInput.save_to() is confirmed present on the installed ComfyUI
    # (comfy_api/latest/_input/video_types.py). It reuses the source
    # stream when possible and transcodes automatically when the target
    # container/codec (from the path's extension) requires it.
    try:
        video.save_to(str(path))
    except Exception as error:
        raise RuntimeError(
            f"Could not write video:\n{path}\n\n{error}"
        ) from error


# ---------------------------------------------------------------------------
# preview helpers (shared with routes.py)
# ---------------------------------------------------------------------------

def _to_comfy_image(array):
    if array.ndim == 2:
        array = np.stack([array, array, array], axis=-1)

    if array.ndim == 3 and array.shape[-1] == 4:
        array = array[..., :3]

    if array.ndim != 3 or array.shape[-1] < 3:
        raise ValueError(f"Unsupported image shape: {array.shape}")

    array = array[..., :3]

    if np.issubdtype(array.dtype, np.integer):
        maximum = np.iinfo(array.dtype).max
        array = array.astype(np.float32) / maximum
    else:
        array = array.astype(np.float32)

    return torch.from_numpy(np.ascontiguousarray(array)).unsqueeze(0)


def _read_image(path):
    try:
        image = iio.imread(path)
        return _to_comfy_image(image)
    except Exception as error:
        raise RuntimeError(
            f"Could not read image:\n{path}\n\n{error}"
        ) from error


def movie_info(path):
    """PyAV-based frame range for a video file. Ported from
    ComfyUI-VFX-Read's own _movie_info after this ffprobe-subprocess
    version was confirmed live as the actual cause of "loading a movie
    takes forever" (a getty stock .mp4 that Read opened instantly) — same
    root cause Read already diagnosed and fixed: spawning ffprobe.exe as a
    fresh child process triggers a real-time Windows Defender scan of that
    executable on first launch, adding tens of seconds, on top of which
    this call wasn't even offloaded to an executor (see routes.py), so it
    blocked the entire server's event loop — including the video's own
    streaming response — while it ran. PyAV links FFmpeg's libraries
    directly into this already-running process instead, avoiding the
    subprocess spawn entirely; it's already a hard dependency of ComfyUI
    core's own "Load Video" node. Kept as a separate copy from Read's
    rather than a shared import (independent installed packages)."""
    try:
        with av.open(str(path)) as container:
            stream = container.streams.video[0]

            width = stream.width
            height = stream.height

            rate = stream.average_rate or stream.guessed_rate
            fps = float(rate) if rate else 0.0

            frame_count = stream.frames or 0

            if frame_count <= 0:
                duration = None
                if stream.duration and stream.time_base:
                    duration = float(stream.duration * stream.time_base)
                elif container.duration:
                    duration = float(container.duration / av.time_base)

                if duration and fps > 0:
                    frame_count = max(1, round(duration * fps))
                else:
                    frame_count = 1
    except Exception as error:
        raise RuntimeError(
            f"Could not read movie info:\n{path}\n\n{error}"
        ) from error

    return {"first": 1, "last": frame_count, "width": width, "height": height}


def _read_movie_frame(path, frame_number=1):
    """PyAV-based single-frame decode — seeks to the nearest keyframe
    at/before the target time, then decodes forward to the first frame
    at/after it. Direct port of ComfyUI-VFX-Read's own _read_movie_frame,
    replacing the ffmpeg-subprocess version for the same reason as
    movie_info above."""
    frame_number = max(1, int(frame_number))

    try:
        with av.open(str(path)) as container:
            stream = container.streams.video[0]

            rate = stream.average_rate or stream.guessed_rate
            fps = float(rate) if rate else 24.0
            target_time = (frame_number - 1) / fps if fps > 0 else 0.0

            try:
                target_pts = int(target_time / stream.time_base)
                container.seek(
                    target_pts, stream=stream, backward=True, any_frame=False
                )
            except av.AVError:
                container.seek(0)

            chosen = None
            tolerance = (0.5 / fps) if fps > 0 else 0.0

            for frame in container.decode(stream):
                if frame.time is None:
                    continue
                chosen = frame
                if frame.time >= target_time - tolerance:
                    break

            if chosen is None:
                raise RuntimeError("no decodable frame found")

            array = chosen.to_ndarray(format="rgb24")
    except Exception as error:
        raise RuntimeError(
            f"Could not decode movie frame {frame_number}:\n{path}\n\n{error}"
        ) from error

    return _to_comfy_image(array)


def make_thumbnail_png(path):
    source = Path(path)

    if not source.is_file():
        raise ValueError(f"File does not exist:\n{source}")

    if source.suffix.lower() in MOVIE_EXTENSIONS:
        tensor = _read_movie_frame(source, 1)
    else:
        tensor = _read_image(source)

    pixels = tensor[0].detach().cpu().numpy()
    pixels = np.clip(pixels, 0.0, 1.0)
    image = Image.fromarray((pixels * 255).astype(np.uint8), "RGB")
    image.thumbnail((640, 420))

    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


# Formats a browser can display natively via a plain <img src>. Anything
# else (e.g. EXR, TIFF) needs converting first — full resolution, unlike
# make_thumbnail_png's deliberately small preview size.
WEB_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}


def is_web_displayable_image(path):
    return Path(path).suffix.lower() in WEB_IMAGE_EXTENSIONS


def full_image_png(path):
    """Full-resolution PNG bytes for a non-web-native image format.

    Only called for a format a browser can't display directly — the
    caller serves web-native formats (png/jpg/...) as a raw file instead,
    which is both faster and avoids a redundant re-encode.
    """
    source = Path(path)

    if not source.is_file():
        raise ValueError(f"File does not exist:\n{source}")

    tensor = _read_image(source)
    pixels = tensor[0].detach().cpu().numpy()
    pixels = np.clip(pixels, 0.0, 1.0)
    image = Image.fromarray((pixels * 255).astype(np.uint8), "RGB")

    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


# ---------------------------------------------------------------------------
# node
# ---------------------------------------------------------------------------

class VFXWrite:
    CATEGORY = "VFX / IO"
    DESCRIPTION = (
        "VFX-safe output. Writes an image, image sequence, or an "
        "already-encoded video to a versioned destination (v##) that is "
        "never overwritten."
    )

    RETURN_TYPES = ()

    FUNCTION = "write"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "path": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "placeholder": r"F:/comfyUI/output",
                    },
                ),
                "file_name": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "placeholder": r"shot_010_comp_v##.mov",
                    },
                ),
            },
            "optional": {
                "image": ("IMAGE",),
                "video": ("VIDEO",),
                "frame_start": (
                    "INT",
                    {
                        "default": 1001,
                        "min": 0,
                        "max": 10000000,
                        "step": 1,
                    },
                ),
            },
        }

    def write(
        self,
        path,
        file_name,
        image=None,
        video=None,
        frame_start=1001,
    ):
        if image is None and video is None:
            raise ValueError(
                "Write node needs an 'image' or 'video' input connected."
            )

        if image is not None and video is not None:
            raise ValueError(
                "Write node received both an image and a video input. "
                "Connect only one at a time."
            )

        pattern = combine_path(path, file_name)

        (
            directory,
            filename_pattern,
            version_match,
            pad_v,
            frame_match,
            pad_f,
            version_number,
        ) = resolve_pattern(pattern)

        written_paths = []

        if video is not None:
            if frame_match:
                raise ValueError(
                    "Video output does not use a frame token (####). "
                    "Remove it from the file name pattern for video "
                    "writes:\n" + pattern
                )

            resolved_name = _substitute(
                filename_pattern, version_match, pad_v, version_number
            )
            resolved_path = directory / resolved_name
            resolved_path.parent.mkdir(parents=True, exist_ok=True)
            _write_video(video, resolved_path)
            written_paths.append(resolved_path)

        else:
            batch = image.shape[0]

            if batch > 1 and not frame_match:
                raise ValueError(
                    f"Image input has {batch} frames but the file name "
                    "pattern has no frame token (####). Add one, for "
                    "example:\nname_v##.####.exr"
                )

            for index in range(batch):
                frame_number = (frame_start + index) if frame_match else None

                resolved_name = _substitute(
                    filename_pattern,
                    version_match,
                    pad_v,
                    version_number,
                    frame_match,
                    pad_f,
                    frame_number,
                )

                resolved_path = directory / resolved_name
                resolved_path.parent.mkdir(parents=True, exist_ok=True)
                _write_image(image[index], resolved_path)
                written_paths.append(resolved_path)

        preview_path = str(written_paths[0])

        return {
            "ui": {
                "vfx_write": [
                    {
                        "path": preview_path,
                        "kind": "video" if video is not None else "image",
                        "count": len(written_paths),
                        "version": version_number,
                    }
                ]
            },
        }


NODE_CLASS_MAPPINGS = {
    "VFXWrite": VFXWrite,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VFXWrite": "Write",
}
