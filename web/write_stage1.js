// ComfyUI-VFX-Write / web/write_stage1.js
//
// Node type: VFXWrite   Extension: vfx.write.stage1
// Routes:    /vfx-write/browse  /vfx-write/versions  /vfx-write/frames
//            /vfx-write/frames-in-folder  /vfx-write/thumbnail  /vfx-write/video
//            /vfx-write/video-info  /vfx-write/image
//
// Layout: one file row (destination text + folder icon) -> one version row
// (dropdown, no label) -> preview (image or video) -> scrub bar -> a
// unified transport row (play/prev/next/loop/fullscreen). Direct port of
// ComfyUI-VFX-Read's own round-3 layout — see that file's header for the
// full design history this one reuses.
//
// ---------------------------------------------------------------------------
// Preview sizing design (read this before touching computeSize/draw)
// ---------------------------------------------------------------------------
// computeSize() returns a small, TRULY FIXED minimum (PREVIEW_MIN_H) —
// never anything derived from node.size. draw() (for the native preview;
// here everything is DOM so there's no draw() at all) or the DOM wrapper's
// own CSS is what actually fills the live node.size. See ComfyUI-VFX-Read's
// header for the four earlier, broken designs this avoids — same node type,
// same bug class, already solved once; not repeating that history here.
//
// ---------------------------------------------------------------------------
// Value persistence design (read this before changing onConfigure)
// ---------------------------------------------------------------------------
// LiteGraph serializes widget values POSITIONALLY into widgets_values[].
// reorderWidgets() permutes node.widgets in place, so the save-time array
// and the load-time array disagree and values land in the wrong slots. Fix:
// onSerialize writes a NAME-KEYED map into o.vfx_write_values, and
// onConfigure restores from that map after reorderWidgets() has run — same
// fix ComfyUI-VFX-Read uses.
//
// `path`/`file_name`/`frame_start` are real Python inputs (write() needs
// all three — VFXWrite has no outputs at all, it's a pure terminal/side-
// effect node), so — like Read's source_path/frame/first/last/etc. — each
// becomes an invisible DOM-backed carrier of the same name
// (buildHiddenValue/replaceWithHiddenCarrier) rather than a visible native
// row. `path`/`file_name` are driven by the single visible file-row text
// field (split on the last '/'); `frame_start` has no visible control at
// all — it just keeps its INPUT_TYPES default (1001) unless restored from
// a saved workflow. Confirmed via app.graphToPrompt() on Read:
// addDOMWidget's getValue/setValue IS what prompt-queuing reads through
// (keyed by name, same as a native widget), so this is safe for real
// execution parameters, not just decorative UI.
//
// `first`/`last` (the browsed version's on-disk frame range) are NOT Python
// inputs at all — purely local scrub-bar bookkeeping — so they're plain
// fields on the preview state object, not widgets. This also means the old
// frame/first/last "watcher" machinery (watchWidgetValue) is gone entirely
// — nothing in the UI writes into a real Python input at all; playback
// here is preview-only.

import { app } from "../../scripts/app.js";

const NODE_TYPE = "VFXWrite";

const PREVIEW_WIDGET = "$$vfx-write-preview";
const VIDEO_WIDGET = "$$vfx-write-video";
const SCRUB_WIDGET = "$$vfx-write-scrub";
const TRANSPORT_WIDGET = "vfx_write_transport";
const FILE_ROW_WIDGET = "$$vfx-write-file-row";
const VERSION_ROW_WIDGET = "$$vfx-write-version-row";

// Real Python inputs (write() reads all three) — see the design note above.
const VALUE_WIDGETS = ["path", "file_name", "frame_start"];

const WIDGET_ORDER = [
  FILE_ROW_WIDGET,
  VERSION_ROW_WIDGET,
  PREVIEW_WIDGET,
  VIDEO_WIDGET,
  SCRUB_WIDGET,
  TRANSPORT_WIDGET,
];

const PREVIEW_MIN_H = 120;
const PREVIEW_DEFAULT_H = 220;
const TRANSPORT_H = 24;
const SCRUB_H = 20;
// Wide enough for the file row's text field + folder icon, and the
// transport row's five buttons, without crowding. Retune directly if it
// doesn't match your own resized node.
const MIN_NODE_W = 320;

const MOVIE_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"]);

const PREFETCH_AHEAD = 24;
const PREFETCH_BEHIND = 8;
const MAX_CONCURRENT = 4;
const MAX_CACHE = 240;
const DEFAULT_FPS = 24;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function el(tag, style, props) {
  const node = document.createElement(tag);
  if (style) Object.assign(node.style, style);
  if (props) Object.assign(node, props);
  return node;
}

// Shared small dark-themed icon/label button — same styling used
// throughout this file's dialogs and rows.
function smallBtn(label, title) {
  return el(
    "button",
    {
      background: "#2c2c2c",
      color: "#ddd",
      border: "1px solid #4a4a4a",
      borderRadius: "3px",
      padding: "3px 8px",
      font: "11px sans-serif",
      cursor: "pointer",
      minWidth: "28px",
    },
    { textContent: label, title: title || "" }
  );
}

function rowTextInput(type) {
  return el(
    "input",
    {
      flex: "1 1 auto",
      minWidth: "0",
      background: "#1a1a1a",
      border: "1px solid #444",
      color: "#ddd",
      padding: "4px 6px",
      borderRadius: "3px",
      font: "11px monospace",
    },
    { type: type || "text" }
  );
}

