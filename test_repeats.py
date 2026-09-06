"""Self-check for repeated-route detection. Run: python test_repeats.py"""
import math
import random
from datetime import datetime, timedelta

import repeats as R

HOME = (47.3769, 8.5417)          # Zurich
M_PER_DEG = 111320.0


def loop(centre=HOME, radius_m=800.0, n=400):
    """A circular loop of 2*pi*r metres, sampled n times. -> (points, metres)."""
    lat, lon = centre
    east = M_PER_DEG * math.cos(math.radians(lat))
    pts = [(lat + radius_m * math.sin(2 * math.pi * i / n) / M_PER_DEG,
            lon + radius_m * math.cos(2 * math.pi * i / n) / east)
           for i in range(n + 1)]
    return pts, 2 * math.pi * radius_m


def out_and_back(centre=HOME, total_m=5000.0, step=20.0):
    """Straight out due east for half the distance, then back. -> (points, metres)."""
    lat, lon = centre
    east = M_PER_DEG * math.cos(math.radians(lat))
    out = [(lat, lon + d / east) for d in _steps(total_m / 2.0, step)]
    return out + out[::-1], total_m


def _steps(limit, step):
    d = 0.0
    while d <= limit:
        yield d
        d += step


def jitter(points, metres=12.0, seed=1):
    """The same roads recorded on another day: every fix a few metres out."""
    rnd = random.Random(seed)
    return [(lat + rnd.uniform(-metres, metres) / M_PER_DEG,
             lon + rnd.uniform(-metres, metres) / M_PER_DEG) for lat, lon in points]


def make_run(gid, day, points, distance_m, moving_s):
    day0 = datetime(2025, 1, 1)
    return {"garmin_id": gid, "start": day0 + timedelta(days=day),
            "distance_m": distance_m, "moving_s": moving_s,
            "tiles": R.signature(points)}


# --------------------------------------------------------------------------- #
def test_signature_is_the_tracks_tiles():
    pts, _m = loop()
    tiles = R.signature(pts)
    assert 20 < len(tiles) < 100, len(tiles)      # a 5 km loop, ~200 m tiles
    assert all(isinstance(t, tuple) and len(t) == 2 for t in tiles)
    assert R.signature([]) == set()
    assert R.signature(None) == set()


def test_similarity_against_hand_computed_values():
    a, b = {(0, 0), (1, 0), (2, 0)}, {(1, 0), (2, 0), (3, 0)}
    assert R.similarity(a, b) == 0.5              # 2 shared of 4 in total
    assert R.similarity(a, a) == 1.0
    assert R.similarity(a, {(9, 9)}) == 0.0
    # A subset scores its own share -- the whole reason distance is checked too.
    assert R.similarity({(0, 0), (1, 0)}, {(0, 0), (1, 0), (2, 0), (3, 0)}) == 0.5
    assert R.similarity(a, set()) == 0.0
    assert R.similarity(set(), a) == 0.0


def test_two_empty_tile_sets_do_not_divide_by_zero():
    """Two runs with no GPS are two unknowns, not the same route."""
    assert R.similarity(set(), set()) == 0.0
    assert R.similarity(None, None) == 0.0


def test_the_same_route_recorded_twice_clusters():
    pts, metres = loop()
    runs = [make_run(1, 0, pts, metres, 1500),
            make_run(2, 7, jitter(pts, 12, seed=1), metres * 1.01, 1490),
            make_run(3, 14, jitter(pts, 40, seed=2), metres * 0.99, 1510)]
    groups = R.cluster(runs)
    assert len(groups) == 1, [len(g) for g in groups]
    assert [r["garmin_id"] for r in groups[0]] == [1, 2, 3]
    # Even 40 m of wobble leaves the tile sets plainly the same route.
    assert R.similarity(runs[0]["tiles"], runs[2]["tiles"]) > R.SAME_ROUTE


