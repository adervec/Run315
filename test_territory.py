"""Self-check for the territory game. Run: python test_territory.py"""
import math

import territory as T


def reference_tile(lat, lon, zoom):
    """The OSM wiki formula, written out independently of territory.py."""
    n = 2 ** zoom
    rad = math.radians(lat)
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.log(math.tan(rad) + 1.0 / math.cos(rad)) / math.pi) / 2.0 * n)
    return (x, y)


def test_tile_for_matches_the_reference_formula():
    for lat, lon in [(51.4779, -0.0015), (47.3769, 8.5417), (-33.8688, 151.2093),
                     (40.7128, -74.0060), (0.0, 0.0), (60.1699, 24.9384)]:
        for zoom in (12, 14, 17):
            assert T.tile_for(lat, lon, zoom) == reference_tile(lat, lon, zoom), (lat, lon, zoom)


def test_tile_for_known_points():
    # Greenwich observatory sits just west of the prime meridian, so it lands in
    # the last tile of the western half.
    x, y = T.tile_for(51.4779, -0.0015, zoom=17)
    assert x == 2 ** 17 // 2 - 1, x
    # Tile 0,0 is the top-left of the world.
    assert T.tile_for(85.0, -179.999, zoom=1) == (0, 0)
    assert T.tile_for(-85.0, 179.999, zoom=1) == (1, 1)
    # Zoom 0 is one tile for the whole planet.
    assert T.tile_for(47.37, 8.54, zoom=0) == (0, 0)


def test_tile_for_rejects_junk():
    assert T.tile_for(None, 8.0) is None
    assert T.tile_for(47.0, None) is None
    assert T.tile_for("nope", 8.0) is None
    assert T.tile_for(47.0, 500.0) is None
    assert T.tile_for(200.0, 8.0) is None
    assert T.tile_for(float("nan"), 8.0) is None
    # Beyond the Mercator limit clamps rather than exploding.
    assert T.tile_for(89.9, 0.0, zoom=5) is not None


def test_tile_bounds_round_trip():
    lat, lon = 47.3769, 8.5417                       # Zurich
    x, y = T.tile_for(lat, lon)
    south, west, north, east = T.tile_bounds(x, y)
    assert south < lat < north, (south, lat, north)
    assert west < lon < east, (west, lon, east)
    # Neighbouring tiles share an edge exactly.
    assert abs(T.tile_bounds(x + 1, y)[1] - east) < 1e-9


def test_tile_size_shrinks_toward_the_poles():
    equator = T.tile_size_m(T.tile_for(0.0, 0.0)[1])
    zurich = T.tile_size_m(T.tile_for(47.0, 8.0)[1])
    assert 290 < equator < 320, equator               # ~305 m at z17
    assert zurich < equator
    assert abs(zurich - equator * math.cos(math.radians(47.0))) < 5


def test_tiles_for_track_bridges_gaps():
    # Two points far apart in tile terms must leave a continuous trail.
    a = (47.3769, 8.5417)
    b = (47.3769, 8.5600)
    claimed = T.tiles_for_track([a, b])
    xs = sorted(t[0] for t in claimed)
    assert len(claimed) > 3
    assert xs == list(range(xs[0], xs[-1] + 1)), "gap in the bridged trail"
    assert len({t[1] for t in claimed}) <= 2          # same latitude, one row


def test_tiles_for_track_ignores_teleports():
    """A GPS glitch across the country must not paint a line through it."""
    near = T.tiles_for_track([(47.37, 8.54), (47.371, 8.541)])
    far = T.tiles_for_track([(47.37, 8.54), (52.52, 13.40)])   # Zurich -> Berlin
    assert len(far) == 2, len(far)
    assert len(near) >= 2


def test_tiles_for_track_edges():
    assert T.tiles_for_track([]) == set()
    assert T.tiles_for_track([(None, None)]) == set()
    assert T.tiles_for_track([(47.0, 8.0), (47.0, 8.0)]) == {T.tile_for(47.0, 8.0)}
    assert len(T.tiles_for_track([(47.0, 8.0), None, (47.0, 8.0)])) == 1


def test_max_square():
    assert T.max_square(set()) == (0, None)
    assert T.max_square({(5, 5)}) == (1, (5, 5))

    # A solid 3x3 block.
    block = {(x, y) for x in range(10, 13) for y in range(20, 23)}
    size, corner = T.max_square(block)
    assert size == 3 and corner == (10, 20)

    # Every 2x2 window inside a 3x3 contains the centre, so losing the centre
    # drops the best square all the way to 1.
    holed = set(block)
    holed.discard((11, 21))
    assert T.max_square(holed)[0] == 1

    # Losing a corner instead still leaves a 2x2.
    cornerless = set(block)
    cornerless.discard((12, 22))
    assert T.max_square(cornerless)[0] == 2

    # A long thin line is never more than 1.
    assert T.max_square({(x, 0) for x in range(50)})[0] == 1

    # The reported corner really is the top-left of a solid square.
    big = {(x, y) for x in range(4) for y in range(4)} | {(100, 100)}
    size, corner = T.max_square(big)
    assert size == 4
    assert T.square_tiles(size, corner) <= big


