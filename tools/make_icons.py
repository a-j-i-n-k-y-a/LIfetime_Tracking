"""Generate the PWA icons as PNGs with nothing but the standard library."""
import struct
import zlib
import os

BG = (59, 32, 25)        # brown
GOOD = (128, 171, 215)   # blue
BAD = (216, 67, 76)      # lifted red
PAST = (86, 48, 37)      # lived, unlogged

# 6x6 lattice of a life: mostly logged, a few rough days, a tail not yet lived.
PATTERN = [
    "ggrgg.",
    "gggrg.",
    "rggggg",
    "ggrggr",
    "gggg..",
    "gr....",
]

COLORS = {"g": GOOD, "r": BAD, ".": PAST}


def write_png(path, size, inset_ratio):
    """Draw the lattice centred in a square canvas and write it out."""
    grid = len(PATTERN)
    inset = int(size * inset_ratio)
    span = size - 2 * inset
    step = span / grid
    cell = step * 0.78  # leave a gutter between squares
    radius = size * 0.5

    rows = []
    for y in range(size):
        row = bytearray()
        row.append(0)  # PNG filter type: none
        for x in range(size):
            color = BG
            gx = (x - inset) / step
            gy = (y - inset) / step
            if 0 <= gx < grid and 0 <= gy < grid:
                fx = (gx % 1) * step
                fy = (gy % 1) * step
                if fx < cell and fy < cell:
                    color = COLORS[PATTERN[int(gy)][int(gx)]]
            row.extend(color)
            # Fully opaque inside the icon, transparent outside for the
            # non-maskable variants so the rounded shape reads on any launcher.
            if inset_ratio > 0.1:
                row.append(255)
            else:
                dx = x - size / 2 + 0.5
                dy = y - size / 2 + 0.5
                row.append(255 if dx * dx + dy * dy <= radius * radius else 0)
        rows.append(bytes(row))

    raw = b"".join(rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))

    with open(path, "wb") as handle:
        handle.write(png)
    print(f"{path}  {size}x{size}  {len(png):,} bytes")


out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")

os.makedirs(out, exist_ok=True)

write_png(os.path.join(out, "icon-192.png"), 192, 0.08)
write_png(os.path.join(out, "icon-512.png"), 512, 0.08)
# Maskable icons get aggressively cropped by Android launchers, so keep the
# artwork inside the inner 60% safe zone.
write_png(os.path.join(out, "icon-maskable-512.png"), 512, 0.20)
