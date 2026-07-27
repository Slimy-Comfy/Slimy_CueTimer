// Slimy_ColoredMaskTracker — canvas widget
//
// Point + painted initial-mask mode. Colours are assigned by selected output index.
// and remapped via the node's index colour dropdowns.
//
// Controls:
//   Click on empty space      → new identity
//   Shift+click               → add positive point to selected identity
//   Alt+click                 → add negative point to selected identity
//   Click on existing point   → select that identity
//   Right-click on point      → remove that single point (or whole identity if last)
//   Delete / Backspace        → remove selected identity
//   Undo                      → remove last identity
//   Clear                     → remove all identities

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const CANVAS_FALLBACK_H = 320;
const HIT_PX   = 12;
const MAX_IDS  = 6;

// SAM3 default colours for preview (must match SAM3_DEFAULT_COLORS in __init__.py)
const PAINT_COLOR_NAMES = ["Black", "White", "Blue", "Red", "Green", "Magenta", "Cyan", "Yellow"];
const SAM3_COLORS = ["#0000FF", "#FF0000", "#00FF00", "#FF00FF", "#00FFFF", "#FFFF00"];
const COLOR_HEX = { White: "#FFFFFF", Black: "#000000", Blue: "#0000FF", Red: "#FF0000", Green: "#00FF00", Magenta: "#FF00FF", Cyan: "#00FFFF", Yellow: "#FFFF00" };

function remappedPaintColor(colorName, assignments) {
    const sourceName = PAINT_COLOR_NAMES.includes(colorName) ? colorName : "Blue";
    const option = assignments?.[sourceName];
    const dstName = typeof option === "string" ? option.trim().split(/\s+/)[0] : sourceName;
    return COLOR_HEX[dstName] || COLOR_HEX[sourceName] || "#0000FF";
}

const RIGHT_PANE_W = 190;

const COLOR_WIDGET_NAMES = ["Black", "White", "Blue", "Red", "Green", "Magenta", "Cyan", "Yellow", "Mask"];
const COLOR_OPTIONS = [
    "Black",
    "White",
    "Blue",
    "Red",
    "Green",
    "Magenta",
    "Cyan",
    "Yellow",
    "None",
];
const COLOR_DEFAULTS = {
    Black:   "Black",
    White:   "White",
    Blue:    "Blue",
    Red:     "Red",
    Green:   "Green",
    Magenta: "Magenta",
    Cyan:    "Cyan",
    Yellow:  "Yellow",
    Mask:    "None",
};
const COLOR_CHIPS = {
    "White": "#ffffff",
    "Black": "#000000",
    "Blue": "#0000ff",
    "Red": "#ff0000",
    "Green": "#00cc00",
    "Magenta": "#ff00ff",
    "Cyan": "#00ffff",
    "Yellow": "#ffff00",
    "Mask": "#ff8000",
};

function normalizeColorOption(value, fallback = "None") {
    const text = String(value ?? "").trim().toLowerCase();
    for (const name of COLOR_OPTIONS) {
        if (name !== "None" && text.includes(name.toLowerCase())) return name;
    }
    return text.includes("none") ? "None" : fallback;
}

function viewURL(info) {
    const qs = `filename=${encodeURIComponent(info.filename)}&type=${info.type}` +
               `&subfolder=${encodeURIComponent(info.subfolder || "")}&rand=${Math.random()}`;
    const path = `/view?${qs}`;
    return (api && typeof api.apiURL === "function") ? api.apiURL(path) : path;
}