function rowSelect(options) {
  const s = el("select", {
    width: "100%",
    background: "#1a1a1a",
    border: "1px solid #444",
    color: "#ddd",
    padding: "4px 6px",
    borderRadius: "3px",
    font: "11px sans-serif",
  });
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt;
    s.appendChild(o);
  }
  return s;
}

function pairedRowContainer() {
  return el("div", {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  });
}

// Grey outline-folder SVG (currentColor) instead of an emoji — an emoji
// glyph carries its own fixed color that can't be recolored via CSS; an
// inline SVG can.
function folderIconButton() {
  const btn = el(
    "button",
    {
      background: "#2c2c2c",
      border: "1px solid #4a4a4a",
      borderRadius: "3px",
      padding: "0 8px",
      cursor: "pointer",
      color: "#9a9a9a",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    },
    { title: "Choose destination" }
  );
  btn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">' +
    '<path d="M10 4H2v16h20V6H12l-2-2z"/></svg>';
  return btn;
}

// Commits a text field's value on Enter or on losing focus, rather than on
// every keystroke.
function commitOnEnterOrBlur(input, commit) {
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      commit();
      input.blur();
    }
  });
  input.addEventListener("blur", commit);
}

function getWidget(node, name) {
  return node.widgets?.find((w) => w.name === name) || null;
}

// Node 2.0 renders each widget's visible DOM control from a separate
// Vue-reactive mirror on widget._state, NOT from widget.value directly —
// see ComfyUI-VFX-Read's identical note. Every programmatic widget-value
// write in this file goes through this function.
function setWidget(node, name, value) {
  const w = getWidget(node, name);
  if (!w) return;
  if (w.value !== value) w.value = value;
  if (w._state && w._state.value !== value) w._state.value = value;
}

