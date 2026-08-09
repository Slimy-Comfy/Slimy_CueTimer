import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const FONT_ID    = "slimy-cue-timer-font";
const FONT_FACE  = "Orbitron";
const MAX_HISTORY = 100;
const PREDICT_HISTORY_COUNT = 5;
const PREDICT_MIN_VALID_MS = 15000;
const PREDICT_MAX_PCT = 0.98;

// PeepPreviewループ設定。末尾フレームを指定回数ぶん保持してから先頭へ戻す。
const PEEP_PREVIEW_FRAME_MS = 240;
const PEEP_PREVIEW_END_HOLD_FRAMES = 5;

const PeepState = {
    samplerStep: 0,
    samplerTotal: 0,
    nodesDone: 0,
    nodesTotal: 0,
    predictedTotalMs: 0,
    frameCount: 1,
    currentPromptId: null,
    finalVideo: null, // 完了後に表示する最終動画アセット
    pendingFinalVideo: null, // 実行中に検出した候補。完了までは表示しない
};

// --- Final video detection (executed イベントの output から動画/GIFらしきファイルを拾う) ---
const SLIMY_VIDEO_EXT_RE = /\.(mp4|webm|mov|mkv|gif|webp)$/i;

function slimyExtractVideoAssets(output) {
    const found = [];
    if (!output) return found;
    for (const key of Object.keys(output)) {
        const val = output[key];
        if (!Array.isArray(val)) continue;
        for (let item of val) {
            if (typeof item === "string") {
                try { item = JSON.parse(item); } catch (e) { continue; }
            }
            if (item && typeof item.filename === "string" && SLIMY_VIDEO_EXT_RE.test(item.filename)) {
                found.push({
                    filename: item.filename,
                    subfolder: item.subfolder || "",
                    type: item.type || "output",
                });
            }
        }
    }
    return found;
}

function slimyBuildViewUrl(asset) {
    const params = new URLSearchParams({
        filename: asset.filename,
        subfolder: asset.subfolder || "",
        type: asset.type || "output",
    });
    return api.apiURL(`/view?${params.toString()}`);
}

// DOMウィジェット(video等)の上ではホイール/中クリックドラッグがcanvasまで
// 届かないため、明示的にcanvas要素へ転送してパン・ズームを維持する。
// (Slimy_VideoSpoolerで同じ問題への対処として実装済みのものを移植)
function _slimyGetCanvasEl() {
    return app?.canvasEl || app?.canvas?.canvas || document.querySelector("canvas");
}

// Synthetic pointer events dispatched to the LiteGraph canvas bubble back to
// window. Without this guard, the forwarding listeners catch their own events
// and recursively dispatch forever.
const _slimyForwardedPointerEvents = new WeakSet();

function _slimyDispatchPointerToCanvas(type, e) {
    const canvasEl = _slimyGetCanvasEl();
    if (!canvasEl) return;
    const forwarded = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: e.pointerId,
        pointerType: e.pointerType || "mouse",
        isPrimary: e.isPrimary,
        button: e.button,
        buttons: e.buttons,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
    });
    _slimyForwardedPointerEvents.add(forwarded);
    canvasEl.dispatchEvent(forwarded);
}

function _slimyForwardWheelToCanvas(el) {
    el.addEventListener("wheel", (e) => {
        const canvasEl = _slimyGetCanvasEl();
        if (!canvasEl) return;
        canvasEl.dispatchEvent(new WheelEvent("wheel", e));
    }, { passive: true });
}

function _slimyForwardMiddleDragToCanvas(el) {
    let dragging = false;
    const dispatch = (type, e) => _slimyDispatchPointerToCanvas(type, e);
    const onDown = (e) => {
        if (e.button !== 1) return;
        dragging = true;
        dispatch("pointerdown", e);
    };
    const onMove = (e) => {
        if (_slimyForwardedPointerEvents.has(e)) return;
        if (dragging) dispatch("pointermove", e);
    };
    const onUp = (e) => {
        if (_slimyForwardedPointerEvents.has(e)) return;
        if (dragging) { dragging = false; dispatch("pointerup", e); }
    };
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
        dragging = false;
        el.removeEventListener("pointerdown", onDown);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
    };
}

// Native <video> covers the LiteGraph canvas. Forward left-button actions from the
// picture area back to the canvas so canvas widgets remain clickable and the node
// can still be dragged. Keep the native control strip and real buttons interactive.
function _slimyForwardLeftFromVideoToCanvas(container, video) {
    let forwarding = false;
    let downX = 0;
    let downY = 0;
    let moved = false;
    const CLICK_DRAG_THRESHOLD_PX = 5;

    const dispatch = (type, e) => _slimyDispatchPointerToCanvas(type, e);
    const togglePlayback = () => {
        if (video.paused || video.ended) {
            video.play().catch(() => { /* browser may block playback */ });
        } else {
            video.pause();
        }
    };

    const isNativeInteractiveArea = (e) => {
        if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement) return true;
        if (e.target !== video) return false;
        const r = video.getBoundingClientRect();
        // Preserve the browser's native video controls at the bottom.
        return e.clientY >= r.bottom - 48;
    };

    const onDown = (e) => {
        if (e.button !== 0 || isNativeInteractiveArea(e)) return;
        forwarding = true;
        downX = e.clientX;
        downY = e.clientY;
        moved = false;
        e.preventDefault();
        e.stopPropagation();
        dispatch("pointerdown", e);
    };
    const onMove = (e) => {
        if (_slimyForwardedPointerEvents.has(e) || !forwarding) return;
        if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_DRAG_THRESHOLD_PX) {
            moved = true;
        }
        e.preventDefault();
        dispatch("pointermove", e);
    };
    const onUp = (e) => {
        if (_slimyForwardedPointerEvents.has(e) || !forwarding) return;
        forwarding = false;
        e.preventDefault();
        dispatch("pointerup", e);
        if (!moved) togglePlayback();
    };
    const onCancel = (e) => {
        if (_slimyForwardedPointerEvents.has(e) || !forwarding) return;
        forwarding = false;
        dispatch("pointercancel", e);
    };

    container.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);

    return () => {
        forwarding = false;
        container.removeEventListener("pointerdown", onDown, true);
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", onCancel, true);
    };
}

function slimyParseHistoryTimeMs(timeStr) {
    if (typeof timeStr !== "string") return 0;
    const m = timeStr.match(/^(\d+):(\d+):(\d+)$/);
    if (!m) return 0;
    return Number(m[1]) * 60000 + Number(m[2]) * 1000 + Number(m[3]);
}

function slimyEstimateTotalMsFromHistory(nodes) {
    const durations = [];
    for (const node of nodes || []) {
        const hist = node.properties?.history || [];
        for (const entry of hist) {
            const timeStr  = typeof entry === "object" ? entry.time : entry;
            const entryType = typeof entry === "object" ? entry.type : "done";
            if (entryType === "error") continue;  // 中止・エラーは除外
            const ms = slimyParseHistoryTimeMs(timeStr);
            if (ms >= PREDICT_MIN_VALID_MS) durations.push(ms);
            if (durations.length >= PREDICT_HISTORY_COUNT) break;
        }
        if (durations.length >= PREDICT_HISTORY_COUNT) break;
    }
    if (!durations.length) return 0;
    return durations.reduce((a, b) => a + b, 0) / durations.length;
}