function setupNode(node) {
    const dataWidget = node.widgets?.find((w) => w.name === "tracker_data");
    if (dataWidget) {
        dataWidget.hidden = true;
        dataWidget.computeSize = () => [0, -4];
        dataWidget.draw = function () {};
    }

    const colorWidgets = {};
    for (const name of COLOR_WIDGET_NAMES) {
        const w = node.widgets?.find((x) => x.name === name);
        if (!w) continue;
        colorWidgets[name] = w;
        w.hidden = true;
        w.computeSize = () => [0, -4];
        w.draw = function () {};
    }

    const state = {
        markers:       [],
        img:           null,
        frames:        [],
        maskFrames:    [],
        overlayFrames: [],
        frameIndex:    0,
        viewMode:      "input", // "input" | "overlay" | "mask"
        nodeId:        null,    // recolor API用キャッシュキー
        objectURL:     null,    // in-memory preview blob URL
        view:          { scale: 1, ox: 0, oy: 0 },
        selected:      -1,
        toolMode:      "paint", // "paint" | "erase"
        paintColor:    "Blue",
        brushSize:     28,
        paintStrokes:  [],
        painting:      false,
        activeStroke:  null,
        brushCursor:   { visible: false, x: 0, y: 0 },
        colorAssignments: { ...COLOR_DEFAULTS },
        fillTarget:     "None",
        fillMode:       "Black",
        fillExpand:     0,
        fillBlockSize:  0,
        testFirstFrameToken: null, // transient; included only while queuing a one-frame test
        normalRunNonce: null,       // changed after a test so the next full run cannot reuse the old ComfyUI execution cache
        // Lightweight persisted references to ComfyUI temp preview files.
        // Only filename/subfolder/type are stored; image bytes are not serialized.
        previewCache: { frames: [], maskFrames: [], overlayFrames: [] },
    };
    node._slimy = state;

    const syncFromWidget = () => {
        if (!dataWidget) return;
        try {
            const d = JSON.parse(dataWidget.value || "{}");
            state.markers = []; // Point mode removed; ignore legacy data.
            state.paintStrokes = Array.isArray(d.paint_strokes) ? d.paint_strokes : [];
            state.paintColor = PAINT_COLOR_NAMES.includes(d.paint_color) ? d.paint_color : PAINT_COLOR_NAMES[Math.max(0, Math.min(5, Number(d.paint_index) | 0)) + 2] || "Blue";
            state.brushSize = Number.isFinite(Number(d.brush_size)) ? Math.max(2, Number(d.brush_size)) : 28;
            state.frameIndex = Number.isFinite(Number(d.frame_index)) ? Math.max(0, Number(d.frame_index) | 0) : 0;
            state.normalRunNonce = typeof d.normal_run_nonce === "string" ? d.normal_run_nonce : null;
            if (d.color_remap && typeof d.color_remap === "object") {
                state.colorAssignments = { ...COLOR_DEFAULTS };
                for (const name of COLOR_WIDGET_NAMES) {
                    state.colorAssignments[name] = normalizeColorOption(d.color_remap?.[name], COLOR_DEFAULTS[name] ?? "None");
                }
            }
            state.fillTarget = normalizeColorOption(d.fill_target ?? d.knockout_color, d.knockout_black_mask ? "Black" : "None");
            state.fillMode = ["Black", "White", "Neutral Gray", "Telea", "Navier-Stokes"].includes(d.fill_mode)
                ? d.fill_mode
                : "Black";
            state.fillExpand = Number.isFinite(Number(d.fill_expand))
                ? Math.max(-64, Math.min(64, Math.trunc(Number(d.fill_expand))))
                : 0;
            state.fillBlockSize = Number.isFinite(Number(d.fill_block_size))
                ? Math.max(0, Math.min(256, Math.trunc(Number(d.fill_block_size))))
                : 0;

            // Restore temp-file references. node.properties is the authoritative
            // store because hidden widget values can be stale when workflow tabs
            // are detached/re-attached. Keep widget data as a legacy fallback.
            const propCache = node.properties?._slimy_preview_cache;
            const pc = propCache && typeof propCache === "object"
                ? propCache
                : (d.preview_cache && typeof d.preview_cache === "object" ? d.preview_cache : {});
            const validRefs = (v) => Array.isArray(v) ? v.filter((x) => x && typeof x === "object" && x.filename) : [];
            state.frames = validRefs(pc.frames);
            state.maskFrames = validRefs(pc.mask_frames ?? pc.maskFrames);
            state.overlayFrames = validRefs(pc.overlay_frames ?? pc.overlayFrames);
            state.viewMode = ["input", "overlay", "mask"].includes(pc.view_mode) ? pc.view_mode : state.viewMode;
            state.nodeId = pc.node_id != null ? String(pc.node_id) : state.nodeId;
            state.previewCache = {
                frames: state.frames,
                mask_frames: state.maskFrames,
                overlay_frames: state.overlayFrames,
                view_mode: state.viewMode,
                node_id: state.nodeId,
            };
        } catch (_) {}
    };
    syncFromWidget();

    let refreshPaintKeyMarkers = () => {};

    const writeData = () => {
        const previewCache = {
            frames: state.frames || [],
            mask_frames: state.maskFrames || [],
            overlay_frames: state.overlayFrames || [],
            view_mode: state.viewMode || "input",
            node_id: state.nodeId,
        };
        node.properties ??= {};
        node.properties._slimy_preview_cache = previewCache;
        state.previewCache = previewCache;
        if (dataWidget) {
            dataWidget.value = JSON.stringify({
                frame_index: state.frameIndex || 0,
                markers: [],
                paint_strokes: state.paintStrokes,
                paint_frame_index: state.frameIndex || 0,
                paint_color: state.paintColor || "Blue",
                paint_index: Math.max(0, PAINT_COLOR_NAMES.indexOf(state.paintColor) - 2), // legacy
                brush_size: state.brushSize || 28,
                color_remap: state.colorAssignments || { ...COLOR_DEFAULTS },
                fill_target: state.fillTarget || "None",
                fill_mode: state.fillMode || "Black",
                fill_expand: Number.isFinite(Number(state.fillExpand)) ? Math.trunc(Number(state.fillExpand)) : 0,
                fill_block_size: Number.isFinite(Number(state.fillBlockSize)) ? Math.trunc(Number(state.fillBlockSize)) : 0,
                ...(state.testFirstFrameToken ? { test_first_frame_token: state.testFirstFrameToken } : {}),
                ...(state.normalRunNonce ? { normal_run_nonce: state.normalRunNonce } : {}),
                // Persist only temp-file references, never image data.
                preview_cache: previewCache,
            });
        }
        refreshPaintKeyMarkers();
        node.graph?.setDirtyCanvas(true, true);
    };

    // ── DOM ──────────────────────────────────────────────────────────────────
    const root = document.createElement("div");
    root.style.cssText = "display:flex;flex-direction:column;gap:4px;width:100%;box-sizing:border-box;";
    root.tabIndex = 0;

    const bar = document.createElement("div");
    bar.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;font-size:11px;align-items:center;";
    root.appendChild(bar);

    const body = document.createElement("div");
    body.style.cssText = "display:flex;flex-direction:row;gap:8px;width:100%;box-sizing:border-box;align-items:flex-start;";
    root.appendChild(body);

    const leftPane = document.createElement("div");
    leftPane.style.cssText = "flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px;";
    body.appendChild(leftPane);

    const rightPane = document.createElement("div");
    rightPane.style.cssText = `flex:0 0 ${RIGHT_PANE_W}px;width:${RIGHT_PANE_W}px;box-sizing:border-box;border-left:1px solid #444;padding-left:8px;font-size:11px;color:#ccc;`;
    body.appendChild(rightPane);

    // Explicit footer spacer below both panes. A margin on the left preview alone
    // was swallowed by the flex row / taller right pane and produced no visible gap.
    const previewBottomSpacer = document.createElement("div");
    previewBottomSpacer.style.cssText = "display:block;flex:0 0 16px;height:16px;min-height:16px;width:100%;box-sizing:border-box;pointer-events:none;";
    root.appendChild(previewBottomSpacer);

    const mkBtn = (label, onClick) => {
        const b = document.createElement("button");
        b.textContent = label;
        b.style.cssText = "padding:2px 7px;cursor:pointer;border-radius:4px;border:1px solid #555;background:#2a2a2a;color:#ddd;font-size:11px;";
        b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClick(); redraw(); };
        bar.appendChild(b);
        return b;
    };
    const testFirstFrameBtn = mkBtn("Test 1st Frame", async () => {
        if (testFirstFrameBtn.disabled) return;
        testFirstFrameBtn.disabled = true;
        const previousText = testFirstFrameBtn.textContent;
        testFirstFrameBtn.textContent = "Queuing...";
        try {
            // Put a unique transient token into tracker_data before queueing.
            // This makes ComfyUI's node cache distinguish the one-frame test
            // from an otherwise identical full-video execution.
            state.testFirstFrameToken = `${Date.now()}-${Math.random()}`;
            writeData();
            // Let the hidden widget value settle before prompt serialization.
            await new Promise((resolve) => requestAnimationFrame(() => resolve()));
            await app.queuePrompt(0);
        } catch (err) {
            console.error("[Slimy_ColoredMaskTracker] first-frame test failed", err);
        } finally {
            // Restore the normal serialized input immediately after the test
            // prompt has been submitted, so the next queue uses all frames.
            state.testFirstFrameToken = null;
            // Force the next normal queue to be a distinct ComfyUI prompt even when
            // every visible setting is identical to the state before the test.
            state.normalRunNonce = `${Date.now()}-${Math.random()}`;
            writeData();
            testFirstFrameBtn.textContent = previousText;
            testFirstFrameBtn.disabled = false;
        }
    });
    testFirstFrameBtn.title = "Queue one execution with frame 0 only. The test uses a separate cache key; the next normal queue uses the full video.";

    mkBtn("Undo",  () => {
        state.paintStrokes.pop();
        state.selected = -1; writeData();
    });
    const deleteCurrentKeyBtn = mkBtn("Delete Key", () => {
        const frame = state.frameIndex || 0;
        state.paintStrokes = state.paintStrokes.filter((st) => Number(st?.frame_index ?? 0) !== frame);
        state.selected = -1;
        writeData();
    });
    deleteCurrentKeyBtn.title = "Delete all Paint/Erase strokes on the current frame";

    const clearAllKeysBtn = mkBtn("Clear Keys", () => {
        state.markers = [];
        state.paintStrokes = [];
        state.selected = -1;
        writeData();
    });
    clearAllKeysBtn.title = "Delete every Paint key on all frames";

    const toolBtn = mkBtn("Paint", () => {
        state.toolMode = state.toolMode === "paint" ? "erase" : "paint";
        toolBtn.textContent = state.toolMode === "paint" ? "Paint" : "Erase";
    });
    toolBtn.title = "Paint / Erase";

    const paintIndexSelect = document.createElement("select");
    paintIndexSelect.title = "Paint color";
    paintIndexSelect.style.cssText = "height:20px;background:#222;color:#ddd;border:1px solid #555;border-radius:3px;font-size:11px;";
    PAINT_COLOR_NAMES.forEach((name) => {
        const o = document.createElement("option");
        o.value = name; o.textContent = name; o.style.color = COLOR_HEX[name];
        paintIndexSelect.appendChild(o);
    });
    paintIndexSelect.value = state.paintColor;
    paintIndexSelect.onchange = (e) => { e.stopPropagation(); state.paintColor = paintIndexSelect.value || "Blue"; writeData(); redraw(); };
    bar.appendChild(paintIndexSelect);

    const brushLabel = document.createElement("span");
    brushLabel.textContent = "Brush:";
    brushLabel.style.cssText = "color:#bbb;font-size:11px;margin-left:4px;";
    bar.appendChild(brushLabel);

    const brushSlider = document.createElement("input");
    brushSlider.type = "range"; brushSlider.min = "2"; brushSlider.max = "160"; brushSlider.step = "2";
    brushSlider.value = String(state.brushSize); brushSlider.title = "Brush size";
    brushSlider.style.cssText = "width:72px;height:18px;";
    brushSlider.oninput = (e) => { e.stopPropagation(); state.brushSize = Number(brushSlider.value) || 28; writeData(); redraw(); };
    for (const ev of ["pointerdown", "mousedown", "wheel"]) brushSlider.addEventListener(ev, e => e.stopPropagation());
    bar.appendChild(brushSlider);

    // Image view buttons are overlaid at the preview's top-right.
    const VIEW_MODES = ["input", "overlay", "mask"];
    const VIEW_LABELS = { input: "Input", overlay: "Overlay", mask: "Mask" };
    const viewButtons = {};
    const updateViewButtons = () => {
        for (const mode of VIEW_MODES) {
            const active = state.viewMode === mode;
            const b = viewButtons[mode];
            if (!b) continue;
            b.style.background = active ? "#4b6f96" : "rgba(35,35,35,0.86)";
            b.style.color = active ? "#fff" : "#ddd";
            b.style.borderColor = active ? "#88b8e8" : "#555";
        }
    };
    const setViewMode = (mode) => {
        if (mode === "overlay" && !state.overlayFrames.length) return;
        if (mode === "mask" && !state.maskFrames.length) return;
        state.viewMode = mode;
        updateViewButtons();
        writeData();
        loadFrame(state.frameIndex);
    };

    // Frame navigation belongs to the left preview pane. Keep the paint/brush
    // controls in the existing top toolbar.
    const frameBox = document.createElement("div");
    frameBox.style.cssText = "display:flex;align-items:center;gap:3px;width:100%;min-width:0;box-sizing:border-box;";
    leftPane.appendChild(frameBox);

    const prevFrameBtn = document.createElement("button");
    prevFrameBtn.textContent = "◀";
    prevFrameBtn.style.cssText = "padding:1px 5px;cursor:pointer;border-radius:4px;border:1px solid #555;background:#2a2a2a;color:#ddd;font-size:11px;";
    frameBox.appendChild(prevFrameBtn);

    const frameInput = document.createElement("input");
    frameInput.type = "number";
    frameInput.min = "0";
    frameInput.value = "0";
    frameInput.style.cssText = "width:46px;height:18px;background:#222;color:#ddd;border:1px solid #555;border-radius:3px;font-size:11px;text-align:right;";
    frameBox.appendChild(frameInput);

    const frameTotal = document.createElement("span");
    frameTotal.textContent = "/ 0";
    frameTotal.style.cssText = "color:#aaa;font-size:11px;";
    frameBox.appendChild(frameTotal);

    const frameSliderWrap = document.createElement("span");
    frameSliderWrap.style.cssText = "position:relative;display:inline-flex;flex:1 1 auto;min-width:70px;height:24px;margin:0 2px;align-items:center;";
    frameBox.appendChild(frameSliderWrap);

    const frameSlider = document.createElement("input");
    frameSlider.type = "range";
    frameSlider.min = "0";
    frameSlider.max = "0";
    frameSlider.step = "1";
    frameSlider.value = "0";
    frameSlider.title = "任意のフレームへ移動";
    frameSlider.style.cssText = "position:absolute;left:0;right:0;top:4px;width:100%;height:18px;margin:0;cursor:pointer;z-index:2;";
    frameSliderWrap.appendChild(frameSlider);

    const paintKeyLayer = document.createElement("span");
    paintKeyLayer.style.cssText = "position:absolute;left:8px;right:8px;top:0;height:7px;pointer-events:none;z-index:3;";
    frameSliderWrap.appendChild(paintKeyLayer);

    refreshPaintKeyMarkers = () => {
        paintKeyLayer.replaceChildren();
        const total = state.frames.length || (state.img ? 1 : 0);
        if (total <= 0) return;
        const maxFrame = Math.max(0, total - 1);
        const keyFrames = [...new Set(
            state.paintStrokes
                .map((st) => Math.max(0, Math.min(maxFrame, Number(st?.frame_index ?? 0) || 0)))
        )].sort((a, b) => a - b);
        for (const frame of keyFrames) {
            const mark = document.createElement("span");
            const ratio = maxFrame > 0 ? frame / maxFrame : 0;
            mark.style.cssText = `position:absolute;left:${ratio * 100}%;top:0;width:5px;height:7px;transform:translateX(-50%);background:#ff9d00;border:1px solid #2a2a2a;border-radius:1px;box-sizing:border-box;`;
            mark.title = `Paint key: frame ${frame}`;
            paintKeyLayer.appendChild(mark);
        }
    };

    const nextFrameBtn = document.createElement("button");
    nextFrameBtn.textContent = "▶";
    nextFrameBtn.style.cssText = prevFrameBtn.style.cssText;
    frameBox.appendChild(nextFrameBtn);


    function updateFrameUI() {
        const total = state.frames.length || (state.img ? 1 : 0);
        frameInput.max = String(Math.max(0, total - 1));
        frameInput.value = String(state.frameIndex || 0);
        frameSlider.max = String(Math.max(0, total - 1));
        frameSlider.value = String(state.frameIndex || 0);
        frameSlider.disabled = total <= 1;
        frameTotal.textContent = `/ ${Math.max(0, total - 1)}`;
        prevFrameBtn.disabled = total <= 1 || state.frameIndex <= 0;
        nextFrameBtn.disabled = total <= 1 || state.frameIndex >= total - 1;
        const currentHasKey = state.paintStrokes.some((st) => Number(st?.frame_index ?? 0) === (state.frameIndex || 0));
        deleteCurrentKeyBtn.disabled = !currentHasKey;
        deleteCurrentKeyBtn.style.opacity = currentHasKey ? "1" : "0.45";
        clearAllKeysBtn.disabled = state.paintStrokes.length === 0;
        clearAllKeysBtn.style.opacity = state.paintStrokes.length ? "1" : "0.45";
        refreshPaintKeyMarkers();
    }

    // ── in-memory preview（Tempファイルを作らず直接取得）──────────────
    let recolorTimer = null;
    function triggerRecolor() {
        clearTimeout(recolorTimer);
        recolorTimer = setTimeout(() => {
            if (!state.nodeId) return;
            loadFrame(state.frameIndex);
        }, 50);
    }

    function setPreviewBlob(blob, onLoaded) {
        if (state.objectURL) URL.revokeObjectURL(state.objectURL);
        const objectURL = URL.createObjectURL(blob);
        state.objectURL = objectURL;
        const im = new Image();
        im.onload = () => {
            state.img = im;
            updateFrameUI();
            redraw();
            onLoaded?.();
        };
        im.onerror = () => onLoaded?.();
        im.src = objectURL;
    }

    // 状態だけを更新する軽量パス（画像取得は行わない）。
    // スライダーをドラッグしている間、通過した中間フレームを毎回フェッチ/デコード
    // せずに済むよう、doRefresh（ネットワーク取得）とは切り離してある。
    function setFrameIndexOnly(index) {
        const total = state.frames.length;
        if (!total) { updateFrameUI(); redraw(); return; }
        state.frameIndex = Math.max(0, Math.min(total - 1, Number(index) || 0));
        writeData();
        updateFrameUI();
    }

    function loadFrame(index, onLoaded) {
        const total = state.frames.length;
        if (!total) { updateFrameUI(); redraw(); onLoaded?.(); return; }
        setFrameIndexOnly(index);
        doRefresh(onLoaded);
    }

    // 追い越された古いリクエストの応答が後から届いても無視するための連番。
    let refreshRequestSeq = 0;
    function doRefresh(onLoaded) {
        if (!state.nodeId) { onLoaded?.(); return; }
        const assignments = {};
        for (const name of COLOR_WIDGET_NAMES) assignments[name] = colorSelects[name]?.value ?? "";
        const seq = ++refreshRequestSeq;
        fetch("/slimy/recolor", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                node_id: state.nodeId,
                frame_index: state.frameIndex,
                mode: state.viewMode,
                assignments,
            }),
        }).then(async (r) => {
            if (!r.ok) return null;
            return await r.blob();
        }).then((blob) => {
            if (seq !== refreshRequestSeq) { onLoaded?.(); return; } // 追い越されたので破棄
            if (!blob) { onLoaded?.(); return; }
            setPreviewBlob(blob, onLoaded);
        }).catch(() => onLoaded?.());
    }

    // スライダーをドラッグしている間は、通過した中間フレームごとに doRefresh
    // (画像取得+デコード)を実行せず、操作が一瞬止まった時にだけ実行する。
    let sliderRefreshTimer = null;
    const SLIDER_REFRESH_DEBOUNCE_MS = 90;
    function scheduleSliderRefresh() {
        clearTimeout(sliderRefreshTimer);
        sliderRefreshTimer = setTimeout(() => {
            sliderRefreshTimer = null;
            doRefresh();
        }, SLIDER_REFRESH_DEBOUNCE_MS);
    }
    function flushSliderRefresh() {
        if (sliderRefreshTimer !== null) {
            clearTimeout(sliderRefreshTimer);
            sliderRefreshTimer = null;
        }
        doRefresh();
    }

    // Frame-step buttons: move one frame immediately, then repeat while held.
    // Repeats are serialized: the next frame is requested only after the current
    // preview image has finished loading. This prevents skipped-looking motion
    // when temp-image loading cannot keep up with 16 fps.
    function bindFrameHold(button, direction) {
        const HOLD_DELAY_MS = 300;
        const FRAME_INTERVAL_MS = 1000 / 16;
        let holdDelayTimer = null;
        let repeatTimer = null;
        let moved = false;
        let activePointerId = null;
        let repeating = false;
        let loadInFlight = false;

        const clearTimers = () => {
            if (holdDelayTimer !== null) {
                clearTimeout(holdDelayTimer);
                holdDelayTimer = null;
            }
            if (repeatTimer !== null) {
                clearTimeout(repeatTimer);
                repeatTimer = null;
            }
            repeating = false;
        };

        const step = (done) => {
            if (loadInFlight) return false;
            const total = state.frames.length || (state.img ? 1 : 0);
            const target = Math.max(0, Math.min(Math.max(0, total - 1), state.frameIndex + direction));
            if (target === state.frameIndex) {
                clearTimers();
                done?.(false);
                return false;
            }
            moved = true;
            loadInFlight = true;
            loadFrame(target, () => {
                loadInFlight = false;
                done?.(true);
            });
            return true;
        };

        const scheduleNext = () => {
            if (!repeating || activePointerId === null) return;
            repeatTimer = setTimeout(() => {
                repeatTimer = null;
                if (!repeating || activePointerId === null) return;
                step((advanced) => {
                    if (advanced && repeating && activePointerId !== null) scheduleNext();
                });
            }, FRAME_INTERVAL_MS);
        };

        const stop = (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            const shouldRefresh = moved;
            clearTimers();
            moved = false;
            if (activePointerId !== null && button.hasPointerCapture?.(activePointerId)) {
                try { button.releasePointerCapture(activePointerId); } catch (_) {}
            }
            activePointerId = null;
            if (shouldRefresh && !loadInFlight) doRefresh();
        };

        button.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || button.disabled) return;
            e.preventDefault();
            e.stopPropagation();
            clearTimers();
            moved = false;
            loadInFlight = false;
            activePointerId = e.pointerId;
            try { button.setPointerCapture(e.pointerId); } catch (_) {}
            step();
            holdDelayTimer = setTimeout(() => {
                holdDelayTimer = null;
                repeating = true;
                if (loadInFlight) {
                    const waitForLoad = () => {
                        if (!repeating || activePointerId === null) return;
                        if (loadInFlight) {
                            repeatTimer = setTimeout(waitForLoad, 16);
                        } else {
                            scheduleNext();
                        }
                    };
                    waitForLoad();
                } else {
                    scheduleNext();
                }
            }, HOLD_DELAY_MS);
        });
        button.addEventListener("pointerup", stop);
        button.addEventListener("pointercancel", stop);
        button.addEventListener("pointerleave", (e) => {
            if (activePointerId !== null) stop(e);
        });
        button.addEventListener("lostpointercapture", () => {
            if (activePointerId !== null) stop();
        });
        button.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    }

    bindFrameHold(prevFrameBtn, -1);
    bindFrameHold(nextFrameBtn, 1);
    frameInput.onchange  = (e) => { e.preventDefault(); e.stopPropagation(); loadFrame(frameInput.value, doRefresh); };
    frameSlider.oninput   = (e) => {
        e.preventDefault(); e.stopPropagation();
        // ドラッグ中: 数値表示/スライダー位置だけ即時更新し、画像取得はデバウンスする。
        setFrameIndexOnly(frameSlider.value);
        scheduleSliderRefresh();
    };
    frameSlider.onchange  = (e) => {
        e.preventDefault(); e.stopPropagation();
        // 指を離した時点の最終値で確実に一度だけ取得する。
        flushSliderRefresh();
    };
    for (const ev of ["pointerdown", "mousedown", "wheel"]) {
        frameSlider.addEventListener(ev, (e) => e.stopPropagation());
    }

    const colorHeader = document.createElement("div");
    colorHeader.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:6px;margin:0 0 5px 0;";
    rightPane.appendChild(colorHeader);

    const colorTitle = document.createElement("div");
    colorTitle.textContent = "Color Remap";
    colorTitle.style.cssText = "font-weight:bold;color:#ddd;";
    colorHeader.appendChild(colorTitle);

    const resetRemapBtn = document.createElement("button");
    resetRemapBtn.textContent = "Reset";
    resetRemapBtn.title = "Reset all color remap dropdowns";
    resetRemapBtn.style.cssText = "padding:1px 6px;cursor:pointer;border-radius:4px;border:1px solid #555;background:#2a2a2a;color:#ddd;font-size:11px;";
    colorHeader.appendChild(resetRemapBtn);

    const colorPanel = document.createElement("div");
    colorPanel.style.cssText = "display:grid;grid-template-columns:64px 1fr;gap:4px 6px;align-items:center;font-size:11px;";
    rightPane.appendChild(colorPanel);

    const fillWrap = document.createElement("div");
    fillWrap.style.cssText = "display:grid;grid-template-columns:64px 1fr;gap:4px 6px;align-items:center;margin-top:10px;padding-top:8px;border-top:1px solid #444;font-size:11px;";
    rightPane.appendChild(fillWrap);

    const fillLabel = document.createElement("div");
    fillLabel.textContent = "Image Fill";
    fillLabel.style.cssText = "grid-column:1 / -1;font-weight:bold;color:#ddd;";
    fillWrap.appendChild(fillLabel);

    const targetLabel = document.createElement("label");
    targetLabel.textContent = "Target";
    targetLabel.style.cssText = "color:#ccc;";
    fillWrap.appendChild(targetLabel);

    const fillTargetSelect = document.createElement("select");
    fillTargetSelect.title = "Color Remap適用後の最終色から、画像側で処理する領域を選択します。カラーマスク自体は変更しません。";
    fillTargetSelect.style.cssText = "width:100%;height:22px;background:#222;color:#ddd;border:1px solid #555;border-radius:3px;font-size:11px;";
    for (const name of ["None", ...PAINT_COLOR_NAMES]) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        fillTargetSelect.appendChild(option);
    }
    fillTargetSelect.value = state.fillTarget || "None";
    fillWrap.appendChild(fillTargetSelect);

    const modeLabel = document.createElement("label");
    modeLabel.textContent = "Fill";
    modeLabel.style.cssText = "color:#ccc;";
    fillWrap.appendChild(modeLabel);

    const fillModeSelect = document.createElement("select");
    fillModeSelect.title = "対象領域をBlack、White、50%グレー、または周囲画素を使うTelea / Navier-Stokesで埋めます。";
    fillModeSelect.style.cssText = "width:100%;height:22px;background:#222;color:#ddd;border:1px solid #555;border-radius:3px;font-size:11px;";
    for (const name of ["Black", "White", "Neutral Gray", "Telea", "Navier-Stokes"]) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        fillModeSelect.appendChild(option);
    }
    fillModeSelect.value = state.fillMode || "Black";
    fillWrap.appendChild(fillModeSelect);

    const expandLabel = document.createElement("label");
    expandLabel.textContent = "Expand";
    expandLabel.style.cssText = "color:#ccc;";
    fillWrap.appendChild(expandLabel);

    const fillExpandInput = document.createElement("input");
    fillExpandInput.type = "number";
    fillExpandInput.min = "-64";
    fillExpandInput.max = "64";
    fillExpandInput.step = "1";
    fillExpandInput.value = String(Number.isFinite(Number(state.fillExpand)) ? Math.trunc(Number(state.fillExpand)) : 0);
    fillExpandInput.title = "正数で対象色領域を拡張、負数で収縮します。Color Mask、Image Fill、Binary Maskへ同時に反映します。";
    fillExpandInput.style.cssText = "width:100%;height:22px;box-sizing:border-box;background:#222;color:#ddd;border:1px solid #555;border-radius:3px;font-size:11px;padding:0 5px;";
    fillWrap.appendChild(fillExpandInput);

    const blockLabel = document.createElement("label");
    blockLabel.textContent = "Block Size";
    blockLabel.style.cssText = "color:#ccc;";
    fillWrap.appendChild(blockLabel);

    const fillBlockSizeInput = document.createElement("input");
    fillBlockSizeInput.type = "number";
    fillBlockSizeInput.min = "0";
    fillBlockSizeInput.max = "256";
    fillBlockSizeInput.step = "1";
    fillBlockSizeInput.value = String(Number.isFinite(Number(state.fillBlockSize)) ? Math.trunc(Number(state.fillBlockSize)) : 0);
    fillBlockSizeInput.title = "0で無効。1以上で対象色領域をこのpx四方のブロック単位に量子化(モザイク化)します。";
    fillBlockSizeInput.style.cssText = "width:100%;height:22px;box-sizing:border-box;background:#222;color:#ddd;border:1px solid #555;border-radius:3px;font-size:11px;padding:0 5px;";
    fillWrap.appendChild(fillBlockSizeInput);

    fillBlockSizeInput.onchange = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const v = Number(fillBlockSizeInput.value);
        state.fillBlockSize = Number.isFinite(v) ? Math.max(0, Math.min(256, Math.trunc(v))) : 0;
        fillBlockSizeInput.value = String(state.fillBlockSize);
        writeData();
    };

    fillTargetSelect.onchange = (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.fillTarget = normalizeColorOption(fillTargetSelect.value, "None");
        writeData();
    };

    fillModeSelect.onchange = (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.fillMode = fillModeSelect.value || "Black";
        writeData();
    };

    fillExpandInput.onchange = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const v = Number(fillExpandInput.value);
        state.fillExpand = Number.isFinite(v) ? Math.max(-64, Math.min(64, Math.trunc(v))) : 0;
        fillExpandInput.value = String(state.fillExpand);
        writeData();
    };

    // color select 要素への参照（recolor時に値を読む）
    const colorSelects = {};

    function makeColorRow(name) {
        const label = document.createElement("label");
        label.style.cssText = "display:flex;align-items:center;gap:4px;color:#ccc;white-space:nowrap;";
        const chip = document.createElement("span");
        chip.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:50%;border:1px solid #666;background:${COLOR_CHIPS[name] || "#777"};`;
        const text = document.createElement("span");
        text.textContent = name;
        label.appendChild(chip);
        label.appendChild(text);

        const sel = document.createElement("select");
        sel.style.cssText = "width:100%;font-size:11px;background:#222;color:#ddd;border:1px solid #555;border-radius:3px;height:20px;";
        for (const optText of COLOR_OPTIONS) {
            const opt = document.createElement("option");
            opt.value = optText;
            opt.textContent = optText;
            sel.appendChild(opt);
        }

        const widget = colorWidgets[name];
        const savedValue = normalizeColorOption(state.colorAssignments?.[name] ?? widget?.value, COLOR_DEFAULTS[name] ?? "None");
        sel.value = savedValue;
        if (widget && widget.value !== savedValue) widget.value = savedValue;

        sel.onchange = (e) => {
            e.preventDefault();
            e.stopPropagation();
            state.colorAssignments = { ...(state.colorAssignments || COLOR_DEFAULTS), [name]: sel.value };
            if (widget) {
                widget.value = sel.value;
                if (typeof widget.callback === "function") widget.callback(sel.value);
            }
            writeData();
            // キャッシュがあれば即座に recolor
            if (state.nodeId) triggerRecolor();
        };

        colorPanel.appendChild(label);
        colorPanel.appendChild(sel);
        colorSelects[name] = sel;
    }

    for (const name of COLOR_WIDGET_NAMES) {
        if (name === "Mask") continue; // Mask Output は下の専用セクションで作る
        makeColorRow(name);
    }

    // Mask Output: 3番目の出力(binary_mask)にどの色を使うかの指定。
    // Color Remap適用後の最終色に対して一致判定するため、複数のIdentityが
    // 同じ最終色にリマップされていれば、それらは自動的にひとつのbinary_maskへ
    // 統合される。Image Fillと同じ見た目の独立セクションとして切り分ける。
    const maskOutWrap = document.createElement("div");
    maskOutWrap.style.cssText = "display:grid;grid-template-columns:1fr;gap:4px;margin-top:10px;padding-top:8px;border-top:1px solid #444;";
    rightPane.appendChild(maskOutWrap);

    const maskOutLabel = document.createElement("div");
    maskOutLabel.textContent = "Binary Mask";
    maskOutLabel.style.cssText = "font-weight:bold;color:#ddd;";
    maskOutWrap.appendChild(maskOutLabel);

    const maskOutSelect = document.createElement("select");
    maskOutSelect.title = "3番目の出力(binary_mask)として書き出す色。Color Remap適用後の最終色で一致判定するため、複数のIdentityを同じ色にリマップしてまとめて抽出できる。";
    maskOutSelect.style.cssText = "width:100%;height:22px;background:#222;color:#ddd;border:1px solid #555;border-radius:3px;font-size:11px;";
    for (const optText of COLOR_OPTIONS) {
        const opt = document.createElement("option");
        opt.value = optText;
        opt.textContent = optText;
        maskOutSelect.appendChild(opt);
    }
    {
        const widget = colorWidgets["Mask"];
        const savedValue = normalizeColorOption(state.colorAssignments?.["Mask"] ?? widget?.value, COLOR_DEFAULTS["Mask"] ?? "None");
        maskOutSelect.value = savedValue;
        if (widget && widget.value !== savedValue) widget.value = savedValue;
    }
    maskOutWrap.appendChild(maskOutSelect);

    maskOutSelect.onchange = (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.colorAssignments = { ...(state.colorAssignments || COLOR_DEFAULTS), Mask: maskOutSelect.value };
        const widget = colorWidgets["Mask"];
        if (widget) {
            widget.value = maskOutSelect.value;
            if (typeof widget.callback === "function") widget.callback(maskOutSelect.value);
        }
        writeData();
        if (state.nodeId) triggerRecolor();
    };
    colorSelects["Mask"] = maskOutSelect;

    resetRemapBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        state.colorAssignments = { ...COLOR_DEFAULTS };
        for (const name of COLOR_WIDGET_NAMES) {
            const value = COLOR_DEFAULTS[name] ?? "None";
            const sel = colorSelects[name];
            const widget = colorWidgets[name];
            if (sel) sel.value = value;
            if (widget) {
                widget.value = value;
                if (typeof widget.callback === "function") widget.callback(value);
            }
        }
        writeData();
        if (state.nodeId) triggerRecolor();
    };

    // Help/status text removed from the visible left pane. Keep a tiny sink so
    // existing status assignments remain harmless without adding layout height.
    const hint = { textContent: "" };

    // Keep the view selector outside the image so it never covers painted content.
    const viewModeBar = document.createElement("div");
    viewModeBar.style.cssText = "display:flex;justify-content:center;gap:3px;width:100%;min-height:23px;box-sizing:border-box;";
    leftPane.appendChild(viewModeBar);
    for (const mode of VIEW_MODES) {
        const b = document.createElement("button");
        b.textContent = VIEW_LABELS[mode];
        b.title = `Show ${VIEW_LABELS[mode]}`;
        b.style.cssText = "padding:2px 7px;cursor:pointer;border-radius:4px;border:1px solid #555;background:rgba(35,35,35,0.86);color:#ddd;font-size:10px;line-height:15px;";
        b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); setViewMode(mode); };
        for (const ev of ["pointerdown", "mousedown", "wheel"]) b.addEventListener(ev, e => e.stopPropagation());
        viewButtons[mode] = b;
        viewModeBar.appendChild(b);
    }
    updateViewButtons();

    const canvasWrap = document.createElement("div");
    canvasWrap.style.cssText = "position:relative;width:100%;min-width:0;";
    leftPane.appendChild(canvasWrap);

    const canvas = document.createElement("canvas");
    canvas.style.cssText = `width:100%;height:${CANVAS_FALLBACK_H}px;background:#1a1a1a;border-radius:4px;display:block;touch-action:none;user-select:none;cursor:none;`;
    canvasWrap.appendChild(canvas);

    const ctx = canvas.getContext("2d");

    // ── view helpers ─────────────────────────────────────────────────────────
    function refreshView() {
        const cssW = Math.max(1, Math.floor(canvas.clientWidth || (node.size[0] - RIGHT_PANE_W - 36)));
        const img = state.img;
        const cssH = img && img.naturalWidth > 0
            ? Math.max(1, Math.round(cssW * img.naturalHeight / img.naturalWidth))
            : CANVAS_FALLBACK_H;

        canvas.style.height = `${cssH}px`;

        if (canvas.width !== cssW) canvas.width = cssW;
        if (canvas.height !== cssH) canvas.height = cssH;

        if (!img) { state.view = { scale: 1, ox: 0, oy: 0 }; return; }
        const scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
        state.view = {
            scale,
            ox: (canvas.width  - img.naturalWidth  * scale) / 2,
            oy: (canvas.height - img.naturalHeight * scale) / 2,
        };
    }

    const imgToScreen = (x, y) => [state.view.ox + x * state.view.scale,
                                    state.view.oy + y * state.view.scale];
    const canvasToImg = (px, py) => [(px - state.view.ox) / state.view.scale,
                                     (py - state.view.oy) / state.view.scale];
    function eventToCanvas(e) {
        const r = canvas.getBoundingClientRect();
        return [(e.clientX - r.left) * (canvas.width  / r.width),
                (e.clientY - r.top)  * (canvas.height / r.height)];
    }

    // ── hit testing ──────────────────────────────────────────────────────────
    function nearestPoint(m, px, py) {
        let best = -1, bestD = HIT_PX;
        m.points.forEach((p, pi) => {
            const [sx, sy] = imgToScreen(p[0], p[1]);
            const d = Math.hypot(px - sx, py - sy);
            if (d <= bestD) { bestD = d; best = pi; }
        });
        return best;
    }

    function markerAt(px, py) {
        for (let i = state.markers.length - 1; i >= 0; i--) {
            if (nearestPoint(state.markers[i], px, py) >= 0) return i;
        }
        return -1;
    }

    // ── draw ─────────────────────────────────────────────────────────────────
    function redraw() {
        refreshView();
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (!state.img) {
            ctx.fillStyle = "#777"; ctx.font = "12px sans-serif";
            ctx.fillText("Press ▶ to load the first frame, then paint a seed mask.", 12, 24);
            hint.textContent = "Click=new identity · Shift+click=add pos · Alt+click=neg · Right-click=remove";
            return;
        }

        ctx.drawImage(state.img,
            state.view.ox, state.view.oy,
            state.img.naturalWidth  * state.view.scale,
            state.img.naturalHeight * state.view.scale);

        // Painted initial masks are shown using each stroke's selected Index colour.
        // The paint colour is only a UI preview; tracking still uses a binary seed mask.
        ctx.save();
        ctx.lineCap = "round"; ctx.lineJoin = "round";
        for (const st of state.paintStrokes) {
            if ((st.frame_index ?? 0) !== state.frameIndex) continue;
            const pts = Array.isArray(st.points) ? st.points : [];
            if (!pts.length) continue;
            ctx.globalCompositeOperation = st.mode === "erase" ? "destination-out" : "source-over";
            const paintColor = remappedPaintColor(st.color || PAINT_COLOR_NAMES[(Number(st.index) || 0) + 2] || "Blue", state.colorAssignments);
            ctx.globalAlpha = 0.82;
            ctx.strokeStyle = paintColor;
            ctx.fillStyle = paintColor;
            ctx.lineWidth = Math.max(1, (Number(st.size) || 28) * state.view.scale);
            const [x0, y0] = imgToScreen(pts[0][0], pts[0][1]);
            if (pts.length === 1) {
                ctx.beginPath(); ctx.arc(x0, y0, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
            } else {
                ctx.beginPath(); ctx.moveTo(x0, y0);
                for (let pi = 1; pi < pts.length; pi++) {
                    const [sx, sy] = imgToScreen(pts[pi][0], pts[pi][1]); ctx.lineTo(sx, sy);
                }
                ctx.stroke();
            }
        }
        ctx.restore();

        state.markers.forEach((m, i) => {
            const color = SAM3_COLORS[i % SAM3_COLORS.length];
            const sel   = i === state.selected;
            m.points.forEach((p) => {
                const [sx, sy] = imgToScreen(p[0], p[1]);
                const positive = p[2] !== 0;
                const r = sel ? 7 : 5;
                ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
                ctx.fillStyle   = positive ? color : "#111";
                ctx.fill();
                ctx.lineWidth   = 2;
                ctx.strokeStyle = positive ? (sel ? "#fff" : "#000") : color;
                ctx.stroke();
                if (!positive) {
                    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
                    ctx.beginPath(); ctx.moveTo(sx - 3, sy); ctx.lineTo(sx + 3, sy); ctx.stroke();
                }
            });
            if (m.points.length > 0) {
                const [lx, ly] = imgToScreen(m.points[0][0], m.points[0][1]);
                ctx.font = "bold 12px sans-serif";
                ctx.fillStyle = "#000"; ctx.fillText(String(i + 1), lx + 8 + 1, ly - 7 + 1);
                ctx.fillStyle = color;  ctx.fillText(String(i + 1), lx + 8,     ly - 7);
            }
        });

        if (state.brushCursor.visible) {
            const radius = Math.max(1, state.brushSize * state.view.scale / 2);
            ctx.save();
            ctx.beginPath();
            ctx.arc(state.brushCursor.x, state.brushCursor.y, radius, 0, Math.PI * 2);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "rgba(255,255,255,0.95)";
            ctx.shadowColor = "rgba(0,0,0,0.9)";
            ctx.shadowBlur = 2;
            ctx.stroke();
            ctx.restore();
        }

        const smsg = state.selected >= 0 ? `, identity ${state.selected + 1} selected` : "";
        if (false) {
            hint.textContent = `${state.markers.length} identit(y/ies)${smsg} · Shift+click=add · Alt+click=neg`;
        } else {
            const hasKey = state.paintStrokes.some((st) => Number(st?.frame_index ?? 0) === (state.frameIndex || 0));
            hint.textContent = `${state.toolMode === "paint" ? "Paint" : "Erase"} seed mask · ${state.paintColor} · brush ${state.brushSize}px${hasKey ? " · KEY" : ""}`;
        }
    }

    // ── workflow mouse passthrough ───────────────────────────────────────────
    // 中ボタンドラッグ（ワークフローパン）：
    // ComfyUI の addDOMWidget は wrapper div を生成してイベントを吸収するため、
    // pointer-events の制御だけでは不十分。
    // → node.onMouseDown で中ボタンを検知して false を返し LiteGraph に処理を委譲する。
    // ホイール (ズーム) は DOM イベントを LiteGraph canvas に転送する。

    function graphCanvasEl() {
        return app?.canvas?.canvas || document.querySelector("canvas#graph-canvas, canvas");
    }

    function forwardWheelToGraph(e) {
        const target = graphCanvasEl();
        if (!target) return;
        target.dispatchEvent(new WheelEvent("wheel", {
            bubbles: true, cancelable: true, view: window,
            deltaX: e.deltaX, deltaY: e.deltaY, deltaZ: e.deltaZ,
            deltaMode: e.deltaMode,
            clientX: e.clientX, clientY: e.clientY,
            screenX: e.screenX, screenY: e.screenY,
            ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
            altKey: e.altKey,   metaKey: e.metaKey,
        }));
    }

    // ホイール転送
    for (const el of [root, body, leftPane, rightPane, canvas]) {
        if (!el) continue;
        el.addEventListener("wheel", (e) => {
            e.preventDefault();
            e.stopPropagation();
            forwardWheelToGraph(e);
        }, { passive: false });
    }

    // 中ボタンパン：LGraphCanvas の内部状態を直接操作する
    // app.canvas.dragging_canvas がパン中フラグ兼前回座標
    root.addEventListener("pointerdown", (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();

        const lgc = app?.canvas;
        if (!lgc) return;

        lgc.dragging_canvas = [e.clientX, e.clientY];

        const onMove = (ev) => {
            if (!lgc.dragging_canvas) return;
            const [lx, ly] = lgc.dragging_canvas;
            const scale = lgc.ds?.scale ?? lgc.scale ?? 1;
            const dx = (ev.clientX - lx) / scale;
            const dy = (ev.clientY - ly) / scale;
            if (lgc.ds?.offset) {
                lgc.ds.offset[0] += dx;
                lgc.ds.offset[1] += dy;
            } else if (lgc.offset) {
                lgc.offset[0] += dx;
                lgc.offset[1] += dy;
            }
            lgc.dragging_canvas = [ev.clientX, ev.clientY];
            lgc.dirty_canvas = true;
            lgc.dirty_bgcanvas = true;
            lgc.draw();
        };

        const onUp = (ev) => {
            if (ev.button !== 1) return;
            lgc.dragging_canvas = null;
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup",   onUp,   true);
        };

        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup",   onUp,   true);
    }, true);

    // ── pointer events ───────────────────────────────────────────────────────
    canvas.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || !state.img) return;
        root.focus();
        refreshView();
        const [px, py] = eventToCanvas(e);
        const [ix, iy] = canvasToImg(px, py);

        if (true) {
            e.preventDefault(); e.stopPropagation();
            state.painting = true;
            state.activeStroke = {
                color: state.paintColor, index: Math.max(0, PAINT_COLOR_NAMES.indexOf(state.paintColor) - 2), frame_index: state.frameIndex || 0,
                size: state.brushSize, mode: state.toolMode === "erase" ? "erase" : "paint",
                points: [[ix, iy]],
            };
            state.paintStrokes.push(state.activeStroke);
            canvas.setPointerCapture?.(e.pointerId);
            writeData(); redraw(); return;
        }

        const addMod = e.shiftKey || e.altKey;

        if (addMod && state.selected >= 0 && state.markers[state.selected]) {
            if (state.markers[state.selected].frame_index == null) {
                state.markers[state.selected].frame_index = state.frameIndex || 0;
            }
            state.markers[state.selected].points.push([ix, iy, e.altKey ? 0 : 1]);
            writeData(); redraw(); return;
        }

        const idx = markerAt(px, py);
        if (idx >= 0) {
            state.selected = idx;
            redraw(); return;
        }

        if (state.markers.length >= MAX_IDS) {
            hint.textContent = `Maximum ${MAX_IDS} identities reached.`;
            return;
        }
        state.selected = -1;
        state.markers.push({ type: "point", frame_index: state.frameIndex || 0, points: [[ix, iy, 1]] });
        state.selected = state.markers.length - 1;
        writeData(); redraw();
    });

    canvas.addEventListener("pointermove", (e) => {
        if (!state.img) return;
        refreshView();
        const [px, py] = eventToCanvas(e);
        state.brushCursor = { visible: true, x: px, y: py };
        if (!state.painting || !state.activeStroke) { redraw(); return; }
        const [ix, iy] = canvasToImg(px, py);
        const pts = state.activeStroke.points;
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(ix - last[0], iy - last[1]) >= Math.max(1, state.brushSize * 0.15)) {
            pts.push([ix, iy]); writeData(); redraw();
        }
    });
    canvas.addEventListener("pointerenter", (e) => {
        if (!state.img) return;
        refreshView();
        const [px, py] = eventToCanvas(e);
        state.brushCursor = { visible: true, x: px, y: py };
        redraw();
    });
    canvas.addEventListener("pointerleave", () => {
        state.brushCursor.visible = false;
        redraw();
    });

    const finishPaint = (e) => {
        if (!state.painting) return;
        state.painting = false; state.activeStroke = null;
        try { canvas.releasePointerCapture?.(e.pointerId); } catch (_) {}
        writeData(); redraw();
    };
    canvas.addEventListener("pointerup", finishPaint);
    canvas.addEventListener("pointercancel", finishPaint);

    canvas.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (true) return;
        refreshView();
        const [px, py] = eventToCanvas(e);
        const idx = markerAt(px, py);
        if (idx < 0) return;
        const m = state.markers[idx];
        if (m.points.length > 1) {
            const pi = nearestPoint(m, px, py);
            if (pi >= 0) m.points.splice(pi, 1);
        } else {
            state.markers.splice(idx, 1);
            state.selected = -1;
        }
        writeData(); redraw();
    });

    root.addEventListener("keydown", (e) => {
        if ((e.key === "Delete" || e.key === "Backspace") && state.selected >= 0) {
            e.preventDefault(); e.stopPropagation();
            state.markers.splice(state.selected, 1);
            state.selected = -1;
            writeData(); redraw();
        }
    });

    let resizeQueued = false;
    const queueRedraw = () => {
        if (resizeQueued) return;
        resizeQueued = true;
        requestAnimationFrame(() => {
            resizeQueued = false;
            redraw();
        });
    };

    if (typeof ResizeObserver !== "undefined") {
        // Observe only the canvas width. Observing the root caused a feedback loop:
        // computeSize -> root height change -> ResizeObserver -> redraw -> height change.
        const ro = new ResizeObserver(queueRedraw);
        ro.observe(canvas);
        node._slimyResizeObserver = ro;
    }

    const widget = node.addDOMWidget("slimy_canvas", "slimy_canvas", root, {
        serialize: false, hideOnZoom: false,
    });

    // addDOMWidget が生成する wrapper div にも中ボタン処理を適用
    if (widget.element && widget.element !== root) {
        setupMiddlePan(widget.element);
        // Keep a real gap between the DOM widget and the node's lower border.
        // This is separate from the preview/canvas height, so the preview does not
        // grow to consume the added node height.
        widget.element.style.boxSizing = "border-box";
        widget.element.style.paddingBottom = "16px";
    }
    widget.computeSize = function () {
        const w = node.size[0];
        const canvasW = Math.max(1, Math.floor(w - RIGHT_PANE_W - 36));
        const img = state.img;
        const canvasH = img && img.naturalWidth > 0
            ? Math.max(1, Math.round(canvasW * img.naturalHeight / img.naturalWidth))
            : CANVAS_FALLBACK_H;

        // Toolbar + hint + external view buttons + gaps/padding.
        // The previous fixed 60px estimate was too small and let the lower
        // preview extend outside the node frame.
        const chromeH = 94;
        const bottomMarginH = 32; // 16px root spacer + 16px DOM-widget lower padding
        const colorH = 24 + COLOR_WIDGET_NAMES.length * 24;
        // Keep this deterministic. Reading root.scrollHeight here fed the assigned
        // widget height back into computeSize and made the node glide vertically.
        return [w, Math.max(canvasH + chromeH, colorH + 8) + bottomMarginH];
    };

    node._slimyOnExecuted = (message) => {
        const reportedCount = Array.isArray(message?.frame_count)
            ? Number(message.frame_count[0] ?? 0)
            : Number(message?.frame_count ?? 0);
        const legacyFrames =
            (Array.isArray(message?.video_preview) && message.video_preview.length ? message.video_preview :
            (Array.isArray(message?.images) && message.images.length ? message.images : []));
        const frameCount = Math.max(0, reportedCount || legacyFrames.length);
        if (!frameCount) return;

        state.nodeId = Array.isArray(message?.node_id) ? message.node_id[0] : (message?.node_id ?? null);
        // Length-only arrays preserve the existing navigation/UI contract. Pixels
        // are fetched directly from the Python tensor cache as Blob responses.
        state.frames = Array.from({ length: frameCount }, () => null);

        state.maskFrames = Array.from({ length: frameCount }, () => null);
        state.overlayFrames = Array.from({ length: frameCount }, () => null);
        state.frameIndex = Math.max(0, Math.min(state.frameIndex || 0, frameCount - 1));
        // Keep the last selected view. On first execution Overlay is the most useful.
        if (!["input", "overlay", "mask"].includes(state.viewMode)) state.viewMode = "overlay";
        updateViewButtons();
        writeData();
        loadFrame(state.frameIndex);
    };

    function syncColorSelects() {
        for (const name of COLOR_WIDGET_NAMES) {
            const widget = colorWidgets[name];
            const sel = colorSelects[name];
            const value = normalizeColorOption(state.colorAssignments?.[name] ?? widget?.value, COLOR_DEFAULTS[name] ?? "None");
            if (sel && sel.value !== value) sel.value = value;
            if (widget && widget.value !== value) widget.value = value;
        }
        if (fillTargetSelect) fillTargetSelect.value = state.fillTarget || "None";
        if (fillModeSelect) fillModeSelect.value = state.fillMode || "Black";
        if (fillExpandInput) fillExpandInput.value = String(Number.isFinite(Number(state.fillExpand)) ? Math.trunc(Number(state.fillExpand)) : 0);
        if (fillBlockSizeInput) fillBlockSizeInput.value = String(Number.isFinite(Number(state.fillBlockSize)) ? Math.trunc(Number(state.fillBlockSize)) : 0);
    }

    node._slimyPersistPreview = () => {
        const previewCache = {
            frames: state.frames || [],
            mask_frames: state.maskFrames || [],
            overlay_frames: state.overlayFrames || [],
            view_mode: state.viewMode || "input",
            node_id: state.nodeId,
        };
        node.properties ??= {};
        node.properties._slimy_preview_cache = previewCache;
        state.previewCache = previewCache;
        return previewCache;
    };

    node._slimySync = () => {
        syncFromWidget();
        syncColorSelects();
        updateFrameUI();
        if (state.frames.length) loadFrame(state.frameIndex);
        else redraw();
    };

    setTimeout(() => {
        syncColorSelects();
        if (state.frames.length) loadFrame(state.frameIndex);
        else redraw();
    }, 50);
}

