from pathlib import Path

from aiohttp import web

from server import PromptServer

from .nodes import (
    full_image_png,
    is_web_displayable_image,
    list_frames,
    list_versions,
    make_thumbnail_png,
    movie_info,
)


routes = PromptServer.instance.routes


@routes.get("/vfx-write/browse")
async def browse(request):
    raw_path = request.query.get("path", "").strip()

    if raw_path:
        folder = Path(raw_path).expanduser()

        if folder.is_file():
            folder = folder.parent

        if not folder.exists():
            folder = Path.home()
    else:
        folder = Path.home()

    directories = sorted(
        (
            {"name": item.name, "path": str(item)}
            for item in folder.iterdir()
            if item.is_dir()
        ),
        key=lambda item: item["name"].lower(),
    )

    files = sorted(
        (item.name for item in folder.iterdir() if item.is_file()),
        key=str.lower,
    )

    return web.json_response(
        {
            "folder": str(folder),
            "parent": str(folder.parent),
            "directories": directories,
            "files": files,
        }
    )


@routes.get("/vfx-write/versions")
async def versions(request):
    raw_pattern = request.query.get("path", "").strip()

    if not raw_pattern:
        return web.json_response({"versions": []})

    pattern = raw_pattern.replace("\\", "/")

    try:
        found = list_versions(pattern)
    except ValueError as error:
        return web.json_response({"versions": [], "error": str(error)})

    return web.json_response({"versions": found})


@routes.get("/vfx-write/frames")
async def frames(request):
    raw_pattern = request.query.get("path", "").strip()
    raw_version = request.query.get("version", "").strip()

    if not raw_pattern or not raw_version:
        return web.json_response({"frames": []})

    try:
        version = int(raw_version)
    except ValueError:
        return web.json_response({"frames": [], "error": "invalid version"})

    pattern = raw_pattern.replace("\\", "/")

    try:
        found = list_frames(pattern, version)
    except ValueError as error:
        return web.json_response({"frames": [], "error": str(error)})

    return web.json_response({"frames": found})


@routes.get("/vfx-write/video")
async def video(request):
    raw_path = request.query.get("path", "").strip()

    if not raw_path:
        raise web.HTTPBadRequest(text="Missing 'path' query parameter.")

    source = Path(raw_path)

    if not source.is_file():
        raise web.HTTPNotFound(text=f"File does not exist:\n{source}")

    # FileResponse supports HTTP Range requests, which <video> needs for
    # seeking/scrubbing.
    return web.FileResponse(source)


@routes.get("/vfx-write/video-info")
async def video_info(request):
    raw_path = request.query.get("path", "").strip()

    if not raw_path:
        raise web.HTTPBadRequest(text="Missing 'path' query parameter.")

    source = Path(raw_path)

    if not source.is_file():
        raise web.HTTPNotFound(text=f"File does not exist:\n{source}")

    try:
        info = movie_info(source)
    except Exception as error:
        raise web.HTTPInternalServerError(text=str(error))

    return web.json_response(info)


@routes.get("/vfx-write/image")
async def image(request):
    raw_path = request.query.get("path", "").strip()

    if not raw_path:
        raise web.HTTPBadRequest(text="Missing 'path' query parameter.")

    source = Path(raw_path)

    if not source.is_file():
        raise web.HTTPNotFound(text=f"File does not exist:\n{source}")

    if is_web_displayable_image(source):
        # Raw passthrough — faster, and exact original quality (no re-encode).
        return web.FileResponse(source)

    try:
        png_bytes = full_image_png(source)
    except Exception as error:
        raise web.HTTPInternalServerError(text=str(error))

    return web.Response(body=png_bytes, content_type="image/png")


@routes.get("/vfx-write/thumbnail")
async def thumbnail(request):
    raw_path = request.query.get("path", "").strip()

    if not raw_path:
        raise web.HTTPBadRequest(text="Missing 'path' query parameter.")

    try:
        png_bytes = make_thumbnail_png(raw_path)
    except ValueError as error:
        raise web.HTTPNotFound(text=str(error))
    except Exception as error:
        raise web.HTTPInternalServerError(text=str(error))

    return web.Response(body=png_bytes, content_type="image/png")
