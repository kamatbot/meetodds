#!/usr/bin/env python3
"""Generate the MeetOdds iOS brand assets (app icon, launch mark, launch colour).

Run from ios/:  python3 Scripts/make_brand_assets.py
Geometry and colours here must stay in sync with MeetOdds/Views/Brand.swift so the
SwiftUI splash's first frame matches the static launch screen pixel for pixel.
"""
import json, math, os, sys
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), "..")
ASSETS = os.path.join(ROOT, "MeetOdds", "Assets.xcassets")
DESKTOP_ICON = os.path.join(ROOT, "..", "frontend", "src-tauri", "icons", "icon_512x512@2x.png")

# Shared with Brand.swift
LAUNCH_BACKGROUND = "#22156F"
BAR_WIDTH, BAR_GAP = 12, 10
BAR_HEIGHTS = [22, 42, 66, 92, 66, 42, 22]
BAR_COLORS = ["#5FE9DC", "#74E7C4", "#7CC8FF", "#B2A8FF", "#D9A7FF", "#FF9FD0", "#FFA3A8"]

def hex_rgb(h): return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))

def write(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f: json.dump(obj, f, indent=2); f.write("\n")

def launch_mark():
    w = len(BAR_HEIGHTS) * BAR_WIDTH + (len(BAR_HEIGHTS) - 1) * BAR_GAP
    h = max(BAR_HEIGHTS)
    folder = os.path.join(ASSETS, "LaunchMark.imageset"); os.makedirs(folder, exist_ok=True)
    images = []
    for scale in (1, 2, 3):
        ss = 4  # supersample for smooth capsule edges
        im = Image.new("RGBA", (w * scale * ss, h * scale * ss), (0, 0, 0, 0))
        d = ImageDraw.Draw(im)
        x = 0
        for height, color in zip(BAR_HEIGHTS, BAR_COLORS):
            top = (h - height) / 2
            box = [x * scale * ss, top * scale * ss, (x + BAR_WIDTH) * scale * ss, (top + height) * scale * ss]
            d.rounded_rectangle(box, radius=BAR_WIDTH / 2 * scale * ss, fill=hex_rgb(color) + (255,))
            x += BAR_WIDTH + BAR_GAP
        im = im.resize((w * scale, h * scale), Image.LANCZOS)
        name = f"LaunchMark@{scale}x.png"
        im.save(os.path.join(folder, name)); images.append({"filename": name, "idiom": "universal", "scale": f"{scale}x"})
    write(os.path.join(folder, "Contents.json"), {"images": images, "info": {"author": "xcode", "version": 1}})

def launch_background():
    r, g, b = hex_rgb(LAUNCH_BACKGROUND)
    comp = {"color-space": "srgb", "components": {"alpha": "1.000", "red": f"{r/255:.3f}", "green": f"{g/255:.3f}", "blue": f"{b/255:.3f}"}}
    write(os.path.join(ASSETS, "LaunchBackground.colorset", "Contents.json"),
          {"colors": [{"color": comp, "idiom": "universal"}], "info": {"author": "xcode", "version": 1}})

def app_icon():
    """The desktop icon is a rounded square on black; iOS wants full bleed. Extend the
    gradient into the corners by sampling along the arc so there is no seam."""
    src = Image.open(DESKTOP_ICON).convert("RGB")
    size = src.size[0]; R = 200; inner = R - 6
    px = src.load(); out = src.copy(); o = out.load()
    for cx, cy in ((R, R), (size - 1 - R, R), (R, size - 1 - R), (size - 1 - R, size - 1 - R)):
        x0, x1 = (0, R) if cx == R else (size - R, size)
        y0, y1 = (0, R) if cy == R else (size - R, size)
        for y in range(y0, y1):
            for x in range(x0, x1):
                dx, dy = x - cx, y - cy
                dist = math.hypot(dx, dy)
                if dist > inner:
                    sx = cx + dx / dist * inner; sy = cy + dy / dist * inner
                    o[x, y] = px[int(round(sx)), int(round(sy))]
    folder = os.path.join(ASSETS, "AppIcon.appiconset")
    os.makedirs(folder, exist_ok=True)
    out.save(os.path.join(folder, "AppIcon-1024.png"))
    write(os.path.join(folder, "Contents.json"),
          {"images": [{"filename": "AppIcon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}],
           "info": {"author": "xcode", "version": 1}})

if __name__ == "__main__":
    write(os.path.join(ASSETS, "Contents.json"), {"info": {"author": "xcode", "version": 1}})
    launch_mark(); launch_background(); app_icon()
    print("brand assets written to", os.path.relpath(ASSETS, ROOT))