def test_a_sparsely_recorded_run_still_matches():
    """One fix every 125 m instead of every 12 m must not found a new route."""
    dense, metres = loop(n=400)
    sparse, _m = loop(n=40)
    assert R.similarity(R.signature(dense), R.signature(sparse)) > R.SAME_ROUTE
    groups = R.cluster([make_run(1, 0, dense, metres, 1500),
                        make_run(2, 3, sparse, metres, 1500)])
    assert len(groups) == 1


def test_a_different_route_does_not_join_the_cluster():
    pts, metres = loop()
    away, away_m = loop(centre=(47.4100, 8.5900))          # 4 km across town
    shifted, shifted_m = loop(centre=(47.3769 + 250 / M_PER_DEG, 8.5417))

    groups = R.cluster([make_run(1, 0, pts, metres, 1500),
                        make_run(2, 1, jitter(pts, 12), metres, 1520),
                        make_run(3, 2, away, away_m, 1500)])
    assert len(groups) == 2, [len(g) for g in groups]
    assert len(groups[0]) == 2 and len(groups[1]) == 1
    assert groups[1][0]["garmin_id"] == 3

    # Harder: a loop of the same length from the same door, one street north.
    # It shares real ground, so this is the case a lazy threshold gets wrong.
    near = R.similarity(R.signature(pts), R.signature(shifted))
    assert 0.0 < near < R.SAME_ROUTE, near
    assert len(R.cluster([make_run(1, 0, pts, metres, 1500),
                          make_run(2, 1, shifted, shifted_m, 1500)])) == 2


def test_half_a_route_is_not_the_same_route():
    """The subset trap: 5 km out and back down a road the 10 km version uses.

    Every tile of the short run is a tile of the long one, so the ground agrees
    and only the distance says otherwise.
    """
    short_pts, short_m = out_and_back(total_m=5000)
    long_pts, long_m = out_and_back(total_m=10000)
    short, long = R.signature(short_pts), R.signature(long_pts)
    assert short < long, "the fixture is meant to be a strict subset"
    assert R.similarity(short, long) > 0.5, "the trap has to be real to be worth guarding"

    runs = [make_run(1, 0, short_pts, short_m, 1450),
            make_run(2, 1, long_pts, long_m, 3000)]
    assert len(R.cluster(runs)) == 2

    # ...and it is the distance guard doing the work, not the threshold. Drop
    # the tile threshold below what the pair scores and they still stay apart;
    # only unbolting the distance check merges them.
    assert len(R.cluster(runs, threshold=0.4)) == 2
    assert len(R.cluster(runs, threshold=0.4, tolerance=10.0)) == 1


def test_a_slightly_longer_day_is_still_the_same_route():
    """The guard must not be so tight that an extra block founds a new route."""
    pts, metres = loop()
    runs = [make_run(1, 0, pts, metres, 1500),
            make_run(2, 7, jitter(pts, 15), metres * 1.08, 1620)]
    assert len(R.cluster(runs)) == 1


def test_runs_without_gps_are_not_a_route():
    pts, metres = loop()
    treadmill = {"garmin_id": 9, "start": datetime(2025, 2, 1),
                 "distance_m": 5000.0, "moving_s": 1500, "tiles": set()}
    groups = R.cluster([make_run(1, 0, pts, metres, 1500),
                        make_run(2, 1, jitter(pts), metres, 1500), treadmill])
    assert len(groups) == 1 and len(groups[0]) == 2
    assert R.cluster([treadmill]) == []


def test_clusters_come_back_most_run_first():
    pts, metres = loop()
    away, away_m = loop(centre=(47.4100, 8.5900))
    runs = [make_run(1, 0, away, away_m, 1500)]                 # founded first
    runs += [make_run(10 + i, 1 + i, jitter(pts, 10, seed=i), metres, 1500)
             for i in range(4)]
    groups = R.cluster(runs)
    assert [len(g) for g in groups] == [4, 1]


