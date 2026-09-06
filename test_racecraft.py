"""Self-check for race strategy and postmortem. Run: python test_racecraft.py"""
import math

import racecraft as R

LAT0, LON0 = 47.3769, 8.5417
M_PER_DEG = 111320.0


def course(legs, ele0=400.0):
    """Build a course from [(metres, climb_m), ...] running due north."""
    pts, lat, ele = [(LAT0, LON0, ele0)], LAT0, ele0
    for metres, climb in legs:
        steps = max(int(metres / 25), 1)
        for _ in range(steps):
            lat += (metres / steps) / M_PER_DEG
            ele += climb / steps
            pts.append((round(lat, 7), LON0, round(ele, 2)))
    return pts


def stream(legs, start_hr=150, hr_rise=0.0):
    """Build a run stream from [(metres, pace_s_per_km, climb_m), ...]."""
    out, t, d, ele = [], 0.0, 0.0, 400.0
    out.append((0.0, 0.0, start_hr, LAT0, LON0, ele))
    total = sum(l[0] for l in legs)
    for metres, pace, climb in legs:
        steps = max(int(metres / 50), 1)
        for _ in range(steps):
            d += metres / steps
            t += (metres / steps) / 1000.0 * pace
            ele += climb / steps
            hr = start_hr + hr_rise * (d / total)
            out.append((round(t, 2), round(d, 2), round(hr), LAT0, LON0, round(ele, 2)))
    return out


def test_cost_ratio():
    assert R.cost_ratio(0.0) == 1.0
    assert R.cost_ratio(None) == 1.0
    # Uphill costs more, downhill less, monotonically over the usable range.
    assert R.cost_ratio(0.05) > 1.0
    assert R.cost_ratio(0.10) > R.cost_ratio(0.05)
    assert R.cost_ratio(-0.05) < 1.0
    # 10% up is roughly two-thirds dearer than flat.
    assert 1.5 < R.cost_ratio(0.10) < 1.8, R.cost_ratio(0.10)
    # The downhill benefit is floored: you cannot fall down a hill for free.
    assert R.cost_ratio(-0.20) == R.MIN_RATIO
    assert R.cost_ratio(-0.90) == R.MIN_RATIO
    assert R.cost_ratio(0.90) <= R.MAX_RATIO


def test_grade_adjusted_pace():
    assert R.grade_adjusted_pace(None, 0.05) is None
    assert R.grade_adjusted_pace(300.0, 0.0) == 300.0
    # 5:00/km up a 10% hill is worth much better than 5:00 on the flat.
    assert R.grade_adjusted_pace(300.0, 0.10) < 200.0
    # And downhill flatters you, so the adjusted pace is slower than the split.
    assert R.grade_adjusted_pace(300.0, -0.10) > 300.0


def test_segment_course_flat():
    segs = R.segment_course(course([(5000, 0)]))
    assert len(segs) == 5
    for s in segs:
        assert abs(s["distance_m"] - 1000) < 60, s["distance_m"]
        assert abs(s["grade"]) < 0.002
        assert abs(s["cost"] - 1.0) < 0.05
    assert [s["n"] for s in segs] == [1, 2, 3, 4, 5]


def test_segment_course_with_a_hill():
    # 2 km flat, 1 km climbing 60 m, 2 km flat.
    segs = R.segment_course(course([(2000, 0), (1000, 60), (2000, 0)]))
    assert len(segs) == 5
    hill = segs[2]
    assert 0.045 < hill["grade"] < 0.075, hill["grade"]
    assert hill["climb_m"] > 50
    assert hill["cost"] > 1.2
    assert segs[0]["cost"] < hill["cost"]


def test_segment_course_leaves_a_short_last_piece():
    segs = R.segment_course(course([(2400, 0)]))
    assert len(segs) == 3
    assert 300 < segs[-1]["distance_m"] < 500, segs[-1]["distance_m"]


