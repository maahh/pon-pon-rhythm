#!/usr/bin/env python3
"""アプリアイコン生成：カニ🦀モチーフ（PILで図形描画・絵文字フォント非依存）。

192 / 512 / 180(apple-touch) の3サイズをicons/に出力する。
"""
from PIL import Image, ImageDraw
import os

BG = (26, 26, 46)        # ダークネイビー
CRAB = (233, 69, 96)     # コーラルレッド
CRAB_DARK = (179, 47, 69)
WHITE = (255, 255, 255)
PUPIL = (26, 26, 46)

OUT_DIR = os.path.join(os.path.dirname(__file__), "icons")


def draw_crab(size):
    """1辺sizeのカニアイコンを描いて返す。"""
    img = Image.new("RGB", (size, size), BG)
    d = ImageDraw.Draw(img)
    s = size  # 比率計算用

    def box(cx, cy, rx, ry):
        return [cx - rx, cy - ry, cx + rx, cy + ry]

    cx, cy = s * 0.5, s * 0.56  # 体の中心（やや下）

    # 脚（体の左右に3本ずつ）
    leg_w = max(2, int(s * 0.018))
    for i, oy in enumerate((-0.04, 0.04, 0.12)):
        y = cy + s * oy
        d.line([(s * 0.30, y), (s * 0.10, y - s * 0.05)], fill=CRAB_DARK, width=leg_w)
        d.line([(s * 0.70, y), (s * 0.90, y - s * 0.05)], fill=CRAB_DARK, width=leg_w)

    # ハサミ（左右）
    d.ellipse(box(s * 0.16, cy - s * 0.10, s * 0.085, s * 0.10), fill=CRAB)
    d.ellipse(box(s * 0.84, cy - s * 0.10, s * 0.085, s * 0.10), fill=CRAB)
    d.line([(s * 0.22, cy - s * 0.06), (s * 0.38, cy + s * 0.02)], fill=CRAB, width=int(s * 0.05))
    d.line([(s * 0.78, cy - s * 0.06), (s * 0.62, cy + s * 0.02)], fill=CRAB, width=int(s * 0.05))

    # 体（甲羅）
    d.ellipse(box(cx, cy, s * 0.26, s * 0.20), fill=CRAB)

    # 目（柄つき）
    eye_dx, eye_y = s * 0.10, cy - s * 0.20
    d.line([(cx - eye_dx, cy - s * 0.05), (cx - eye_dx, eye_y)], fill=CRAB_DARK, width=int(s * 0.03))
    d.line([(cx + eye_dx, cy - s * 0.05), (cx + eye_dx, eye_y)], fill=CRAB_DARK, width=int(s * 0.03))
    for ex in (cx - eye_dx, cx + eye_dx):
        d.ellipse(box(ex, eye_y, s * 0.055, s * 0.055), fill=WHITE)
        d.ellipse(box(ex, eye_y + s * 0.01, s * 0.022, s * 0.022), fill=PUPIL)

    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    targets = {
        "icon-512.png": 512,
        "icon-192.png": 192,
        "apple-touch-icon.png": 180,
    }
    base = draw_crab(512)
    for name, size in targets.items():
        out = base if size == 512 else base.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT_DIR, name)
        out.save(path, "PNG")
        print(f"Saved: {path}")


if __name__ == "__main__":
    main()
