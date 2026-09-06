"""Self-check for the trail coverage engine. Run: python test_trails.py"""
import math

import trails as T

LAT = 45.0        # everything happens at 45 N, where a degree of longitude is cos(45) wide


def east(lat, lng, metres):
    """A point `metres` due east of (lat, lng)."""
    return (lat, lng + metres / (T.M_PER_DEG_LAT * math.cos(math.radians(lat))))


def north(lat, lng, metres):
    """A point `metres` due north of (lat, lng)."""
    return (lat + metres / T.M_PER_DEG_LAT, lng)


def line_east(metres, lat=LAT, lng=0.0):
    """A straight two-point line running `metres` east."""
    return [(lat, lng), east(lat, lng, metres)]


def gaps(coords):
    return [T.dist_m(a[0], a[1], b[0], b[1]) for a, b in zip(coords, coords[1:])]


def mask(n, indices):
    """A hit mask of `n` nodes with `indices` set."""
    m = bytearray(n)
    for i in indices:
        m[i] = 1
    return m


def flat_seg(way_id, nodes, name=None, len_m=None, spacing=25.0):
    """A straight segment of `nodes` nodes, `spacing` metres apart."""
    coords = [east(LAT, 0.0, i * spacing) for i in range(nodes)]
    return T.Segment(id=way_id, coords=coords, name=name,
                     len_m=spacing * nodes if len_m is None else len_m)


def overpass_way(way_id, metres, tags=None):
    """One Overpass `way` element, straight and `metres` long."""
    return {"type": "way", "id": way_id, "tags": tags or {"highway": "path"},
            "geometry": [{"lat": la, "lon": ln} for la, ln in line_east(metres)]}


def test_dist_m_against_known_values():
    # A thousandth of a degree of latitude is 111.32 m anywhere on Earth.
    assert abs(T.dist_m(45.0, 0.0, 45.001, 0.0) - 111.32) < 0.001
    # A degree of longitude shrinks by the cosine of the latitude; at 60 N, half.
    assert abs(T.dist_m(60.0, 0.0, 60.0, 1.0) - T.M_PER_DEG_LAT * 0.5) < 0.001
    assert T.dist_m(45.0, 7.0, 45.0, 7.0) == 0.0
    assert abs(T.dist_m(45.0, 7.0, 45.01, 7.01) - T.dist_m(45.01, 7.01, 45.0, 7.0)) < 1e-9
    # 3-4-5: 300 m north and 400 m east is 500 m away.
    p = north(*east(LAT, 0.0, 400.0), 300.0)
    assert abs(T.dist_m(LAT, 0.0, p[0], p[1]) - 500.0) < 0.5


def test_resample_gives_even_spacing():
    coords, len_m = T.resample(line_east(1010), 25)
    assert abs(len_m - 1010) < 0.01, len_m
    assert len(coords) == 41, len(coords)        # 0, 25 ... 1000; the last 10 m is a stub
    assert all(abs(g - 25) < 0.01 for g in gaps(coords)), gaps(coords)
    # The true end is kept when it is more than half a step past the last node.
    ends_short, _ = T.resample(line_east(1020), 25)
    assert len(ends_short) == 42
    assert abs(gaps(ends_short)[-1] - 20) < 0.01


def test_resample_breaks_on_a_long_gap():
    """A drive between two trailheads must not paint a line across the map."""
    a0 = (LAT, 0.0)
    a1 = east(*a0, 100)
    b0 = east(*a0, 5000)
    b1 = east(*b0, 100)
    coords, len_m = T.resample([a0, a1, b0, b1], 25, 150)
    assert abs(len_m - 200) < 0.01, len_m        # the 4.9 km jump is not distance
    assert len(coords) == 10, len(coords)        # 5 nodes either side, nothing between
    jumps = [g for g in gaps(coords) if g > 150]
    assert len(jumps) == 1 and abs(jumps[0] - 4900) < 0.01, jumps
    # Without a gap limit the same points are joined right across the map.
    joined, joined_len = T.resample([a0, a1, b0, b1], 25)
    assert abs(joined_len - 5100) < 0.01
    assert len(joined) > 200


