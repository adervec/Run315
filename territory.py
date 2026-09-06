"""intvl -- the territory game.

Every run claims the map tiles it passes through. Ground you have never covered
stays fogged. The scores are the ones that make you plan routes differently:
total tiles, the biggest solid square you own, and the biggest connected blob.

Pure functions over (lat, lon) points and tile sets. No I/O, no dependencies.
See test_territory.py.
"""
import math
from collections import deque

# Web Mercator slippy tiles. z17 is ~305 m at the equator, which is the right
# grain for running: a tile is a block or two, so a new street is a new tile.
DEFAULT_ZOOM = 17
MERCATOR_LIMIT = 85.05112878          # Web Mercator is undefined past this


def tile_for(lat, lon, zoom=DEFAULT_ZOOM):
    """(lat, lon) -> (x, y) slippy tile. None if the point is not on Earth."""
    if lat is None or lon is None:
        return None
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    if not (-180.0 <= lon <= 180.0) or not (-90.0 <= lat <= 90.0):
        return None
    if lat != lat or lon != lon:      # NaN
        return None
    lat = max(-MERCATOR_LIMIT, min(MERCATOR_LIMIT, lat))
    n = 2 ** zoom
    x = int((lon + 180.0) / 360.0 * n)
    rad = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(rad)) / math.pi) / 2.0 * n)
    return (min(x, n - 1), min(max(y, 0), n - 1))


def tile_bounds(x, y, zoom=DEFAULT_ZOOM):
    """(x, y) -> (south, west, north, east) in degrees, for drawing the square."""
    n = 2.0 ** zoom

    def lat_at(ty):
        return math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * ty / n))))

    return (lat_at(y + 1), x / n * 360.0 - 180.0,
            lat_at(y), (x + 1) / n * 360.0 - 180.0)


def tile_size_m(y, zoom=DEFAULT_ZOOM):
    """Ground width of a tile at this row, in metres. Shrinks toward the poles."""
    south, west, north, east = tile_bounds(0, y, zoom)
    mid_lat = (south + north) / 2.0
    return 40075016.686 * math.cos(math.radians(mid_lat)) / (2.0 ** zoom)


def tiles_for_track(points, zoom=DEFAULT_ZOOM):
    """[(lat, lon), ...] -> set of tiles the track touches.

    Consecutive points are bridged, so a fast-moving or sparsely sampled track
    does not leave holes in the trail of tiles it obviously ran through.
    """
    claimed, prev = set(), None
    for p in points:
        if not p or len(p) < 2:
            continue
        t = tile_for(p[0], p[1], zoom)
        if t is None:
            continue
        if prev is not None and t != prev:
            claimed.update(_bridge(prev, t))
        claimed.add(t)
        prev = t
    return claimed


def _bridge(a, b, max_span=64):
    """Tiles on the straight line between two tiles (Bresenham).

    A jump longer than `max_span` tiles is a GPS glitch or a drive between two
    runs, not a route -- those endpoints are kept but the gap is not filled in.
    """
    x0, y0 = a
    x1, y1 = b
    if abs(x1 - x0) > max_span or abs(y1 - y0) > max_span:
        return {a, b}

    out = set()
    dx, dy = abs(x1 - x0), -abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx + dy
    while True:
        out.add((x0, y0))
        if x0 == x1 and y0 == y1:
            return out
        e2 = 2 * err
        if e2 >= dy:
            err += dy
            x0 += sx
        if e2 <= dx:
            err += dx
            y0 += sy


# --------------------------------------------------------------------------- #
# scores
# --------------------------------------------------------------------------- #
def max_square(tiles):
    """Largest solid n x n block of claimed tiles. -> (n, (x, y) of its top-left).

    Classic largest-square DP, but over a sparse dict so the empty ocean between
    your home and everywhere else costs nothing.
    """
    if not tiles:
        return (0, None)
    dp = {}
    best, corner = 0, None
    for (x, y) in sorted(tiles, key=lambda t: (t[1], t[0])):
        n = 1 + min(dp.get((x - 1, y), 0),
                    dp.get((x, y - 1), 0),
                    dp.get((x - 1, y - 1), 0))
        dp[(x, y)] = n
        if n > best:
            best, corner = n, (x - n + 1, y - n + 1)
    return (best, corner)


def max_cluster(tiles):
    """Largest 4-connected group of claimed tiles. -> (size, set_of_tiles)."""
    remaining = set(tiles)
    best = set()
    while remaining:
        seed = remaining.pop()
        group, queue = {seed}, deque([seed])
        while queue:
            x, y = queue.popleft()
            for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if n in remaining:
                    remaining.discard(n)
                    group.add(n)
                    queue.append(n)
        if len(group) > len(best):
            best = group
    return (len(best), best)


