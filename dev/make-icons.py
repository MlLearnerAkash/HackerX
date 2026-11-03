#!/usr/bin/env python3
"""Generate the extension icons (orange tile + white upvote triangle).

Pure stdlib: no Pillow required. Renders at 4x and box-downsamples for
antialiasing, then writes PNGs with zlib + struct.
"""

import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
SIZES = (16, 32, 48, 128)
SS = 4  # supersample factor

BG = (255, 102, 0)  # Hacker News orange
FG = (255, 255, 255)


def rounded_rect_alpha(x, y, w, h, radius):
    """1 inside a rounded rect, 0 outside, in continuous coords."""
    cx = min(max(x, radius), w - radius)
    cy = min(max(y, radius), h - radius)
    dx, dy = x - cx, y - cy
    if dx == 0 and dy == 0:
        return 1.0
    d = (dx * dx + dy * dy) ** 0.5
    if d <= radius:
        return 1.0
    return 0.0


def triangle_inside(x, y, w, h, apex_y, base_y, half_width):
    """Is (x, y) inside an upward triangle centred horizontally?"""
    if y < apex_y or y > base_y:
        return False
    t = (y - apex_y) / (base_y - apex_y)
    half = half_width * t
    return abs(x - w / 2) <= half


def render(size):
    n = size * SS
    px = [[(0, 0, 0, 0) for _ in range(n)] for _ in range(n)]
    radius = n * 0.23
    pad = n * 0.26  # glyph box inset

    for yy in range(n):
        for xx in range(n):
            cx, cy = xx + 0.5, yy + 0.5
            if rounded_rect_alpha(cx, cy, n, n, radius) < 0.5:
                continue
            r, g, b = BG
            gx = (cx - pad) / (n - 2 * pad)
            gy = (cy - pad) / (n - 2 * pad)
            if triangle_inside(gx, gy, 1.0, 1.0, 0.08, 0.92, 0.42):
                r, g, b = FG
            px[yy][xx] = (r, g, b, 255)

    # Box downsample.
    out = bytearray()
    for y in range(size):
        for x in range(size):
            rs = gs = bs = a_s = 0
            for dy in range(SS):
                for dx in range(SS):
                    r, g, b, a = px[y * SS + dy][x * SS + dx]
                    rs += r * a
                    gs += g * a
                    bs += b * a
                    a_s += a
            cover = a_s / (SS * SS)
            if a_s:
                out.extend((rs // a_s, gs // a_s, bs // a_s, int(cover + 0.5)))
            else:
                out.extend((0, 0, 0, 0))
    return bytes(out)


def write_png(path, size, raw):
    stride = size * 4
    rows = b"".join(b"\x00" + raw[i * stride : (i + 1) * stride] for i in range(size))

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        write_png(os.path.join(OUT_DIR, f"icon{size}.png"), size, render(size))
        print(f"icons/icon{size}.png")


if __name__ == "__main__":
    main()