def test_a_track_along_a_trail_covers_every_node():
    coords, len_m = T.resample(line_east(1000), T.NODE_STEP_M)
    seg = T.Segment(id="w1", coords=coords, len_m=len_m, name="Ridge")
    track, _ = T.resample(line_east(1000), T.TRACK_STEP_M)
    hits = T.mark_hits(T.build_index([seg], T.DEFAULT_TOL_M), track)
    assert set(hits) == {"w1"}
    assert T.count_bits(hits["w1"]) == len(coords)
    assert T.covered_runs(hits["w1"]) == [(0, len(coords) - 1)]


def test_a_track_a_hundred_metres_away_marks_nothing():
    coords, len_m = T.resample(line_east(1000), T.NODE_STEP_M)
    seg = T.Segment(id="w1", coords=coords, len_m=len_m)
    track, _ = T.resample(line_east(1000), T.TRACK_STEP_M)
    parallel = [north(la, ln, 100) for la, ln in track]
    assert T.mark_hits(T.build_index([seg], T.DEFAULT_TOL_M), parallel) == {}


def test_tolerance_boundary():
    coords, len_m = T.resample(line_east(500), T.NODE_STEP_M)
    seg = T.Segment(id="w1", coords=coords, len_m=len_m)
    index = T.build_index([seg], 25)
    just_in = [north(la, ln, 24.9) for la, ln in coords]
    just_out = [north(la, ln, 25.1) for la, ln in coords]
    assert T.count_bits(T.mark_hits(index, just_in, 25)["w1"]) == len(coords)
    assert T.mark_hits(index, just_out, 25) == {}
    # Widening the tolerance picks the same track back up -- nothing is cached.
    assert T.count_bits(T.mark_hits(index, just_out, 30)["w1"]) == len(coords)


def test_a_crossing_track_marks_only_the_junction():
    """Running across a trail is not running it."""
    coords, len_m = T.resample(line_east(1000), T.NODE_STEP_M)
    seg = T.Segment(id="w1", coords=coords, len_m=len_m, name="Ridge")
    middle = len(coords) // 2
    mid = coords[middle]
    crossing, _ = T.resample([north(mid[0], mid[1], -200), north(mid[0], mid[1], 200)],
                             T.TRACK_STEP_M)
    hits = T.mark_hits(T.build_index([seg], 25), crossing)
    assert 1 <= T.count_bits(hits["w1"]) <= 3          # the junction node, maybe its neighbours
    runs = T.covered_runs(hits["w1"])
    assert len(runs) == 1
    assert runs[0][0] >= middle - 1 and runs[0][1] <= middle + 1


def test_threshold_and_first_touch_attribution():
    """A trail is done at 90%, and running it again is worth nothing."""
    seg = flat_seg("w1", 10, name="Ridge", len_m=250.0)      # 25 m per node
    acts = [
        {"id": "c", "date": "2026-05-03", "hits": {"w1": mask(10, range(9))}},   # a repeat
        {"id": "a", "date": "2026-05-01", "hits": {"w1": mask(10, range(8))}},   # 80%
        {"id": "b", "date": "2026-05-02", "hits": {"w1": mask(10, range(9))}},   # 90%
    ]
    ch = T.chronology(acts, [seg])          # deliberately handed over out of order
    assert ch["per_act"]["a"]["new_nodes"] == 8
    assert abs(ch["per_act"]["a"]["new_m"] - 200.0) < 1e-9
    assert ch["per_act"]["a"]["finished"] == []            # 80% is not done
    assert ch["per_act"]["b"]["new_nodes"] == 1            # the node that crossed the line
    assert ch["per_act"]["b"]["finished"] == ["n:ridge"]
    assert ch["done_on"] == {"n:ridge": "2026-05-02"}
    assert ch["per_act"]["c"]["new_nodes"] == 0            # a repeat lap is new ground for nobody
    assert ch["per_act"]["c"]["new_m"] == 0.0
    assert ch["per_act"]["c"]["finished"] == []            # and it does not finish it twice
    assert abs(ch["total_m"] - 225.0) < 1e-9
    assert [t["date"] for t in ch["timeline"]] == ["2026-05-01", "2026-05-02", "2026-05-03"]
    assert [t["cum_m"] for t in ch["timeline"]] == [200.0, 225.0, 225.0]


