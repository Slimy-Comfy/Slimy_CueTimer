import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const FONT_ID    = "slimy-cue-timer-font";
const FONT_FACE  = "Orbitron";
const MAX_HISTORY = 100;
const PREDICT_HISTORY_COUNT = 5;
const PREDICT_MIN_VALID_MS = 15000;
const PREDICT_MAX_PCT = 0.98;

const PeepState = {
    samplerStep: 0,
    samplerTotal: 0,
    nodesDone: 0,
    nodesTotal: 0,
    predictedTotalMs: 0,
};

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
            this._slimyNotifySound = this.properties.peepNotifySound !== false;
            if (this.properties.notifyEnabled === undefined) this.properties.notifyEnabled = true;
            if (this.properties.peepNotifySound === undefined) this.properties.peepNotifySound = true;
            if (this.properties.peepPreview === undefined) this.properties.peepPreview = true;

            GlobalTimer.registerNode(this);
        };

        // --- Canvas drawing ---
        nodeType.prototype.onDrawForeground = function (ctx) {
            const [w, h] = this.size;
            const PAD       = 8;
            const SB_W      = 9;           // scrollbar width

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
            const TIMER_PAD_V   = fontSize * 0.18;
            const CB_SIZE_CONST = 11;
            const TIMER_BOT_PAD = CB_SIZE_CONST + 10;  // チェックボックス高さ＋上下余白
            const TIMER_H   = Math.round(fontSize + TIMER_PAD_V * 2) + TIMER_BOT_PAD;
            const HIST_FONT_S = 10;
            const HIST_LINE_H = HIST_FONT_S * 1.3;
            const HIST_ROWS   = 5;
            const HIST_H      = Math.ceil(HIST_LINE_H * HIST_ROWS + PAD * 2);
            const BAR_AREA_H  = 42;
            const DIVIDER_Y   = TIMER_H;
            const BAR_Y       = DIVIDER_Y + HIST_H;
            const CONTENT_H   = TIMER_H + HIST_H + BAR_AREA_H;

            let cx = w / 2 - totalW / 2;
            ctx.fillStyle    = timerColor;
            ctx.textAlign    = "left";
            ctx.textBaseline = "middle";
            const cy = (TIMER_H - TIMER_BOT_PAD) / 2;  // 下マージンを除いた領域の中央
            chars.forEach(c => {
                const cw = c === ":" ? sepW : cellW;
                ctx.fillText(c, cx + (cw - ctx.measureText(c).width) / 2, cy);
                cx += cw;
            });
            ctx.restore();

            // ── Divider ─────────────────────────────────────────────────
            ctx.save();
            ctx.strokeStyle = "rgba(255,255,255,0.1)";
            ctx.lineWidth   = 1;
            ctx.beginPath();
            ctx.moveTo(0, DIVIDER_Y);
            ctx.lineTo(w, DIVIDER_Y);
            ctx.stroke();
            ctx.restore();

            // ── Notify checkboxes (3つ・左寄せ等間隔) ──────────────────
            const CB_SIZE  = CB_SIZE_CONST;
            const CB_Y     = DIVIDER_Y - TIMER_BOT_PAD / 2 - CB_SIZE / 2;  // 下マージン帯の中央
            const CB_GAP   = 16;   // チェックボックス間の余白

            ctx.save();
            ctx.font         = `500 10px sans-serif`;
            ctx.textBaseline = "middle";

            // ラベル幅を事前計測して等間隔のステップ幅を決める
            const label0 = "systemNotify";
            const label1 = "peepSound";
            const label2 = "peepPreview";
            const labelW0 = ctx.measureText(label0).width;
            const labelW1 = ctx.measureText(label1).width;
            const CB_STEP  = Math.max(CB_SIZE + 4 + labelW0, CB_SIZE + 4 + labelW1) + CB_GAP;

            const CB_X0 = PAD;
            const CB_X1 = CB_X0 + CB_STEP;
            const CB_X2 = CB_X1 + CB_STEP;

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
                    ctx.moveTo(x + 2,              CB_Y + CB_SIZE * 0.5);
                    ctx.lineTo(x + CB_SIZE * 0.4,  CB_Y + CB_SIZE - 2.5);
                    ctx.lineTo(x + CB_SIZE - 2,    CB_Y + 2.5);
                    ctx.stroke();
                }
                ctx.fillStyle = checked
                    ? color.replace(")", ", 0.75)").replace("rgb(", "rgba(").replace(/^#/, "")
                    : "rgba(255,255,255,0.25)";
                // hex色はそのまま透明度付きで出せないのでfillStyleを直接指定
                ctx.fillStyle = checked
                    ? (color === "#00ff22" ? "rgba(0,255,34,0.65)"
                    :  color === "#4a9eff" ? "rgba(74,158,255,0.75)"
                    :                        "rgba(240,165,0,0.8)")
                    : "rgba(255,255,255,0.25)";
                ctx.textAlign = "left";
                ctx.fillText(label, x + CB_SIZE + 4, CB_Y + CB_SIZE / 2);
            };

            const enabled         = this.properties.notifyEnabled !== false;
            const peepEnabledTop  = this.properties.peepNotifySound !== false;
            const peepPreviewEnabled = this.properties.peepPreview !== false;

            drawCB(CB_X0, enabled,         "#00ff22", label0);
            drawCB(CB_X1, peepEnabledTop,  "#4a9eff", label1);
            drawCB(CB_X2, peepPreviewEnabled, "#f0a500", label2);

            ctx.restore();

            // ヒットエリアを保存
            const CB_HIT_PAD_X = 6;
            const CB_HIT_PAD_Y = 5;
            const cbHit = (x, labelW) => ({
                x: x - CB_HIT_PAD_X,
                y: CB_Y - CB_HIT_PAD_Y,
                w: CB_SIZE + 4 + labelW + CB_HIT_PAD_X * 2,
                h: CB_SIZE + CB_HIT_PAD_Y * 2
            });
            this._cbRect        = cbHit(CB_X0, labelW0);
            this._peepCbRect    = cbHit(CB_X1, labelW1);
            this._previewCbRect = cbHit(CB_X2, ctx.measureText(label2).width);

            // ── History area ─────────────────────────────────────────────
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

            // ── Progress bars area (always visible under history) ───────
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

            // ── PeepPreview area ───────────────────────────────────────
            const PREVIEW_Y = CONTENT_H + 6;
            const PREVIEW_H = Math.max(90, h - PREVIEW_Y - PAD);
            const PREVIEW_X = PAD;
            const PREVIEW_W = w - PAD * 2;

            if (this.properties.peepPreview !== false) {
                this._slimyPreviewRect = { x: PREVIEW_X, y: PREVIEW_Y, w: PREVIEW_W, h: PREVIEW_H };

                ctx.save();
                ctx.fillStyle = "#111";
                ctx.strokeStyle = "rgba(0,255,34,0.22)";
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.roundRect(PREVIEW_X, PREVIEW_Y, PREVIEW_W, PREVIEW_H, 6);
                ctx.fill();
                ctx.stroke();

                const imgY = PREVIEW_Y + 8;
                const imgH = Math.max(24, PREVIEW_H - 16);
                const imgX = PREVIEW_X + 6;
                const imgW = PREVIEW_W - 12;

                ctx.fillStyle = "#151515";
                ctx.beginPath();
                ctx.roundRect(imgX, imgY, imgW, imgH, 5);
                ctx.fill();

                const img = this._slimyPreviewImage;
                if (img && img.complete && img.naturalWidth > 0) {
                    const scale = Math.min(imgW / img.naturalWidth, imgH / img.naturalHeight);
                    const dw = img.naturalWidth * scale;
                    const dh = img.naturalHeight * scale;
                    const dx = imgX + (imgW - dw) / 2;
                    const dy = imgY + (imgH - dh) / 2;
                    ctx.imageSmoothingEnabled = false;
                    ctx.drawImage(img, dx, dy, dw, dh);
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

            if (this._previewCbRect) {
                const { x, y, w, h } = this._previewCbRect;
                if (mx >= x && mx <= x + w && my >= y && my <= y + h) {
                    this.properties.peepPreview = this.properties.peepPreview === false ? true : false;
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
            if (this.properties.peepPreview === undefined) this.properties.peepPreview = true;
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
            api.addEventListener("execution_start",       ()           => {
                SlimyNotify.requestPermission();
                PeepState.nodesDone = 0;
                PeepState.nodesTotal = 0;
                PeepState.samplerStep = 0;
                PeepState.samplerTotal = 0;
                const nodes = app.graph?._nodes?.filter(n => n.type === "Slimy_CueTimer") || [];
                PeepState.predictedTotalMs = slimyEstimateTotalMsFromHistory(nodes);
                GlobalTimer.start();
            });
            api.addEventListener("executing",             ({ detail }) => {
                if (detail === null) {
                    PeepState.nodesDone = 0;
                    PeepState.nodesTotal = 0;
                    PeepState.samplerStep = 0;
                    PeepState.samplerTotal = 0;
                    PeepState.predictedTotalMs = 0;
                    GlobalTimer.stop("done");
                } else {
                    PeepState.nodesDone += 1;
                    if (PeepState.nodesTotal === 0) PeepState.nodesTotal = app.graph?._nodes?.length ?? 1;
                    if (PeepState.nodesDone > PeepState.nodesTotal) PeepState.nodesTotal = PeepState.nodesDone;
                }
                const nodes = app.graph?._nodes?.filter(n => n.type === "Slimy_CueTimer") || [];
                for (const node of nodes) node.setDirtyCanvas(true, false);
            });
            api.addEventListener("execution_error",       ()           => { PeepState.predictedTotalMs = 0; GlobalTimer.stop("error"); });
            api.addEventListener("execution_interrupted", ()           => { PeepState.predictedTotalMs = 0; GlobalTimer.stop("error"); });

            api.addEventListener("b_preview", ({ detail }) => {
                if (!(detail instanceof Blob)) return;
                const url = URL.createObjectURL(detail);
                const img = new Image();
                img.onload = () => {
                    const nodes = app.graph?._nodes?.filter(n => n.type === "Slimy_CueTimer") || [];
                    for (const node of nodes) {
                        node._slimyPreviewImage = img;
                        if (node.properties.peepNotifySound !== false) playPeepPreviewBeep();
                        node.setDirtyCanvas(true, true);
                    }
                    URL.revokeObjectURL(url);
                };
                img.src = url;
            });

            api.addEventListener("progress", ({ detail }) => {
                PeepState.samplerStep  = detail.value ?? 0;
                PeepState.samplerTotal = detail.max   ?? 0;
                const nodes = app.graph?._nodes?.filter(n => n.type === "Slimy_CueTimer") || [];
                for (const node of nodes) node.setDirtyCanvas(true, false);
            });
        }
    },
};

app.registerExtension(SlimyCueTimerExtension);
