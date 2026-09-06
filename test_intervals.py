"""Self-check for track and interval analysis. Run: python test_intervals.py"""
import math

import intervals as I


def session(reps, rep_m, rep_pace, rec_s, rec_pace=330.0, warmup_m=1000.0,
            warmup_pace=330.0, step=5.0, hr_work=178, hr_rest=140):
    """Build a stream for `reps` x `rep_m` with jog recoveries.

    step is metres between samples; paces are seconds per km.
    """
    out, t, d = [], 0.0, 0.0

    def leg(metres, pace, hr):
        nonlocal t, d
        n = max(int(metres / step), 1)
        for _ in range(n):
            d += metres / n
            t += (metres / n) / 1000.0 * pace
            out.append((round(t, 2), round(d, 2), hr))

    out.append((0.0, 0.0, hr_rest))
    leg(warmup_m, warmup_pace, hr_rest)
    for i in range(reps):
        leg(rep_m, rep_pace, hr_work)
        if i < reps - 1:
            leg(rec_s / (rec_pace / 1000.0), rec_pace, hr_rest)
    leg(warmup_m, warmup_pace, hr_rest)
    return out


def test_clean_and_speed_series():
    assert I.speed_series([]) == []
    assert I.speed_series([(0, 0, None), (1, 5, None)]) == []
    s = I.speed_series([(0, 0, 100), (1, 3, 100), (2, 6, 100), (3, 9, 100), (4, 12, 100)])
    assert len(s) == 5
    assert all(abs(p[2] - 3.0) < 0.2 for p in s), [p[2] for p in s]
    # Junk in, nothing out.
    assert I.speed_series([(None, 1, 1), ("x", 2, 1), (float("nan"), 3, 1)]) == []
    # Distance never goes backwards.
    back = I.speed_series([(0, 0, None), (1, 10, None), (2, 4, None), (3, 20, None),
                           (4, 30, None), (5, 40, None)])
    assert all(p[2] >= 0 for p in back)


def test_otsu_splits_two_clusters():
    assert I.otsu_threshold([]) is None
    assert I.otsu_threshold([5.0] * 20) is None
    cut = I.otsu_threshold([3.0] * 50 + [6.0] * 50)
    assert 3.0 < cut < 6.0, cut
    # Lopsided sets still split in the gap.
    cut2 = I.otsu_threshold([3.0] * 90 + [6.0] * 10)
    assert 3.0 < cut2 < 6.0, cut2


def test_snap_distance():
    assert I.snap_distance(402) == 400
    assert I.snap_distance(387) == 400          # a GPS-short lap of the oval
    assert I.snap_distance(415) == 400
    assert I.snap_distance(1580) == 1600
    assert I.snap_distance(250) is None         # genuinely between distances
    assert I.snap_distance(0) is None
    assert I.snap_distance(None) is None


def test_detects_a_clean_400_session():
    """8 x 400 m at 75 s with 90 s jog: all eight reps, right distance and pace."""
    stream = session(8, 400.0, 187.5, 90.0)     # 187.5 s/km == 75 s per 400
    reps = I.detect_reps(stream)
    assert len(reps) == 8, len(reps)
    for r in reps:
        assert abs(r["distance_m"] - 400) < 60, r["distance_m"]
        assert r["snapped_m"] == 400
        assert abs(r["seconds"] - 75) < 12, r["seconds"]
        assert r["avg_hr"] and r["avg_hr"] > 165
    assert [r["n"] for r in reps] == list(range(1, 9))
    assert all(r["recovery_s"] for r in reps[:-1])
    assert reps[-1]["recovery_s"] is None
    assert all(abs(r["recovery_s"] - 90) < 20 for r in reps[:-1]), \
        [r["recovery_s"] for r in reps[:-1]]


def test_warmup_and_cooldown_are_not_reps():
    """A steady run with no hard bits has no rep structure worth reporting."""
    steady = session(0, 0, 0, 0, warmup_m=8000.0, warmup_pace=300.0)
    assert I.analyse(steady) is None
    # And a single hard effort is not a "session" either.
    one = session(1, 1000.0, 190.0, 0)
    assert I.analyse(one) is None


def test_traffic_lights_do_not_make_a_steady_run_look_like_intervals():
    """Regression: a standing stop is bimodal against running, but it is not a rep.

    Two red lights in an easy run had every steady run reporting itself as an
    interval session.
    """
    stream, t, d = [(0.0, 0.0, 145)], 0.0, 0.0
    for km in range(8):
        for _ in range(200):                 # 5 m steps at a steady 5:30/km
            d += 5.0
            t += 5.0 / 1000.0 * 330.0
            stream.append((round(t, 2), round(d, 2), 145))
        if km in (1, 5):                     # stand at the lights
            for _ in range(6):
                t += 4.0
                stream.append((round(t, 2), round(d, 2), 138))
    assert I.analyse(stream) is None, I.analyse(stream)

    # A real session with jog recoveries still registers, stops or not.
    real = session(6, 800.0, 195.0, 120.0)
    assert I.analyse(real) is not None