def test_a_trail_is_the_sum_of_its_ways():
    """Two ways sharing a name are one trail; 90% is 90% of both together."""
    a = flat_seg("w1", 10, name="Ridge", len_m=250.0)
    b = flat_seg("w2", 10, name="ridge", len_m=250.0)      # same trail, different case
    acts = [{"id": "a", "date": "2026-05-01", "hits": {"w1": mask(10, range(10))}}]
    ch = T.chronology(acts, [a, b])
    assert ch["done_on"] == {}                            # half of the trail is not done
    acts.append({"id": "b", "date": "2026-05-02",
                 "hits": {"w2": mask(10, range(8))}})     # 18 of 20 nodes
    ch = T.chronology(acts, [a, b])
    assert ch["done_on"] == {"n:ridge": "2026-05-02"}
    assert abs(ch["total_m"] - 450.0) < 1e-9


def test_chronology_respects_the_segment_filter():
    ridge = flat_seg("w1", 10, name="Ridge", len_m=250.0)
    pavement = flat_seg("w2", 10, name="High Street", len_m=250.0)
    acts = [{"id": "a", "date": "2026-05-01",
             "hits": {"w1": mask(10, range(10)), "w2": mask(10, range(10))}}]
    ch = T.chronology(acts, [ridge, pavement], allow_seg=lambda i: i == "w1")
    assert ch["per_act"]["a"]["new_nodes"] == 10          # the filtered way counted for nothing
    assert ch["done_on"] == {"n:ridge": "2026-05-01"}
    # Hits for a segment that is not loaded at all are ignored, not crashed on.
    stray = [{"id": "a", "date": "2026-05-01", "hits": {"w99": mask(4, [0, 1])}}]
    assert T.chronology(stray, [ridge])["total_m"] == 0.0


def test_union_coverage_ors_the_masks():
    acts = [{"hits": {"w1": mask(6, [0, 1])}},
            {"hits": {"w1": mask(6, [1, 4]), "w2": mask(3, [0])}}]
    cover = T.union_coverage(acts)
    assert list(cover["w1"]) == [1, 1, 0, 0, 1, 0]
    assert T.count_bits(cover["w1"]) == 3
    assert T.count_bits(cover["w2"]) == 1
    assert T.count_bits(acts[0]["hits"]["w1"]) == 2       # the source masks are untouched
    assert set(T.union_coverage(acts, allow_seg=lambda i: i != "w2")) == {"w1"}
    assert T.union_coverage([]) == {}


def test_covered_runs_finds_the_gaps():
    assert T.covered_runs(bytearray([0, 1, 1, 0, 1, 0, 0, 1])) == [(1, 2), (4, 4), (7, 7)]
    assert T.covered_runs(bytearray([1, 1, 1])) == [(0, 2)]
    assert T.covered_runs(bytearray(4)) == []
    assert T.covered_runs(bytearray()) == []


def test_trail_key_groups_by_name():
    a = T.Segment(id="1", coords=[], name="Blue Trail")
    b = T.Segment(id="2", coords=[], name="blue trail")
    c = T.Segment(id="3", coords=[], name=None)
    assert T.trail_key(a) == T.trail_key(b) == "n:blue trail"
    assert T.trail_key(c) == "w:3"
    # Two unnamed ways are two trails, not one unfinishable mega-trail.
    assert T.trail_key(c) != T.trail_key(T.Segment(id="4", coords=[]))
    assert T.trail_key(T.Segment(id=99, coords=[])) == "w:99"