function slimyGetNodeProgressPct() {
    const rawNodePct =
        PeepState.nodesTotal > 0
            ? PeepState.nodesDone / PeepState.nodesTotal
            : 0;

    if (!GlobalTimer.isRunning || PeepState.predictedTotalMs <= 0 || GlobalTimer.startTime <= 0) {
        return rawNodePct;
    }

    const elapsedMs = Date.now() - GlobalTimer.startTime;
    const predictedNodePct = Math.min(elapsedMs / PeepState.predictedTotalMs, PREDICT_MAX_PCT);

    return Math.max(rawNodePct, predictedNodePct);
}

// --- Notification & Sound ---
const SlimyNotify = {
    _permissionRequested: false,

    requestPermission() {
        if (this._permissionRequested) return;
        this._permissionRequested = true;
        if (Notification.permission === "default") {
            Notification.requestPermission();
        }
    },

    playSound(type) {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            if (type === "done") {
                // 完了: 短い上昇チャイム
                [[880, 0, 0.12], [1100, 0.13, 0.12], [1320, 0.26, 0.18]].forEach(([freq, start, dur]) => {
                    const osc  = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain); gain.connect(ctx.destination);
                    osc.type = "sine";
                    osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
                    gain.gain.setValueAtTime(1.0, ctx.currentTime + start);
                    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
                    osc.start(ctx.currentTime + start);
                    osc.stop(ctx.currentTime + start + dur + 0.01);
                });
            } else {
                // エラー/中断: 低い警告音
                [[440, 0, 0.15], [330, 0.18, 0.25]].forEach(([freq, start, dur]) => {
                    const osc  = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain); gain.connect(ctx.destination);
                    osc.type = "sawtooth";
                    osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
                    gain.gain.setValueAtTime(1.0, ctx.currentTime + start);
                    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
                    osc.start(ctx.currentTime + start);
                    osc.stop(ctx.currentTime + start + dur + 0.01);
                });
            }
        } catch (e) { console.warn("SlimyCueTimer: audio error", e); }
    },

    send(type, timeStr) {
        this.playSound(type);
        if (Notification.permission !== "granted") return;
        const title = type === "done" ? "✅ Queue Complete" : "⚠️ Queue Stopped";
        const body  = type === "done"
            ? `完了しました　${timeStr}`
            : `中断 / エラー　${timeStr}`;
        new Notification(title, { body, silent: true });
    },
};

function playPeepPreviewBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [[660, 0, 0.18], [440, 0.2, 0.28]].forEach(([freq, start, dur]) => {
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = "sine";
            osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
            gain.gain.setValueAtTime(0.4, ctx.currentTime + start);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
            osc.start(ctx.currentTime + start);
            osc.stop(ctx.currentTime + start + dur + 0.01);
        });
    } catch (e) {
        console.warn("SlimyCueTimer: peep preview chime failed", e);
    }
}

// --- VRAM Clear ---
// キュー完了直後にComfyUIコア標準の /free エンドポイントを叩き、
// モデルのアンロード + 実行キャッシュのクリアをまとめて行う。
// (ComfyUI-Manager の "Free model and node cache" ボタンと同じ仕組み)
let _slimyVramClearInFlight = false;
async function slimyClearVRAM() {
    if (_slimyVramClearInFlight) return;
    _slimyVramClearInFlight = true;
    try {
        const res = await api.fetchApi("/free", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ unload_models: true, free_memory: true }),
        });
        if (!res.ok) {
            console.warn("[Slimy_CueTimer] VRAM clear failed:", await res.text());
        }
    } catch (err) {
        console.warn("[Slimy_CueTimer] VRAM clear failed:", err);
    } finally {
        _slimyVramClearInFlight = false;
    }
}

// いずれかのSlimy_CueTimerノードでVRAM Clearが有効なら実行する。
// 正常終了(done) / エラー(error) / 中断(interrupted) いずれの停止理由でも共通で使う。
function slimyMaybeClearVRAM() {
    const vramEnabled = [...GlobalTimer.activeNodes].some(n => n.properties.vramCleanupEnabled !== false);
    if (vramEnabled) slimyClearVRAM();
}

