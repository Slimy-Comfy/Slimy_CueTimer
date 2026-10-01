import asyncio
import json
import os
import platform
import smtplib
import ssl
import subprocess
from email.mime.text import MIMEText

import folder_paths
from aiohttp import web
from server import PromptServer

from .Slimy_CueTimer import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .video_preview_patch import install as install_video_preview_patch

install_video_preview_patch()

WEB_DIRECTORY = "web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]


# ---------------------------------------------------------------------------
# Feature flags
# ---------------------------------------------------------------------------
# Personal build: True
# GitHub/public build: set this ONE flag to False before publishing.
# When False, the Email UI is hidden, saved Email settings are ignored, and
# the backend mail endpoint refuses delivery.
ENABLE_EMAIL = False


@PromptServer.instance.routes.get("/slimy/cuetimer/features")
async def slimy_cuetimer_features(request):
    return web.json_response({"email": bool(ENABLE_EMAIL)})


_TYPE_TO_DIR = {
    "output": folder_paths.get_output_directory,
    "input": folder_paths.get_input_directory,
    "temp": folder_paths.get_temp_directory,
}


@PromptServer.instance.routes.post("/slimy/cuetimer/reveal")
async def slimy_cuetimer_reveal(request):
    """指定ファイルの場所を、ComfyUIサーバーが動いているマシン上のOS標準の
    ファイラー(Windows: Explorer / macOS: Finder / Linux: xdg-open)で開く。
    Slimy_VideoSpoolerの同名エンドポイントと同じ実装だが、CueTimer単体でも
    動くよう独立して持たせている(Spooler未導入でも動画Save系ノードのファイル
    を開けるように)。
    """
    try:
        body = await request.json()
    except Exception:
        return web.Response(status=400, text="invalid json")
    filename = body.get("filename")
    subfolder = body.get("subfolder") or ""
    file_type = body.get("type") or "output"

    if not filename:
        return web.Response(status=400, text="filename required")

    get_dir = _TYPE_TO_DIR.get(file_type, folder_paths.get_output_directory)
    base = get_dir()
    full_path = os.path.join(base, subfolder, filename) if subfolder else os.path.join(base, filename)
    full_path = os.path.normpath(full_path)
    if not os.path.isfile(full_path):
        return web.Response(status=404, text=f"file not found: {full_path}")

    try:
        system = platform.system()
        if system == "Windows":
            subprocess.Popen(["explorer", "/select,", full_path])
        elif system == "Darwin":
            subprocess.Popen(["open", "-R", full_path])
        else:
            subprocess.Popen(["xdg-open", os.path.dirname(full_path)])
    except Exception as e:
        return web.Response(status=500, text=f"failed to open file manager: {e}")
    return web.json_response({"ok": True, "path": full_path})


# ---------------------------------------------------------------------------
# Desktop mirror (Slimy_CueTimer Desktop Widget)
# ---------------------------------------------------------------------------
_CUETIMER_MIRROR_STATE = {
    "running": False,
    "timer": "00:00:000",
    "step": 0,
    "step_total": 0,
    "total_pct": 0,
    "history": [],
    "timer_visible": True,
    "peep_visible": True,
    "peep_sound": True,
    "final_video": None,
    "preview_version": 0,
    "preview_frames": 1,
}
_CUETIMER_MIRROR_PREVIEW = b""
_CUETIMER_MIRROR_PREVIEW_CONTENT_TYPE = "image/jpeg"
_CUETIMER_MIRROR_CONTROL = {"peep_sound": None, "timer_visible": None}


@PromptServer.instance.routes.post("/slimy/cuetimer/mirror_control")
async def slimy_cuetimer_mirror_control_post(request):
    try:
        body = await request.json()
    except Exception:
        return web.Response(status=400, text="invalid json")

    if "peep_sound" in body:
        _CUETIMER_MIRROR_CONTROL["peep_sound"] = bool(body["peep_sound"])
    if "timer_visible" in body:
        _CUETIMER_MIRROR_CONTROL["timer_visible"] = bool(body["timer_visible"])
    return web.json_response({"ok": True})