def test_stitch_joins_ways_that_meet():
    p0, p1, p2 = (LAT, 0.0), east(LAT, 0.0, 100), east(LAT, 0.0, 200)
    a = T.Segment(id="w1", coords=[p0, p1])
    b = T.Segment(id="w2", coords=[p1, p2])
    chains = T.stitch_trail([a, b])
    assert len(chains) == 1
    assert chains[0]["pts"] == [p0, p1, p2]              # the shared node appears once
    assert abs(chains[0]["len_m"] - 200) < 0.01
    # Direction does not matter: OSM ways point whichever way the mapper drew them.
    for flipped in ([p2, p1], [p1, p0]):
        joined = T.stitch_trail([a, T.Segment(id="w2", coords=flipped)])
        assert len(joined) == 1 and len(joined[0]["pts"]) == 3, flipped
    # Ends within the join tolerance still count as meeting; beyond it they do not.
    near = T.Segment(id="w2", coords=[east(*p1, 40), east(*p1, 140)])
    assert len(T.stitch_trail([a, near])) == 1
    far = T.Segment(id="w2", coords=[east(*p1, 60), east(*p1, 160)])
    assert len(T.stitch_trail([a, far])) == 2
    # A spur that meets nothing is its own chain, and the spine sorts first.
    lonely = T.Segment(id="w3", coords=[east(LAT, 0.0, 5000), east(LAT, 0.0, 5050)])
    chains = T.stitch_trail([lonely, a, b])
    assert len(chains) == 2
    assert abs(chains[0]["len_m"] - 200) < 0.01 and abs(chains[1]["len_m"] - 50) < 0.01


def test_way_kind_buckets_and_motor_flag():
    assert T.way_kind({"highway": "path"}) == ("path", False)
    assert T.way_kind({"highway": "steps"}) == ("steps", False)
    assert T.way_kind({"highway": "cycleway"}) == ("cycleway", False)
    assert T.way_kind({"highway": "bridleway"}) == ("bridleway", False)
    assert T.way_kind({"highway": "footway"}) == ("path", False)
    assert T.way_kind({"highway": "footway", "footway": "sidewalk"}) == ("sidewalk", False)
    assert T.way_kind({"highway": "footway", "footway": "crossing"}) == ("sidewalk", False)
    assert T.way_kind({}) == ("path", False)
    assert T.way_kind(None) == ("path", False)
    # A track is a vehicle road until the tagging says otherwise.
    assert T.way_kind({"highway": "track"}) == ("track", True)
    assert T.way_kind({"highway": "track", "motor_vehicle": "no"}) == ("track", False)
    assert T.way_kind({"highway": "path", "atv": "designated"}) == ("path", True)
    assert T.way_kind({"highway": "path", "snowmobile": "yes"}) == ("path", True)
    assert T.way_kind({"highway": "path", "motorcycle": "permissive"}) == ("path", True)
    assert T.way_kind({"highway": "path", "atv": "no"}) == ("path", False)


def test_segments_from_overpass_inherits_relation_names():
    hiking = {"type": "relation", "id": 9, "tags": {"name": "Bruce Trail", "route": "hiking"},
              "members": [{"type": "way", "ref": 1}, {"type": "way", "ref": 2},
                          {"type": "node", "ref": 77}]}
    cycling = {"type": "relation", "id": 8, "tags": {"name": "Waterfront Loop",
                                                     "route": "bicycle"},
               "members": [{"type": "way", "ref": 1}]}
    ways = [overpass_way(1, 410),
            overpass_way(2, 410, {"highway": "track"}),
            overpass_way(3, 410, {"highway": "path", "name": "Own Name"})]

    for relations in ([hiking, cycling], [cycling, hiking]):
        segs = {s.id: s for s in T.segments_from_overpass({"elements": relations + ways},
                                                          region="r1")}
        assert set(segs) == {"1", "2", "3"}
        assert segs["1"].name == "Bruce Trail"      # a hiking route outranks the cycle route
        assert segs["2"].name == "Bruce Trail"
        assert segs["3"].name == "Own Name"         # the way's own name always wins

    seg = segs["1"]
    assert seg.kind == "path" and seg.motor is False
    assert segs["2"].kind == "track" and segs["2"].motor is True
    assert seg.region == "r1"
    assert abs(seg.len_m - 410) < 0.01
    assert len(seg.coords) == 17                    # 0, 25 ... 400
    assert seg.bbox[0] <= LAT <= seg.bbox[2]
    assert T.trail_key(seg) == T.trail_key(segs["2"]) == "n:bruce trail"


def test_segments_from_overpass_skips_junk():
    data = {"elements": [
        overpass_way(1, 5),                                        # a 5 m stub: one node
        {"type": "way", "id": 2, "tags": {"highway": "path"},
         "geometry": [{"lat": LAT, "lon": 0.0}]},                  # a single point
        {"type": "way", "id": 3, "tags": {"highway": "path"}},     # no geometry at all
        {"type": "node", "id": 4, "lat": LAT, "lon": 0.0},
        {"type": "relation", "id": 5, "tags": {"route": "hiking"}},  # unnamed relation
        overpass_way(6, 410),
    ]}
    assert [s.id for s in T.segments_from_overpass(data)] == ["6"]
    assert T.segments_from_overpass({}) == []
    assert T.segments_from_overpass({"elements": []}) == []
    assert T.segments_from_overpass(None) == []


