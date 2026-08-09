import os
import platform
import subprocess

import folder_paths
from aiohttp import web
from server import PromptServer

from .Slimy_CueTimer import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from .video_preview_patch import install as install_video_preview_patch

install_video_preview_patch()

WEB_DIRECTORY = "web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]


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
