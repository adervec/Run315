"""Self-check for vitals. Run: python test_vitals.py"""
import math
from datetime import date, timedelta

import vitals as V

DAY0 = date(2026, 6, 1)


def series(n=60):
    return [DAY0 + timedelta(days=i) for i in range(n)]


def test_pearson_against_known_values():
    assert abs(V.pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1.0) < 1e-9
    assert abs(V.pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1.0) < 1e-9
    # A flat series correlates with nothing rather than dividing by zero.
    assert V.pearson([1, 1, 1, 1], [1, 2, 3, 4]) is None
    assert V.pearson([1, 2], [3, 4]) is None
    # Gaps are dropped pairwise, not treated as zero.
    assert abs(V.pearson([1, None, 3, 4], [2, 99, 6, 8]) - 1.0) < 1e-9


def test_critical_r_behaves_like_a_significance_threshold():
    # More days, easier to clear.
    assert V.critical_r(100) < V.critical_r(30)
    # More tests, harder to clear -- this is the correction doing its job.
    assert V.critical_r(60, tests=100) > V.critical_r(60, tests=1)
    # Sanity against the textbook figure: n=30, alpha .05 two-tailed is ~0.36.
    assert 0.33 < V.critical_r(30) < 0.39, V.critical_r(30)
    assert V.critical_r(3) is None


def test_a_real_relationship_is_found_at_the_right_lag():
    days = series(60)
    # Hard every third day.
    load = {d: (90.0 if i % 3 == 0 else 20.0) for i, d in enumerate(days)}
    # Stress rises the day *after* a hard day, and nothing else moves.
    daily = []
    for i, d in enumerate(days):
        yesterday = load[days[i - 1]] if i else 20.0
        daily.append((d, {"stress_avg": 20.0 + yesterday * 0.4,
                          "spo2_avg": 96.0}))
    result = V.correlate(daily, load)
    found = {f["metric"]: f for f in result["findings"]}
    assert "stress_avg" in found, result
    assert found["stress_avg"]["lag"] == 1, found["stress_avg"]
    assert found["stress_avg"]["r"] > 0.9
    # A flat metric must never be reported.
    assert "spo2_avg" not in found


def test_pure_noise_does_not_produce_findings():
    """The multiple-comparison guard is the whole point of this module."""
    import random
    rng = random.Random(11)
    days = series(70)
    load = {d: rng.uniform(0, 90) for d in days}
    # Twenty unrelated metrics of pure noise.
    daily = [(d, {"m%d" % k: rng.gauss(0, 1) for k in range(20)}) for d in days]
    result = V.correlate(daily, load)
    assert result["tested"] >= 60, result["tested"]
    assert result["findings"] == [], result["findings"]


def test_the_correction_is_visibly_stricter_than_no_correction():
    """Uncorrected testing should flag more than corrected -- and be reported."""
    import random
    rng = random.Random(5)
    days = series(70)
    load = {d: rng.uniform(0, 90) for d in days}
    daily = [(d, {"m%d" % k: rng.gauss(0, 1) for k in range(25)}) for d in days]
    result = V.correlate(daily, load)
    # With 100 tests of noise, a few clear the uncorrected bar. That number is
    # surfaced precisely so the difference is not hidden.
    assert result["uncorrected"] >= len(result["findings"])
    assert result["critical_r"] > V.critical_r(result["days"], tests=1)


def test_correlate_needs_enough_paired_days():
    days = series(10)
    load = {d: 50.0 + i for i, d in enumerate(days)}
    daily = [(d, {"stress_avg": 20.0 + i}) for i, d in enumerate(days)]
    result = V.correlate(daily, load)
    assert result["tested"] == 0 and result["findings"] == []
    assert V.correlate([], {})["findings"] == []


def test_finding_note_knows_which_direction_is_bad():
    days = series(60)
    load = {d: (90.0 if i % 2 == 0 else 10.0) for i, d in enumerate(days)}
    # Stress tracking load upward is the bad direction.
    bad = [(d, {"stress_avg": 20.0 + load[d] * 0.5}) for d in days]
    note = V.correlate(bad, load)["findings"][0]["note"]
    assert "costs you" in note

    # Deep sleep tracking load upward is the good direction.
    good = [(d, {"deep_s": 4000.0 + load[d] * 10}) for d in days]
    note = V.correlate(good, load)["findings"][0]["note"]
    assert "would hope for" in note


def test_only_the_best_lag_survives_per_metric():
    """A slow-moving signal correlates at several lags; that is one finding."""
    days = series(60)
    load = {d: 40.0 + 30.0 * math.sin(i / 8.0) for i, d in enumerate(days)}
    daily = [(d, {"stress_avg": 20.0 + load[d] * 0.5}) for d in days]
    result = V.correlate(daily, load)
    metrics = [f["metric"] for f in result["findings"]]
    assert metrics.count("stress_avg") == 1