// Mirrors nodes.py's combine_path(): join the folder ("path") and the
// filename pattern ("file_name") into the one combined pattern string the
// backend routes (versions/frames/thumbnail/video/video-info) all expect.
function patternOf(node) {
  const folder = (getWidget(node, "path")?.value || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const name = (getWidget(node, "file_name")?.value || "").trim().replace(/\\/g, "/");
  if (!folder || !name) return "";
  return `${folder}/${name}`;
}

// The single combined string the file row shows: folder + "/" + filename.
function combinedDisplayValue(node) {
  const path = getWidget(node, "path")?.value || "";
  const fileName = getWidget(node, "file_name")?.value || "";
  if (!path && !fileName) return "";
  const folder = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return folder ? `${folder}/${fileName}` : fileName;
}

// Splits a typed/pasted combined string back into path + file_name on the
// last '/' — same split a save dialog would do. Everything before it is
// the destination folder, the remainder is the filename pattern (with its
// own v##/#### tokens).
function applyCombinedInput(node, raw) {
  const value = (raw || "").trim().replace(/\\/g, "/");
  const idx = value.lastIndexOf("/");
  const folder = idx >= 0 ? value.slice(0, idx) : "";
  const name = idx >= 0 ? value.slice(idx + 1) : value;
  setWidget(node, "path", folder);
  setWidget(node, "file_name", name);
  refreshVersionList(node);
}

function refreshFileRowDisplay(node) {
  const state = node.__vfxWritePreview;
  if (!state?.fileRowInput) return;
  const v = combinedDisplayValue(node);
  if (state.fileRowInput.value !== v) state.fileRowInput.value = v;
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

function fullImageUrl(sourcePath) {
  const url = new URL("/vfx-write/image", window.location.origin);
  url.searchParams.set("path", sourcePath || "");
  return url.toString();
}

// Chrome's <video> element (MEDIA_ERR_SRC_NOT_SUPPORTED, code 4) refuses
// to decode several codecs common in VFX delivery — ProRes and DNxHD
// chief among them — no matter the container extension. Confirmed live:
// a real ProRes .mov fails with the browser's own cryptic
// "PipelineStatus::DEMUXER_ERROR_NO_SUPPORTED_STREAMS" message, which
// reads like something is broken when the file (and the write/read paths
// themselves) are actually fine — only the in-node preview can't decode
// it. This is a genuine browser limitation with no workaround; the
// clearer message just says so instead of surfacing raw internals.
function friendlyVideoError(error) {
  if (error && error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    return "Preview unavailable: this video's codec isn't supported by browser playback (common for ProRes/DNxHD .mov files). The file itself is fine — just not previewable here.";
  }
  return error?.message || "Failed to load video.";
}

function isMovie(path) {
  const dot = (path || "").lastIndexOf(".");
  if (dot < 0) return false;
  return MOVIE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

// Chrome = everything on the node that ISN'T the preview (title,
// input/output sockets, every other widget) — a fixed quantity for this
// node type, measured exactly once and cached on the node instance. See
// ComfyUI-VFX-Read's chromeOf for the full design note.
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

  return {
    path: typeof path === "string" ? path : "",
    file_name: typeof fileName === "string" ? fileName : "",
    frame_start: Number.isFinite(frameStart) ? frameStart : 1001,
  };
}

function applyValues(node, values) {
  const clean = sanitizeValues(values);
  for (const name of VALUE_WIDGETS) {
    setWidget(node, name, clean[name]);
  }
  return clean;
}

// ---------------------------------------------------------------------------
// hidden value carriers (see design note near buildHiddenValue in
// ComfyUI-VFX-Read for why `widget.hidden = true` does NOT work on this
// ComfyUI build, and why `options.hidden` on a DOM widget does)
// ---------------------------------------------------------------------------

function buildHiddenValue(node, name, initialValue) {
  let backing = initialValue;
  const container = el("div", { display: "none" });
  const widget = node.addDOMWidget(name, "hidden", container, {
    getValue: () => backing,
    setValue: (v) => { backing = v; },
    hidden: true,
  });
  widget.computeSize = () => [0, 0];
  return widget;
}

// Removes the native widget ComfyUI auto-created from INPUT_TYPES for
// `name` and replaces it with an invisible carrier of the same name,
// seeded with whatever value it currently held. Runs in onNodeCreated,
// which always fires before onConfigure's own restore — so this seeds
// from the INPUT_TYPES default on a fresh node, and onConfigure's later
// setWidget() call finds this carrier by name and applies the real
// restored value to it exactly as it would a native widget.
function replaceWithHiddenCarrier(node, name) {
  const existing = getWidget(node, name);
  const initialValue = existing ? existing.value : undefined;
  if (existing) {
    const idx = node.widgets.indexOf(existing);
    if (idx !== -1) node.widgets.splice(idx, 1);
  }
  return buildHiddenValue(node, name, initialValue);
}

function reorderWidgets(node) {
  if (!Array.isArray(node.widgets) || !node.widgets.length) return;

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

// ---------------------------------------------------------------------------
// frame cache — keyed by frame number (or 0 for a single-file "sequence").
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
// file row — combined destination text field + folder icon
// ---------------------------------------------------------------------------

function buildFileRow(node) {
  const state = node.__vfxWritePreview;
  const container = pairedRowContainer();
  container.style.marginTop = "6px";

  const input = rowTextInput("text");
  input.placeholder = "Choose a destination...";
  input.value = combinedDisplayValue(node);
  commitOnEnterOrBlur(input, () => {
    applyCombinedInput(node, input.value);
    refreshFileRowDisplay(node);
  });

  const browseBtn = folderIconButton();
  browseBtn.addEventListener("click", () => buildBrowseDialog(node));

  container.appendChild(input);
  container.appendChild(browseBtn);

  const widget = node.addDOMWidget(FILE_ROW_WIDGET, "file-row", container, {
    serialize: false,
  });
  widget.computeSize = (width) => [width, TRANSPORT_H];

  state.fileRowInput = input;
  return widget;
}

// ---------------------------------------------------------------------------
// version row — dropdown only, no label
// ---------------------------------------------------------------------------

function setVersionSelectOptions(selectEl, labels) {
  selectEl.replaceChildren();
  for (const label of labels) {
    const o = document.createElement("option");
    o.value = label;
    o.textContent = label;
    selectEl.appendChild(o);
  }
}

function setVersionRowVisible(node, visible) {
  const state = node.__vfxWritePreview;
  if (!state || state.versionRowVisible === visible) return;
  state.versionRowVisible = visible;
  if (state.versionRowContainer) {
    state.versionRowContainer.style.display = visible ? "flex" : "none";
  }
  node.setDirtyCanvas?.(true, true);
}

function buildVersionRow(node) {
  const state = node.__vfxWritePreview;
  const container = pairedRowContainer();
  container.style.marginBottom = "8px";
  // Hidden until refreshVersionList finds at least one version — a file
  // with no version token anywhere (filename or destination folder) has
  // nothing to pick between, so there's no point showing an empty
  // dropdown. computeSize alone does NOT collapse a DOM widget's wrapper
  // under Node 2.0 (same "computeSize is ignored for hiding" behavior
  // documented throughout this project), so display is toggled directly
  // too — see refreshVersionList.
  container.style.display = "none";

  const versionSelect = rowSelect([]);
  versionSelect.title = "Version";
  // A bare <select> inside a flex row sizes to its OPTIONS' own text
  // content (e.g. "v01") under flex-basis:auto, not the container —
  // confirmed live: it left-aligned and sat at roughly a third of the row
  // width. flex:"1 1 auto" forces it to fill the row regardless of option
  // text length.
  versionSelect.style.flex = "1 1 auto";
  versionSelect.addEventListener("change", () => {
    const versions = node.__vfxWriteVersions || [];
    const match = versions.find(
      (v) => `v${String(v.version).padStart(2, "0")}` === versionSelect.value
    );
    if (match) loadVersion(node, patternOf(node), match.version);
  });

  container.appendChild(versionSelect);

  const widget = node.addDOMWidget(VERSION_ROW_WIDGET, "version-row", container, {
    serialize: false,
  });
  widget.computeSize = (width) => [width, state.versionRowVisible ? TRANSPORT_H : 0];

  state.versionSelect = versionSelect;
  state.versionRowContainer = container;
  state.versionRowVisible = false;
  return widget;
}

async function refreshVersionList(node) {
  const state = node.__vfxWritePreview;
  const versionSelect = state?.versionSelect;
  if (!versionSelect) return;

  const pattern = patternOf(node);

  if (!pattern) {
    setVersionSelectOptions(versionSelect, []);
    setVersionRowVisible(node, false);
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
  setVersionRowVisible(node, versions.length > 0);

  const labels = versions.map((v) => `v${String(v.version).padStart(2, "0")}`);
  setVersionSelectOptions(versionSelect, labels);

  if (labels.length) {
    versionSelect.value = labels[labels.length - 1];
    const latest = versions[versions.length - 1];
    loadVersion(node, pattern, latest.version);
  }
}

// ---------------------------------------------------------------------------
// preview - a DOM widget (real <img>). Always before the video widget.
// ---------------------------------------------------------------------------

function buildPreviewWidget(node) {
  const state = {
    mode: "image", // "image" | "video" — video uses buildVideoWidget's
    // <video> element instead; this widget's DOM wrapper collapses to
    // zero height while that's active.
    playhead: 1, // currently browsed/scrubbed frame number
    first: 1,
    last: 1,
    scrubVisible: false,
    img: null,
    shownPath: null,
    videoEl: null,
    filename: "",
    frameList: [],
    currentFrame: null,
    cache: createFrameCache(),
    playing: false,
    loop: false,
    rafId: 0,
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

function clearImageDisplay(state) {
  state.img = null;
  state.shownPath = null;
  state.filename = "";
  if (state.imgEl) {
    state.imgEl.removeAttribute("src");
    state.imgEl.style.display = "none";
  }
  if (state.placeholderEl) state.placeholderEl.style.display = "block";
  if (state.labelEl) state.labelEl.style.display = "none";
}

// ---------------------------------------------------------------------------
// video - a real, persistent <video controls loop> element.
// ---------------------------------------------------------------------------

function buildVideoWidget(node) {
  const state = node.__vfxWritePreview;

  const container = el("div", {
    width: "100%",
    height: "100%",
    background: "#000",
    borderRadius: "4px",
    overflow: "hidden",
    position: "relative",
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

  // A video with no loading feedback of its own can look frozen for
  // several seconds on a large or slow-to-reach file (e.g. a network
  // drive) — reported live as "choosing a movie has no response", when
  // it was actually just buffering with nothing on screen to say so.
  // Mirrors the image preview's own "Loading preview..." placeholder.
  const status = el(
    "div",
    {
      position: "absolute",
      inset: "0",
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      color: "#aaa",
      font: "11px sans-serif",
      background: "rgba(0,0,0,0.4)",
      pointerEvents: "none",
      textAlign: "center",
      padding: "8px",
    },
    { textContent: "Loading video..." }
  );

  container.appendChild(videoEl);
  container.appendChild(status);

  const widget = node.addDOMWidget(VIDEO_WIDGET, "video", container, {
    serialize: false,
  });
  widget.computeSize = (width) => [width, state.mode === "video" ? PREVIEW_MIN_H : 0];

  // Native controls stay on for fast drag-to-seek scanning; keep our own
  // transport row's play/pause icon in sync either way.
  videoEl.addEventListener("play", () => state.refreshTransportUI?.());
  videoEl.addEventListener("pause", () => state.refreshTransportUI?.());
  videoEl.addEventListener("loadstart", () => {
    status.textContent = "Loading video...";
    status.style.display = "flex";
  });
  videoEl.addEventListener("canplay", () => {
    status.style.display = "none";
  });
  videoEl.addEventListener("error", () => {
    status.textContent = friendlyVideoError(videoEl.error);
    status.style.display = "flex";
  });

  state.videoEl = videoEl;
  state.videoContainer = container;
  state.videoStatusEl = status;
  return widget;
}

// Drag-able scrub bar — direct port of ComfyUI-VFX-Read's own scrub
// widget. Hidden in video mode (native <video> already has one) and for a
// single still frame (first === last).
function buildScrubWidget(node) {
  const state = node.__vfxWritePreview;

  const container = el("div", {
    width: "100%",
    display: "none",
    alignItems: "center",
  });

  const rangeEl = document.createElement("input");
  rangeEl.type = "range";
  rangeEl.min = "1";
  rangeEl.max = "1";
  rangeEl.step = "1";
  rangeEl.value = "1";
  Object.assign(rangeEl.style, {
    width: "100%",
    accentColor: "#8a8a8a",
    cursor: "pointer",
  });

  rangeEl.addEventListener("input", () => {
    const value = Number(rangeEl.value);
    if (!Number.isFinite(value)) return;
    showFrame(node, value);
  });

  container.appendChild(rangeEl);

  const widget = node.addDOMWidget(SCRUB_WIDGET, "scrub", container, {
    serialize: false,
  });
  widget.computeSize = (width) => [width, state.scrubVisible ? SCRUB_H : 0];

  state.scrubEl = rangeEl;
  state.scrubContainer = container;
  return widget;
}

function refreshScrub(node) {
  const state = node.__vfxWritePreview;
  if (!state || !state.scrubEl) return;

  const first = state.first ?? 1;
  const last = state.last ?? first;
  state.scrubEl.min = String(Math.min(first, last));
  state.scrubEl.max = String(Math.max(first, last));

  const visible = state.mode !== "video" && first < last;
  state.scrubVisible = visible;
  if (state.scrubContainer) {
    state.scrubContainer.style.display = visible ? "flex" : "none";
  }
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

  state.playhead = frameNumber;
  if (state.scrubEl) state.scrubEl.value = String(frameNumber);

  const applyEntry = (k) => {
    const cacheEntry = state.cache.map.get(k);
    if (!cacheEntry?.ready || !cacheEntry.img) return;
    state.img = cacheEntry.img;
    state.shownPath = entry.path;
    if (state.imgEl) {
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

function teardownVideo(state) {
  state.mode = "image";
  if (state.videoEl) {
    state.videoEl.pause();
    state.videoEl.removeAttribute("src");
    state.videoEl.load();
  }
  if (state.videoContainer) state.videoContainer.style.display = "none";
  if (state.previewContainer) state.previewContainer.style.display = "flex";
  state.refreshTransportUI?.();
}

function setupVideo(node, state, path) {
  if (!state.videoEl) return;
  state.mode = "video";
  clearImageDisplay(state);
  if (state.previewContainer) state.previewContainer.style.display = "none";
  if (state.scrubContainer) state.scrubContainer.style.display = "none";
  state.videoEl.loop = state.loop;
  state.videoEl.src = videoUrl(path);
  state.videoEl.load();
  if (state.videoContainer) state.videoContainer.style.display = "block";
  state.refreshTransportUI?.();
}

// Shared tail end of loading a version OR previewing a freshly-picked
// file/sequence (see previewPicked below): given a resolved frameList,
// sets up video/scrub state and shows the first frame. Split out so both
// callers stay in sync rather than duplicating this logic.
async function applyFrameList(node, frameList) {
  const state = node.__vfxWritePreview;
  state.frameList = frameList;

  if (!state.frameList.length) {
    state.filename = "";
    refreshScrub(node);
    node.setDirtyCanvas?.(true, true);
    return;
  }

  const single = state.frameList.length === 1 ? state.frameList[0] : null;

  if (single && isMovie(single.path)) {
    setupVideo(node, state, single.path);
    state.filename = single.path;

    // Purely informational — the range of the video being BROWSED, so the
    // scrub bar (hidden in video mode anyway) has sane bounds if the mode
    // changes later. Never touches the real `frame` input.
    let info = null;
    try {
      info = await apiGet("/vfx-write/video-info", { path: single.path });
    } catch (_) {
      info = null;
    }

    state.first = info?.first ?? 1;
    state.last = info?.last ?? 1;
    refreshScrub(node);
    node.setDirtyCanvas?.(true, true);
    return;
  }

  const nums = state.frameList.map((f) => f.frame).filter((n) => n !== null);
  const rangeFirst = nums.length ? Math.min(...nums) : 1;
  const rangeLast = nums.length ? Math.max(...nums) : 1;

  state.first = rangeFirst;
  state.last = rangeLast;
  refreshScrub(node);

  showFrame(node, rangeFirst);
}

function resetPreviewForLoad(node) {
  const state = node.__vfxWritePreview;
  stopPlay(node);
  teardownVideo(state);
  cacheClear(state.cache);
  clearImageDisplay(state);
  state.currentFrame = null;
  state.playhead = 1;
  state.first = 1;
  state.last = 1;
  return state;
}

async function loadVersion(node, pattern, version) {
  const state = node.__vfxWritePreview;
  if (!state || !pattern || version === undefined || version === null) return;

  resetPreviewForLoad(node);

  let frameData;
  try {
    frameData = await apiGet("/vfx-write/frames", { path: pattern, version });
  } catch (_) {
    frameData = { frames: [] };
  }

  let frameList;
  if (frameData.frames && frameData.frames.length) {
    frameList = frameData.frames
      .slice()
      .sort((a, b) => a.frame - b.frame)
      .map((f) => ({ frame: f.frame, path: f.path }));
  } else {
    const versions = node.__vfxWriteVersions || [];
    const match = versions.find((v) => v.version === version);
    frameList = match ? [{ frame: null, path: match.path }] : [];
  }

  await applyFrameList(node, frameList);
}

// Previews exactly what was just picked in the browse dialog (a single
// file, or a collapsed sequence group — see group_files/pick), completely
// independent of whether the resulting destination fits any versioned
// naming convention at all. Confirmed live as a real gap: a plain,
// unversioned file (or sequence) picked in the dialog correctly set
// path/file_name, but the canvas stayed empty forever — refreshVersionList
// only ever calls loadVersion() when list_versions finds at least one
// version, so a destination with none never got previewed. `pattern` is
// the already-guessed combined destination (folder + v##/#### template),
// used to scope the /vfx-write/frames-in-folder lookup for a sequence.
async function previewPicked(node, f, pattern) {
  const state = node.__vfxWritePreview;
  if (!state || !f) return;

  resetPreviewForLoad(node);

  let frameList;

  if (f.kind === "sequence") {
    let frameData;
    try {
      frameData = await apiGet("/vfx-write/frames-in-folder", { path: pattern });
    } catch (_) {
      frameData = { frames: [] };
    }
    frameList = (frameData.frames || [])
      .slice()
      .sort((a, b) => a.frame - b.frame)
      .map((fr) => ({ frame: fr.frame, path: fr.path }));

    // Fall back to just the one representative frame if the folder scan
    // came up empty for some reason (e.g. a race with files changing on
    // disk) — still better than showing nothing for a file we know exists.
    if (!frameList.length) frameList = [{ frame: null, path: f.path }];
  } else {
    frameList = [{ frame: null, path: f.path }];
  }

  await applyFrameList(node, frameList);
}

// ---------------------------------------------------------------------------
// playback
// ---------------------------------------------------------------------------

function stepFrame(node, delta) {
  const state = node.__vfxWritePreview;
  if (!state) return;

  if (state.mode === "video") {
    const videoEl = state.videoEl;
    if (!videoEl) return;
    videoEl.pause();
    const duration = Number.isFinite(videoEl.duration) ? videoEl.duration : Infinity;
    videoEl.currentTime = Math.max(0, Math.min(duration, videoEl.currentTime + delta / DEFAULT_FPS));
    state.refreshTransportUI?.();
    return;
  }

  if (!state.frameList.length) return;
  const first = state.first ?? 1;
  const last = state.last ?? first;
  const next = Math.min(Math.max((state.playhead ?? first) + delta, first), last);
  showFrame(node, next);
}

function togglePlay(node) {
  const state = node.__vfxWritePreview;
  if (!state) return;
  state.playing ? stopPlay(node) : startPlay(node);
}

function startPlay(node) {
  const state = node.__vfxWritePreview;
  if (!state || state.playing || state.mode === "video") return;
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

      const first = state.first ?? 1;
      const last = state.last ?? first;
      let next = (state.playhead ?? first) + advance;

      if (next > last) {
        if (state.loop) {
          const span = Math.max(1, last - first + 1);
          next = first + ((next - first) % span);
        } else {
          showFrame(node, last);
          stopPlay(node);
          return;
        }
      }

      showFrame(node, next);
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
// transport - real DOM buttons (play/prev/next/loop/fullscreen). Shared by
// both preview modes, same as ComfyUI-VFX-Read's transport row, minus its
// "Use Frame" button — nothing here writes into the real `frame` input, see
// the header design note.
// ---------------------------------------------------------------------------

function buildTransportWidget(node) {
  const state = node.__vfxWritePreview;
  const btn = smallBtn;

  function setActive(b, active) {
    b.style.background = active ? "#3a5a8a" : "#2c2c2c";
    b.style.borderColor = active ? "#6f9ad0" : "#4a4a4a";
  }

  const container = el("div", {
    width: "100%",
    display: "flex",
    gap: "4px",
    alignItems: "center",
  });

  const playBtn = btn("▶", "Play/Pause");
  const prevBtn = btn("⏮", "Previous frame");
  const nextBtn = btn("⏭", "Next frame");
  const loopBtn = btn("↻", "Loop");
  const spacer = el("div", { flex: "1" });
  const fsBtn = btn("⛶", "Fullscreen");

  function refreshTransportUI() {
    const isPlaying = state.mode === "video" ? !!state.videoEl && !state.videoEl.paused : state.playing;
    playBtn.textContent = isPlaying ? "⏸" : "▶";

    const loopActive = state.mode === "video" ? !!state.videoEl?.loop : state.loop;
    setActive(loopBtn, loopActive);
  }

  playBtn.addEventListener("click", () => {
    if (state.mode === "video") {
      if (!state.videoEl) return;
      if (state.videoEl.paused) state.videoEl.play();
      else state.videoEl.pause();
    } else {
      togglePlay(node);
    }
    refreshTransportUI();
  });

  prevBtn.addEventListener("click", () => stepFrame(node, -1));
  nextBtn.addEventListener("click", () => stepFrame(node, 1));

  loopBtn.addEventListener("click", () => {
    state.loop = !state.loop;
    if (state.mode === "video" && state.videoEl) state.videoEl.loop = state.loop;
    refreshTransportUI();
  });

  fsBtn.addEventListener("click", () => {
    if (state.fsOpen && state.closeFullscreen) {
      state.closeFullscreen();
      return;
    }
    openFullscreen(node);
  });

  refreshTransportUI();

  container.appendChild(playBtn);
  container.appendChild(prevBtn);
  container.appendChild(nextBtn);
  container.appendChild(loopBtn);
  container.appendChild(spacer);
  container.appendChild(fsBtn);

  const widget = node.addDOMWidget(TRANSPORT_WIDGET, "transport", container, {
    serialize: false,
  });
  widget.computeSize = (width) => [width, TRANSPORT_H];

  state.transportWidget = widget;
  state.transportContainer = container;
  state.refreshTransportUI = refreshTransportUI;
  return widget;
}

// ---------------------------------------------------------------------------
// fullscreen review — single entry point dispatches to whichever mode is
// active, same pattern as ComfyUI-VFX-Read's openFullscreen.
// ---------------------------------------------------------------------------

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

function openFullscreen(node) {
  const state = node.__vfxWritePreview;
  if (!state) return;
  if (state.mode === "video") openVideoFullscreen(node, state);
  else openImageFullscreen(node, state);
}

// Image/sequence mode: real Fullscreen API, full-resolution source,
// wheel-zoom, drag-to-pan.
function openImageFullscreen(node, state) {
  if (!state.img || !state.shownPath) return;

  const sourcePath = state.shownPath;

  const overlay = el("div", {
    position: "fixed",
    inset: "0",
    background: "#000",
    zIndex: "10001",
    overflow: "hidden",
  });

  const viewport = el("div", {
    width: "100%",
    height: "100%",
    overflow: "hidden",
    cursor: "grab",
  });

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
    const p = state.shownPath;
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
    state.fsOpen = false;
    state.closeFullscreen = null;
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

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
  state.fsOpen = true;
  state.closeFullscreen = close;
  requestRealFullscreen(overlay);
}

// Video mode: reparents the *existing* <video> element (and the shared
// transport row) into the overlay rather than creating a second video/
// second set of buttons — preserves playback position, and every button
// keeps working fullscreen with zero duplicated logic. Both get moved back
// to their normal spot in the node on close.
function openVideoFullscreen(node, state) {
  const videoEl = state.videoEl;
  const transportEl = state.transportContainer;
  if (!videoEl || !transportEl) return;

  const videoOriginalParent = videoEl.parentElement;
  const videoOriginalNext = videoEl.nextSibling;
  const videoOriginalStyle = videoEl.getAttribute("style");

  const transportOriginalParent = transportEl.parentElement;
  const transportOriginalNext = transportEl.nextSibling;

  const overlay = el("div", {
    position: "fixed",
    inset: "0",
    background: "#000",
    zIndex: "10001",
    display: "flex",
    flexDirection: "column",
  });

  const stage = el("div", {
    flex: "1 1 auto",
    minHeight: "0",
    position: "relative",
    overflow: "hidden",
    display: "flex",
  });

  Object.assign(videoEl.style, {
    width: "100%",
    height: "100%",
    display: "block",
    objectFit: "contain",
    background: "#000",
  });
  stage.appendChild(videoEl);

  const barRow = el("div", {
    flex: "0 0 auto",
    padding: "6px 8px",
    background: "#181818",
    borderTop: "1px solid #333",
  });
  barRow.appendChild(transportEl);

  let closed = false;

  function restore() {
    if (videoOriginalStyle === null) videoEl.removeAttribute("style");
    else videoEl.setAttribute("style", videoOriginalStyle);
    videoOriginalParent.insertBefore(videoEl, videoOriginalNext);
    transportOriginalParent.insertBefore(transportEl, transportOriginalNext);
  }

  function close() {
    if (closed) return;
    closed = true;
    exitRealFullscreen();
    restore();
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("fullscreenchange", onFsChange);
    document.removeEventListener("webkitfullscreenchange", onFsChange);
    state.fsOpen = false;
    state.closeFullscreen = null;
  }

  function onKey(e) {
    if (e.key === "Escape") close();
  }

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
  stage.appendChild(closeBtn);

  overlay.appendChild(stage);
  overlay.appendChild(barRow);
  document.body.appendChild(overlay);
  state.fsOpen = true;
  state.closeFullscreen = close;
  requestRealFullscreen(overlay);
}

// ---------------------------------------------------------------------------
// destination browser
// ---------------------------------------------------------------------------

// Given an existing on-disk filename, guesses the v##/#### template: the
// rightmost v01/v02-style version token becomes v## (padding matched),
// then the rightmost remaining run of 3+ digits (typically a frame
// number) becomes #### (padding matched). Best-effort — picking a file
// runs this so the destination pattern is pre-filled instead of typed by
// hand; the result is still just a normal editable string in the file
// row afterward.
function patternFromExampleFilename(name) {
  const versionRe = /[vV](\d{1,2})(?!\d)/g;
  let versionMatch = null;
  let m;
  while ((m = versionRe.exec(name))) versionMatch = m;

  let result = name;

  if (versionMatch) {
    const digitsStart = versionMatch.index + 1;
    const digitsEnd = digitsStart + versionMatch[1].length;
    result =
      result.slice(0, digitsStart) +
      "#".repeat(versionMatch[1].length) +
      result.slice(digitsEnd);
  }

  // Frame numbers sit immediately before the extension (name.0001.exr,
  // name_0001.exr) — anchoring to "right before the extension" avoids
  // mistaking an embedded number elsewhere in the name (e.g. a shot
  // number like "010" in "shot_010_comp_v01.png") for a frame token.
  // Confirmed live: a plain /\d{3,}/ search (no anchor) wrongly matched
  // "010" and produced "shot_###_comp_v##.png" for a single non-sequence
  // file.
  const dot = result.lastIndexOf(".");
  const base = dot >= 0 ? result.slice(0, dot) : result;
  const ext = dot >= 0 ? result.slice(dot) : "";
  const frameMatch = base.match(/(\d{3,})$/);

  if (frameMatch) {
    const start = base.length - frameMatch[1].length;
    result = base.slice(0, start) + "#".repeat(frameMatch[1].length) + ext;
  }

  return result;
}

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

  // Enter already submits the typed path (see the keydown handler below),
  // so a separate "Go" button was pure duplication — same as
  // ComfyUI-VFX-Read's own dialog. Back/Forward/Up replace the old lone
  // "Up" button.
  const backBtn = smallBtn("←", "Back");
  const forwardBtn = smallBtn("→", "Forward");
  const upBtn = smallBtn("↑", "Up one level");

  head.appendChild(pathInput);
  head.appendChild(backBtn);
  head.appendChild(forwardBtn);
  head.appendChild(upBtn);

  const list = el("div", { flex: "1 1 auto", overflowY: "auto", padding: "4px 0" });

  const hint = el("div", {
    flex: "0 0 auto",
    color: "#8a8a8a",
    font: "10px sans-serif",
    padding: "6px 8px",
    borderTop: "1px solid #3a3a3a",
  });
  hint.textContent =
    "Click a file to fill the destination from it (guesses its v##/#### tokens) — or pick an empty folder and type the file name pattern yourself.";

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
  let currentParent = "";

  // Browser-style history — same pattern as ComfyUI-VFX-Read's own dialog.
  // requestGen guards against a stale response landing after a newer
  // request has already started.
  let history = [];
  let historyIndex = -1;
  let requestGen = 0;

  function setNavEnabled(btn, enabled) {
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? "1" : "0.4";
    btn.style.cursor = enabled ? "pointer" : "default";
  }

  function updateNavButtons() {
    setNavEnabled(backBtn, historyIndex > 0);
    setNavEnabled(forwardBtn, historyIndex < history.length - 1);
    setNavEnabled(upBtn, !!currentParent && currentParent !== currentFolder);
  }

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

  // Picking an existing file (or a collapsed sequence group — see
  // group_files/_group_files on the backend) adopts its folder as `path`
  // and guesses a v##/#### pattern from its representative file's name as
  // `file_name` — same "pick a real example, get a usable pattern" flow
  // as choosing a folder, just seeded from a concrete file instead of
  // typed by hand. `f.path` is always a single real file (a sequence
  // group's is its first frame), so this works the same for both kinds.
  async function pick(f) {
    const fullPath = f.path.replace(/\\/g, "/");
    const idx = fullPath.lastIndexOf("/");
    const folder = (idx >= 0 ? fullPath.slice(0, idx) : currentFolder).replace(/\/+$/, "");
    const fileName = idx >= 0 ? fullPath.slice(idx + 1) : fullPath;
    const pattern = patternFromExampleFilename(fileName);
    const combined = folder ? `${folder}/${pattern}` : pattern;
    applyCombinedInput(node, combined);
    refreshFileRowDisplay(node);
    // Always preview exactly what was picked, whether or not it fits a
    // versioned naming convention — see previewPicked's own design note.
    await previewPicked(node, f, combined);
    close();
  }

  async function load(dir, opts = {}) {
    const gen = ++requestGen;

    list.replaceChildren();
    row("Loading...", "", null);

    let data;
    try {
      data = await apiGet("/vfx-write/browse", { path: dir || "" });
    } catch (e) {
      if (gen !== requestGen) return;
      list.replaceChildren();
      row(`Error: ${e.message}`, "", null);
      return;
    }

    if (gen !== requestGen) return;

    currentFolder = data.folder || "";
    currentParent = data.parent || "";
    pathInput.value = currentFolder;

    if (!opts.fromHistory) {
      history = history.slice(0, historyIndex + 1);
      history.push(currentFolder);
      historyIndex = history.length - 1;
    }
    updateNavButtons();

    list.replaceChildren();

    if (data.parent && data.parent !== currentFolder) {
      row(".. (parent)", "dir", () => load(data.parent));
    }

    for (const d of data.directories || []) {
      row(d.name, "dir", () => load(d.path));
    }

    for (const f of data.files || []) {
      const sub = f.kind === "sequence" ? `seq ${f.first}-${f.last}` : "file";
      row(f.label || f.path, sub, () => pick(f));
    }

    if (!list.children.length) row("(empty)", "", null);
  }

  backBtn.addEventListener("click", () => {
    if (historyIndex <= 0) return;
    historyIndex--;
    load(history[historyIndex], { fromHistory: true });
  });
  forwardBtn.addEventListener("click", () => {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    load(history[historyIndex], { fromHistory: true });
  });
  upBtn.addEventListener("click", () => {
    if (currentParent && currentParent !== currentFolder) load(currentParent);
  });
  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") load(pathInput.value);
  });

  chooseBtn.addEventListener("click", () => {
    const typed = pathInput.value.trim();
    const folder = (typed || currentFolder).replace(/\\/g, "/").replace(/\/+$/, "");
    if (!folder) return;

    setWidget(node, "path", folder);
    refreshFileRowDisplay(node);
    refreshVersionList(node);
    close();
  });

  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  // Shields the dialog's own inputs from document/window-level keyboard
  // handling (e.g. LiteGraph's own canvas shortcuts) the same way
  // ComfyUI-VFX-Read's dialog does.
  overlay.addEventListener("keydown", (e) => e.stopPropagation());
  overlay.addEventListener("paste", (e) => e.stopPropagation());

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

      buildPreviewWidget(this);

      // Convert the execution-critical native widgets into invisible
      // DOM-backed carriers FIRST, so the file row can immediately read
      // their current (INPUT_TYPES-default) values. See the design note
      // near buildHiddenValue/replaceWithHiddenCarrier.
      for (const name of ["path", "file_name", "frame_start"]) {
        replaceWithHiddenCarrier(this, name);
      }

      buildFileRow(this);
      buildVersionRow(this);

      buildVideoWidget(this);
      buildScrubWidget(this);
      buildTransportWidget(this);

      if (this.size[0] < MIN_NODE_W) this.size[0] = MIN_NODE_W;

      reorderWidgets(this);

      // Deterministic initial size — chrome + PREVIEW_DEFAULT_H — computed
      // directly rather than via a second this.computeSize() call (which
      // would read the still-stale this.size at this point).
      const chrome = chromeOf(this);
      this.setSize([this.size[0], chrome + PREVIEW_DEFAULT_H]);

      refreshVersionList(this);

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

      reorderWidgets(this);

      // Just prime the chrome cache on this (freshly constructed) node
      // instance — deliberately NOT resizing here. The saved this.size
      // (the user's own prior resize, if any) is already correct as
      // restored.
      chromeOf(this);

      applyValues(this, o?.vfx_write_values);
      refreshFileRowDisplay(this);

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

    // Manual escape hatch for a node that's ended up taller than its
    // content needs — same "Reset Size" ComfyUI-VFX-Read added. Keeps the
    // current width, only resets the height back to natural chrome +
    // PREVIEW_DEFAULT_H.
    const getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;

    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      const r = getExtraMenuOptions?.apply(this, arguments);
      const node = this;
      options.push({
        content: "Reset Size",
        callback: () => {
          node.__vfxWriteChrome = undefined;
          const chrome = chromeOf(node);
          node.setSize([node.size[0], chrome + PREVIEW_DEFAULT_H]);
          node.setDirtyCanvas?.(true, true);
        },
      });
      return r;
    };
  },
});
