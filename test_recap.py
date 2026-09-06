"""Self-check for the career recap. Run: python test_recap.py"""
from datetime import date, datetime, timedelta

import recap as R


def run(when, km=10.0, seconds=3000.0, ascent=50.0):
    return {"start": when, "distance_m": km * 1000.0,
            "moving_s": seconds, "elev_gain_m": ascent}


def weekly(start, weeks, km=10.0):
    """One run a week for `weeks` consecutive weeks."""
    return [run(start + timedelta(days=7 * i), km) for i in range(weeks)]


def test_totals():
    acts = [run(datetime(2026, 1, 1), 10.0), run(datetime(2026, 1, 2), 5.0)]
    t = R.totals(acts)
    assert t["runs"] == 2
    assert t["distance_m"] == 15000.0
    assert t["seconds"] == 6000.0
    assert t["ascent_m"] == 100.0
    # Missing fields count as zero rather than crashing.
    assert R.totals([{"start": datetime(2026, 1, 1)}])["distance_m"] == 0.0
    assert R.totals([])["runs"] == 0


def test_by_year_is_most_recent_first():
    acts = [run(datetime(2024, 5, 1), 8.0), run(datetime(2026, 5, 1), 12.0),
            run(datetime(2025, 5, 1), 10.0), run(datetime(2026, 6, 1), 20.0)]
    rows = R.by_year(acts)
    assert [r["year"] for r in rows] == [2026, 2025, 2024]
    assert rows[0]["runs"] == 2 and rows[0]["distance_m"] == 32000.0
    assert rows[0]["longest_m"] == 20000.0


def test_busiest_month():
    acts = ([run(datetime(2026, 3, d), 10.0) for d in (1, 2, 3)]
            + [run(datetime(2026, 7, 1), 25.0)])
    month, metres = R.busiest_month(acts, 2026)
    assert month == 3 and metres == 30000.0
    assert R.busiest_month(acts, 2020) is None


def test_week_streak_counts_weeks_not_days():
    today = date(2026, 8, 20)              # a Thursday
    monday = today - timedelta(days=today.weekday())
    acts = weekly(datetime.combine(monday - timedelta(days=7 * 9), datetime.min.time()), 10)
    streak = R.week_streak(acts, today)
    assert streak["current"] == 10, streak
    assert streak["longest"] == 10
    assert streak["weeks_run"] == 10

    # Several runs in one week are still one week.
    same_week = [run(datetime.combine(monday + timedelta(days=d),
                                      datetime.min.time())) for d in range(4)]
    assert R.week_streak(same_week, today)["current"] == 1

    assert R.week_streak([], today) == {"current": 0, "longest": 0, "weeks_run": 0}


def test_a_week_still_in_progress_does_not_break_the_streak():
    """Running Monday to Sunday last week and not yet this week is not a break."""
    today = date(2026, 8, 18)              # a Tuesday
    monday = today - timedelta(days=today.weekday())
    # Runs up to last week only.
    acts = weekly(datetime.combine(monday - timedelta(days=7 * 5),
                                   datetime.min.time()), 5)
    assert R.week_streak(acts, today)["current"] == 5


def test_longest_streak_survives_a_later_gap():
    today = date(2026, 8, 20)
    monday = today - timedelta(days=today.weekday())
    old = weekly(datetime.combine(monday - timedelta(days=7 * 30),
                                  datetime.min.time()), 12)
    recent = weekly(datetime.combine(monday - timedelta(days=7 * 2),
                                     datetime.min.time()), 3)
    streak = R.week_streak(old + recent, today)
    assert streak["longest"] == 12
    assert streak["current"] == 3