def test_one_walk_break_in_a_long_run_is_not_a_session():
    """A 20 km run with a single walk break is two gears, but it is not intervals.

    In a session the reps are a minority of the running; here the running is
    almost all of it.
    """
    stream, t, d = [(0.0, 0.0, 150)], 0.0, 0.0
    for step in range(4000):                 # 20 km in 5 m steps
        pace = 460.0 if 3100 <= step < 3160 else 300.0   # a 300 m walk at 16 km
        d += 5.0
        t += 5.0 / 1000.0 * pace
        stream.append((round(t, 2), round(d, 2), 152))
    assert I.analyse(stream) is None, I.analyse(stream)["name"]


def test_mixed_ladder_is_described_as_a_range():
    stream = []
    t = d = 0.0
    for metres in (1200.0, 800.0, 400.0):
        for pace, dist in ((330.0, 400.0), (190.0, metres)):
            n = int(dist / 5)
            for _ in range(n):
                d += 5.0
                t += 5.0 / 1000.0 * pace
                stream.append((round(t, 2), round(d, 2), 175 if pace < 250 else 140))
    reps = I.detect_reps(stream)
    assert len(reps) == 3, len(reps)
    assert sorted(r["snapped_m"] for r in reps) == [400, 800, 1200]
    assert I.describe(reps) == "3 reps, 400-1200 m"


def test_describe():
    assert I.describe([]) is None
    assert I.describe([{"snapped_m": 400, "pace": 190, "distance_m": 400}] * 6) == "6 x 400 m"
    odd = [{"snapped_m": None, "pace": 200, "distance_m": 505},
           {"snapped_m": None, "pace": 200, "distance_m": 500}]
    assert I.describe(odd) == "2 x ~500 m"


def test_consistency_and_fade():
    even = [{"pace": 190.0}, {"pace": 190.0}, {"pace": 190.0}, {"pace": 190.0}]
    assert I.consistency(even) == 0.0
    assert I.fade(even) == 0.0
    assert I.consistency([{"pace": 190.0}]) is None
    assert I.fade(even[:2]) is None

    faded = [{"pace": 180.0}, {"pace": 182.0}, {"pace": 195.0}, {"pace": 200.0}]
    assert I.fade(faded) > 0.05, I.fade(faded)
    assert I.consistency(faded) > 0.01

    negative = [{"pace": 200.0}, {"pace": 196.0}, {"pace": 184.0}, {"pace": 180.0}]
    assert I.fade(negative) < 0


def test_looks_like_track():
    # 12 laps of a 400 m oval: lots of distance in a tiny box.
    oval, lat0, lon0 = [], 47.3769, 8.5417
    for lap in range(12):
        for i in range(60):
            a = 2 * math.pi * i / 60
            oval.append((lat0 + 0.00045 * math.sin(a),
                         lon0 + 0.00090 * math.cos(a) / math.cos(math.radians(lat0))))
    on, diag = I.looks_like_track(oval)
    assert on is True, (on, diag)
    assert diag < I.TRACK_BBOX_M

    # A point-to-point road run is not a track, however long.
    road = [(lat0 + i * 0.0002, lon0 + i * 0.0002) for i in range(300)]
    assert I.looks_like_track(road)[0] is False
    assert I.looks_like_track([])[0] is False
    assert I.looks_like_track([(1, 1)] * 5)[0] is False


def test_analyse_end_to_end():
    stream = session(6, 800.0, 195.0, 120.0)
    a = I.analyse(stream)
    assert a is not None
    assert a["count"] == 6
    assert a["name"] == "6 x 800 m"
    assert a["uniform"] is True
    assert abs(a["work_m"] - 4800) < 400, a["work_m"]
    assert a["fastest"] <= a["avg_pace"] <= a["slowest"]
    assert a["consistency"] is not None and a["consistency"] < 0.08
    assert a["avg_recovery_s"] and abs(a["avg_recovery_s"] - 120) < 25
    assert a["on_track"] is False          # no GPS given
    assert a["bbox_m"] is None


def test_analyse_flags_a_track_session():
    stream = session(10, 400.0, 185.0, 75.0)
    oval, lat0, lon0 = [], 47.3769, 8.5417
    for i in range(600):
        ang = 2 * math.pi * i / 50
        oval.append((lat0 + 0.00045 * math.sin(ang),
                     lon0 + 0.00090 * math.cos(ang) / math.cos(math.radians(lat0))))
    a = I.analyse(stream, oval)
    assert a["on_track"] is True
    assert a["count"] == 10
    assert a["name"] == "10 x 400 m"


def test_a_dropped_fix_does_not_split_a_rep():
    """One bad sample mid-rep must not turn 4 reps into 7."""
    stream = session(4, 1000.0, 190.0, 120.0)
    # Blank out a couple of samples partway through the second rep.
    mid = len(stream) // 2
    damaged = stream[:mid] + stream[mid + 2:]
    reps = I.detect_reps(damaged)
    assert len(reps) == 4, len(reps)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