def test_climb_m_ignores_gps_noise():
    assert T.climb_m([100.0, 100.4, 100.0, 100.6, 100.1]) == 0     # standing still
    assert T.climb_m([100.0, 110.0, 105.0, 115.0]) == 20
    assert T.climb_m([0.0, 1.0, 2.0, 3.0]) == 0                    # 1 m steps miss the floor
    assert T.climb_m([0.0, 1.0, 2.0, 3.0], 0) == 3                 # a smooth model needs no filter
    assert T.climb_m([200.0, 100.0]) == 0                          # descent is not climb
    assert T.climb_m([100.0, None, 130.0]) == 30                   # a dropped sample is not a cliff
    assert T.climb_m([]) == 0 and T.climb_m([100.0]) == 0


def test_streaks():
    days = ["2026-08-01", "2026-08-02", "2026-08-02", "2026-08-03", "2026-08-10", ""]
    s = T.streaks(days, today="2026-08-11")
    assert s["days"] == 4                             # duplicates and blanks collapse
    assert s["best"] == 3
    assert s["current"] == 1                          # yesterday still counts
    assert T.streaks(days, today="2026-08-10")["current"] == 1
    assert T.streaks(days, today="2026-08-12")["current"] == 0      # already lost it
    assert T.streaks(["2026-08-09", "2026-08-10"], today="2026-08-10")["current"] == 2
    assert T.day_diff("2026-08-01", "2026-09-01") == 31
    assert T.day_diff("nope", "2026-09-01") is None
    assert T.streaks(["nope", "2026-08-10"], today="2026-08-10")["best"] == 1


def test_none_and_nan_points_are_dropped():
    """Watches emit null and NaN samples; neither may crash or move a node."""
    nan = float("nan")
    coords, len_m = T.resample(
        [(LAT, 0.0), (None, 0.0), (LAT, nan), ("x", "y"), (LAT,), None,
         east(LAT, 0.0, 100)], 25)
    assert abs(len_m - 100) < 0.01
    assert len(coords) == 5
    seg = flat_seg("w1", 5)
    index = T.build_index([seg], 25)
    assert T.mark_hits(index, [(nan, nan), (None, None), (200.0, 0.0)]) == {}
    assert T.mark_hits(index, [(nan, nan)] + seg.coords) == {"w1": bytearray([1] * 5)}
    # Off-Earth coordinates go too, without taking the good ones with them.
    assert T.resample([(200.0, 0.0), (LAT, 0.0)], 25) == ([(LAT, 0.0)], 0.0)


def test_empty_and_degenerate_input():
    assert T.resample([], 25) == ([], 0.0)
    assert T.resample(None, 25) == ([], 0.0)
    assert T.resample([(LAT, 0.0)], 25) == ([(LAT, 0.0)], 0.0)
    assert T.resample([(LAT, 0.0), (LAT, 0.0)], 25) == ([(LAT, 0.0)], 0.0)   # zero length
    assert T.bbox_of([]) is None
    assert T.mark_hits(T.build_index([], 25), [(LAT, 0.0)]) == {}
    assert T.mark_hits(T.build_index([flat_seg("w1", 4)], 25), []) == {}
    assert T.stitch_trail([]) == []
    assert T.stitch_trail([T.Segment(id="w1", coords=[(LAT, 0.0)])]) == []   # cannot chain a point
    assert T.count_bits(bytearray()) == 0
    assert T.chronology([], []) == {"per_act": {}, "done_on": {}, "timeline": [],
                                    "total_m": 0.0}
    assert T.chronology([], [T.Segment(id="w1", coords=[])])["total_m"] == 0.0
    assert T.streaks([]) == {"current": 0, "best": 0, "days": 0}
    # A zero step would loop forever; it has to be refused, not survived.
    try:
        T.resample(line_east(100), 0)
        assert False, "a zero step must be rejected"
    except ValueError:
        pass


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