def test_max_cluster():
    assert T.max_cluster(set()) == (0, set())
    # Two islands: 4-connected group of 5, and a lone tile.
    tiles = {(0, 0), (1, 0), (2, 0), (2, 1), (2, 2), (50, 50)}
    size, group = T.max_cluster(tiles)
    assert size == 5
    assert (50, 50) not in group
    # Diagonals do not connect.
    assert T.max_cluster({(0, 0), (1, 1)})[0] == 1


def test_frontier():
    assert T.frontier(set()) == set()
    edge = T.frontier({(0, 0)})
    assert edge == {(1, 0), (-1, 0), (0, 1), (0, -1)}
    # Interior tiles of a block contribute nothing to the frontier.
    block = {(x, y) for x in range(3) for y in range(3)}
    assert (1, 1) not in T.frontier(block)
    assert len(T.frontier(block)) == 12
    assert len(T.frontier(block, limit=5)) == 5


def test_near_miss_squares():
    # A 3x3 with one hole: exactly one tile completes it.
    block = {(x, y) for x in range(3) for y in range(3)}
    block.discard((1, 1))
    misses = T.near_miss_squares(block, 3)
    assert misses[0][0] == ((1, 1),)
    assert misses[0][1] == (0, 0)
    # A window that is already complete is not a "near miss" -- but windows
    # offset from it still are, which is exactly what growth suggestions need.
    full = {(x, y) for x in range(3) for y in range(3)}
    misses = T.near_miss_squares(full, 3)
    corners = [c for _, c in misses]
    assert (0, 0) not in corners, "the completed square should not be suggested"
    assert all(1 <= len(m) <= T._MAX_GAP for m, _ in misses)
    assert misses, "offset windows are still reachable"
    assert T.near_miss_squares(set(), 3) == []
    assert T.near_miss_squares(full, 0) == []


def test_square_growth_targets():
    assert T.square_growth_targets(set()) == []

    # A solid 2x2. Growing to 3x3 needs 5 more tiles wherever you put it.
    block = {(x, y) for x in range(2) for y in range(2)}
    targets = T.square_growth_targets(block)
    assert targets, "should suggest something"
    assert all(size == 3 for _, size, _ in targets)
    assert all(t not in block for t, _, _ in targets)
    assert targets[0][2] == 5

    # An almost-complete 3x3 should suggest the single missing tile first,
    # because that is the cheapest way to reach 3.
    almost = {(x, y) for x in range(3) for y in range(3)} - {(2, 2)}
    best = T.square_growth_targets(almost)
    assert best[0][0] == (2, 2) and best[0][1] == 3 and best[0][2] == 1


def test_stats_and_coverage():
    tiles = {(x, y) for x in range(4) for y in range(4)}
    s = T.stats(tiles)
    assert s["tiles"] == 16
    assert s["max_square"] == 4
    assert s["max_cluster"] == 16
    assert s["area_km2"] > 0
    assert s["zoom"] == T.DEFAULT_ZOOM
    assert s["new_tiles"] == 0

    # new_tiles counts only what is genuinely new.
    assert T.stats(tiles, new_tiles={(0, 0), (99, 99)})["new_tiles"] == 1

    empty = T.stats(set())
    assert empty["tiles"] == 0 and empty["max_square"] == 0 and empty["area_km2"] == 0

    assert T.area_coverage(tiles, None) is None
    full = {(x, y) for x in range(-1, 2) for y in range(-1, 2)}
    assert abs(T.area_coverage(full, (0, 0), radius_tiles=1) - 1.0) < 1e-9
    assert T.area_coverage(set(), (0, 0), radius_tiles=1) == 0.0


def test_home_tile():
    assert T.home_tile({}) is None
    assert T.home_tile({(1, 1): 3, (2, 2): 9, (3, 3): 1}) == (2, 2)


def test_a_real_looking_run_claims_a_sensible_amount():
    """A 5 km loop should claim tens of tiles, not thousands."""
    lat, lon = 47.3769, 8.5417
    pts, r = [], 0.009                      # ~1 km radius circle
    for i in range(200):
        a = 2 * math.pi * i / 200
        pts.append((lat + r * math.sin(a), lon + r * math.cos(a) / math.cos(math.radians(lat))))
    claimed = T.tiles_for_track(pts)
    assert 20 < len(claimed) < 200, len(claimed)
    assert T.max_cluster(claimed)[0] == len(claimed), "a loop should be one blob"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