def test_progression_spots_a_genuine_improvement():
    pts, metres = loop()
    times = [1600, 1590, 1580, 1520, 1500, 1480]               # ~7% quicker
    runs = [make_run(i, i * 14, pts, metres, t) for i, t in enumerate(times)]
    p = R.progression(runs)
    assert p["count"] == 6 and p["timed"] == 6
    assert p["first"] == runs[0]["start"] and p["last"] == runs[-1]["start"]
    assert p["days"] == 70
    assert p["best_s"] == 1480 and p["best"]["garmin_id"] == 5
    assert p["latest_s"] == 1480
    assert p["change"] < -R.IMPROVEMENT, p["change"]
    assert p["improving"] is True
    assert abs(p["off_best"]) < 1e-9, "the last run is the best one"
    assert "quicker" in p["verdict"], p["verdict"]
    assert abs(p["distance_m"] - metres) < 1.0


def test_progression_spots_a_genuine_decline():
    pts, metres = loop()
    times = [1450, 1460, 1470, 1560, 1580, 1600]
    runs = [make_run(i, i * 14, pts, metres, t) for i, t in enumerate(times)]
    p = R.progression(runs)
    assert p["change"] > R.IMPROVEMENT, p["change"]
    assert p["improving"] is False
    assert p["best_s"] == 1450 and p["latest_s"] == 1600
    assert p["off_best"] > 0.09, p["off_best"]
    assert "slower" in p["verdict"], p["verdict"]


def test_progression_calls_a_flat_route_flat():
    pts, metres = loop()
    runs = [make_run(i, i * 7, pts, metres, t)
            for i, t in enumerate([1500, 1510, 1495, 1505])]
    p = R.progression(runs)
    assert abs(p["change"]) < R.IMPROVEMENT
    assert p["improving"] is False
    assert "Level" in p["verdict"], p["verdict"]


def test_a_faster_pace_over_a_shorter_day_is_not_a_course_record():
    """Pace is normalised to the route's own distance before anything is ranked.

    Run 2 cuts 600 m off the route and is quicker per kilometre for it -- 298.9
    against 300.0 s/km -- but Riegel says the shorter effort is worth 301 s/km
    over the full route, so run 1 still holds it.
    """
    pts, metres = loop()
    full = make_run(1, 0, pts, 5000.0, 1500)          # 300.0 s/km
    short = make_run(2, 7, pts, 4400.0, 1315)         # 298.9 s/km raw
    assert 1315 / 4.4 < 1500 / 5.0, "the naive comparison must favour the short one"
    p = R.progression([full, short])
    assert p["best"]["garmin_id"] == 1, p["best_pace"]
    assert p["best_pace"] < p["latest_pace"]


def test_a_longer_day_at_the_same_effort_is_not_a_slower_day():
    """Two runs 10% longer at the Riegel-equivalent effort: no trend at all."""
    pts, metres = loop()
    long_s = 1500 * (5500.0 / 5000.0) ** R.RIEGEL
    runs = [make_run(1, 0, pts, 5000.0, 1500), make_run(2, 7, pts, 5000.0, 1500),
            make_run(3, 14, pts, 5500.0, long_s), make_run(4, 21, pts, 5500.0, long_s)]
    naive = (long_s / 5.5) / (1500 / 5.0) - 1.0
    assert naive > 0.004, naive              # raw pace would call these slower
    p = R.progression(runs)
    assert abs(p["change"]) < 1e-6, p["change"]
    assert p["improving"] is False


def test_untimed_runs_still_count_as_repeats():
    pts, metres = loop()
    runs = [make_run(1, 0, pts, metres, 1500),
            make_run(2, 7, pts, metres, None),
            make_run(3, 14, pts, None, None)]
    p = R.progression(runs)
    assert p["count"] == 3 and p["timed"] == 1
    assert p["change"] is None and p["improving"] is None
    assert p["best_s"] == 1500
    assert "nothing to compare" in p["verdict"]

    none_timed = R.progression([make_run(4, 0, pts, None, None)])
    assert none_timed["best"] is None and none_timed["best_pace"] is None
    assert none_timed["verdict"] == "Never timed this route."


