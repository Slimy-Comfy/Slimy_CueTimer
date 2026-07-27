from .Slimy_CueTimer import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

from . import video_preview_patch
video_preview_patch.install()

WEB_DIRECTORY = "web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
