"""Draw the PWA icons. Run once, commit the result: python icons.py

A 5x7 bitmap font and a hand-rolled PNG writer, because the alternative is a
build dependency for two files that change roughly never. The glyphs sit well
inside the 80% safe circle, so the same image works as a maskable icon and
Android will not crop the 315 off.
"""
import struct
import sys
import zlib
from pathlib import Path

INK = (0x10, 0x18, 0x28)            # --ink
SOFT = (0xe0, 0xf0, 0xf2)           # --measured-soft

GLYPHS = {
    "3": [".111.", "1...1", "....1", "..11.", "....1", "1...1", ".111."],
    "1": ["..1..", ".11..", "..1..", "..1..", "..1..", "..1..", ".111."],
    "5": ["11111", "1....", "1....", "1111.", "....1", "1...1", ".111."],
}


def word(text, gap=1):
    """The word as a grid of 0/1 rows."""
    rows = []
    for y in range(7):
        row = []
        for i, ch in enumerate(text):
            if i:
                row += [0] * gap
            row += [1 if c == "1" else 0 for c in GLYPHS[ch][y]]
        rows.append(row)
    return rows


def png(path, size, grid, share=0.58):
    """Square PNG: grid centred at `share` of the width, ink behind it."""
    gh, gw = len(grid), len(grid[0])
    scale = max(1, round(size * share / gw))
    ox, oy = (size - gw * scale) // 2, (size - gh * scale) // 2

    bg, fg = bytes(INK), bytes(SOFT)
    raw = bytearray()
    for y in range(size):
        raw.append(0)                                    # filter: none
        gy = (y - oy) // scale
        row = grid[gy] if 0 <= gy < gh else None
        for x in range(size):
            gx = (x - ox) // scale
            raw += fg if (row and 0 <= gx < gw and row[gx]) else bg

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

    Path(path).write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b""))
    return path


if __name__ == "__main__":
    grid = word("315")
    for size in (192, 512):
        out = png("static/icon-%d.png" % size, size, grid)
        print("%s  %d bytes" % (out, Path(out).stat().st_size))

    # The safe circle for a maskable icon is the middle 80%. Check the corners
    # of the drawn word land inside it, or Android will shave the digits.
    gh, gw = len(grid), len(grid[0])
    scale = round(512 * 0.58 / gw)
    half_w, half_h = gw * scale / 2.0, gh * scale / 2.0
    corner = (half_w ** 2 + half_h ** 2) ** 0.5
    assert corner < 512 * 0.40, "the word overflows the maskable safe circle"
    print("safe circle: word corner at %.0fpx of %.0fpx" % (corner, 512 * 0.40))
    sys.exit(0)