def square_tiles(size, corner):
    """Every tile inside a max_square() result, for drawing it."""
    if not size or not corner:
        return set()
    x0, y0 = corner
    return {(x0 + dx, y0 + dy) for dx in range(size) for dy in range(size)}


def frontier(tiles, limit=None):
    """Unclaimed tiles touching claimed ones -- the edge of your fog."""
    edge = set()
    for (x, y) in tiles:
        for n in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if n not in tiles:
                edge.add(n)
    if limit is None:
        return edge
    return set(sorted(edge)[:limit])


_MAX_GAP = 6      # a window needing more than this is not a near miss


def near_miss_squares(tiles, size, max_gap=_MAX_GAP):
    """Every `size` x `size` window missing between 1 and `max_gap` tiles.

    -> [(missing_tiles_tuple, corner)], cheapest first. A 2D prefix sum counts
    each window in constant time, so this stays fast over a whole city.
    """
    if not tiles or size < 1:
        return []
    xs = [t[0] for t in tiles]
    ys = [t[1] for t in tiles]
    x0, x1 = min(xs) - size + 1, max(xs)
    y0, y1 = min(ys) - size + 1, max(ys)
    w, h = x1 - x0 + size, y1 - y0 + size

    # ps[j][i] = claimed tiles in the rectangle above-left of (x0+i, y0+j)
    ps = [[0] * (w + 1) for _ in range(h + 1)]
    for j in range(h):
        row = ps[j + 1]
        prev = ps[j]
        for i in range(w):
            row[i + 1] = (row[i] + prev[i + 1] - prev[i]
                          + (1 if (x0 + i, y0 + j) in tiles else 0))

    out = []
    for j in range(h - size + 1):
        for i in range(w - size + 1):
            have = (ps[j + size][i + size] - ps[j][i + size]
                    - ps[j + size][i] + ps[j][i])
            gap = size * size - have
            if 1 <= gap <= max_gap:
                cx, cy = x0 + i, y0 + j
                missing = tuple((cx + dx, cy + dy)
                                for dx in range(size) for dy in range(size)
                                if (cx + dx, cy + dy) not in tiles)
                out.append((missing, (cx, cy)))
    out.sort(key=lambda m: (len(m[0]), m[1]))
    return out


def square_growth_targets(tiles, limit=12):
    """Which unclaimed tiles would grow your max square, and what it takes.

    This is the question the game actually asks: not "where have I not been"
    but "where do I run to make the square bigger".
    -> [(tile, new_size, tiles_still_needed)], easiest win first.
    """
    if not tiles:
        return []
    target = max_square(tiles)[0] + 1
    best = {}
    for missing, _corner in near_miss_squares(tiles, target):
        for m in missing:
            if m not in best or len(missing) < best[m]:
                best[m] = len(missing)
    ranked = sorted(best.items(), key=lambda kv: (kv[1], kv[0]))[:limit]
    return [(t, target, cost) for t, cost in ranked]


def stats(tiles, new_tiles=(), zoom=DEFAULT_ZOOM):
    """The scoreboard."""
    sq_size, sq_corner = max_square(tiles)
    cl_size, cluster = max_cluster(tiles)
    rows = sorted(t[1] for t in tiles)
    metres = tile_size_m(rows[len(rows) // 2], zoom) if rows else 0.0
    return {
        "tiles": len(tiles),
        "new_tiles": len(set(new_tiles) - set(tiles)) if new_tiles else 0,
        "max_square": sq_size,
        "square_corner": sq_corner,
        "max_cluster": cl_size,
        "cluster": cluster,
        "tile_metres": metres,
        "area_km2": len(tiles) * (metres / 1000.0) ** 2,
        "zoom": zoom,
    }


def area_coverage(tiles, centre, radius_tiles=12):
    """What share of a square area around `centre` you have claimed. 0..1."""
    if not centre:
        return None
    cx, cy = centre
    total = (radius_tiles * 2 + 1) ** 2
    have = sum(1 for dx in range(-radius_tiles, radius_tiles + 1)
               for dy in range(-radius_tiles, radius_tiles + 1)
               if (cx + dx, cy + dy) in tiles)
    return have / float(total)


def home_tile(tiles_with_counts):
    """Most-visited tile -- where you start from. `{tile: times_run}` -> tile."""
    if not tiles_with_counts:
        return None
    return max(tiles_with_counts.items(), key=lambda kv: (kv[1], kv[0]))[0]