def test_shape_tells_a_loop_from_an_out_and_back():
    pts, metres = loop()
    assert R.shape(R.signature(pts), metres) == "loop"
    back_pts, back_m = out_and_back(total_m=8000)
    assert R.shape(R.signature(back_pts), back_m) == "out and back"
    assert R.shape(set(), 5000.0) == "route"
    assert R.shape(R.signature(pts), None) == "route"
    assert R.name_for(R.signature(pts), 8420.0) == "8.4 km loop"
    assert R.name_for(R.signature(back_pts), back_m) == "8.0 km out and back"
    assert R.name_for(set(), None) == "Unnamed route"


def test_summarise_keeps_only_the_routes_you_repeat():
    pts, metres = loop()
    away, away_m = loop(centre=(47.4100, 8.5900))
    runs = [make_run(100 + i, i * 7, jitter(pts, 10, seed=i), metres, 1600 - 20 * i)
            for i in range(5)]
    runs += [make_run(200 + i, 3 + i * 7, jitter(away, 10, seed=i), away_m, 1500)
             for i in range(2)]

    routes = R.summarise(runs)
    assert len(routes) == 1, [r["name"] for r in routes]
    route = routes[0]
    assert route["count"] == 5
    assert route["name"] == "5.0 km loop", route["name"]
    assert route["garmin_ids"] == [100, 101, 102, 103, 104]
    assert route["progression"]["improving"] is True
    assert route["tiles"] <= runs[0]["tiles"] | runs[1]["tiles"], "core, not invented"
    assert route["tiles"], "something has to be left to draw"

    # Loosen the bar and the twice-run route appears, still behind the main one.
    both = R.summarise(runs, min_repeats=2)
    assert [r["count"] for r in both] == [5, 2]


def test_summarise_names_routes_by_distance_and_shape():
    pts, metres = loop(radius_m=1340.0)                  # ~8.4 km
    back_pts, back_m = out_and_back(centre=(47.4100, 8.5900), total_m=10000)
    runs = [make_run(i, i * 5, jitter(pts, 10, seed=i), metres, 2500) for i in range(3)]
    runs += [make_run(50 + i, 2 + i * 5, jitter(back_pts, 10, seed=i), back_m, 3000)
             for i in range(4)]
    names = [r["name"] for r in R.summarise(runs)]
    assert names == ["10.0 km out and back", "8.4 km loop"], names


def test_core_tiles_drop_a_one_off_diversion():
    """A single run's detour is not part of the route, so it is not drawn."""
    pts, metres = loop()
    detour = list(pts) + [(47.3769 + 900 / M_PER_DEG, 8.5417 + 0.02)]
    runs = [make_run(1, 0, pts, metres, 1500),
            make_run(2, 7, pts, metres, 1500),
            make_run(3, 14, detour, metres * 1.05, 1600)]
    route = R.summarise(runs)[0]
    assert route["count"] == 3
    extra = runs[2]["tiles"] - runs[0]["tiles"]
    assert extra, "the fixture is meant to add ground"
    assert not (extra & route["tiles"]), "one run's detour leaked into the route"


def test_degenerate_input():
    assert R.cluster([]) == []
    assert R.summarise([]) == []
    assert R.progression([]) is None
    assert R.progression(None) is None

    pts, metres = loop()
    one = make_run(1, 0, pts, metres, 1500)
    assert R.cluster([one]) == [[one]]
    assert R.summarise([one]) == []
    alone = R.summarise([one], min_repeats=1)
    assert len(alone) == 1 and alone[0]["count"] == 1
    assert alone[0]["progression"]["change"] is None

    # No GPS anywhere: nothing to cluster, and nothing that crashes.
    blank = [{"garmin_id": i, "start": datetime(2025, 3, i + 1), "distance_m": 5000.0,
              "moving_s": 1500, "tiles": set()} for i in range(3)]
    assert R.cluster(blank) == []
    assert R.summarise(blank) == []

    # Tiles but no numbers at all, including no date.
    bare = {"garmin_id": 7, "tiles": R.signature(pts), "start": None,
            "distance_m": None, "moving_s": None}
    route = R.summarise([bare, dict(bare, garmin_id=8)], min_repeats=1)[0]
    assert route["name"] == "Unnamed route"
    assert route["progression"]["first"] is None and route["progression"]["days"] == 0
    assert route["shape"] == "route"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
