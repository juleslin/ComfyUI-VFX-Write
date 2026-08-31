// ComfyUI-VFX-Write / web/write_stage1.js
//
// Node type: VFXWrite   Extension: vfx.write.stage1
// Routes:    /vfx-write/browse  /vfx-write/versions  /vfx-write/frames
//            /vfx-write/thumbnail  /vfx-write/video
//
// Layout: Choose destination -> path -> frame_start (hidden) -> Preview
// version -> frame -> first -> last -> preview (a single widget: canvas +
// play/loop/fullscreen drawn as an overlay bar at its own bottom edge, not
// a separate widget — see the design note below for why). Controls on
// top, big preview filling the bottom — same shape as core nodes like
// Load Image — and preview is the LAST widget so nothing else can ever
// sit where it might overdraw.
//
// ---------------------------------------------------------------------------
// Preview sizing design (read this before touching computeSize/draw)
// ---------------------------------------------------------------------------
// computeSize() returns a small, TRULY FIXED minimum (PREVIEW_MIN_H) —
// never anything derived from node.size. draw() is what actually fills
// the live node.size, reading it fresh on every call.
//
// Four earlier, broken designs, kept here so the next change doesn't
// repeat them:
//   1. computeSize() returning a STORED value that draw() had derived from
//      node.size the frame before: LiteGraph clamps resize-drag results UP
//      to computeSize() as a floor. Since that floor reflected the
//      PREVIOUS frame's size, any mismatch with the real chrome height
//      compounded every redraw — the node grew on its own, detached from
//      the mouse.
//   2. computeSize() returning a fixed constant while draw() still filled
//      node.size dynamically, with preview and transport as TWO SEPARATE
//      widgets: stopped the runaway growth, but LiteGraph positions each
//      widget using the PRECEDING widget's computeSize(), not what it
//      actually drew — so transport (positioned right after preview)
//      stayed pinned wherever preview's fixed computeSize placed it,
//      never tracking preview's real drawn bottom edge as the node
//      resized.
//   3. computeSize() reading node.size live but updating its OWN cached
//      "chrome" from node.onResize(): the cached chrome could still go
//      stale mid-drag (onResize does not fire at every moment LiteGraph
//      itself consults computeSize()), reintroducing the same compounding
//      growth as #1.
//   4. computeSize() reading node.size live directly (no separate cache):
//      fixed growth AND transport-tracking (there's no transport widget
//      once merged into preview — see below), but broke SHRINKING. Since
//      computeSize()'s return scaled with the CURRENT size, it amounted
//      to "my minimum is my current size" — self-referential, so
//      LiteGraph's own "never go below computeSize()" rule blocked any
//      shrink attempt by definition, no matter how small a shrink.
// The fix: a computeSize() that is a genuine constant is the only design
// that can never conflict with a drag in either direction. It sacrifices
// nothing, because the ACTUAL dynamic "fill available space" look comes
// entirely from draw() reading node.size live — draw() never feeds back
// into LiteGraph's size bookkeeping the way computeSize() does.
//
// Merging transport into preview (one widget, not two) removes the
// remaining reason a second widget's position needed to track anything:
// there is no widget "after" preview whose position depends on preview's
// reported height, so preview can freely draw its play/loop/fullscreen
// bar whereever it likes within its own live-sized box.
//
// ---------------------------------------------------------------------------
// Value persistence design (read this before changing onConfigure)
// ---------------------------------------------------------------------------
// "Choose destination" is added before the native "path"/"frame_start"
// widgets, which reorders them relative to their LiteGraph creation order.
// LiteGraph serializes widget values POSITIONALLY into widgets_values[], so
// permuting node.widgets breaks save/restore unless handled explicitly
// (ComfyUI-VFX-Read hit this first — see its own read_stage1.js header).
// Fix, ported from Read: onSerialize writes a NAME-KEYED map into
// o.vfx_write_values; onConfigure restores from that map after
// reorderWidgets() has run, instead of relying on positional restore.
//
// frame / first / last are preview-only (not Python inputs at all — they
// never affect what gets written) and are always re-derived from the
// selected version's real frame range, so they are marked serialize:false
// rather than persisted.

import { app } from "../../scripts/app.js";

const NODE_TYPE = "VFXWrite";
const PREVIEW_WIDGET = "$$vfx-write-preview";
const VIDEO_WIDGET = "$$vfx-write-video";
const FULLSCREEN_ROW_WIDGET = "$$vfx-write-fullscreen-row";
const VERSION_WIDGET = "$$vfx-write-version";
const BROWSE_WIDGET = "Choose destination";
const FRAME_WIDGET = "frame";
const FIRST_WIDGET = "first";
const LAST_WIDGET = "last";

// "frame" is a REAL Python input now (the write() function uses it to
// extract a frame back out of a written video), so it needs the same
// name-keyed persistence protection as path/file_name/frame_start.
// first/last stay UI-only (serialize:false) — informational range display,
// not something write() reads.
const VALUE_WIDGETS = ["path", "file_name", "frame_start", FRAME_WIDGET];

const WIDGET_ORDER = [
  BROWSE_WIDGET,
  "path",
  "file_name",
  "frame_start",
  VERSION_WIDGET,
  FRAME_WIDGET,
  FIRST_WIDGET,
  LAST_WIDGET,
  FULLSCREEN_ROW_WIDGET,
  PREVIEW_WIDGET,
  VIDEO_WIDGET,
];

const PREVIEW_MIN_H = 120;
const PREVIEW_DEFAULT_H = 220;
const TRANSPORT_H = 24;

const MOVIE_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]);

const PREFETCH_AHEAD = 24;
const PREFETCH_BEHIND = 8;
const MAX_CONCURRENT = 4;
const MAX_CACHE = 240;
const DEFAULT_FPS = 24;

function el(tag, style, props) {
  const node = document.createElement(tag);
  if (style) Object.assign(node.style, style);
  if (props) Object.assign(node, props);
  return node;
}

