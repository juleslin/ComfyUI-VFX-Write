import io
import json
import re
import subprocess
from pathlib import Path

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


def list_versions(pattern):
    """Return [{"version": int, "path": str}, ...] for versions already on disk."""
    directory, filename_pattern = _split_pattern(pattern)

    version_match, pad_v, frame_match, pad_f = _build_matchers(filename_pattern)
    scanner = _compile_scanner(filename_pattern, version_match, pad_v, frame_match, pad_f)

    found = {}

    if directory.exists():
        for candidate in sorted(directory.iterdir(), key=lambda item: item.name.lower()):
            if not candidate.is_file():
                continue

            match = scanner.match(candidate.name)

            if not match:
                continue

            version = int(match.group("version"))
            found.setdefault(version, candidate)

    return [
        {"version": version, "path": str(found[version])}
        for version in sorted(found.keys())
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
    path for that case.
    """
    directory, filename_pattern = _split_pattern(pattern)

    version_match, pad_v, frame_match, pad_f = _build_matchers(filename_pattern)

    if not frame_match:
        return []

    scanner = _compile_frame_scanner(
        filename_pattern, version_match, pad_v, version, frame_match, pad_f
    )

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


def _rate_to_float(value):
    if not value or value in {"0/0", "N/A"}:
        return 0.0

    try:
        numerator, denominator = value.split("/")
        return float(numerator) / float(denominator)
    except Exception:
        return 0.0


def movie_info(path):
    """ffprobe-based frame range for a video file. Mirrors ComfyUI-VFX-Read's
    own _movie_info — same reasoning, kept as a separate copy here rather
    than a shared import (Read and Write are independent installed
    packages under custom_nodes/, not a shared library)."""
    command = [
        "ffprobe",
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries",
        "stream=width,height,nb_frames,avg_frame_rate,duration",
        "-of", "json",
        str(path),
    ]

    result = subprocess.run(command, capture_output=True, check=False)

    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"FFprobe failed:\n{detail}")

    payload = json.loads(result.stdout.decode("utf-8"))
    stream = payload["streams"][0]

    width = int(stream.get("width", 0))
    height = int(stream.get("height", 0))

    raw_count = stream.get("nb_frames", "N/A")

    if raw_count not in {None, "", "N/A"}:
        try:
            frame_count = int(raw_count)
        except ValueError:
            frame_count = 0
    else:
        frame_count = 0

    if frame_count <= 0:
        duration = float(stream.get("duration", 0) or 0)
        fps = _rate_to_float(stream.get("avg_frame_rate", "0/0"))

        if duration > 0 and fps > 0:
            frame_count = max(1, round(duration * fps))
        else:
            frame_count = 1

    return {"first": 1, "last": frame_count, "width": width, "height": height}


def _read_movie_frame(path, frame_number=1):
    command = [
        "ffmpeg",
        "-v", "error",
        "-i", str(path),
        "-vf", f"select=eq(n\\,{max(1, int(frame_number)) - 1})",
        "-frames:v", "1",
        "-f", "image2pipe",
        "-vcodec", "png",
        "-",
    ]

    result = subprocess.run(command, capture_output=True, check=False)

    if result.returncode != 0 or not result.stdout:
        detail = result.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(f"FFmpeg could not decode a preview frame.\n\n{detail}")

    image = Image.open(io.BytesIO(result.stdout)).convert("RGB")
    return _to_comfy_image(np.asarray(image))


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
        "never overwritten. For a video, also extracts 'frame' back out of "
        "the file just written (like Read does from a source) so the "
        "image output can feed straight into further processing."
    )

    RETURN_TYPES = ("IMAGE", "VIDEO", "STRING")
    RETURN_NAMES = ("image", "video", "path")

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
                "frame": (
                    "INT",
                    {
                        "default": 1,
                        "min": 1,
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
        frame=1,
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
        output_image = image

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

            try:
                output_image = _read_movie_frame(resolved_path, frame)
            except Exception as error:
                raise RuntimeError(
                    f"Video was written, but frame {frame} could not be "
                    f"extracted back out of it:\n{resolved_path}\n\n{error}"
                ) from error

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
            "result": (output_image, video, preview_path),
        }


NODE_CLASS_MAPPINGS = {
    "VFXWrite": VFXWrite,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VFXWrite": "Write",
}
