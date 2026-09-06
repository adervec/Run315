"""Self-check for plan adherence. Run: python test_adherence.py"""
from datetime import date, datetime, timedelta

import adherence as AD

MONDAY = date(2026, 1, 5)          # a Monday, so week bounds are unambiguous


def planned_week(n, km, long_km=None, easy=False, phase="build"):
    return {"week": n, "phase": phase, "easy_week": easy,
            "distance_m": km * 1000.0,
            "long_run_m": (long_km or km * 0.3) * 1000.0}


def runs_in_week(begin, total_km, longest_km=None, count=4):
    """Spread `total_km` over `count` runs inside the week starting `begin`."""
    longest_km = longest_km if longest_km is not None else total_km / count
    rest = total_km - longest_km
    out = [{"start": datetime.combine(begin, datetime.min.time()),
            "distance_m": longest_km * 1000.0}]
    for i in range(1, count):
        out.append({"start": datetime.combine(begin + timedelta(days=i),
                                              datetime.min.time()),
                    "distance_m": rest / max(count - 1, 1) * 1000.0})
    return out


def test_week_bounds_are_monday_to_sunday():
    begin, end = AD.week_bounds(MONDAY, 0)
    assert begin == MONDAY and end == MONDAY + timedelta(days=6)
    assert begin.weekday() == 0 and end.weekday() == 6
    # Week 2 starts a fortnight later.
    assert AD.week_bounds(MONDAY, 2)[0] == MONDAY + timedelta(days=14)
    # A start date midweek still snaps back to its Monday.
    assert AD.week_bounds(date(2026, 1, 7), 0)[0] == MONDAY


def test_actual_week_only_counts_that_week():
    acts = (runs_in_week(MONDAY, 50.0)
            + runs_in_week(MONDAY + timedelta(days=7), 30.0))
    got = AD.actual_week(acts, MONDAY, MONDAY + timedelta(days=6))
    assert abs(got["distance_m"] - 50000.0) < 1.0
    assert got["runs"] == 4
    # Nothing in an empty week.
    empty = AD.actual_week(acts, MONDAY + timedelta(days=21),
                           MONDAY + timedelta(days=27))
    assert empty["distance_m"] == 0.0 and empty["runs"] == 0


def test_compare_week_verdicts():
    plan = planned_week(1, 50.0)

    def verdict(km):
        return AD.compare_week(plan, {"distance_m": km * 1000.0,
                                      "longest_m": 0.0, "runs": 4})["verdict"]

    assert verdict(50.0) == "on target"
    assert verdict(46.0) == "on target"        # within a tenth
    assert verdict(54.0) == "on target"
    assert verdict(42.0) == "under"
    assert verdict(30.0) == "well under"
    assert verdict(58.0) == "over"
    assert verdict(70.0) == "well over"

    # A week with no target cannot be judged.
    assert AD.compare_week(planned_week(1, 0.0), {"distance_m": 10000.0,
                                                  "longest_m": 0.0,
                                                  "runs": 1}) is None


def test_long_run_is_judged_separately_from_volume():
    """Hitting the mileage with lots of short runs is not the same plan."""
    plan = planned_week(1, 50.0, long_km=20.0)
    # Full volume, but the longest run was only 10 km.
    row = AD.compare_week(plan, {"distance_m": 50000.0, "longest_m": 10000.0,
                                 "runs": 5})
    assert row["verdict"] == "on target"
    assert row["long_done"] is False
    assert abs(row["long_share"] - 0.5) < 1e-9

    done = AD.compare_week(plan, {"distance_m": 50000.0, "longest_m": 19000.0,
                                  "runs": 4})
    assert done["long_done"] is True     # within a tenth counts


def test_review_ignores_a_week_still_in_progress():
    plan = [planned_week(n, 50.0) for n in range(1, 5)]
    acts = []
    for i in range(4):
        acts += runs_in_week(MONDAY + timedelta(days=7 * i), 50.0)
    # "Today" falls inside week 3, so only weeks 1 and 2 are judged.
    today = MONDAY + timedelta(days=16)
    result = AD.review(plan, acts, MONDAY, today)
    assert result["weeks"] == 2, result["weeks"]
    assert all(r["end"] < today for r in result["rows"])