function getWidget(node, name) {
  return node.widgets?.find((w) => w.name === name) || null;
}

// Node 2.0 renders each widget's visible DOM control (text/number/combo
// input) from a separate Vue-reactive mirror on widget._state, NOT from
// widget.value directly — confirmed live this session against ComfyUI-VFX-
// Read's identical bug (widget.value correctly held a restored value after
// reload, but the actual on-screen input showed empty, because nothing had
// ever written to _state.value). Writing widget._state.value directly does
// trigger Vue's reactivity and fixes the display; classic-mode widgets (no
// _state) are unaffected by the extra check. Every programmatic
// widget-value write in this file should go through this function rather
// than assigning widget.value directly, or the same bug recurs.
function setWidget(node, name, value) {
  const w = getWidget(node, name);
  if (!w) return;
  if (w.value !== value) w.value = value;
  if (w._state && w._state.value !== value) w._state.value = value;
}

// Mirrors nodes.py's combine_path(): join the folder ("path") and the
// filename pattern ("file_name") into the one combined pattern string the
// backend routes (versions/frames/thumbnail/video-info) all still expect.
function patternOf(node) {
  const folder = (getWidget(node, "path")?.value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const name = (getWidget(node, "file_name")?.value || "").trim().replace(/\\/g, "/");
  if (!folder || !name) return "";
  return `${folder}/${name}`;
}

function numValue(node, name, fallback) {
  const v = getWidget(node, name)?.value;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function apiGet(path, params) {
  const url = new URL(path, window.location.origin);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return await response.json();
}

function thumbnailUrl(sourcePath) {
  const url = new URL("/vfx-write/thumbnail", window.location.origin);
  url.searchParams.set("path", sourcePath || "");
  return url.toString();
}

function videoUrl(sourcePath) {
  const url = new URL("/vfx-write/video", window.location.origin);
  url.searchParams.set("path", sourcePath || "");
  return url.toString();
}

function isMovie(path) {
  const dot = (path || "").lastIndexOf(".");
  if (dot < 0) return false;
  return MOVIE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

// Chrome = everything on the node that ISN'T the preview (title,
// input/output sockets, every other widget) — a fixed quantity for this
// node type, measured exactly once and cached on the node instance.
//
// Rather than reimplementing LiteGraph's own layout math by hand (tried
// that — it undercounted by ~48px, most likely missing how it reserves
// space for this node's input/output sockets), this asks LiteGraph
// itself: the preview widget's own computeSize() (below) is a genuine
// constant (PREVIEW_MIN_H), so node.computeSize()'s total is always
// exactly chrome + PREVIEW_MIN_H — subtracting PREVIEW_MIN_H isolates
// chrome, with no dependency on node.size anywhere in the measurement.
// Verified live that node.computeSize() does not mutate node.size, so
// this is a safe, pure read.
function chromeOf(node) {
  if (node.__vfxWriteChrome !== undefined) return node.__vfxWriteChrome;
  node.__vfxWriteChrome = node.computeSize()[1] - PREVIEW_MIN_H;
  return node.__vfxWriteChrome;
}

// ---------------------------------------------------------------------------
// name-keyed value persistence (see header comment)
// ---------------------------------------------------------------------------

function collectValues(node) {
  const out = {};
  for (const name of VALUE_WIDGETS) {
    const w = getWidget(node, name);
    if (w) out[name] = w.value;
  }
  return out;
}

function sanitizeValues(saved) {
  const src = saved && typeof saved === "object" ? saved : {};
  const path = src.path;
  const fileName = src.file_name;
  const frameStart = Number(src.frame_start);
  const frame = Number(src[FRAME_WIDGET]);

  return {
    path: typeof path === "string" ? path : "",
    file_name: typeof fileName === "string" ? fileName : "",
    frame_start: Number.isFinite(frameStart) ? frameStart : 1001,
    [FRAME_WIDGET]: Number.isFinite(frame) ? frame : 1,
  };
}

function applyValues(node, values) {
  const clean = sanitizeValues(values);
  for (const name of VALUE_WIDGETS) {
    setWidget(node, name, clean[name]);
  }
  return clean;
}

// Hidden, not removed: the value (default 1001) still exists and still
// controls where a new sequence's numbering starts — it's just not shown,
// per request. Same technique ComfyUI-VFX-Read uses for its range widgets.
function hideWidget(node, name) {
  const w = getWidget(node, name);
  if (!w) return;
  w.hidden = true;
  w.computeSize = () => [0, -4];
}

function reorderWidgets(node) {
  if (!Array.isArray(node.widgets) || !node.widgets.length) return;

  hideWidget(node, "frame_start");

  const rank = (w) => {
    const i = WIDGET_ORDER.indexOf(w?.name);
    return i === -1 ? WIDGET_ORDER.length : i;
  };

  const decorated = node.widgets.map((w, i) => ({ w, i, r: rank(w) }));
  decorated.sort((a, b) => a.r - b.r || a.i - b.i);

  const next = decorated.map((d) => d.w);
  if (!next.some((w, i) => w !== node.widgets[i])) return;

  node.widgets.length = 0;
  node.widgets.push(...next);
  node.setDirtyCanvas?.(true, true);
}

function watchWidgetValue(widget, onChange) {
  if (!widget || widget.__vfxWatched) return;

  const existing = Object.getOwnPropertyDescriptor(widget, "value");
  let backing = existing && "value" in existing ? existing.value : widget.value;

  const get = existing && existing.get ? existing.get.bind(widget) : () => backing;
  const set =
    existing && existing.set
      ? existing.set.bind(widget)
      : (v) => {
          backing = v;
        };

  Object.defineProperty(widget, "value", {
    configurable: true,
    enumerable: true,
    get,
    set(v) {
      const before = get();
      set(v);
      if (before !== get()) {
        try {
          onChange(get());
        } catch (e) {
          console.error(e);
        }
      }
    },
  });

  widget.__vfxWatched = true;
}

// ---------------------------------------------------------------------------
// frame cache — keyed by frame number (or 0 for a single-file "sequence"),
// mirrors ComfyUI-VFX-Read's prefetch approach.
// ---------------------------------------------------------------------------

function createFrameCache() {
  return { map: new Map(), order: [], inflight: 0, queue: [] };
}

function cacheTrim(cache) {
  while (cache.order.length > MAX_CACHE) {
    cache.map.delete(cache.order.shift());
  }
}

function cacheRequest(cache, path, key, onReady) {
  const existing = cache.map.get(key);
  if (existing) return existing;

  const entry = { img: null, ready: false, failed: false };
  cache.map.set(key, entry);
  cache.order.push(key);
  cacheTrim(cache);

  cache.queue.push({ key, path, entry, onReady });
  cachePump(cache);
  return entry;
}

function cachePump(cache) {
  while (cache.inflight < MAX_CONCURRENT && cache.queue.length) {
    const job = cache.queue.shift();
    if (!cache.map.has(job.key)) continue;

    cache.inflight++;
    const img = new Image();
    img.decoding = "async";

    const done = (ok) => {
      cache.inflight--;
      job.entry.ready = ok;
      job.entry.failed = !ok;
      job.entry.img = ok ? img : null;
      if (ok) job.onReady?.(job.key);
      cachePump(cache);
    };

    img.addEventListener("load", () => done(true), { once: true });
    img.addEventListener("error", () => done(false), { once: true });
    img.src = thumbnailUrl(job.path);
  }
}

function cacheClear(cache) {
  cache.map.clear();
  cache.order.length = 0;
  cache.queue.length = 0;
}

// ---------------------------------------------------------------------------
// preview - a DOM widget (real <img>). Always the LAST widget before the
// video widget. Renders either a preloaded image (for a written image /
// image sequence) or is collapsed to zero height while buildVideoWidget's
// <video> is showing instead — see the "mode" field on state.
// ---------------------------------------------------------------------------

// Node 2.0 gives a canvas type:"custom" widget a HARD grid cell matching
// exactly what its computeSize() reports — confirmed live this session by
// inspecting the real DOM: our preview widget's row was exactly
// PREVIEW_MIN_H (120px) tall, no more, with the NEXT widget's own
// (opaque-background) row starting immediately after it. Classic LiteGraph
// let a widget's draw() call paint taller than its own declared box
// harmlessly (nothing clipped it); Node 2.0's real CSS grid does NOT allow
// that — content painted below the 120px cell is simply covered by the
// next row's own opaque background, which is exactly the "part of the
// canvas is cropped" bug reported live. A DOM widget doesn't have this
// problem at all: its wrapper element visibly stretches to fill whatever
// space is actually available (confirmed for the video widget below), so
// this is now a real <img>, not a canvas draw() — same fix, same
// architecture, as the video widget already uses.
function buildPreviewWidget(node) {
  const state = {
    mode: "image", // "image" | "video" — video uses buildVideoWidget's
    // <video> element instead. This widget's DOM wrapper collapses to
    // zero height in video mode; see reorderWidgets/buildVideoWidget for
    // how the two trade off which one is actually visible.
    img: null,
    videoEl: null,
    filename: "",
    frameList: [],
    currentFrame: null,
    cache: createFrameCache(),
    playing: false,
    loop: false,
    rafId: 0, // image-sequence play loop
    lastTick: 0,
    acc: 0,
  };

  const container = el("div", {
    width: "100%",
    height: "100%",
    background: "#181818",
    border: "1px solid #333",
    borderRadius: "4px",
    overflow: "hidden",
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });

  const imgEl = document.createElement("img");
  Object.assign(imgEl.style, {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain",
    display: "none",
  });
  imgEl.draggable = false;

  const placeholder = el(
    "div",
    { color: "#777", font: "11px sans-serif" },
    { textContent: "No output written yet." }
  );

  const label = el(
    "div",
    {
      position: "absolute",
      left: "6px",
      bottom: "6px",
      maxWidth: "calc(100% - 12px)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      background: "rgba(0,0,0,0.55)",
      color: "#c8c8c8",
      font: "10px monospace",
      padding: "2px 4px",
      borderRadius: "2px",
      pointerEvents: "none",
      display: "none",
    }
  );

  container.appendChild(placeholder);
  container.appendChild(imgEl);
  container.appendChild(label);

  const widget = node.addDOMWidget(PREVIEW_WIDGET, "image", container, {
    serialize: false,
  });
  widget.computeSize = (width) => [width, state.mode === "video" ? 0 : PREVIEW_MIN_H];

  state.imgEl = imgEl;
  state.placeholderEl = placeholder;
  state.labelEl = label;
  state.previewContainer = container;
  node.__vfxWritePreview = state;
  return widget;
}

// Resets the image side of the preview to "nothing loaded". Used whenever
// switching away from a shown frame (new version, video mode, empty
// sequence) — keeps the DOM in sync with state without duplicating the
// show/hide logic at every call site.
function clearImageDisplay(state) {
  state.img = null;
  state.filename = "";
  if (state.imgEl) {
    state.imgEl.removeAttribute("src");
    state.imgEl.style.display = "none";
  }
  if (state.placeholderEl) state.placeholderEl.style.display = "block";
  if (state.labelEl) state.labelEl.style.display = "none";
}

// ---------------------------------------------------------------------------
// video - a real, persistent <video controls loop> element (a DOM widget,
// not a canvas), used instead of PREVIEW_WIDGET when state.mode is
// "video". Real playback, scrub bar, volume, and fullscreen all come for
// free from the browser — no custom drawing, no custom hit-testing, no
// custom fullscreen handling to get wrong. Built once and reused for the
// node's lifetime; setupVideo/teardownVideo just show/hide it and change
// its src.
//
// computeSize() is a genuine constant here too, for the exact same reason
// as PREVIEW_WIDGET's (see the design note near the top of this file) —
// the two widgets' computeSize()s are simple opposites of each other
// (whichever matches the current state.mode reports PREVIEW_MIN_H, the
// other reports 0), so they never both claim space, and neither depends
// on node.size, so neither can create a resize feedback loop.
// ---------------------------------------------------------------------------

function buildVideoWidget(node) {
  const state = node.__vfxWritePreview;

  const container = el("div", {
    width: "100%",
    height: "100%",
    background: "#000",
    borderRadius: "4px",
    overflow: "hidden",
    display: "none",
  });

  const videoEl = document.createElement("video");
  videoEl.controls = true;
  videoEl.playsInline = true;
  Object.assign(videoEl.style, {
    width: "100%",
    height: "100%",
    display: "block",
    objectFit: "contain",
    background: "#000",
  });

  container.appendChild(videoEl);

  const widget = node.addDOMWidget(VIDEO_WIDGET, "video", container, {
    serialize: false,
  });
  widget.computeSize = (width) => [width, state.mode === "video" ? PREVIEW_MIN_H : 0];

  state.videoEl = videoEl;
  state.videoContainer = container;
  return widget;
}

// A real, directly-clickable native <button> — not drawn on the canvas.
// Canvas-drawn buttons proved unreliable through LiteGraph's own dispatch
// (the exact issue that made the old video controls not respond, and
// likely the image fullscreen button too), so this uses the same fix
// already proven for the fullscreen overlay's own button: a genuine DOM
// element with a real click listener. A small fixed-height row, not
// overlaid on the canvas — placed BEFORE preview in WIDGET_ORDER, so
// (unlike the old transport bar) it never needs preview to already be
// last to avoid overlap; it has nothing dynamic about its own size at
// all. Only shown in image mode — video's own native controls already
// have a fullscreen button.
function buildFullscreenButtonWidget(node) {
  const state = node.__vfxWritePreview;

  const container = el("div", {
    width: "100%",
    display: "flex",
    justifyContent: "flex-end",
  });

  const btn = el(
    "button",
    {
      background: "#2c2c2c",
      color: "#eee",
      border: "1px solid #5a5a5a",
      borderRadius: "3px",
      padding: "3px 10px",
      font: "11px sans-serif",
      cursor: "pointer",
    },
    { textContent: "⛶ Fullscreen" }
  );
  btn.addEventListener("click", () => openFullscreen(node));

  container.appendChild(btn);

  const widget = node.addDOMWidget(FULLSCREEN_ROW_WIDGET, "fullscreen", container, {
    serialize: false,
  });
  widget.computeSize = (width) => [width, state.mode === "video" ? 0 : TRANSPORT_H];

  state.fullscreenBtnContainer = container;
  return widget;
}

// ---------------------------------------------------------------------------
// frame display + version loading
// ---------------------------------------------------------------------------

function showFrame(node, frameNumber) {
  const state = node.__vfxWritePreview;
  if (!state || !state.frameList.length) return;

  const entry =
    state.frameList.find((f) => f.frame === frameNumber) || state.frameList[0];
  const idx = state.frameList.indexOf(entry);
  const key = entry.frame ?? 0;

  const applyEntry = (k) => {
    const cacheEntry = state.cache.map.get(k);
    if (!cacheEntry?.ready || !cacheEntry.img) return;
    state.img = cacheEntry.img;
    if (state.imgEl) {
      // Reuses the cache entry's already-fetched URL, so this paints
      // instantly from the browser's own HTTP cache rather than refetching.
      state.imgEl.src = cacheEntry.img.src;
      state.imgEl.style.display = "block";
    }
    if (state.placeholderEl) state.placeholderEl.style.display = "none";
  };

  state.currentFrame = key;
  const cacheEntry = cacheRequest(state.cache, entry.path, key, (k) => {
    if (state.currentFrame === k) applyEntry(k);
  });
  if (cacheEntry.ready) applyEntry(key);

  for (let i = 1; i <= PREFETCH_AHEAD; i++) {
    const n = state.frameList[idx + i];
    if (!n) break;
    cacheRequest(state.cache, n.path, n.frame ?? 0, null);
  }
  for (let i = 1; i <= PREFETCH_BEHIND; i++) {
    const n = state.frameList[idx - i];
    if (!n) break;
    cacheRequest(state.cache, n.path, n.frame ?? 0, null);
  }

  const count = state.frameList.length;
  const suffix = count > 1 ? `  [${idx + 1}/${count}]` : "";
  state.filename = `${entry.path}${suffix}`;
  if (state.labelEl) {
    state.labelEl.textContent = state.filename;
    state.labelEl.style.display = state.filename ? "block" : "none";
  }
}

// state.videoEl / state.videoContainer are built ONCE by buildVideoWidget
// and persist for the node's lifetime — teardown/setup just hide/show and
// change the source, they don't create or destroy the element itself.
function teardownVideo(state) {
  state.mode = "image";
  if (state.videoEl) {
    state.videoEl.pause();
    state.videoEl.removeAttribute("src");
    state.videoEl.load();
  }
  if (state.videoContainer) state.videoContainer.style.display = "none";
  if (state.fullscreenBtnContainer) state.fullscreenBtnContainer.style.display = "flex";
  // computeSize()'s [width, 0] in video mode does NOT actually collapse a
  // DOM widget's wrapper under Node 2.0 (confirmed live: the same
  // "computeSize is ignored for hiding" behavior hit by before_range/
  // after_range/missing_frames) — without this, the image container sat
  // there as a thin black bar with "No output written yet." showing above
  // the video. Explicit display toggling is required either way.
  if (state.previewContainer) state.previewContainer.style.display = "flex";
}

function setupVideo(node, state, path) {
  if (!state.videoEl) return;
  state.mode = "video";
  clearImageDisplay(state);
  if (state.fullscreenBtnContainer) state.fullscreenBtnContainer.style.display = "none";
  if (state.previewContainer) state.previewContainer.style.display = "none";
  // Always loop during preview: native <video controls> has no loop
  // toggle of its own, and looping is the sensible default while
  // reviewing a short clip.
  state.videoEl.loop = true;
  state.videoEl.src = videoUrl(path);
  state.videoEl.load();
  if (state.videoContainer) state.videoContainer.style.display = "block";
}

async function loadVersion(node, pattern, version) {
  const state = node.__vfxWritePreview;
  if (!state || !pattern || version === undefined || version === null) return;

  stopPlay(node);
  teardownVideo(state);
  cacheClear(state.cache);
  clearImageDisplay(state);
  state.frameList = [];
  state.currentFrame = null;

  let frameData;
  try {
    frameData = await apiGet("/vfx-write/frames", { path: pattern, version });
  } catch (_) {
    frameData = { frames: [] };
  }

  if (frameData.frames && frameData.frames.length) {
    state.frameList = frameData.frames
      .slice()
      .sort((a, b) => a.frame - b.frame)
      .map((f) => ({ frame: f.frame, path: f.path }));
  } else {
    const versions = node.__vfxWriteVersions || [];
    const match = versions.find((v) => v.version === version);
    if (match) state.frameList = [{ frame: null, path: match.path }];
  }

  if (!state.frameList.length) {
    state.filename = "";
    node.__vfxWriteRestoring = true;
    setWidget(node, FIRST_WIDGET, 1);
    setWidget(node, LAST_WIDGET, 1);
    node.__vfxWriteRestoring = false;
    node.setDirtyCanvas?.(true, true);
    return;
  }

  const single = state.frameList.length === 1 ? state.frameList[0] : null;

  if (single && isMovie(single.path)) {
    setupVideo(node, state, single.path);
    state.filename = single.path;

    // first/last become real ffprobe-derived info about the video being
    // BROWSED — purely informational (so you know the valid range before
    // typing a frame to extract). Deliberately NOT touching `frame` here:
    // it's a real write()-time input controlling what gets extracted on
    // the NEXT run, and browsing an old version must never silently
    // change that (same "browsing never affects what gets written next"
    // rule as the version picker itself).
    let info = null;
    try {
      info = await apiGet("/vfx-write/video-info", { path: single.path });
    } catch (_) {
      info = null;
    }

    node.__vfxWriteRestoring = true;
    setWidget(node, FIRST_WIDGET, info?.first ?? 1);
    setWidget(node, LAST_WIDGET, info?.last ?? 1);
    node.__vfxWriteRestoring = false;

    node.setDirtyCanvas?.(true, true);
    return;
  }

  const nums = state.frameList.map((f) => f.frame).filter((n) => n !== null);
  const rangeFirst = nums.length ? Math.min(...nums) : 1;
  const rangeLast = nums.length ? Math.max(...nums) : 1;

  node.__vfxWriteRestoring = true;
  setWidget(node, FIRST_WIDGET, rangeFirst);
  setWidget(node, LAST_WIDGET, rangeLast);
  setWidget(node, FRAME_WIDGET, rangeFirst);
  node.__vfxWriteRestoring = false;

  showFrame(node, rangeFirst);
}

// ---------------------------------------------------------------------------
// version picker
// ---------------------------------------------------------------------------

async function refreshVersionList(node) {
  const versionWidget = getWidget(node, VERSION_WIDGET);
  if (!versionWidget) return;

  const pattern = patternOf(node);

  if (!pattern) {
    versionWidget.options.values = [];
    setWidget(node, VERSION_WIDGET, "");
    return;
  }

  let data;

  try {
    data = await apiGet("/vfx-write/versions", { path: pattern });
  } catch (_) {
    return;
  }

  const versions = data.versions || [];
  node.__vfxWriteVersions = versions;

  const labels = versions.map((v) => `v${String(v.version).padStart(2, "0")}`);
  versionWidget.options.values = labels;

  if (labels.length) {
    setWidget(node, VERSION_WIDGET, labels[labels.length - 1]);
    const latest = versions[versions.length - 1];
    loadVersion(node, pattern, latest.version);
  } else {
    setWidget(node, VERSION_WIDGET, "");
  }
}

// ---------------------------------------------------------------------------
// frame / first / last watchers
// ---------------------------------------------------------------------------

// Clamping only makes sense when there's an actual multi-frame IMAGE
// SEQUENCE loaded to scrub through (state.frameList.length > 1) — that's
// the only case where `frame` directly selects a real, already-cached
// preview thumbnail. In every other case — a fresh node before any
// version is loaded, a single image, or a video (frameList is a 1-entry
// dummy there, and first/last are just informational display of whatever
// video is currently BROWSED, not a bound on what write() should extract
// next) — `frame` is a forward-looking write()-time input with no real
// range to clamp against yet. Clamping it anyway was a real bug: on a
// fresh node first/last default to 1/1, so typing frame=30 before ever
// loading a version got silently reset to 1. Out-of-range values are
// instead caught at write() time with a clear ffmpeg error, same as Read.
function clampFrameToRange(node) {
  const state = node.__vfxWritePreview;
  if (!state || state.frameList.length <= 1) return;

  const first = numValue(node, FIRST_WIDGET, 1);
  const last = numValue(node, LAST_WIDGET, 1);
  if (first > last) return;

  const cur = numValue(node, FRAME_WIDGET, first);
  let next = cur;
  if (next < first) next = first;
  else if (next > last) next = last;

  if (next !== cur) {
    setWidget(node, FRAME_WIDGET, next);
  } else {
    showFrame(node, cur);
  }
}

function installWatchers(node) {
  watchWidgetValue(getWidget(node, FRAME_WIDGET), (v) => {
    if (node.__vfxWriteRestoring) return;

    const state = node.__vfxWritePreview;
    if (!state || state.frameList.length <= 1) return;

    const first = numValue(node, FIRST_WIDGET, 1);
    const last = numValue(node, LAST_WIDGET, 1);
    const num = Number(v);
    if (!Number.isFinite(num)) return;

    if (first <= last) {
      if (num < first) {
        setWidget(node, FRAME_WIDGET, first);
        return;
      }
      if (num > last) {
        setWidget(node, FRAME_WIDGET, last);
        return;
      }
    }

    showFrame(node, num);
  });

  for (const name of [FIRST_WIDGET, LAST_WIDGET]) {
    watchWidgetValue(getWidget(node, name), () => {
      if (node.__vfxWriteRestoring) return;
      clampFrameToRange(node);
    });
  }
}

// ---------------------------------------------------------------------------
// playback
// ---------------------------------------------------------------------------

function togglePlay(node) {
  const state = node.__vfxWritePreview;
  if (!state) return;
  state.playing ? stopPlay(node) : startPlay(node);
}

function startPlay(node) {
  const state = node.__vfxWritePreview;
  if (!state || state.playing) return;
  if (!state.frameList.length) return;

  state.playing = true;
  state.lastTick = performance.now();
  state.acc = 0;
  node.setDirtyCanvas?.(true, true);

  const tick = (now) => {
    if (!state.playing) return;

    const step = 1000 / DEFAULT_FPS;
    state.acc += now - state.lastTick;
    state.lastTick = now;

    if (state.acc >= step) {
      const advance = Math.floor(state.acc / step);
      state.acc -= advance * step;

      const first = numValue(node, FIRST_WIDGET, 1);
      const last = numValue(node, LAST_WIDGET, 1);
      let next = numValue(node, FRAME_WIDGET, first) + advance;

      if (next > last) {
        if (state.loop) {
          const span = Math.max(1, last - first + 1);
          next = first + ((next - first) % span);
        } else {
          setWidget(node, FRAME_WIDGET, last);
          stopPlay(node);
          return;
        }
      }

      setWidget(node, FRAME_WIDGET, next);
    }

    state.rafId = requestAnimationFrame(tick);
  };

  state.rafId = requestAnimationFrame(tick);
}

function stopPlay(node) {
  const state = node.__vfxWritePreview;
  if (!state) return;
  state.playing = false;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = 0;
  node.setDirtyCanvas?.(true, true);
}

// ---------------------------------------------------------------------------
// fullscreen review
// ---------------------------------------------------------------------------

// Real browser Fullscreen API (takes over the whole monitor, hides browser
// chrome) on the overlay element, not just a full-viewport-sized div —
// falls back silently to the plain overlay if the browser refuses (no
// user-gesture context, permissions policy, etc.), since the overlay is
// still a usable large preview either way.
function requestRealFullscreen(element) {
  const req = element.requestFullscreen || element.webkitRequestFullscreen;
  if (!req) return;
  try {
    const p = req.call(element);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) {}
}

function exitRealFullscreen() {
  const inFullscreen = document.fullscreenElement || document.webkitFullscreenElement;
  if (!inFullscreen) return;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!exit) return;
  try {
    const p = exit.call(document);
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) {}
}

// Image/sequence only — video is a real embedded <video controls> element
// (see buildVideoWidget) with its own native fullscreen button, so this
// is never reached in video mode (PREVIEW_WIDGET's mouse() short-circuits
// before calling this then).
// Full-resolution URL, not the small (max 640x420) thumbnail the little
// canvas preview uses — that thumbnail was also the earlier bug: an <img>
// sized only by max-width/max-height never grows PAST its own intrinsic
// size, so a 640x420 source just sat small in the middle of the screen no
// matter how big the overlay was.
function fullImageUrl(sourcePath) {
  const url = new URL("/vfx-write/image", window.location.origin);
  url.searchParams.set("path", sourcePath || "");
  return url.toString();
}

function openFullscreen(node) {
  const state = node.__vfxWritePreview;
  if (!state || !state.img) return;

  const entry = state.frameList[state.frameIndex] || state.frameList[0];
  const sourcePath = entry?.path;
  if (!sourcePath) return;

  const overlay = el("div", {
    position: "fixed",
    inset: "0",
    background: "#000",
    zIndex: "10001",
    overflow: "hidden",
  });

  // Fills the overlay at all times; the <img> inside is what actually
  // scales/pans via CSS transform for zoom, independent of this box.
  const viewport = el("div", {
    width: "100%",
    height: "100%",
    overflow: "hidden",
    cursor: "grab",
  });

  // width/height:100% + object-fit — NOT max-width/max-height — so a
  // small source image is scaled UP to fill the screen too, not just
  // capped when it's larger. object-fit:contain keeps the aspect ratio
  // either way.
  const img = el("img", {
    width: "100%",
    height: "100%",
    objectFit: "contain",
    userSelect: "none",
    transformOrigin: "center center",
  });
  img.draggable = false;
  img.src = fullImageUrl(sourcePath);

  viewport.appendChild(img);

  let scale = 1;
  let tx = 0;
  let ty = 0;
  const MIN_SCALE = 1;
  const MAX_SCALE = 12;

  function applyTransform() {
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    viewport.style.cursor = scale > 1 ? "grab" : "default";
  }

  function resetView() {
    scale = 1;
    tx = 0;
    ty = 0;
    applyTransform();
  }

  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
      if (next === scale) return;
      scale = next;
      if (scale === MIN_SCALE) {
        tx = 0;
        ty = 0;
      }
      applyTransform();
    },
    { passive: false }
  );

  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let panStartX = 0;
  let panStartY = 0;

  viewport.addEventListener("mousedown", (e) => {
    if (scale <= MIN_SCALE) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = tx;
    panStartY = ty;
    viewport.style.cursor = "grabbing";
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    tx = panStartX + (e.clientX - dragStartX);
    ty = panStartY + (e.clientY - dragStartY);
    applyTransform();
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    viewport.style.cursor = scale > 1 ? "grab" : "default";
  });

  viewport.addEventListener("dblclick", resetView);

  function sync() {
    // Keep showing the frame currently on the small preview if it changes
    // (e.g. still playing an image sequence) while fullscreen is open.
    const current = state.frameList[state.frameIndex] || state.frameList[0];
    const p = current?.path;
    if (p && !img.src.endsWith(encodeURIComponent(p))) {
      img.src = fullImageUrl(p);
    }
  }

  const iv = setInterval(sync, 200);

  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(iv);
    exitRealFullscreen();
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("fullscreenchange", onFsChange);
    document.removeEventListener("webkitfullscreenchange", onFsChange);
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

  // The browser's own Escape/UI exits real fullscreen without going
  // through onKey/click — catch that here so the overlay still cleans up.
  function onFsChange() {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) close();
  }

  document.addEventListener("keydown", onKey);
  document.addEventListener("fullscreenchange", onFsChange);
  document.addEventListener("webkitfullscreenchange", onFsChange);

  const closeBtn = el(
    "button",
    {
      position: "absolute",
      top: "12px",
      right: "12px",
      zIndex: "10002",
      background: "rgba(0,0,0,0.55)",
      color: "#eee",
      border: "1px solid #666",
      borderRadius: "4px",
      padding: "6px 10px",
      font: "12px sans-serif",
      cursor: "pointer",
    },
    { textContent: "✕ Close" }
  );
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });

  const hint = el("div", {
    position: "absolute",
    bottom: "12px",
    left: "12px",
    zIndex: "10002",
    background: "rgba(0,0,0,0.55)",
    color: "#ccc",
    borderRadius: "4px",
    padding: "4px 8px",
    font: "10px sans-serif",
    pointerEvents: "none",
  });
  hint.textContent = "Scroll to zoom · drag to pan · double-click to reset · Esc to close";

  overlay.appendChild(viewport);
  overlay.appendChild(closeBtn);
  overlay.appendChild(hint);
  document.body.appendChild(overlay);
  requestRealFullscreen(overlay);
}