app.registerExtension({
    name: "slimy.coloredMaskTracker",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "SlimyColoredMaskTracker") return;

        const onCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onCreated?.apply(this, arguments);
            setupNode(this);
            return r;
        };

        // 中ボタン mousedown を LiteGraph のパン処理に委譲する
        // LiteGraph は onMouseDown が false を返すと自身の処理（パン）を続行する
        const onMouseDown = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function (e) {
            if (e.button === 1) return false; // LiteGraph にパンを任せる
            return onMouseDown?.apply(this, arguments);
        };

        const onExecuted = nodeType.prototype.onExecuted;
        nodeType.prototype.onExecuted = function (message) {
            onExecuted?.apply(this, arguments);
            this._slimyOnExecuted?.(message);
        };

        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (o) {
            this._slimyPersistPreview?.();
            const r = onSerialize?.apply(this, arguments);
            if (o) {
                o.properties ??= {};
                if (this.properties?._slimy_preview_cache) {
                    o.properties._slimy_preview_cache = this.properties._slimy_preview_cache;
                }
            }
            return r;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const info = arguments?.[0];
            const values = info?.widgets_values;
            // Legacy workflow migration:
            // remove refine_iterations, detect_interval and speed_mode values before
            // LiteGraph maps the remaining saved values onto the new widget order.
            if (Array.isArray(values) && values.length >= 14) {
                const legacyRefine = values[1];
                const legacyThreshold = values[2];
                const legacyInterval = values[3];
                const legacySpeed = values[4];
                const looksLegacy =
                    typeof legacyRefine === "number" &&
                    typeof legacyThreshold === "number" &&
                    typeof legacyInterval === "number" &&
                    typeof legacySpeed === "string" &&
                    (legacySpeed === "Normal" || legacySpeed.startsWith("Fast"));
                if (looksLegacy) {
                    values.splice(1, 1); // refine_iterations
                    values.splice(2, 2); // detect_interval, speed_mode
                }
            }
            const r = onConfigure?.apply(this, arguments);
            this._slimySync?.();
            return r;
        };
    },
});