@PromptServer.instance.routes.get("/slimy/cuetimer/mirror_control")
async def slimy_cuetimer_mirror_control_get(request):
    # One-shot command mailbox: browser consumes the newest desktop command.
    peep_sound = _CUETIMER_MIRROR_CONTROL.get("peep_sound")
    timer_visible = _CUETIMER_MIRROR_CONTROL.get("timer_visible")
    _CUETIMER_MIRROR_CONTROL["peep_sound"] = None
    _CUETIMER_MIRROR_CONTROL["timer_visible"] = None
    return web.json_response({"peep_sound": peep_sound, "timer_visible": timer_visible})


@PromptServer.instance.routes.post("/slimy/cuetimer/mirror_state")
async def slimy_cuetimer_mirror_state_post(request):
    try:
        body = await request.json()
    except Exception:
        return web.Response(status=400, text="invalid json")

    for key in (
        "running", "timer", "step", "step_total", "total_pct", "history",
        "timer_visible", "peep_visible", "peep_sound", "final_video", "preview_frames",
    ):
        if key in body:
            _CUETIMER_MIRROR_STATE[key] = body[key]
    return web.json_response({"ok": True})


@PromptServer.instance.routes.get("/slimy/cuetimer/mirror_state")
async def slimy_cuetimer_mirror_state_get(request):
    return web.json_response(_CUETIMER_MIRROR_STATE)


@PromptServer.instance.routes.post("/slimy/cuetimer/mirror_preview")
async def slimy_cuetimer_mirror_preview_post(request):
    global _CUETIMER_MIRROR_PREVIEW, _CUETIMER_MIRROR_PREVIEW_CONTENT_TYPE
    try:
        data = await request.read()
    except Exception:
        return web.Response(status=400, text="invalid body")
    if not data:
        return web.Response(status=400, text="empty body")
    if len(data) > 32 * 1024 * 1024:
        return web.Response(status=413, text="preview too large")

    _CUETIMER_MIRROR_PREVIEW = data
    _CUETIMER_MIRROR_PREVIEW_CONTENT_TYPE = request.headers.get("Content-Type") or "application/octet-stream"
    _CUETIMER_MIRROR_STATE["preview_version"] = int(_CUETIMER_MIRROR_STATE.get("preview_version", 0)) + 1
    try:
        frames = int(request.headers.get("X-Slimy-Frames", "1"))
    except Exception:
        frames = 1
    _CUETIMER_MIRROR_STATE["preview_frames"] = max(1, frames)
    return web.json_response({"ok": True, "preview_version": _CUETIMER_MIRROR_STATE["preview_version"]})


@PromptServer.instance.routes.get("/slimy/cuetimer/mirror_preview")
async def slimy_cuetimer_mirror_preview_get(request):
    if not _CUETIMER_MIRROR_PREVIEW:
        return web.Response(status=404, text="no preview")
    return web.Response(body=_CUETIMER_MIRROR_PREVIEW, content_type=_CUETIMER_MIRROR_PREVIEW_CONTENT_TYPE)


@PromptServer.instance.routes.post("/slimy/cuetimer/mirror_preview_clear")
async def slimy_cuetimer_mirror_preview_clear(request):
    global _CUETIMER_MIRROR_PREVIEW, _CUETIMER_MIRROR_PREVIEW_CONTENT_TYPE
    _CUETIMER_MIRROR_PREVIEW = b""
    _CUETIMER_MIRROR_PREVIEW_CONTENT_TYPE = "image/jpeg"
    _CUETIMER_MIRROR_STATE["preview_frames"] = 1
    _CUETIMER_MIRROR_STATE["preview_version"] = int(_CUETIMER_MIRROR_STATE.get("preview_version", 0)) + 1
    return web.json_response({"ok": True, "preview_version": _CUETIMER_MIRROR_STATE["preview_version"]})


