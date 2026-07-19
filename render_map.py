#!/usr/bin/env python3
"""Render map.json to a PNG so the composed map can be inspected outside the editor.
Usage: python3 render_map.py [map.json] [out.png] [scale]"""
import json, sys, os
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC   = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "map.json")
OUT   = sys.argv[2] if len(sys.argv) > 2 else "/tmp/map_render.png"
SCALE = int(sys.argv[3]) if len(sys.argv) > 3 else 3

# each sheet has its own tile size (terrain 16px, characters 24px)
SHEETS = {
    0:           ("assets/img/tiles_packed.png",     16),
    "tiles":     ("assets/img/tiles_packed.png",     16),
    "interface": ("assets/img/interface_packed.png", 16),
    "enemies":   ("assets/img/enemies_packed.png",   24),
    "players":   ("assets/img/players_packed.png",   24),
    "weapons":   ("assets/img/weapons_packed.png",   24),
}
_cache = {}
def sheet(key):
    if key not in _cache:
        path, ts = SHEETS[key]
        _cache[key] = (Image.open(os.path.join(ROOT, path)).convert("RGBA"), ts)
    return _cache[key]

d = json.load(open(SRC))
cols, rows, T = d["cols"], d["rows"], d.get("tile", 16)
img = Image.new("RGBA", (cols*T, rows*T), (201, 154, 99, 255))   # sand backdrop, like the editor

for L in d["layers"]:
    if L.get("type") == "image" or not L.get("visible", True):
        continue
    alpha = L.get("alpha", 1)
    layer_im = Image.new("RGBA", img.size, (0, 0, 0, 0))
    for i, t in enumerate(L.get("tiles") or []):
        if not t:
            continue
        sh, c, r = t
        src, ts = sheet(sh)
        tile = src.crop((c*ts, r*ts, c*ts+ts, r*ts+ts))
        if ts != T:
            tile = tile.resize((T, T), Image.NEAREST)
        layer_im.paste(tile, ((i % cols)*T, (i // cols)*T), tile)
    if alpha < 1:
        a = layer_im.getchannel("A").point(lambda p: int(p*alpha))
        layer_im.putalpha(a)
    img.alpha_composite(layer_im)

if SCALE != 1:
    img = img.resize((img.width*SCALE, img.height*SCALE), Image.NEAREST)
img.save(OUT)
print(f"{SRC} -> {OUT}  ({img.width}x{img.height}, grade {cols}x{rows}, tile {T}px)")