def test_sleep_architecture():
    days = series(30)
    # 18% deep, 22% REM: both inside the usual adult ranges.
    daily = [(d, {"deep_s": 0.18 * 28800, "light_s": 0.60 * 28800,
                  "rem_s": 0.22 * 28800}) for d in days]
    result = V.sleep_architecture(daily)
    assert result["deep_typical"] and result["rem_typical"]
    assert abs(result["deep_share"] - 0.18) < 1e-9
    assert "usual adult proportions" in result["note"]

    # Very little deep sleep is named, with the estimate caveat attached.
    poor = [(d, {"deep_s": 0.05 * 28800, "light_s": 0.73 * 28800,
                 "rem_s": 0.22 * 28800}) for d in days]
    note = V.sleep_architecture(poor)["note"]
    assert "less deep sleep" in note and "estimate" in note

    assert V.sleep_architecture([]) is None


def test_trend_compares_windows_and_knows_which_way_is_better():
    days = series(40)
    # Resting stress falling over the block is an improvement.
    daily = [(d, {"stress_avg": 40.0 - i * 0.4}) for i, d in enumerate(days)]
    result = V.trend(daily, "stress_avg", window=14)
    assert result["change"] < 0
    assert result["better"] is True
    assert result["notable"] is True

    # Deep sleep falling is not.
    daily = [(d, {"deep_s": 6000.0 - i * 40}) for i, d in enumerate(days)]
    assert V.trend(daily, "deep_s", window=14)["better"] is False

    # Not enough history says nothing.
    assert V.trend([(DAY0, {"stress_avg": 20.0})], "stress_avg") is None


def test_outliers_and_odd_days():
    days = series(40)
    daily = []
    for i, d in enumerate(days):
        row = {"stress_avg": 25.0, "rhr": 48.0, "spo2_avg": 96.0, "deep_s": 5000.0}
        if i == 20:
            # One day where several things go wrong at once.
            row = {"stress_avg": 70.0, "rhr": 62.0, "spo2_avg": 89.0,
                   "deep_s": 5000.0}
        daily.append((d, row))

    hits = V.outliers(daily, "stress_avg")
    assert len(hits) == 1 and hits[0]["day"] == days[20]

    odd = V.odd_days(daily, min_metrics=3)
    assert odd and odd[0]["day"] == days[20]
    assert odd[0]["count"] >= 3
    # The metric that did not move is not listed among the reasons.
    assert "deep_s" not in [m["metric"] for m in odd[0]["metrics"]]

    # A long run is not an odd day: the metrics that always spike when you run
    # further must not be what makes a day look unusual.
    mechanical_spike = []
    for i, d in enumerate(days):
        row = {"calories_active": 400.0, "steps": 9000.0,
               "vigorous_minutes": 10.0, "intensity_minutes": 20.0,
               "stress_avg": 25.0}
        if i == 12:
            row = {"calories_active": 1600.0, "steps": 26000.0,
                   "vigorous_minutes": 70.0, "intensity_minutes": 120.0,
                   "stress_avg": 25.0}
        mechanical_spike.append((d, row))
    assert V.odd_days(mechanical_spike, min_metrics=3) == [], "that is just a long run"

    # A single metric moving is not an odd day.
    quiet = [(d, {"stress_avg": 70.0 if i == 5 else 25.0}) for i, d in enumerate(days)]
    assert V.odd_days(quiet, min_metrics=3) == []


def test_mechanical_restatements_are_separated_from_findings():
    """Calories correlating with running is arithmetic, not a discovery."""
    days = series(60)
    load = {d: (90.0 if i % 3 == 0 else 15.0) for i, d in enumerate(days)}
    daily = [(d, {"calories_active": 300 + load[d] * 10,       # mechanical
                  "stress_avg": 20.0 + load[d] * 0.4})         # a real response
             for d in days]
    result = V.correlate(daily, load)
    names = [f["metric"] for f in result["findings"]]
    assert "stress_avg" in names
    assert "calories_active" not in names, "arithmetic must not top the findings"
    assert "calories_active" in [f["metric"] for f in result["mechanical"]]


def test_a_seven_day_lag_carries_its_own_warning():
    days = series(60)
    # A purely weekly rhythm: lag 0 and lag 7 are the same phase.
    load = {d: (90.0 if i % 7 == 0 else 15.0) for i, d in enumerate(days)}
    daily = [(d, {"hrv_ms": 60.0 - load[days[max(i - 7, 0)]] * 0.2}
              ) for i, d in enumerate(days)]
    result = V.correlate(daily, load)
    seven = [f for f in result["findings"] if f["lag"] == 7]
    if seven:
        assert "weekly rhythm" in seven[0]["note"]


def test_lag_zero_reads_as_english():
    days = series(60)
    load = {d: (90.0 if i % 2 == 0 else 10.0) for i, d in enumerate(days)}
    daily = [(d, {"stress_avg": 20.0 + load[d] * 0.5}) for d in days]
    note = V.correlate(daily, load)["findings"][0]["note"]
    assert "on the same day a hard day" not in note
    assert "on a hard day itself" in note


def test_labels_are_human():
    assert V.label("spo2_low") == "lowest blood oxygen"
    assert V.label("rem_s") == "REM sleep"
    # An unknown metric degrades to something readable rather than a key.
    assert V.label("some_new_metric") == "some new metric"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