_CUETIMER_DESKTOP_HTML = r"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Slimy CueTimer</title>
<style>
:root{color-scheme:dark;--bg:#111318;--panel:#181b22;--line:#2c313d;--text:#eef2f7;--muted:#9da7b5;--accent:#8cb4ff}
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:var(--bg);color:var(--text);font-family:Segoe UI,Meiryo,sans-serif;overflow:hidden}
body{display:flex;flex-direction:column;padding:10px;gap:8px}
#timer{font-size:34px;font-weight:700;letter-spacing:.8px;text-align:center;line-height:1.15;flex:0 0 auto}
#stats{display:flex;gap:8px;align-items:center;justify-content:center;font-size:13px;color:var(--muted);flex:0 0 auto}
#bar{height:6px;background:#242934;border-radius:999px;overflow:hidden;flex:0 0 auto}#fill{height:100%;width:0;background:var(--accent)}
#previewWrap{position:relative;min-height:120px;flex:1 1 auto;border:1px solid var(--line);border-radius:8px;background:#0b0d11;overflow:hidden;display:flex;align-items:center;justify-content:center}
#preview{display:block;width:100%;height:100%}
#preview.empty{display:none}#previewSource{display:none}#noPreview{color:#687386;font-size:13px}
#history{height:120px;flex:0 0 120px;overflow:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:6px 8px;font-size:12px;line-height:1.5}
.hrow{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.done{color:#a6e3a1}.run{color:#f9e2af}.err{color:#f38ba8}
#status{font-size:11px;color:#6f7a89;text-align:right;flex:0 0 auto}
</style>
</head>
<body>
<div id="timer">00:00:000</div>
<div id="stats"><span id="steps">Steps 0 / 0</span><span>•</span><span id="pct">0%</span></div>
<div id="bar"><div id="fill"></div></div>
<div id="previewWrap"><canvas id="preview" class="empty"></canvas><img id="previewSource" alt="preview source"><div id="noPreview">Waiting for CueTimer preview…</div></div>
<div id="history"></div>
<div id="status">Connecting…</div>
<script>
const PEEP_PREVIEW_FRAME_MS=240;
const PEEP_PREVIEW_END_HOLD_FRAMES=5;
let lastPreviewVersion=-1;
let previewFrameCount=1;
let previewFrameIndex=0;
let previewEndHoldTicks=0;
let previewRunning=false;
let previewTimer=null;
const $=id=>document.getElementById(id);
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

function drawPreviewFrame(){
  const src=$('previewSource');
  const cv=$('preview');
  if(!src.complete || !src.naturalWidth || !src.naturalHeight) return;
  const count=Math.max(1,previewFrameCount|0);
  const sw=src.naturalWidth/count;
  const sh=src.naturalHeight;
  const wrap=$('previewWrap');
  const dpr=Math.max(1,window.devicePixelRatio||1);
  const cw=Math.max(1,wrap.clientWidth);
  const ch=Math.max(1,wrap.clientHeight);
  const pw=Math.max(1,Math.round(cw*dpr));
  const ph=Math.max(1,Math.round(ch*dpr));
  if(cv.width!==pw || cv.height!==ph){ cv.width=pw; cv.height=ph; }
  const ctx=cv.getContext('2d');
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,pw,ph);
  const scale=Math.min(pw/sw,ph/sh);
  const dw=sw*scale, dh=sh*scale;
  const dx=(pw-dw)/2, dy=(ph-dh)/2;
  const sx=Math.min(count-1,Math.max(0,previewFrameIndex))*sw;
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality='high';
  ctx.drawImage(src,sx,0,sw,sh,dx,dy,dw,dh);
}
function syncPreviewTimer(){
  const need=previewRunning && previewFrameCount>1;
  if(need && !previewTimer){
    previewTimer=setInterval(()=>{
      const last=previewFrameCount-1;
      if(previewFrameIndex>=last){
        previewEndHoldTicks++;
        if(previewEndHoldTicks>=PEEP_PREVIEW_END_HOLD_FRAMES){
          previewFrameIndex=0;
          previewEndHoldTicks=0;
        }
      }else{
        previewFrameIndex++;
        previewEndHoldTicks=0;
      }
      drawPreviewFrame();
    },PEEP_PREVIEW_FRAME_MS);
  }else if(!need && previewTimer){
    clearInterval(previewTimer);
    previewTimer=null;
  }
}
window.addEventListener('resize',drawPreviewFrame);

function renderHistory(h){
  if(!Array.isArray(h)){ $('history').innerHTML=''; return; }
  $('history').innerHTML=h.slice(-60).reverse().map(x=>{
    if(typeof x==='string') return `<div class="hrow">${esc(x)}</div>`;
    const cls=x?.type==='error'?'err':(x?.type==='running'?'run':'done');
    const a=x?.time||x?.stamp||''; const b=x?.label||x?.name||x?.type||'';
    return `<div class="hrow ${cls}">${esc(a)} ${esc(b)}</div>`;
  }).join('');
}
async function tick(){
  try{
    const r=await fetch('/slimy/cuetimer/mirror_state',{cache:'no-store'});
    if(!r.ok) throw new Error('state '+r.status);
    const s=await r.json();
    previewRunning=!!s.running; $('status').textContent=previewRunning?'Running':'Ready';
    $('timer').textContent=s.timer||'00:00:000';
    $('steps').textContent=`Steps ${s.step||0} / ${s.step_total||0}`;
    const p=Math.max(0,Math.min(100,Number(s.total_pct)||0));
    $('pct').textContent=`${Math.round(p)}%`; $('fill').style.width=`${p}%`;
    if(s.timer_visible===false){ $('timer').style.display='none'; $('stats').style.display='none'; $('bar').style.display='none'; }
    else { $('timer').style.display='block'; $('stats').style.display='flex'; $('bar').style.display='block'; }
    renderHistory(s.history);
    if(s.peep_visible===false){ $('previewWrap').style.display='none'; }
    else { $('previewWrap').style.display='flex'; }
    previewFrameCount=Math.max(1,Number(s.preview_frames||1)|0);
    syncPreviewTimer();
    const ver=Number(s.preview_version||0);
    if(ver!==lastPreviewVersion){
      lastPreviewVersion=ver;
      if(ver>0){
        previewFrameIndex=0; previewEndHoldTicks=0;
        const src=$('previewSource');
        src.onload=()=>{
          $('preview').classList.remove('empty');
          $('noPreview').style.display='none';
          drawPreviewFrame();
        };
        src.onerror=()=>{
          $('preview').classList.add('empty');
          $('noPreview').style.display='block';
        };
        src.src=`/slimy/cuetimer/mirror_preview?v=${ver}`;
      }
    }
  }catch(e){ $('status').textContent='ComfyUI disconnected'; }
}
setInterval(tick,250); tick();
</script>
</body></html>"""


@PromptServer.instance.routes.get("/slimy/cuetimer/desktop")
async def slimy_cuetimer_desktop(request):
    return web.Response(
        text=_CUETIMER_DESKTOP_HTML,
        content_type="text/html",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
    )


# ---------------------------------------------------------------------------
# Email notification (キュー完了/エラー時に指定アドレスへメール送信)
# ---------------------------------------------------------------------------

_EMAIL_CONFIG_PATH = os.path.join(os.path.dirname(__file__), "email_config.json")

_EMAIL_CONFIG_TEMPLATE = {
    "_comment": "SlimyCueTimer からのメール通知用SMTP設定。値を入力して保存してください。"
                "Gmailの場合はGoogleアカウントの「アプリパスワード」をsmtp_passwordに使用してください。",
    "smtp_host": "smtp.gmail.com",
    "smtp_port": 587,
    "smtp_user": "",
    "smtp_password": "",
    "use_tls": True,
    "use_ssl": False,
    "from_addr": "",
}


def _ensure_email_config_template():
    if os.path.isfile(_EMAIL_CONFIG_PATH):
        return
    try:
        with open(_EMAIL_CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(_EMAIL_CONFIG_TEMPLATE, f, indent=2, ensure_ascii=False)
        print(f"[Slimy_CueTimer] created {_EMAIL_CONFIG_PATH} - please edit SMTP settings to enable email notifications.")
    except Exception as e:
        print(f"[Slimy_CueTimer] failed to create email_config.json template: {e}")


def _load_email_config():
    _ensure_email_config_template()
    try:
        with open(_EMAIL_CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception as e:
        print(f"[Slimy_CueTimer] failed to read email_config.json: {e}")
        return None
    # 環境変数が設定されていればそちらを優先（パスワードをファイルに残したくない場合用）
    cfg["smtp_host"]     = os.environ.get("SLIMY_SMTP_HOST", cfg.get("smtp_host"))
    cfg["smtp_port"]     = os.environ.get("SLIMY_SMTP_PORT", cfg.get("smtp_port"))
    cfg["smtp_user"]     = os.environ.get("SLIMY_SMTP_USER", cfg.get("smtp_user"))
    cfg["smtp_password"] = os.environ.get("SLIMY_SMTP_PASSWORD", cfg.get("smtp_password"))
    cfg["from_addr"]     = os.environ.get("SLIMY_SMTP_FROM", cfg.get("from_addr")) or cfg.get("smtp_user")
    return cfg


_EMAIL_SUBJECTS = {
    "done":        "\u2705 ComfyUI Queue Complete / \u30ad\u30e5\u30fc\u5b8c\u4e86",
    "error":       "\u26a0\ufe0f ComfyUI Queue Stopped / \u30ad\u30e5\u30fc\u4e2d\u65ad\u30fberror",
}


def _send_email_sync(cfg, to_addrs, subject, body):
    host = cfg.get("smtp_host")
    port = int(cfg.get("smtp_port") or 587)
    use_ssl = bool(cfg.get("use_ssl"))
    use_tls = bool(cfg.get("use_tls"))
    user = cfg.get("smtp_user")
    password = cfg.get("smtp_password")
    from_addr = cfg.get("from_addr") or user

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = ", ".join(to_addrs)

    if use_ssl:
        with smtplib.SMTP_SSL(host, port, context=ssl.create_default_context()) as server:
            if user and password:
                server.login(user, password)
            server.sendmail(from_addr, to_addrs, msg.as_string())
    else:
        with smtplib.SMTP(host, port) as server:
            if use_tls:
                server.starttls(context=ssl.create_default_context())
            if user and password:
                server.login(user, password)
            server.sendmail(from_addr, to_addrs, msg.as_string())


@PromptServer.instance.routes.post("/slimy/cuetimer/notify_email")
async def slimy_cuetimer_notify_email(request):
    """キュー完了(またはエラー/中断)時にJS側から呼ばれ、指定アドレスへメールを送る。"""
    if not ENABLE_EMAIL:
        return web.Response(status=403, text="email notification is disabled in this build")
    try:
        body = await request.json()
    except Exception:
        return web.Response(status=400, text="invalid json")

    to_addrs = body.get("to")
    if isinstance(to_addrs, str):
        to_addrs = [to_addrs]
    to_addrs = [a.strip() for a in (to_addrs or []) if isinstance(a, str) and a.strip()]
    if not to_addrs:
        return web.Response(status=400, text="'to' (recipient email address) is required")

    status  = body.get("status", "done")
    elapsed = body.get("elapsed", "")

    cfg = _load_email_config()
    if not cfg or not cfg.get("smtp_host") or not cfg.get("smtp_user"):
        return web.Response(
            status=500,
            text=(
                "SMTP is not configured. Edit "
                f"{_EMAIL_CONFIG_PATH} and set smtp_host / smtp_user / smtp_password "
                "(or set SLIMY_SMTP_HOST / SLIMY_SMTP_USER / SLIMY_SMTP_PASSWORD env vars)."
            ),
        )

    subject = _EMAIL_SUBJECTS.get(status, "ComfyUI Queue Notification")
    text_body = (
        "Slimy_CueTimer からの通知です。\n\n"
        f"ステータス: {status}\n"
        f"経過時間: {elapsed}\n"
    )

    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, _send_email_sync, cfg, to_addrs, subject, text_body)
    except Exception as e:
        return web.Response(status=500, text=f"failed to send email: {e}")

    return web.json_response({"ok": True, "to": to_addrs})
