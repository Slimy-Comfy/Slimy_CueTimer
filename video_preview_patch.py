"""
KSampler標準プレビューは1枚のまま維持し、CueTimerだけへ複数コマのストリップを送る。
プレビュー窓はKSamplerのステップ進捗に応じて動画時間軸上を後方へスライドする。

例（100フレーム / 20ステップ）:
  step 1  -> 0-7
  step 10 -> 50-57
  step 20 -> 92-99

KSampler側には、その窓の最後の1コマだけを返す。
"""

import base64
import io
from contextvars import ContextVar

import numpy as np
import torch
from PIL import Image

# CueTimerのループアニメーションに含める最大コマ数。
# 8へ戻す場合は、この値だけを8に変更する。
MAX_PREVIEW_FRAMES = 16
_PREVIEW_PROGRESS = ContextVar("slimy_preview_progress", default=None)


def _tensor_to_pil(t: torch.Tensor) -> Image.Image:
    t = t.detach().float().cpu()
    if t.min() < -0.01:
        t = (t + 1.0) / 2.0
    t = torch.clamp(t, 0.0, 1.0)
    arr = (t.numpy() * 255).astype(np.uint8)
    arr = np.moveaxis(arr, 0, 2)
    return Image.fromarray(arr)


def _image_to_data_url(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.save(buf, format="PNG", optimize=False)
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


class _SlidingWindowPreviewer:
    def __init__(self, base_previewer, device, latent_format):
        self.base = base_previewer
        self.device = device
        self.latent_format = latent_format
        self._taesd = None

    def _get_taesd(self):
        # CueTimer専用にTAESDをGPUへ追加常駐させない。
        # 標準previewerとは別のデコーダを保持すると、実行後も専用GPUメモリが
        # 解放されにくくなるため、ストリップは軽量latent2rgbで生成する。
        return None

    def _latent2rgb_frame(self, latent_chw):
        factors = getattr(self.latent_format, "latent_rgb_factors", None)
        if factors is None:
            rgb = latent_chw.mean(dim=0, keepdim=True).repeat(3, 1, 1)
            return _tensor_to_pil(rgb)
        factors_t = torch.tensor(
            factors,
            device=latent_chw.device,
            dtype=latent_chw.dtype,
        )
        rgb = torch.einsum("chw,cr->rhw", latent_chw, factors_t)
        return _tensor_to_pil(rgb)

    @staticmethod
    def _window_start(total_frames: int, window_size: int) -> int:
        max_start = max(0, total_frames - window_size)
        progress = _PREVIEW_PROGRESS.get()
        if not progress:
            return 0

        step, total_steps = progress
        try:
            step = int(step)
            total_steps = int(total_steps)
        except (TypeError, ValueError):
            return 0

        if step <= 0 or total_steps <= 1:
            return 0

        # callbackのstepは0始まり。表示上のstep番号は step+1。
        # 100f/20stepsなら step10で start=50、最終stepで92へクランプ。
        ratio = min(1.0, max(0.0, (step + 1) / total_steps))
        return min(max_start, round(total_frames * ratio))

    def _decode_strip(self, x0, start: int, count: int) -> Image.Image:
        frames = []
        # CueTimer用ストリップは追加モデルを使わずlatent2rgbだけで作る。
        # これにより独自TAESDのGPU常駐と、各ステップ16回のデコードを避ける。
        with torch.no_grad():
            for t in range(start, start + count):
                frames.append(self._latent2rgb_frame(x0[0, :, t]))

        width, height = frames[0].size
        strip = Image.new("RGB", (width * len(frames), height))
        for i, frame in enumerate(frames):
            strip.paste(frame, (i * width, 0))
        return strip

    @staticmethod
    def _send_cuetimer_preview(strip: Image.Image, frame_count: int, start: int):
        try:
            from server import PromptServer

            PromptServer.instance.send_sync(
                "slimy_peep_preview",
                {
                    "image": _image_to_data_url(strip),
                    "frames": frame_count,
                    "start": start,
                },
            )
        except Exception as e:
            print(f"[Slimy_CueTimer] CueTimer専用プレビュー送信失敗: {e}")

    def decode_latent_to_preview_image(self, preview_format, x0):
        if getattr(x0, "ndim", 0) != 5 or x0.shape[2] <= 1:
            return self.base.decode_latent_to_preview_image(preview_format, x0)

        try:
            total_frames = int(x0.shape[2])
            frame_count = min(MAX_PREVIEW_FRAMES, total_frames)
            start = self._window_start(total_frames, frame_count)

            # CueTimerには設定したコマ数のプレビュー窓を送る。
            strip = self._decode_strip(x0, start, frame_count)
            self._send_cuetimer_preview(strip, frame_count, start)

            # KSampler本体には窓の最後の1コマだけを返す。
            last_index = start + frame_count - 1
            selected = x0[:, :, last_index:last_index + 1]
            return self.base.decode_latent_to_preview_image(preview_format, selected)
        except Exception as e:
            print(f"[Slimy_CueTimer] スライド窓プレビュー失敗、標準表示へフォールバック: {e}")
            return self.base.decode_latent_to_preview_image(preview_format, x0)

    def __getattr__(self, name):
        return getattr(self.base, name)


def install():
    try:
        import latent_preview
    except ImportError:
        print("[Slimy_CueTimer] latent_previewが見つからず、preview patchをスキップしました")
        return

    if getattr(latent_preview, "_slimy_sliding_window_preview_patched", False):
        return

    original_get_previewer = latent_preview.get_previewer
    original_prepare_callback = latent_preview.prepare_callback

    def patched_get_previewer(device, latent_format):
        base = original_get_previewer(device, latent_format)
        if base is None:
            return None
        return _SlidingWindowPreviewer(base, device, latent_format)

    def patched_prepare_callback(model, steps, x0_output_dict=None):
        original_callback = original_prepare_callback(model, steps, x0_output_dict)

        def callback(step, x0, x, total_steps):
            token = _PREVIEW_PROGRESS.set((step, total_steps))
            try:
                return original_callback(step, x0, x, total_steps)
            finally:
                _PREVIEW_PROGRESS.reset(token)

        return callback

    latent_preview.get_previewer = patched_get_previewer
    latent_preview.prepare_callback = patched_prepare_callback
    latent_preview._slimy_sliding_window_preview_patched = True
    print(f"[Slimy_CueTimer] KSampler 1コマ / CueTimer 最大{MAX_PREVIEW_FRAMES}コマ・スライド窓patchを適用しました")