def test_course_stats():
    st = R.course_stats(course([(2000, 0), (1000, 80), (1000, -80), (1000, 0)]))
    assert st["has_elevation"] is True
    assert 4900 < st["length_m"] < 5100
    assert 70 < st["climb_m"] < 95, st["climb_m"]
    assert 70 < st["drop_m"] < 95, st["drop_m"]
    assert st["difficulty"] > 1.0                 # harder than the same distance flat
    assert st["steepest"]["grade"] > 0.05
    assert R.course_stats([]) is None
    assert R.course_stats([(LAT0, LON0, 400)]) is None

    flat = R.course_stats(course([(4000, 0)]))
    assert abs(flat["difficulty"] - 1.0) < 0.05   # flat course, no penalty


def test_pace_plan_totals_the_target_and_slows_for_hills():
    segs = R.segment_course(course([(2000, 0), (1000, 70), (2000, 0)]))
    plan = R.pace_plan(segs, target_s=1500.0)     # 25 minutes for 5 km
    assert len(plan) == len(segs)
    assert abs(sum(p["target_s"] for p in plan) - 1500.0) < 0.5
    assert abs(plan[-1]["cumulative_s"] - 1500.0) < 0.5
    # The climb gets more time than the flat kilometres around it.
    assert plan[2]["target_pace"] > plan[0]["target_pace"]
    assert plan[2]["target_pace"] > plan[4]["target_pace"]
    # Cumulative time only goes up.
    assert all(b["cumulative_s"] > a["cumulative_s"] for a, b in zip(plan, plan[1:]))
    assert R.pace_plan([], 1500) == []
    assert R.pace_plan(segs, 0) == []


def test_pace_plan_negative_split():
    segs = R.segment_course(course([(6000, 0)]))
    plan = R.pace_plan(segs, target_s=1800.0, negative_split=0.02)
    assert abs(sum(p["target_s"] for p in plan) - 1800.0) < 0.5
    assert plan[0]["target_pace"] > plan[-1]["target_pace"]   # start steadier
    even = R.pace_plan(segs, target_s=1800.0, negative_split=0.0)
    assert abs(even[0]["target_pace"] - even[-1]["target_pace"]) < 0.5


def test_hard_sections():
    segs = R.segment_course(course([(1000, 0), (2000, 140), (1000, 0), (1000, 60)]))
    hard = R.hard_sections(segs)
    assert hard, segs
    biggest = hard[0]
    assert biggest["climb_m"] > 100
    assert biggest["from_m"] >= 900
    assert biggest["grade"] > R.CLIMB_GRADE
    # A flat course has nothing to warn about.
    assert R.hard_sections(R.segment_course(course([(5000, 0)]))) == []
    assert R.hard_sections([]) == []


def test_actual_segments():
    segs = R.actual_segments(stream([(3000, 300.0, 0)]))
    assert len(segs) == 3
    for s in segs:
        assert abs(s["pace"] - 300.0) < 12, s["pace"]
        assert s["avg_hr"] == 150
        assert s["gap"] is not None
    assert R.actual_segments([]) == []
    assert R.actual_segments([(0, 0)]) == []


def test_actual_segments_gap_sees_through_a_hill():
    """A slow kilometre uphill can be a better effort than a fast one on the flat."""
    segs = R.actual_segments(stream([(1000, 280.0, 0), (1000, 330.0, 70)]))
    flat, hill = segs[0], segs[1]
    assert hill["pace"] > flat["pace"]            # slower on the clock
    assert hill["gap"] < flat["gap"]              # but a harder effort


def test_compare_and_postmortem_even_race():
    segs = R.segment_course(course([(5000, 0)]))
    plan = R.pace_plan(segs, target_s=1500.0, negative_split=0.0)
    actual = R.actual_segments(stream([(5000, 300.0, 0)]))
    pm = R.postmortem(plan, actual, target_s=1500.0)
    assert pm is not None
    assert len(pm["rows"]) == len(actual)
    assert abs(pm["total_s"] - 1500) < 40
    assert abs(pm["fade"]) < 0.03
    assert "Even" in pm["verdict"] or "Negative" in pm["verdict"], pm["verdict"]
    assert R.postmortem(plan, []) is None