// --- Global Timer Manager ---
const GlobalTimer = {
    startTime: 0,
    intervalId: null,
    isRunning: false,
    activeNodes: new Set(),

    formatTime(ms) {
        if (ms < 0) ms = 0;
        const minutes      = String(Math.floor(ms / 60000)).padStart(2, "0");
        const seconds      = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
        const milliseconds = String(ms % 1000).padStart(3, "0");
        return { str: `${minutes}:${seconds}:${milliseconds}`, minutes, seconds, milliseconds };
    },

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.startTime = Date.now();
        this.intervalId = setInterval(() => {
            const t = this.formatTime(Date.now() - this.startTime);
            this.activeNodes.forEach(node => {
                node._timerStr = t.str;
                node.setDirtyCanvas(true, false);
            });
        }, 50);
        this.activeNodes.forEach(node => { node._running = true; });
    },

    stop(type = "done") {
        if (!this.isRunning) return;
        this.isRunning = false;
        clearInterval(this.intervalId);
        const finalTime = this.formatTime(Date.now() - this.startTime);
        const shouldNotify = [...this.activeNodes].some(n => n.properties.notifyEnabled !== false);
        if (shouldNotify) SlimyNotify.send(type, finalTime.str);
        this.activeNodes.forEach(node => {
            node._timerStr = finalTime.str;
            node._running  = false;
            node.properties.elapsed_time_str = finalTime.str;
            const hist = node.properties.history || [];
            const now = new Date();
            const stamp = `${now.getFullYear()}/${String(now.getMonth()+1).padStart(2,"0")}/${String(now.getDate()).padStart(2,"0")} ${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
            hist.unshift({ time: finalTime.str, stamp, type });
            if (hist.length > MAX_HISTORY) hist.length = MAX_HISTORY;
            node.properties.history = hist;
            node._scrollOffset = 0;
            node.setDirtyCanvas(true, false);
        });
    },

    registerNode(node)   { this.activeNodes.add(node); },
    unregisterNode(node) { this.activeNodes.delete(node); },
};

// --- Extension ---
const SlimyCueTimerExtension = {
    name: "Slimy_CueTimer",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "Slimy_CueTimer") return;

        const origCreated   = nodeType.prototype.onNodeCreated;
        const origRemoved   = nodeType.prototype.onRemoved;
        const origSerialize = nodeType.prototype.onSerialize;
        const origConfigure = nodeType.prototype.onConfigure;

        nodeType.prototype.onNodeCreated = function () {
            origCreated?.apply(this, arguments);

            this.bgcolor    = "#0a0a0a";
            this.color      = "#0a0a0a";
            this.title      = "Slimy_CueTimer";
            this.size       = [420, 420];
            this.properties = this.properties || {};
            this.resizable  = true;

            this._timerStr     = this.properties.elapsed_time_str || "00:00:000";
            this._running      = false;
            this._scrollOffset = 0;
            this._isDraggingScrollbar = false;
            this._slimyPreviewImage = null;
            this._slimyFrameCount = 1;
            this._slimyFrameIndex = 0;
            this._slimyFrameTimer = null;
            this._slimyFinalVideoAsset = null;
            this._slimyNotifySound = this.properties.peepNotifySound !== false;
            if (this.properties.notifyEnabled === undefined) this.properties.notifyEnabled = true;
            if (this.properties.peepNotifySound === undefined) this.properties.peepNotifySound = true;
            if (this.properties.vramCleanupEnabled === undefined) this.properties.vramCleanupEnabled = true;
            if (this.properties.autoPlayEnabled === undefined) this.properties.autoPlayEnabled = true;
            // 旧バージョン(peepPreview / peepOnly)からのマイグレーション
            if (this.properties.timerVisible === undefined) {
                this.properties.timerVisible = this.properties.peepOnly === true ? false : true;
            }
            if (this.properties.peepVisible === undefined) {
                this.properties.peepVisible = this.properties.peepPreview !== false;
            }

            GlobalTimer.registerNode(this);
        };

        // --- Final video playback (native <video controls> = シークバー・再生時間・
        //     全画面ボタンが標準で付く。canvasへの手描画はやめてDOM要素をそのまま使う) ---
        nodeType.prototype._slimyEnsureVideoWidget = function () {
            if (this._slimyVideoWidget) return this._slimyVideoWidget;

            // outer: addDOMWidgetがノードの残り領域全体に合わせて自動でサイズ管理する
            // コンテナ。pointer-events:noneにして、下のcanvas(チェックボックスやノードの
            // ドラッグ等)へのクリック/ドラッグを常に素通りさせる。
            const outer = document.createElement("div");
            outer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;pointer-events:none;overflow:visible;";

            // inner: 実際に見える・操作できる部分だけ。onDrawForegroundで毎フレーム
            // imgX/imgY/imgW/imgHへ位置合わせする。ここだけpointer-events:autoに戻す。
            const inner = document.createElement("div");
            inner.style.cssText = "position:absolute;display:none;flex-direction:column;gap:4px;box-sizing:border-box;pointer-events:auto;z-index:5;";
            _slimyForwardWheelToCanvas(inner);
            _slimyForwardMiddleDragToCanvas(inner);
            outer.appendChild(inner);

            const video = document.createElement("video");
            video.controls = true;
            video.loop = true;
            video.muted = true; // 自動再生ブロック回避。音はユーザーがcontrolsからミュート解除できる
            video.playsInline = true;
            video.style.cssText = "width:100%;flex:1 1 auto;min-height:0;background:#000;border-radius:4px;object-fit:contain;";
            inner.appendChild(video);
            this._slimyVideoPointerCleanup?.();
            this._slimyVideoPointerCleanup = _slimyForwardLeftFromVideoToCanvas(inner, video);

            const btnRow = document.createElement("div");
            btnRow.style.cssText = "display:flex;align-items:center;gap:6px;flex:0 0 20px;height:20px;min-height:20px;overflow:hidden;";

            const revealBtn = document.createElement("button");
            revealBtn.textContent = "📂 Open folder";
            revealBtn.title = "Reveal this file in the file manager (on the machine running ComfyUI)";
            revealBtn.style.cssText = "flex:0 0 92px;width:92px;height:20px;min-height:20px;cursor:pointer;padding:0 6px;background:#222;color:#ddd;border:1px solid #444;border-radius:3px;font-size:10px;line-height:18px;white-space:nowrap;";
            revealBtn.addEventListener("click", async (e) => {
                e.preventDefault();
                const asset = this._slimyFinalVideoAsset;
                if (!asset) return;
                try {
                    const res = await api.fetchApi("/slimy/cuetimer/reveal", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ filename: asset.filename, subfolder: asset.subfolder || "", type: asset.type || "output" }),
                    });
                    if (!res.ok) console.warn("[Slimy_CueTimer] reveal failed:", await res.text());
                } catch (err) {
                    console.warn("[Slimy_CueTimer] reveal failed:", err);
                }
            });
            btnRow.appendChild(revealBtn);

            const fileNameEl = document.createElement("div");
            fileNameEl.textContent = "";
            fileNameEl.style.cssText = "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#aaa;font-size:10px;line-height:20px;";
            btnRow.appendChild(fileNameEl);

            inner.appendChild(btnRow);

            const widget = this.addDOMWidget("slimy_final_video", "div", outer, {
                serialize: false,
                hideOnZoom: false,
                getHeight: () => 0,
                getMinHeight: () => 0,
            });
            widget.computeSize = () => [0, 0]; // LiteGraphの自動配置には任せず、onDrawForegroundで毎フレーム位置を上書きする
            widget.element = outer;

            // addDOMWidget が生成する外側ラッパーは、ノードの残り領域ぶんの
            // 透明な当たり判定を持つことがある。動画本体以外を掴めなくなるため、
            // ラッパー自身をゼロサイズ・クリック透過に固定する。
            const normalizeDomWidgetWrapper = () => {
                // outer.parentElement は ComfyUI が挿入する .h-full.w-full。
                // 実際にノード外まで当たり判定を持つのは、その外側の
                // .dom-widget.size-full なので、closest() で直接取得する。
                const wrapper = outer.closest?.(".dom-widget") || outer.parentElement?.parentElement;
                if (!wrapper) return;

                // ComfyUI が描画更新のたびに inline style を戻すため !important で固定。
                wrapper.style.setProperty("pointer-events", "none", "important");
                wrapper.style.setProperty("width", "0px", "important");
                wrapper.style.setProperty("height", "0px", "important");
                wrapper.style.setProperty("min-width", "0px", "important");
                wrapper.style.setProperty("min-height", "0px", "important");
                wrapper.style.setProperty("margin", "0", "important");
                wrapper.style.setProperty("padding", "0", "important");
                wrapper.style.setProperty("overflow", "visible", "important");

                // 中間ラッパーも当たり判定を持たせない。実際の動画領域 inner だけが
                // pointer-events:auto なので、動画コントロールはそのまま操作できる。
                const bridge = outer.parentElement;
                if (bridge && bridge !== wrapper) {
                    bridge.style.setProperty("pointer-events", "none", "important");
                    bridge.style.setProperty("width", "0px", "important");
                    bridge.style.setProperty("height", "0px", "important");
                    bridge.style.setProperty("overflow", "visible", "important");
                }
            };
            normalizeDomWidgetWrapper();
            requestAnimationFrame(normalizeDomWidgetWrapper);
            this._slimyNormalizeVideoWidgetWrapper = normalizeDomWidgetWrapper;

            this._slimyVideoWidget = widget;
            this._slimyVideoEl = video;
            this._slimyVideoFilenameEl = fileNameEl;
            this._slimyVideoWrapEl = inner; // 表示切替・位置合わせはこちら(pointer-events:auto側)に対して行う
            return widget;
        };

        nodeType.prototype._slimyClearFinalVideo = function () {
            this._slimyFinalVideoAsset = null;
            if (this._slimyVideoFilenameEl) {
                this._slimyVideoFilenameEl.textContent = "";
                this._slimyVideoFilenameEl.title = "";
            }
            if (this._slimyVideoEl) {
                try {
                    this._slimyVideoEl.pause();
                    this._slimyVideoEl.removeAttribute("src");
                    this._slimyVideoEl.load();
                } catch (e) { /* ignore */ }
            }
            if (this._slimyVideoWrapEl) this._slimyVideoWrapEl.style.display = "none";
        };

        nodeType.prototype._slimySetFinalVideo = function (asset) {
            this._slimyEnsureVideoWidget();

            // 動画が来たらstripアニメーションは止めて主役を譲る
            if (this._slimyFrameTimer) {
                clearInterval(this._slimyFrameTimer);
                this._slimyFrameTimer = null;
            }

            this._slimyFinalVideoAsset = asset;
            if (this._slimyVideoFilenameEl) {
                const fileName = asset?.filename || "";
                this._slimyVideoFilenameEl.textContent = fileName;
                this._slimyVideoFilenameEl.title = fileName;
            }
            this._slimyVideoEl.src = slimyBuildViewUrl(asset);
            if (this.properties.autoPlayEnabled !== false) {
                this._slimyVideoEl.play().catch(() => { /* 自動再生ブロック時はcontrolsから再生させる */ });
            }
            this._slimyVideoWrapEl.style.display = "flex";
            this.setDirtyCanvas(true, false);
        };

        // --- Canvas drawing ---
        nodeType.prototype.onDrawForeground = function (ctx) {
            const w = this.size[0];
            let h = this.size[1];
            const PAD       = 8;
            const SB_W      = 9;           // scrollbar width
            const showTimer = this.properties.timerVisible !== false;
            const showPeep  = this.properties.peepVisible !== false;

            const CB_SIZE_CONST  = 11;
            const CB_ROW_RESERVE = CB_SIZE_CONST + 10;  // チェックボックス行の高さ＋上下余白

            let TIMER_H, HIST_FONT_S, HIST_LINE_H, HIST_ROWS, HIST_H, BAR_AREA_H;

            if (showTimer) {
                // ── Main timer ──────────────────────────────────────────────
                // フォントサイズを横幅いっぱいになるよう決定し、TIMER_Hを逆算する
                const timerColor = this._running ? "#00ff22" : "#00ff22";
                const PAD_LR = 10;
                const maxW   = w - PAD_LR * 2;

                const chars  = this._timerStr.split("");
                const nDigit = chars.filter(c => c !== ":").length;
                const nSep   = chars.filter(c => c === ":").length;

                // 基準フォントサイズで幅を計測してスケールを求める
                const BASE_FONT = 100;
                ctx.save();
                ctx.font = `700 ${BASE_FONT}px "${FONT_FACE}", monospace`;
                const baseCellW = ctx.measureText("0").width * 1.05;
                const baseSepW  = ctx.measureText(":").width * 1.1;
                const baseTotal = nDigit * baseCellW + nSep * baseSepW;
                let fontSize = Math.max(12, BASE_FONT * (maxW / baseTotal));
                ctx.font = `700 ${fontSize}px "${FONT_FACE}", monospace`;

                const cellW = ctx.measureText("0").width * 1.05;
                const sepW  = ctx.measureText(":").width * 1.1;
                const totalW = nDigit * cellW + nSep * sepW;

                // フォント高さからTIMER_Hを決定（上下パディング込み）
                const TIMER_PAD_V = fontSize * 0.18;
                TIMER_H = Math.round(fontSize + TIMER_PAD_V * 2) + CB_ROW_RESERVE;
                HIST_FONT_S = 10;
                HIST_LINE_H = HIST_FONT_S * 1.3;
                HIST_ROWS   = 5;
                HIST_H      = Math.ceil(HIST_LINE_H * HIST_ROWS + PAD * 2);
                BAR_AREA_H  = 42;

                let cx = w / 2 - totalW / 2;
                ctx.fillStyle    = timerColor;
                ctx.textAlign    = "left";
                ctx.textBaseline = "middle";
                const cy = (TIMER_H - CB_ROW_RESERVE) / 2;  // 下マージンを除いた領域の中央
                chars.forEach(c => {
                    const cw = c === ":" ? sepW : cellW;
                    ctx.fillText(c, cx + (cw - ctx.measureText(c).width) / 2, cy);
                    cx += cw;
                });
                ctx.restore();
            } else {
                // Timer OFF: タイマー数字・履歴・進捗バーは非表示。チェックボックス行のみ確保
                TIMER_H    = CB_ROW_RESERVE;
                HIST_H     = 0;
                BAR_AREA_H = 0;
            }

            const DIVIDER_Y = TIMER_H;
            const BAR_Y     = DIVIDER_Y + HIST_H;
            const CONTENT_H = TIMER_H + HIST_H + BAR_AREA_H;

            // Timer ON/OFF切替時：増減した分だけノード高さを追従させ、Previewの高さは維持する
            if (this._prevShowTimer !== undefined && this._prevShowTimer !== showTimer && typeof this._prevContentH === "number") {
                const contentDelta = CONTENT_H - this._prevContentH;
                this.size[1] = Math.max(60, this.size[1] + contentDelta);
                h = this.size[1];
            }
            this._prevShowTimer = showTimer;
            this._prevContentH  = CONTENT_H;

            // ── Divider ─────────────────────────────────────────────────
            ctx.save();
            ctx.strokeStyle = "rgba(255,255,255,0.1)";
            ctx.lineWidth   = 1;
            ctx.beginPath();
            ctx.moveTo(0, DIVIDER_Y);
            ctx.lineTo(w, DIVIDER_Y);
            ctx.stroke();
            ctx.restore();

            // ── Notify checkboxes (4つ・ノード幅にあわせて縮小してフィット) ──
            const CB_LABELS   = ["systemNotify", "peepSound", "Timer", "Peep", "VRAM Clear", "AutoPlay"];
            const CB_COLORS   = ["#00ff22", "#4a9eff", "#f0a500", "#ff4fc4", "#ff6b3d", "#c084fc"];
            const CB_FILL     = {
                "#00ff22": "rgba(0,255,34,0.65)",
                "#4a9eff": "rgba(74,158,255,0.75)",
                "#f0a500": "rgba(240,165,0,0.8)",
                "#ff4fc4": "rgba(255,79,196,0.8)",
                "#ff6b3d": "rgba(255,107,61,0.8)",
                "#c084fc": "rgba(192,132,252,0.8)",
            };
            const CB_STATES   = [
                this.properties.notifyEnabled !== false,
                this.properties.peepNotifySound !== false,
                showTimer,
                showPeep,
                this.properties.vramCleanupEnabled !== false,
                this.properties.autoPlayEnabled !== false,
            ];

            // 基準サイズ（フル幅時）でラベル幅を計測し、必要な総幅を求める
            const CB_SIZE_BASE = CB_SIZE_CONST;
            const CB_FONT_BASE = 10;
            const CB_GAP_BASE  = 16;   // チェックボックス間の余白

            ctx.save();
            ctx.font = `500 ${CB_FONT_BASE}px sans-serif`;
            const labelWidthsBase = CB_LABELS.map(l => ctx.measureText(l).width);
            const stepsBase = labelWidthsBase.map(lw => CB_SIZE_BASE + 4 + lw);
            const naturalTotalW = stepsBase.reduce((a, b) => a + b, 0) + CB_GAP_BASE * (CB_LABELS.length - 1);

            // ノード幅に収まるよう縮小率を決定（最小0.5倍まで）
            const availableW = w - PAD * 2;
            const cbScale = Math.max(0.5, Math.min(1, availableW / naturalTotalW));

            const CB_SIZE = CB_SIZE_BASE * cbScale;
            const CB_GAP  = CB_GAP_BASE * cbScale;
            const CB_Y    = DIVIDER_Y - CB_ROW_RESERVE / 2 - CB_SIZE / 2;  // 下マージン帯の中央

            ctx.font = `500 ${CB_FONT_BASE * cbScale}px sans-serif`;
            ctx.textBaseline = "middle";
            const labelWidths = CB_LABELS.map(l => ctx.measureText(l).width);

            let cbX = PAD;
            const cbXs = [];
            labelWidths.forEach(lw => {
                cbXs.push(cbX);
                cbX += CB_SIZE + 4 * cbScale + lw + CB_GAP;
            });

            const drawCB = (x, checked, color, label) => {
                ctx.strokeStyle = checked ? color : "rgba(255,255,255,0.3)";
                ctx.lineWidth   = 1.5;
                ctx.beginPath();
                ctx.roundRect(x, CB_Y, CB_SIZE, CB_SIZE, 2);
                ctx.stroke();
                if (checked) {
                    ctx.strokeStyle = color;
                    ctx.lineWidth   = 2;
                    ctx.beginPath();
                    ctx.moveTo(x + 2 * cbScale,             CB_Y + CB_SIZE * 0.5);
                    ctx.lineTo(x + CB_SIZE * 0.4,            CB_Y + CB_SIZE - 2.5 * cbScale);
                    ctx.lineTo(x + CB_SIZE - 2 * cbScale,    CB_Y + 2.5 * cbScale);
                    ctx.stroke();
                }
                ctx.fillStyle = checked ? CB_FILL[color] : "rgba(255,255,255,0.25)";
                ctx.textAlign = "left";
                ctx.fillText(label, x + CB_SIZE + 4 * cbScale, CB_Y + CB_SIZE / 2);
            };

            CB_LABELS.forEach((label, i) => drawCB(cbXs[i], CB_STATES[i], CB_COLORS[i], label));

            ctx.restore();

            // ヒットエリアを保存
            const CB_HIT_PAD_X = 6;
            const CB_HIT_PAD_Y = 5;
            const cbHit = (x, labelW) => ({
                x: x - CB_HIT_PAD_X,
                y: CB_Y - CB_HIT_PAD_Y,
                w: CB_SIZE + 4 * cbScale + labelW + CB_HIT_PAD_X * 2,
                h: CB_SIZE + CB_HIT_PAD_Y * 2
            });
            this._cbRect        = cbHit(cbXs[0], labelWidths[0]);
            this._peepCbRect    = cbHit(cbXs[1], labelWidths[1]);
            this._timerVisCbRect = cbHit(cbXs[2], labelWidths[2]);
            this._peepVisCbRect  = cbHit(cbXs[3], labelWidths[3]);
            this._vramCbRect     = cbHit(cbXs[4], labelWidths[4]);
            this._autoPlayCbRect = cbHit(cbXs[5], labelWidths[5]);

            // ── History area ─────────────────────────────────────────────
            if (showTimer) {
            const hist      = this.properties.history || [];
            const histFontS = HIST_FONT_S;
            const lineH     = HIST_LINE_H;
            const totalH    = hist.length * lineH;
            const visibleH  = HIST_H - PAD * 2;
            this._histLineH = lineH;

            // Clamp scroll
            this._scrollOffset = Math.max(0, Math.min(this._scrollOffset, Math.max(0, totalH - visibleH)));

            ctx.save();
            ctx.beginPath();
            ctx.rect(0, DIVIDER_Y, w, HIST_H);
            ctx.clip();

            ctx.textBaseline = "middle";
            ctx.textAlign    = "left";

            hist.forEach((entry, i) => {
                const y = DIVIDER_Y + PAD + lineH * i + lineH / 2 - this._scrollOffset;
                if (y < DIVIDER_Y - lineH || y > DIVIDER_Y + HIST_H + lineH) return;
                const timeStr   = typeof entry === "object" ? entry.time  : entry;
                const stamp     = typeof entry === "object" ? entry.stamp : null;
                const entryType = typeof entry === "object" ? entry.type  : "done";
                const isError   = entryType === "error";
                const HIST_SCROLL_BTN_SIZE = 13;
                const HIST_SCROLL_BTN_GAP  = 5;
                const histRightClearance = this._sbTrack
                    ? (SB_W + 4 + HIST_SCROLL_BTN_SIZE + HIST_SCROLL_BTN_GAP + 4)
                    : 0;
                const rightEdge = w - PAD - histRightClearance;

                const histColor = isError
                    ? (i === 0 ? "rgba(255,80,80,0.85)" : i === 1 ? "rgba(255,80,80,0.55)" : "rgba(255,80,80,0.35)")
                    : (i === 0 ? "rgba(0,255,34,0.8)"   : i === 1 ? "rgba(0,255,34,0.5)"   : "rgba(0,255,34,0.3)");
                const stampAlpha = i === 0 ? 0.45 : i === 1 ? 0.28 : i === 2 ? 0.18 : 0.12;

                // タイム（等幅フォント）＋末尾マーク
                ctx.font      = `600 ${histFontS}px monospace`;
                ctx.fillStyle = histColor;
                ctx.textAlign = "left";
                const displayStr = isError ? timeStr + " ⚠" : timeStr;
                ctx.fillText(displayStr, PAD, y);

                if (stamp) {
                    ctx.fillStyle = isError
                        ? `rgba(255,80,80,${stampAlpha})`
                        : `rgba(0,255,34,${stampAlpha})`;
                    ctx.textAlign = "right";
                    ctx.fillText(stamp, rightEdge, y);
                }
            });

            // Scrollbar (only when content overflows)
            if (totalH > visibleH) {
                const BTN_SIZE = 13;
                const trackX = w - SB_W - 2;
                const trackY = DIVIDER_Y + PAD;
                const trackH = visibleH;
                const thumbH = Math.max(20, trackH * (visibleH / totalH));
                const thumbY = trackY + (this._scrollOffset / (totalH - visibleH)) * (trackH - thumbH);

                ctx.fillStyle = "rgba(255,255,255,0.06)";
                ctx.beginPath();
                ctx.roundRect(trackX, trackY, SB_W, trackH, 4);
                ctx.fill();

                ctx.fillStyle = this._isDraggingScrollbar
                    ? "rgba(255,255,255,0.55)"
                    : "rgba(255,255,255,0.28)";
                ctx.beginPath();
                ctx.roundRect(trackX, thumbY, SB_W, thumbH, 4);
                ctx.fill();

                const btnX = trackX - BTN_SIZE - 5;
                const upY = trackY;
                const dnY = trackY + trackH - BTN_SIZE;
                const drawHistButton = (y, mark, enabled) => {
                    ctx.fillStyle = enabled ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.035)";
                    ctx.strokeStyle = enabled ? "rgba(255,255,255,0.26)" : "rgba(255,255,255,0.08)";
                    ctx.beginPath();
                    ctx.roundRect(btnX, y, BTN_SIZE, BTN_SIZE, 3);
                    ctx.fill();
                    ctx.stroke();
                    ctx.fillStyle = enabled ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.16)";
                    ctx.font = "10px monospace";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText(mark, btnX + BTN_SIZE / 2, y + BTN_SIZE / 2);
                };
                drawHistButton(upY, "▲", this._scrollOffset > 0);
                drawHistButton(dnY, "▼", this._scrollOffset < totalH - visibleH);

                // Store for hit-test
                this._sbTrack = { x: trackX, y: trackY, w: SB_W, h: trackH };
                this._sbThumb = { y: thumbY, h: thumbH };
                this._sbMeta  = { totalH, visibleH, trackH, thumbH };
                this._histUpRect = { x: btnX, y: upY, w: BTN_SIZE, h: BTN_SIZE };
                this._histDownRect = { x: btnX, y: dnY, w: BTN_SIZE, h: BTN_SIZE };
            } else {
                this._sbTrack = null;
                this._histUpRect = null;
                this._histDownRect = null;
            }

            ctx.restore();
            } else {
                this._sbTrack = null;
                this._histUpRect = null;
                this._histDownRect = null;
                this._histLineH = 0;
            }

            // ── Progress bars area (always visible under history) ───────
            if (showTimer) {
            const BAR_X = PAD;
            const BAR_W = w - PAD * 2;
            const barX = BAR_X + 8;
            const barW = BAR_W - 16;
            const barH = 8;
            const stepPct = PeepState.samplerTotal > 0 ? PeepState.samplerStep / PeepState.samplerTotal : 0;
            const nodePct = slimyGetNodeProgressPct();

            const drawBar = (label, y, pct, text) => {
                ctx.font = "10px monospace";
                ctx.fillStyle = "#aaa";
                ctx.textAlign = "left";
                ctx.textBaseline = "middle";
                ctx.fillText(label, barX, y + barH / 2);

                const tx = barX + 48;
                const tw = barW - 88;
                ctx.fillStyle = "#2a2a2a";
                ctx.beginPath();
                ctx.roundRect(tx, y, tw, barH, 4);
                ctx.fill();

                ctx.fillStyle = label === "Steps" ? "#4a9eff" : "#a855f7";
                ctx.beginPath();
                ctx.roundRect(tx, y, Math.max(0, Math.min(tw, tw * pct)), barH, 4);
                ctx.fill();

                ctx.fillStyle = "#666";
                ctx.textAlign = "right";
                ctx.fillText(text, barX + barW, y + barH / 2);
            };

            ctx.save();
            ctx.fillStyle = "#0d0d0d";
            ctx.strokeStyle = "rgba(255,255,255,0.08)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.roundRect(BAR_X, BAR_Y + 5, BAR_W, BAR_AREA_H - 10, 5);
            ctx.fill();
            ctx.stroke();
            drawBar("Steps", BAR_Y + 10, stepPct, PeepState.samplerTotal > 0 ? `${PeepState.samplerStep}/${PeepState.samplerTotal}` : "—");
            drawBar("Total", BAR_Y + 26, nodePct, `${Math.round(nodePct * 100)}%`);
            ctx.restore();
            }

            // ── PeepPreview area ───────────────────────────────────────
            const PREVIEW_Y = CONTENT_H + 6;
            const PREVIEW_H = Math.max(90, h - PREVIEW_Y - PAD);
            const PREVIEW_X = PAD;
            const PREVIEW_W = w - PAD * 2;

            const showPreview = showPeep;

            if (showPreview) {
                this._slimyPreviewRect = { x: PREVIEW_X, y: PREVIEW_Y, w: PREVIEW_W, h: PREVIEW_H };

                // Timerが非表示の間は数字が無いため、動作中は枠線を発光させて稼働状況を示す
                const glowActive = !showTimer && showPeep && this._running;

                ctx.save();
                ctx.fillStyle = "#111";
                if (glowActive) {
                    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 350);
                    ctx.shadowColor = `rgba(0,255,90,${0.55 + pulse * 0.35})`;
                    ctx.shadowBlur  = 10 + pulse * 16;
                    ctx.strokeStyle = `rgba(60,255,120,${0.7 + pulse * 0.3})`;
                    ctx.lineWidth = 2;
                } else {
                    ctx.strokeStyle = "rgba(0,255,34,0.22)";
                    ctx.lineWidth = 1;
                }
                ctx.beginPath();
                ctx.roundRect(PREVIEW_X, PREVIEW_Y, PREVIEW_W, PREVIEW_H, 6);
                ctx.fill();
                ctx.stroke();
                ctx.shadowBlur = 0;
                ctx.shadowColor = "transparent";

                const imgY = PREVIEW_Y + 8;
                const imgH = Math.max(24, PREVIEW_H - 16);
                const imgX = PREVIEW_X + 6;
                const imgW = PREVIEW_W - 12;

                ctx.fillStyle = "#151515";
                ctx.beginPath();
                ctx.roundRect(imgX, imgY, imgW, imgH, 5);
                ctx.fill();

                const hasFinalVideo = !!this._slimyFinalVideoAsset;
                const img = this._slimyPreviewImage;

                if (hasFinalVideo && this._slimyVideoWrapEl) {
                    // 実DOMのvideo要素をこの領域にぴったり重ねる(controls標準搭載＝
                    // シークバー・再生時間・全画面ボタンが自動で付く)。
                    const el = this._slimyVideoWrapEl;
                    // ComfyUI側がリサイズ時にDOMラッパーの寸法を戻す場合があるため、
                    // 描画ごとにゼロサイズ・クリック透過を再適用する。
                    this._slimyNormalizeVideoWidgetWrapper?.();
                    // addDOMWidget の基準点はノード左上ではなく、
                    // 横10pxの標準マージン + widget.y の位置に置かれる。
                    // imgX/imgY はノード左上基準なので、その基準差を明示的に差し引く。
                    const widgetY = Number(this._slimyVideoWidget?.y) || 0;
                    const widgetMarginX = 10;
                    el.style.display = "flex";
                    el.style.left    = `${imgX - widgetMarginX}px`;
                    el.style.top     = `${imgY - widgetY}px`;
                    el.style.width   = `${imgW}px`;
                    el.style.height  = `${imgH}px`;
                } else if (img && img.complete && img.naturalWidth > 0) {
                    // 複数フレームのストリップ画像から現在のコマだけを切り出して表示
                    const frameCount = this._slimyFrameCount || 1;
                    const frameIndex = frameCount > 1 ? (this._slimyFrameIndex || 0) % frameCount : 0;
                    const srcFrameW  = img.naturalWidth / frameCount;
                    const srcFrameH  = img.naturalHeight;
                    const srcX       = frameIndex * srcFrameW;

                    const scale = Math.min(imgW / srcFrameW, imgH / srcFrameH);
                    const dw = srcFrameW * scale;
                    const dh = srcFrameH * scale;
                    const dx = imgX + (imgW - dw) / 2;
                    const dy = imgY + (imgH - dh) / 2;
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = "high";
                    ctx.drawImage(img, srcX, 0, srcFrameW, srcFrameH, dx, dy, dw, dh);
                } else {
                    ctx.font = "12px monospace";
                    ctx.fillStyle = "rgba(0,255,34,0.35)";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText("Peeping...", w / 2, imgY + imgH / 2);
                }
                ctx.restore();

                // プレビューON時のノード高さ確保
                if (this.size[1] < PREVIEW_Y + 100) {
                    this.size[1] = this._savedPreviewHeight || PREVIEW_Y + 100;
                    this._savedPreviewHeight = null;
                }
            } else {
                this._slimyPreviewRect = null;
                if (this._slimyVideoWrapEl) this._slimyVideoWrapEl.style.display = "none";
                // プレビューOFF時：現在のサイズを記憶してコンパクトに縮小
                const compactH = CONTENT_H + PAD * 2;
                if (this.size[1] > compactH) {
                    this._savedPreviewHeight = this.size[1];
                    this.size[1] = compactH;
                }
            }
        };

        // --- Mouse wheel: let LiteGraph handle it (zoom/pan default) ---
        // We intentionally do NOT override onMouseWheel so ComfyUI keeps zoom.

        // --- Scrollbar drag ─────────────────────────────────────────────
        nodeType.prototype.onMouseDown = function (e, pos) {
            const [mx, my] = pos;

            // チェックボックスのクリック判定
            if (this._cbRect) {
                const { x, y, w, h } = this._cbRect;
                if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
                    this.properties.notifyEnabled = !this.properties.notifyEnabled;
                    if (this.properties.notifyEnabled) SlimyNotify.requestPermission();
                    this.setDirtyCanvas(true, false);
                    return true;
                }
            }

            if (this._peepCbRect) {
                const { x, y, w, h } = this._peepCbRect;
                if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
                    this.properties.peepNotifySound = this.properties.peepNotifySound === false;
                    this._slimyNotifySound = this.properties.peepNotifySound !== false;
                    this.setDirtyCanvas(true, false);
                    return true;
                }
            }

            if (this._timerVisCbRect) {
                const { x, y, w, h } = this._timerVisCbRect;
                if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
                    this.properties.timerVisible = this.properties.timerVisible === false;
                    this.setDirtyCanvas(true, false);
                    return true;
                }
            }

            if (this._peepVisCbRect) {
                const { x, y, w, h } = this._peepVisCbRect;
                if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
                    this.properties.peepVisible = this.properties.peepVisible === false;
                    this.setDirtyCanvas(true, false);
                    return true;
                }
            }

            if (this._vramCbRect) {
                const { x, y, w, h } = this._vramCbRect;
                if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
                    this.properties.vramCleanupEnabled = this.properties.vramCleanupEnabled === false;
                    this.setDirtyCanvas(true, false);
                    return true;
                }
            }

            if (this._autoPlayCbRect) {
                const { x, y, w, h } = this._autoPlayCbRect;
                if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
                    this.properties.autoPlayEnabled = this.properties.autoPlayEnabled === false;
                    this.setDirtyCanvas(true, false);
                    return true;
                }
            }

            const scrollOneHistoryLine = (dir) => {
                if (!this._sbMeta) return false;
                const { totalH, visibleH } = this._sbMeta;
                const scrollRange = Math.max(0, totalH - visibleH);
                const step = this._histLineH || 13;
                this._scrollOffset = Math.max(0, Math.min(scrollRange, this._scrollOffset + dir * step));
                this.setDirtyCanvas(true, false);
                return true;
            };

            if (this._histUpRect) {
                const { x, y, w, h } = this._histUpRect;
                if (mx >= x && mx <= x + w && my >= y && my <= y + h) return scrollOneHistoryLine(-1);
            }

            if (this._histDownRect) {
                const { x, y, w, h } = this._histDownRect;
                if (mx >= x && mx <= x + w && my >= y && my <= y + h) return scrollOneHistoryLine(1);
            }

            if (!this._sbTrack) return false;
            const { x, y, w, h } = this._sbTrack;
            if (mx < x || mx > x + w || my < y || my > y + h) return false;

            // Click on thumb → drag; click on track → jump
            const { y: ty, h: th } = this._sbThumb;
            const { totalH, visibleH, trackH, thumbH } = this._sbMeta;
            const scrollRange = totalH - visibleH;

            if (my >= ty && my <= ty + th) {
                // Drag thumb
                this._isDraggingScrollbar = true;
                this._dragStartY    = my;
                this._dragStartScroll = this._scrollOffset;
            } else {
                // Jump to click position
                const ratio = (my - y - thumbH / 2) / (trackH - thumbH);
                this._scrollOffset = Math.max(0, Math.min(scrollRange, ratio * scrollRange));
            }
            this.setDirtyCanvas(true, false);
            return true;
        };

        nodeType.prototype.onMouseMove = function (e, pos) {
            if (!this._isDraggingScrollbar || !this._sbMeta) return false;
            const [, my] = pos;
            const { totalH, visibleH, trackH, thumbH } = this._sbMeta;
            const scrollRange = totalH - visibleH;
            const delta = my - this._dragStartY;
            const ratio = delta / (trackH - thumbH);
            this._scrollOffset = Math.max(0, Math.min(scrollRange, this._dragStartScroll + ratio * scrollRange));
            this.setDirtyCanvas(true, false);
            return true;
        };

        nodeType.prototype.onMouseUp = function () {
            if (!this._isDraggingScrollbar) return false;
            this._isDraggingScrollbar = false;
            this.setDirtyCanvas(true, false);
            return true;
        };

        // --- Serialize / Configure ---
        nodeType.prototype.onRemoved = function () {
            GlobalTimer.unregisterNode(this);
            if (this._slimyFrameTimer) {
                clearInterval(this._slimyFrameTimer);
                this._slimyFrameTimer = null;
            }
            this._slimyVideoPointerCleanup?.();
            this._slimyVideoPointerCleanup = null;
            this._slimyPreviewImage = null;
            this._slimyClearFinalVideo?.();
            origRemoved?.apply(this, arguments);
        };

        nodeType.prototype.onSerialize = function (o) {
            origSerialize?.apply(this, arguments);
            o.properties = this.properties;
        };

        nodeType.prototype.onConfigure = function (info) {
            origConfigure?.apply(this, arguments);
            this.properties  = info.properties || {};
            this._timerStr   = this.properties.elapsed_time_str || "00:00:000";
            this._scrollOffset = 0;
            if (this.properties.notifyEnabled === undefined) this.properties.notifyEnabled = true;
            if (this.properties.peepNotifySound === undefined) this.properties.peepNotifySound = true;
            if (this.properties.vramCleanupEnabled === undefined) this.properties.vramCleanupEnabled = true;
            if (this.properties.autoPlayEnabled === undefined) this.properties.autoPlayEnabled = true;
            if (this.properties.timerVisible === undefined) {
                this.properties.timerVisible = this.properties.peepOnly === true ? false : true;
            }
            if (this.properties.peepVisible === undefined) {
                this.properties.peepVisible = this.properties.peepPreview !== false;
            }
            this._slimyNotifySound = this.properties.peepNotifySound !== false;
        };
    },

    setup() {
        // Load Orbitron font
        if (!document.getElementById(FONT_ID)) {
            const link = document.createElement("link");
            link.id   = FONT_ID;
            link.rel  = "stylesheet";
            link.href = "https://fonts.googleapis.com/css2?family=Orbitron:wght@700&display=swap";
            document.head.appendChild(link);
        }

        let eventsBound = false;
        if (!eventsBound) {
            eventsBound = true;
            api.addEventListener("execution_start",       ({ detail }) => {
                SlimyNotify.requestPermission();
                PeepState.nodesDone = 0;
                PeepState.nodesTotal = 0;
                PeepState.samplerStep = 0;
                PeepState.samplerTotal = 0;
                PeepState.customPreviewActive = false;
                PeepState.frameCount = 1;
                PeepState.currentPromptId = detail?.prompt_id ?? null;
                PeepState.finalVideo = null;
                PeepState.pendingFinalVideo = null;
                const nodes = app.graph?._nodes?.filter(n => n.type === "Slimy_CueTimer") || [];
                PeepState.predictedTotalMs = slimyEstimateTotalMsFromHistory(nodes);
                for (const node of nodes) {
                    if (node._slimyFrameTimer) {
                        clearInterval(node._slimyFrameTimer);
                        node._slimyFrameTimer = null;
                    }
                    node._slimyPreviewImage = null;
                    node._slimyFrameCount = 1;
                    node._slimyFrameIndex = 0;
                    node._slimyClearFinalVideo?.();
                    node.setDirtyCanvas(true, true);
                }
                GlobalTimer.start();
            });
            api.addEventListener("executing",             ({ detail }) => {
                if (detail === null) {
                    const previewNodes = app.graph?._nodes?.filter(n => n.type === "Slimy_CueTimer") || [];
                    for (const node of previewNodes) {
                        if (node._slimyFrameTimer) {
                            clearInterval(node._slimyFrameTimer);
                            node._slimyFrameTimer = null;
                        }
                    }
                    // 実行中に検出した動画は、キュー完了後にだけ表示する。
                    if (PeepState.pendingFinalVideo) {
                        PeepState.finalVideo = PeepState.pendingFinalVideo;
                        for (const node of previewNodes) node._slimySetFinalVideo?.(PeepState.finalVideo);
                    }
                    PeepState.pendingFinalVideo = null;

                    PeepState.nodesDone = 0;
                    PeepState.nodesTotal = 0;
                    PeepState.samplerStep = 0;
                    PeepState.samplerTotal = 0;
                    PeepState.predictedTotalMs = 0;
                    GlobalTimer.stop("done");

                    // タイマー停止後にVRAMクリアを実行(いずれかのノードで有効な場合のみ)
                    slimyMaybeClearVRAM();
                } else {
                    PeepState.nodesDone += 1;
                    if (PeepState.nodesTotal === 0) PeepState.nodesTotal = app.graph?._nodes?.length ?? 1;
                    if (PeepState.nodesDone > PeepState.nodesTotal) PeepState.nodesTotal = PeepState.nodesDone;
                }
                const nodes = app.graph?._nodes?.filter(n => n.type === "Slimy_CueTimer") || [];
                for (const node of nodes) node.setDirtyCanvas(true, false);
            });
            api.addEventListener("execution_error",       ()           => { PeepState.pendingFinalVideo = null; PeepState.predictedTotalMs = 0; GlobalTimer.stop("error"); slimyMaybeClearVRAM(); });
            api.addEventListener("execution_interrupted", ()           => { PeepState.pendingFinalVideo = null; PeepState.predictedTotalMs = 0; GlobalTimer.stop("error"); slimyMaybeClearVRAM(); });

            // CueTimer専用の近傍フレームアニメーションを受信してループ再生する。
            // KSampler標準b_previewはCueTimerへ表示せず、KSampler本体だけに任せる。
            api.addEventListener("slimy_peep_preview", ({ detail }) => {
                const src = detail?.image;
                if (typeof src !== "string" || !src) return;
                PeepState.customPreviewActive = true;

                const frameCount = Math.max(1, Number(detail?.frames) || 1);
                const img = new Image();
                img.onload = () => {
                    const nodes = app.graph?._nodes?.filter(n => n.type === "Slimy_CueTimer") || [];
                    for (const node of nodes) {
                        node._slimyPreviewImage = img;
                        node._slimyFrameCount = frameCount;
                        node._slimyFrameIndex = 0;
                        node._slimyEndHoldTicks = 0;

                        if (node._slimyFrameTimer) clearInterval(node._slimyFrameTimer);
                        node._slimyFrameTimer = null;

                        if (frameCount > 1 && GlobalTimer.isRunning) {
                            node._slimyFrameTimer = setInterval(() => {
                                if (!GlobalTimer.isRunning) {
                                    clearInterval(node._slimyFrameTimer);
                                    node._slimyFrameTimer = null;
                                    return;
                                }
                                const lastFrameIndex = frameCount - 1;
                                if (node._slimyFrameIndex >= lastFrameIndex) {
                                    node._slimyEndHoldTicks = (node._slimyEndHoldTicks || 0) + 1;
                                    if (node._slimyEndHoldTicks >= PEEP_PREVIEW_END_HOLD_FRAMES) {
                                        node._slimyFrameIndex = 0;
                                        node._slimyEndHoldTicks = 0;
                                    }
                                } else {
                                    node._slimyFrameIndex += 1;
                                    node._slimyEndHoldTicks = 0;
                                }
                                node.setDirtyCanvas(true, false);
                            }, PEEP_PREVIEW_FRAME_MS);
                        }

                        if (node.properties.peepNotifySound !== false) playPeepPreviewBeep();
                        node.setDirtyCanvas(true, true);
                    }
                };
                img.src = src;
            });

            // 静止画ワークフローでは slimy_peep_preview が来ないため、
            // KSampler標準の1コマ Latent Preview をフォールバックとして受信する。
            // 動画用の近傍フレームプレビューが一度でも来た実行では、そちらを優先する。
            api.addEventListener("b_preview", ({ detail }) => {
                if (PeepState.customPreviewActive) return;
                const blob = detail instanceof Blob ? detail : null;
                if (!blob) return;

                const objectUrl = URL.createObjectURL(blob);
                const img = new Image();
                img.onload = () => {
                    URL.revokeObjectURL(objectUrl);
                    const nodes = app.graph?._nodes?.filter(n => n.type === "Slimy_CueTimer") || [];
                    for (const node of nodes) {
                        if (node._slimyFrameTimer) clearInterval(node._slimyFrameTimer);
                        node._slimyFrameTimer = null;
                        node._slimyPreviewImage = img;
                        node._slimyFrameCount = 1;
                        node._slimyFrameIndex = 0;
                        node._slimyEndHoldTicks = 0;
                        node.setDirtyCanvas(true, true);
                    }
                };
                img.onerror = () => URL.revokeObjectURL(objectUrl);
                img.src = objectUrl;
            });

            api.addEventListener("progress", ({ detail }) => {
                PeepState.samplerStep  = detail.value ?? 0;
                PeepState.samplerTotal = detail.max   ?? 0;
                const nodes = app.graph?._nodes?.filter(n => n.type === "Slimy_CueTimer") || [];
                for (const node of nodes) node.setDirtyCanvas(true, false);
            });

            // Upscaleサブツリーなどで動画保存ノードが複数あっても、
            // 実行順(トポロジカル順)で最後に検出された output タイプの動画を「最終成果物」として採用する。
            api.addEventListener("executed", ({ detail }) => {
                if (detail?.prompt_id && detail.prompt_id !== PeepState.currentPromptId) return; // 別ランのイベントは無視

                const assets = slimyExtractVideoAssets(detail?.output);
                if (assets.length === 0) return;

                const chosen = assets.find(a => a.type === "output") || assets[assets.length - 1];

                // 実行途中では表示せず、最後に検出した候補だけ保持する。
                PeepState.pendingFinalVideo = chosen;
            });
        }
    },
};

app.registerExtension(SlimyCueTimerExtension);
