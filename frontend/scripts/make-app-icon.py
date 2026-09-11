#!/usr/bin/env python3
"""Render the MeetOdds app icon in the Horizon palette.

The icon is generated rather than hand-drawn so it can be reproduced when the
palette moves. Colours are taken from frontend/src/app/globals.css: the warm
near-black ground of dark mode, and the burnt orange to coral accent ramp.

    python3 scripts/make-app-icon.py [out.png]

Then regenerate every platform size with:

    pnpm exec tauri icon <out.png>
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = 4  # supersample factor; every coordinate below is in final-size units
MARGIN = 10  # transparent breathing room, matching the previous icon's inset
RADIUS = 232  # ~22.7%, the macOS squircle approximation

GROUND_TOP = (36, 26, 20)
GROUND_BOTTOM = (14, 12, 10)
GLOW = (204, 72, 5)  # --accent (light)
BAR_TOP = (255, 178, 87)  # --coral (dark)
BAR_BOTTOM = (204, 72, 5)  # --accent (light)
HORIZON = (58, 47, 40)

# Heights as a fraction of the tallest bar, symmetric so the silhouette reads as
# a single arc rather than seven unrelated sticks once it is 32px tall.
BARS = (0.30, 0.52, 0.78, 1.00, 0.78, 0.52, 0.30)


def vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    """A 1px-wide gradient stretched to size; cheaper and smoother than per-pixel work."""
    width, height = size
    strip = Image.new("RGB", (1, height))
    for y in range(height):
        t = y / max(height - 1, 1)
        strip.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return strip.resize(size, Image.Resampling.BILINEAR)


def render(size: int = SIZE) -> Image.Image:
    w = size * SS
    canvas = Image.new("RGBA", (w, w), (0, 0, 0, 0))

    # Rounded-square ground.
    mask = Image.new("L", (w, w), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (MARGIN * SS, MARGIN * SS, w - MARGIN * SS, w - MARGIN * SS),
        radius=RADIUS * SS,
        fill=255,
    )
    ground = vertical_gradient((w, w), GROUND_TOP, GROUND_BOTTOM).convert("RGBA")
    canvas.paste(ground, (0, 0), mask)

    # Warm glow behind the waveform, so the bars sit in light rather than on a flat field.
    glow = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    cx, cy, r = w // 2, int(w * 0.56), int(w * 0.34)
    gd.ellipse((cx - r, cy - r, cx + r, cy + r), fill=GLOW + (86,))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=w * 0.09))
    canvas.alpha_composite(Image.composite(glow, Image.new("RGBA", (w, w), (0, 0, 0, 0)), mask))

    # Horizon line: the quiet half of the name. It runs wider than the waveform so it
    # reads as a landscape the bars stand on rather than as a chart axis.
    hd = ImageDraw.Draw(canvas)
    hy = int(w * 0.700)
    inset = int(w * 0.135)
    thickness = int(w * 0.0075)
    hd.rounded_rectangle(
        (inset, hy - thickness, w - inset, hy + thickness),
        radius=thickness,
        fill=HORIZON + (255,),
    )

    # Waveform, drawn into its own layer so one gradient covers every bar.
    bar_w = int(w * 0.072)
    gap = int(w * 0.034)
    tallest = int(w * 0.46)
    foot = int(w * 0.042)
    total = len(BARS) * bar_w + (len(BARS) - 1) * gap
    x = (w - total) // 2
    bars_mask = Image.new("L", (w, w), 0)
    bd = ImageDraw.Draw(bars_mask)
    for fraction in BARS:
        h = int(tallest * fraction)
        bd.rounded_rectangle((x, hy - h, x + bar_w, hy + foot), radius=bar_w // 2, fill=255)
        x += bar_w + gap
    # Map the ramp to the waveform's own extent, not the canvas, or every bar samples
    # the same narrow band of the gradient and the set reads as one flat colour.
    top_y, bottom_y = hy - tallest, hy + foot
    ramp = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    ramp.paste(
        vertical_gradient((w, bottom_y - top_y), BAR_TOP, BAR_BOTTOM).convert("RGBA"),
        (0, top_y),
    )
    canvas.alpha_composite(Image.composite(ramp, Image.new("RGBA", (w, w), (0, 0, 0, 0)), bars_mask))

    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "app-icon.png")
    render().save(out)
    print(f"wrote {out} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    main()