def test_fade_compares_equal_halves():
    """Regression: an odd number of kilometres used to compare 2 against 3.

    Summed time over unequal halves reported a perfectly even 5 km as a 50% fade.
    """
    for km in (5, 7, 9, 13):
        actual = R.actual_segments(stream([(km * 1000, 300.0, 0)]))
        pm = R.postmortem([], actual)
        assert abs(pm["fade"]) < 0.02, (km, pm["fade"])
        assert "Even" in pm["verdict"], (km, pm["verdict"])


def test_postmortem_calls_out_going_out_too_hard():
    segs = R.segment_course(course([(10000, 0)]))
    plan = R.pace_plan(segs, target_s=3000.0, negative_split=0.0)
    # 4:40/km for 5 km, then falling apart to 5:50/km.
    actual = R.actual_segments(stream([(5000, 280.0, 0), (5000, 350.0, 0)]))
    pm = R.postmortem(plan, actual, target_s=3000.0)
    assert pm["fade"] > 0.06, pm["fade"]
    assert "too hard" in pm["verdict"] or "legs went" in pm["verdict"], pm["verdict"]
    assert pm["lost_s"] > 0
    assert pm["worst"]["delta_s"] > 0


def test_postmortem_blames_the_hills_when_the_hills_are_to_blame():
    segs = R.segment_course(course([(2000, 0), (1000, 0), (2000, 0)]))
    plan = R.pace_plan(segs, target_s=1500.0, negative_split=0.0)
    # The plan assumed flat; the run met a climb in the middle third.
    actual = R.actual_segments(stream([(2000, 295.0, 0), (1000, 380.0, 70),
                                       (2000, 295.0, 0)]))
    pm = R.postmortem(plan, actual, target_s=1500.0)
    assert pm["uphill_segments"] >= 1
    assert pm["uphill_loss_s"] > 0
    assert "climbs" in pm["verdict"], pm["verdict"]


def test_postmortem_negative_split_is_praised():
    segs = R.segment_course(course([(6000, 0)]))
    plan = R.pace_plan(segs, target_s=1800.0, negative_split=0.0)
    actual = R.actual_segments(stream([(3000, 310.0, 0), (3000, 290.0, 0)]))
    pm = R.postmortem(plan, actual, target_s=1800.0)
    assert pm["fade"] < 0
    assert "Negative split" in pm["verdict"]
    assert pm["gained_s"] > 0


def test_postmortem_without_a_plan_still_reports():
    actual = R.actual_segments(stream([(5000, 300.0, 0)]))
    pm = R.postmortem([], actual)
    assert pm["planned_s"] is None
    assert pm["delta_s"] is None
    assert all(r["target_s"] is None for r in pm["rows"])
    assert pm["verdict"]


def test_hr_drift_is_measured():
    actual = R.actual_segments(stream([(6000, 300.0, 0)], start_hr=150, hr_rise=20))
    pm = R.postmortem([], actual)
    assert pm["hr_drift"] is not None and pm["hr_drift"] > 5, pm["hr_drift"]


def test_junk_input():
    assert R.clean_course(None) == []
    assert R.clean_course([(None, 1), ("x", 2), (999, 8), (float("nan"), 8)]) == []
    assert R.segment_course([]) == []
    assert R.smooth_elevation([]) == []
    # A course with no elevation still segments, it just has no gradients.
    flat = R.segment_course([(LAT0 + i * 0.0001, LON0) for i in range(200)])
    assert flat and all(s["grade"] is None for s in flat)
    assert all(s["cost"] == 1.0 for s in flat)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