def test_review_totals_and_drift_under():
    plan = [planned_week(n, 50.0) for n in range(1, 6)]
    acts = []
    for i in range(5):
        acts += runs_in_week(MONDAY + timedelta(days=7 * i), 35.0)
    result = AD.review(plan, acts, MONDAY, MONDAY + timedelta(days=40))
    assert result["weeks"] == 5
    assert result["drift"] == "under"
    assert result["under"] == 5 and result["on_target"] == 0
    assert abs(result["share"] - 0.7) < 0.01
    assert "optimistic" in result["note"]


def test_review_drift_over_calls_out_skipped_easy_weeks():
    plan = [planned_week(1, 50.0), planned_week(2, 50.0), planned_week(3, 50.0),
            planned_week(4, 35.0, easy=True)]
    acts = []
    for i in range(4):
        # Runs 60 km every week, including through the easy one.
        acts += runs_in_week(MONDAY + timedelta(days=7 * i), 60.0)
    result = AD.review(plan, acts, MONDAY, MONDAY + timedelta(days=35))
    assert result["drift"] == "over"
    assert "easy weeks were run through" in result["note"]


def test_review_on_target_says_so_plainly():
    plan = [planned_week(n, 50.0) for n in range(1, 5)]
    acts = []
    for i in range(4):
        acts += runs_in_week(MONDAY + timedelta(days=7 * i), 51.0)
    result = AD.review(plan, acts, MONDAY, MONDAY + timedelta(days=35))
    assert result["drift"] is None
    assert result["on_target"] == 4
    assert "tracking the plan closely" in result["note"]


def test_scattered_weeks_are_not_called_close_tracking():
    """Regression: 4 of 16 weeks on target once read as "within a tenth on most
    weeks", which the numbers plainly did not support.
    """
    plan = [planned_week(n, 50.0) for n in range(1, 9)]
    acts = []
    # Alternating well over and well under: the total comes out right, the
    # individual weeks do not.
    for i in range(8):
        acts += runs_in_week(MONDAY + timedelta(days=7 * i),
                             70.0 if i % 2 else 30.0)
    result = AD.review(plan, acts, MONDAY, MONDAY + timedelta(days=70))
    assert result["drift"] is None            # neither direction dominates
    assert result["on_target"] == 0
    assert "tracking the plan closely" not in result["note"]
    assert "both sides of the plan" in result["note"]
    # The totals really are about right, which is the point being made.
    assert 0.9 < result["share"] < 1.1


def test_a_short_block_does_not_get_a_verdict():
    """Two weeks is not a pattern, and must not be reported as one."""
    plan = [planned_week(1, 50.0), planned_week(2, 50.0)]
    acts = runs_in_week(MONDAY, 20.0)
    result = AD.review(plan, acts, MONDAY, MONDAY + timedelta(days=21))
    assert result["drift"] is None
    assert "Too early" in result["note"]


def test_review_edges():
    assert AD.review([], [], MONDAY) is None
    assert AD.review(None, [], MONDAY) is None
    assert AD.review([planned_week(1, 50.0)], [], None) is None
    # Every week still ahead means nothing to judge.
    assert AD.review([planned_week(1, 50.0)], [], MONDAY, MONDAY) is None


def test_next_session_finds_the_week_you_are_in():
    plan = [planned_week(n, 50.0) for n in range(1, 5)]
    # Wednesday of week 2.
    today = MONDAY + timedelta(days=9)
    nxt = AD.next_session(plan, MONDAY, today)
    assert nxt["week"] == 2
    assert nxt["begin"] <= today <= nxt["end"]
    assert nxt["days_left"] == 5          # Wed, Thu, Fri, Sat, Sun

    # Past the end of the plan there is no current week.
    assert AD.next_session(plan, MONDAY, MONDAY + timedelta(days=200)) is None
    assert AD.next_session([], MONDAY, today) is None


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
