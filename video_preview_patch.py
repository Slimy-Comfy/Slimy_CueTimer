"""
video_preview_patch.py
-----------------------
ComfyUIコアの latent_preview.get_previewer() をパッチし、
動画モデル(5D潜在 [B, C, T, H, W])のサンプリング中プレビューを
「1フレーム目だけ」ではなく「複数フレームを横並びにしたストリップ画像」に置き換える。

既存の Slimy_CueTimer の PeepPreview は ComfyUI 標準の "b_preview"
(PromptServer 経由のバイナリプレビューイベント)をそのまま表示しているだけなので、
この patch はプレビュー生成側だけを差し替えれば良く、JS側の変更は不要。
KSamplerがどのノードでもサブグラフの中でも、同じ経路に流れるため自動的に効く。

--- 重要: バージョン依存箇所 ---
ComfyUI本体の latent_preview.py は更新が多いファイルで、
Previewer.decode_latent_to_preview_image() の戻り値の形式
(例: (preview_format, PIL.Image, max_size) のタプルか、bytesそのものか等)
がバージョンによって変わることがあります。
このpatchは try/except で失敗時に元の実装へフォールバックするので、
最悪の場合でも「動画は1フレーム目だけ」という元の挙動に戻るだけで、
プレビュー自体が壊れて動かなくなることはありません。
うまく複数フレーム化されない場合は、お使いのComfyUIの
latent_preview.py 内の decode_latent_to_preview_image の
戻り値の形を確認し、_decode_video() の return 部分を合わせてください。
"""

import numpy as np
import torch
from PIL import Image

MAX_PREVIEW_FRAMES = 8


def _tensor_to_pil(t: torch.Tensor) -> Image.Image:
    t = t.detach().float().cpu()
    if t.min() < -0.01:  # [-1, 1] レンジと推定される場合
        t = (t + 1.0) / 2.0
    t = torch.clamp(t, 0.0, 1.0)
    arr = (t.numpy() * 255).astype(np.uint8)
    arr = np.moveaxis(arr, 0, 2)  # CHW -> HWC
    return Image.fromarray(arr)


class _VideoAwarePreviewer:
    """
    既存の Previewer をラップし、動画潜在(5D、フレーム数>1)のときだけ
    複数フレームを横並びストリップにデコードする。画像潜在(4D)や
    単一フレームのときは元の Previewer にそのまま委譲する。
    """

    def __init__(self, base_previewer, device, latent_format):
        self.base = base_previewer
        self.device = device
        self.latent_format = latent_format
        self._taesd = None

    def _get_taesd(self):
        if self._taesd is not None:
            return self._taesd
        try:
            import folder_paths
            from comfy.taesd.taesd import TAESD
            name = getattr(self.latent_format, "taesd_decoder_name", None)
            path = folder_paths.get_full_path("vae_approx", name) if name else None
            if path:
                self._taesd = TAESD(None, path).to(self.device)
        except Exception as e:
            print(f"[Slimy_CueTimer] TAESD読み込み失敗: {e}")
        return self._taesd

    def _latent2rgb_frame(self, latent_chw):
        factors = getattr(self.latent_format, "latent_rgb_factors", None)
        if factors is None:
            arr = latent_chw.mean(dim=0, keepdim=True).repeat(3, 1, 1)
            return _tensor_to_pil(arr)
        factors_t = torch.tensor(factors, device=latent_chw.device, dtype=latent_chw.dtype)
        rgb = torch.einsum("chw,cr->rhw", latent_chw, factors_t)
        return _tensor_to_pil(rgb)

    def _decode_video(self, preview_format, x0):
        taesd = self._get_taesd()
        total_frames = x0.shape[2]
        # 1フレーム目は多くの場合Ref画像なので、パラパラ表示の対象から除外する
        start_idx = 1 if total_frames > 1 else 0
        n_frames = min(total_frames - start_idx, MAX_PREVIEW_FRAMES)
        frames = []
        with torch.no_grad():
            for t in range(start_idx, start_idx + n_frames):
                if taesd is not None:
                    dec = taesd.decode(x0[0:1, :, t])[0]
                    frames.append(_tensor_to_pil(dec))
                else:
                    frames.append(self._latent2rgb_frame(x0[0, :, t]))

        w, h = frames[0].size
        strip = Image.new("RGB", (w * len(frames), h))
        for i, f in enumerate(frames):
            strip.paste(f, (i * w, 0))

        # フレーム数をJS側に伝える(パラパラ表示のためのコマ数情報)
        # b_preview本体(バイナリ)より先に送ることで、JS側が画像受信時点で
        # 何コマ構成かを把握できるようにする
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("slimy_peep_frame_count", {"frames": len(frames)})
        except Exception as e:
            print(f"[Slimy_CueTimer] フレーム数通知の送信に失敗: {e}")

        # --- 要確認: 呼び出し側(pbar.update_absolute)が期待する戻り値の形 ---
        # 元の decode_latent_to_preview_image と同じ形式に合わせること
        return (preview_format, strip, None)

    def _reset_frame_count(self):
        # 静止画/単一フレームのプレビュー時は、前回の動画生成で残った
        # frameCount(JS側 PeepState.frameCount)をリセットしておく。
        # これをやらないと、直前が動画(frames>1)だった場合に、次の
        # 静止画1枚がその古いフレーム数で横スライスされて再生されてしまう。
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("slimy_peep_frame_count", {"frames": 1})
        except Exception as e:
            print(f"[Slimy_CueTimer] フレーム数リセットの送信に失敗: {e}")

    def decode_latent_to_preview_image(self, preview_format, x0):
        if x0.dim() != 5 or x0.shape[2] <= 1:
            self._reset_frame_count()
            return self.base.decode_latent_to_preview_image(preview_format, x0)
        try:
            return self._decode_video(preview_format, x0)
        except Exception as e:
            print(f"[Slimy_CueTimer] 複数フレームプレビュー生成に失敗、通常表示にフォールバック: {e}")
            self._reset_frame_count()
            return self.base.decode_latent_to_preview_image(preview_format, x0)


def install():
    try:
        import latent_preview
    except ImportError:
        print("[Slimy_CueTimer] latent_preview モジュールが見つからず、動画マルチフレームプレビューpatchをスキップしました")
        return

    if getattr(latent_preview, "_slimy_video_preview_patched", False):
        return  # 二重パッチ防止(他のカスタムノードと共存している場合など)

    original_get_previewer = latent_preview.get_previewer

    def patched_get_previewer(device, latent_format):
        base = original_get_previewer(device, latent_format)
        if base is None:
            return None
        return _VideoAwarePreviewer(base, device, latent_format)

    latent_preview.get_previewer = patched_get_previewer
    latent_preview._slimy_video_preview_patched = True
    print("[Slimy_CueTimer] 動画マルチフレームプレビューpatchを適用しました")