def test_milestone_ladder():
    m = R.milestone(1200.0, R.DISTANCE_TIERS_KM)
    assert m["last"] == 1000 and m["next"] == 2500
    assert abs(m["to_go"] - 1300.0) < 1e-9
    assert 0 < m["progress"] < 1
    assert m["cleared"] == 3          # 100, 500, 1000

    # Below the first rung there is nothing cleared but something to aim at.
    low = R.milestone(10.0, R.DISTANCE_TIERS_KM)
    assert low["last"] is None and low["next"] == 100 and low["cleared"] == 0

    # Past the top there is nothing left to chase.
    top = R.milestone(999999.0, R.DISTANCE_TIERS_KM)
    assert top["next"] is None and top["to_go"] is None and top["progress"] == 1.0

    assert R.milestone(None, R.DISTANCE_TIERS_KM) is None
    assert R.milestone(-1, R.DISTANCE_TIERS_KM) is None


def test_career():
    acts = weekly(datetime(2024, 1, 1), 100, km=10.0)
    c = R.career(acts, races_finished=12, today=date(2026, 8, 20))
    assert c["totals"]["runs"] == 100
    assert abs(c["km"] - 1000.0) < 1e-6
    assert c["distance_milestone"]["last"] == 1000
    assert c["race_milestone"]["last"] == 10 and c["race_milestone"]["next"] == 25
    assert c["years"] > 2.0
    assert 0 < c["equator"] < 1
    assert c["first_run"] == datetime(2024, 1, 1)

    empty = R.career([], 0, today=date(2026, 8, 20))
    assert empty["km"] == 0.0 and empty["years"] is None


def test_compare_years():
    rows = R.by_year([run(datetime(2025, 5, 1), 100.0),
                      run(datetime(2026, 5, 1), 150.0)])
    c = R.compare_years(rows, 2026)
    assert abs(c["change"] - 0.5) < 1e-9
    assert "more running" in c["note"]

    down = R.compare_years(R.by_year([run(datetime(2025, 5, 1), 100.0),
                                      run(datetime(2026, 5, 1), 50.0)]), 2026)
    assert "less running" in down["note"]

    level = R.compare_years(R.by_year([run(datetime(2025, 5, 1), 100.0),
                                       run(datetime(2026, 5, 1), 103.0)]), 2026)
    assert "About the same" in level["note"]

    # Nothing to compare against.
    assert R.compare_years(rows, 2025) is None


def test_partial_year_compares_like_for_like():
    """Eleven months against twelve is not a decline, and must not read as one."""
    today = date(2026, 8, 20)
    acts = (
        # Last year: steady all year, so the full year dwarfs this year to date.
        [run(datetime(2025, m, 1), 100.0) for m in range(1, 13)]
        # This year: the same rate, but only up to August.
        + [run(datetime(2026, m, 1), 100.0) for m in range(1, 9)]
    )
    result = R.partial_year_compare(acts, 2026, today)
    assert result is not None
    # Same rate to the same point in the year: no change.
    assert abs(result["change"]) < 1e-9, result
    assert "About the same" in result["note"]

    # The naive full-year comparison would have shown a big fall.
    naive = R.compare_years(R.by_year(acts), 2026)
    assert naive["change"] < -0.3, naive["change"]

    # A record that only began partway through last year is not a comparison.
    # The 2025 run must fall *before* day 232, or there is no baseline at all
    # and the function correctly returns None instead.
    late_start = ([run(datetime(2025, 8, 1), 5.0)]
                  + [run(datetime(2026, m, 1), 100.0) for m in range(1, 9)])
    thin = R.partial_year_compare(late_start, 2026, today)
    assert thin["thin_baseline"] is True
    assert "first full year" in thin["note"]
    assert "%" not in thin["note"], "a 15,900% figure helps nobody"

    # A real comparison is not flagged.
    assert R.partial_year_compare(acts, 2026, today)["thin_baseline"] is False

    # Not applicable to a past year.
    assert R.partial_year_compare(acts, 2025, today) is None
    # Nothing last year means nothing to compare.
    assert R.partial_year_compare(
        [run(datetime(2026, 1, 1), 10.0)], 2026, today) is None


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