// A real, directly-clickable native <button> inside the overlay. The
// automatic requestRealFullscreen() call right after opening the overlay
// may not always carry a valid "user activation" through LiteGraph's own
// canvas event dispatch by the time it runs — this guarantees one
// reliable path regardless, rather than leaving real fullscreen to chance
// (or to the viewer stumbling onto the video's own native controls, which
// don't exist for the image case anyway).
function fullscreenButton(targetElement) {
  const btn = el(
    "button",
    {
      position: "absolute",
      top: "12px",
      right: "12px",
      zIndex: "10002",
      background: "rgba(0,0,0,0.55)",
      color: "#eee",
      border: "1px solid #666",
      borderRadius: "4px",
      padding: "6px 10px",
      font: "12px sans-serif",
      cursor: "pointer",
    },
    { textContent: "⛶ Fullscreen" }
  );

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    requestRealFullscreen(targetElement);
  });

  return btn;
}

// ---------------------------------------------------------------------------
// destination browser (folder navigation + filename)
// ---------------------------------------------------------------------------

function buildBrowseDialog(node) {
  const overlay = el("div", {
    position: "fixed",
    inset: "0",
    background: "rgba(0,0,0,0.55)",
    zIndex: "10000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });

  const panel = el("div", {
    width: "min(760px, 90vw)",
    height: "min(560px, 85vh)",
    background: "#232323",
    border: "1px solid #444",
    borderRadius: "6px",
    display: "flex",
    flexDirection: "column",
    font: "12px sans-serif",
    color: "#ddd",
    overflow: "hidden",
  });

  const head = el("div", {
    flex: "0 0 auto",
    display: "flex",
    gap: "6px",
    padding: "8px",
    borderBottom: "1px solid #3a3a3a",
  });

  const pathInput = el("input", {
    flex: "1 1 auto",
    background: "#1a1a1a",
    border: "1px solid #444",
    color: "#ddd",
    padding: "4px 6px",
    borderRadius: "3px",
    font: "11px monospace",
  });

  const upBtn = el("button", { flex: "0 0 auto" }, { textContent: "Up" });
  const goBtn = el("button", { flex: "0 0 auto" }, { textContent: "Go" });

  head.appendChild(pathInput);
  head.appendChild(upBtn);
  head.appendChild(goBtn);

  const list = el("div", { flex: "1 1 auto", overflowY: "auto", padding: "4px 0" });

  const hint = el("div", {
    flex: "0 0 auto",
    color: "#8a8a8a",
    font: "10px sans-serif",
    padding: "6px 8px",
    borderTop: "1px solid #3a3a3a",
  });
  hint.textContent =
    "Choosing a folder only. Set the file name (with its v## token) in the node's own \"file name\" field.";

  const foot = el("div", {
    flex: "0 0 auto",
    display: "flex",
    justifyContent: "flex-end",
    gap: "6px",
    padding: "8px",
    borderTop: "1px solid #3a3a3a",
  });

  const cancelBtn = el("button", null, { textContent: "Cancel" });
  const chooseBtn = el("button", null, { textContent: "Choose this folder" });
  foot.appendChild(cancelBtn);
  foot.appendChild(chooseBtn);

  panel.appendChild(head);
  panel.appendChild(list);
  panel.appendChild(hint);
  panel.appendChild(foot);
  overlay.appendChild(panel);

  let currentFolder = "";

  function close() {
    overlay.remove();
  }

  function row(label, sub, onClick) {
    const r = el("div", {
      display: "flex",
      justifyContent: "space-between",
      gap: "10px",
      padding: "4px 10px",
      cursor: onClick ? "pointer" : "default",
      whiteSpace: "nowrap",
    });
    const a = el("div", { overflow: "hidden", textOverflow: "ellipsis" });
    a.textContent = label;
    const b = el("div", { color: "#8a8a8a", flex: "0 0 auto" });
    b.textContent = sub || "";
    r.appendChild(a);
    r.appendChild(b);
    if (onClick) {
      r.addEventListener("mouseenter", () => (r.style.background = "#2e2e2e"));
      r.addEventListener("mouseleave", () => (r.style.background = "transparent"));
      r.addEventListener("click", onClick);
    }
    list.appendChild(r);
    return r;
  }

  async function load(dir) {
    list.replaceChildren();
    row("Loading...", "", null);
    let data;

    try {
      data = await apiGet("/vfx-write/browse", { path: dir || "" });
    } catch (e) {
      list.replaceChildren();
      row(`Error: ${e.message}`, "", null);
      return;
    }

    list.replaceChildren();

    currentFolder = data.folder || "";
    pathInput.value = currentFolder;

    if (data.parent && data.parent !== currentFolder) {
      row(".. (parent)", "dir", () => load(data.parent));
    }

    for (const d of data.directories || []) {
      row(d.name, "dir", () => load(d.path));
    }

    // Files are shown for context only (so you can see what's already in
    // a folder) — nothing to pick, this dialog only chooses a folder.
    for (const f of data.files || []) {
      row(f, "file");
    }

    if (!list.children.length) row("(empty)", "", null);
  }

  upBtn.addEventListener("click", async () => {
    try {
      const data = await apiGet("/vfx-write/browse", { path: currentFolder });
      if (data.parent && data.parent !== data.folder) load(data.parent);
    } catch (_) {}
  });

  goBtn.addEventListener("click", () => load(pathInput.value));
  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") load(pathInput.value);
  });

  chooseBtn.addEventListener("click", () => {
    const typed = pathInput.value.trim();
    const folder = (typed || currentFolder).replace(/\\/g, "/").replace(/\/+$/, "");
    if (!folder) return;

    const pathWidget = getWidget(node, "path");
    setWidget(node, "path", folder);
    pathWidget?.callback?.(folder);
    refreshVersionList(node);
    close();
  });

  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  document.body.appendChild(overlay);

  load(getWidget(node, "path")?.value || "");
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "vfx.write.stage1",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;

    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);

      this.addWidget("button", BROWSE_WIDGET, "", () => {
        buildBrowseDialog(this);
      });

      const versionWidget = this.addWidget(
        "combo",
        VERSION_WIDGET,
        "",
        (value) => {
          const versions = this.__vfxWriteVersions || [];
          const match = versions.find(
            (v) => `v${String(v.version).padStart(2, "0")}` === value
          );

          if (match) {
            loadVersion(this, patternOf(this), match.version);
          }
        },
        { values: [] }
      );
      versionWidget.label = "Preview version";
      versionWidget.serialize = false;

      // "frame" is NOT created here — it's a real Python input now
      // (declared in INPUT_TYPES, write() uses it to extract a frame back
      // out of a written video), so ComfyUI already auto-creates its
      // native widget before onNodeCreated runs, same as path/file_name/
      // frame_start. It persists and restores through the same
      // name-keyed path as those (see VALUE_WIDGETS / onConfigure).

      const firstWidget = this.addWidget(
        "number",
        FIRST_WIDGET,
        1,
        () => {},
        { min: 0, max: 10000000, step: 1, precision: 0 }
      );
      firstWidget.serialize = false;

      const lastWidget = this.addWidget(
        "number",
        LAST_WIDGET,
        1,
        () => {},
        { min: 0, max: 10000000, step: 1, precision: 0 }
      );
      lastWidget.serialize = false;

      buildPreviewWidget(this);
      buildVideoWidget(this);
      buildFullscreenButtonWidget(this);
      installWatchers(this);

      for (const name of ["path", "file_name"]) {
        const w = getWidget(this, name);
        if (!w) continue;

        const onChange = w.callback;

        w.callback = (...args) => {
          const out = onChange?.apply(w, args);
          refreshVersionList(this);
          return out;
        };
      }

      reorderWidgets(this);
      refreshVersionList(this);

      // LiteGraph's node-creation default size does not consult custom
      // widgets' own computeSize() (confirmed live: a fresh node stays at
      // its generic default size indefinitely, well short of what preview
      // + transport + all the numeric widgets actually need). chromeOf()
      // measures the fixed non-preview total via its own bootstrap path
      // (does not touch this.size), so the correct initial fit is exactly
      // chrome + PREVIEW_DEFAULT_H — computed directly rather than via a
      // second this.computeSize() call, which would read the STILL-stale
      // this.size at this point and fit to the wrong number.
      const chrome = chromeOf(this);
      this.setSize([this.size[0], chrome + PREVIEW_DEFAULT_H]);

      return result;
    };

    const onSerialize = nodeType.prototype.onSerialize;

    nodeType.prototype.onSerialize = function (o) {
      const r = onSerialize?.apply(this, arguments);
      try {
        o.vfx_write_values = collectValues(this);
      } catch (e) {
        console.error("VFX Write serialize failed", e);
      }
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;

    nodeType.prototype.onConfigure = function (o) {
      const r = onConfigure?.apply(this, arguments);

      installWatchers(this);
      reorderWidgets(this);

      // Just prime the cache on this (freshly constructed) node instance —
      // deliberately NOT resizing here. The saved this.size (the user's
      // own prior resize, if any) is already correct as restored; chromeOf
      // only reads widgets' own computeSize(), never this.size, so it
      // can't disturb it.
      chromeOf(this);

      this.__vfxWriteRestoring = true;
      try {
        applyValues(this, o?.vfx_write_values);
      } finally {
        this.__vfxWriteRestoring = false;
      }

      setTimeout(() => refreshVersionList(this), 0);

      return r;
    };

    const onExecuted = nodeType.prototype.onExecuted;

    nodeType.prototype.onExecuted = function (message) {
      const result = onExecuted?.apply(this, arguments);

      const entries = message?.vfx_write;

      if (entries && entries.length) {
        refreshVersionList(this);
      }

      return result;
    };

    const onRemoved = nodeType.prototype.onRemoved;

    nodeType.prototype.onRemoved = function () {
      stopPlay(this);
      const state = this.__vfxWritePreview;
      if (state) {
        teardownVideo(state);
        cacheClear(state.cache);
      }
      this.__vfxWritePreview = null;
      return onRemoved?.apply(this, arguments);
    };
  },
});
