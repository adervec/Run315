"""Self-check for the second opinion. Run: python test_secondopinion.py"""
import secondopinion as SO


def test_threshold_hr_agreement():
    close = SO.threshold_hr(172.0, 170.0)
    assert close["band"] == "agree"
    assert "agreement" in close["note"]
    assert close["difference"] == 2.0

    # Reading higher than Garmin should point at the conservative option.
    higher = SO.threshold_hr(180.0, 172.0)
    assert higher["band"] == "near"
    assert "conservative" in higher["note"]

    lower = SO.threshold_hr(160.0, 178.0)
    assert lower["band"] == "differ"
    assert "easy runs feel too easy" in lower["note"]


def test_threshold_hr_needs_both_sides():
    assert SO.threshold_hr(None, 170.0) is None
    assert SO.threshold_hr(170.0, None) is None
    assert SO.threshold_hr(0, 0) is None


def test_threshold_pace_is_relative_not_absolute():
    """Ten seconds matters more to a fast runner than a slow one."""
    fast = SO.threshold_pace(200.0, 190.0)      # 5.3%
    slow = SO.threshold_pace(400.0, 390.0)      # 2.6%
    assert fast["difference_s"] == slow["difference_s"] == 10.0
    assert fast["band"] == "near"
    assert slow["band"] == "agree"


def test_races_only_compares_shared_distances():
    ours = {5000: 1200.0, 10000: 2500.0, 21097: 5600.0}
    theirs = {5000: 1210.0, 10000: 2480.0}
    rows = SO.races(ours, theirs)
    assert [r["distance_m"] for r in rows] == [5000, 10000]
    assert all(r["ours"] and r["theirs"] for r in rows)
    # Sorted by distance so the table reads in order.
    assert rows[0]["distance_m"] < rows[1]["distance_m"]

    assert SO.races({}, {}) == []
    assert SO.races(None, None) == []
    assert SO.races({5000: 1200.0}, {10000: 2500.0}) == []


def test_races_sign_convention():
    """Positive means this app is slower, which is what the wording assumes."""
    rows = SO.races({5000: 1300.0}, {5000: 1200.0})
    assert rows[0]["difference_s"] > 0
    assert rows[0]["relative"] > 0


def test_race_summary_distinguishes_bias_from_scatter():
    # Agreement everywhere.
    agree = SO.races({5000: 1200.0, 10000: 2500.0}, {5000: 1205.0, 10000: 2490.0})
    assert "one answer" in SO.race_summary(agree)

    # Consistently quicker at every distance.
    quick = SO.races({5000: 1100.0, 10000: 2300.0}, {5000: 1200.0, 10000: 2500.0})
    summary = SO.race_summary(quick)
    assert "quicker than Garmin at every distance" in summary
    assert "threshold" in summary

    # Consistently slower.
    slow = SO.races({5000: 1300.0, 10000: 2700.0}, {5000: 1200.0, 10000: 2500.0})
    assert "slower than Garmin at every distance" in SO.race_summary(slow)

    # Disagreeing in different directions is a shape problem, not a level one.
    mixed = SO.races({5000: 1100.0, 10000: 2700.0}, {5000: 1200.0, 10000: 2500.0})
    assert "shape of the curve" in SO.race_summary(mixed)

    assert SO.race_summary([]) is None


def test_review_counts_what_it_compared():
    ours = {"threshold_hr": 172.0, "threshold_pace": 250.0,
            "races": {5000: 1200.0, 10000: 2500.0}}
    theirs = {"threshold_hr": 170.0, "threshold_pace": 248.0,
              "races": {5000: 1205.0, 10000: 2490.0}}
    result = SO.review(ours, theirs)
    assert result["comparisons"] == 4      # two thresholds, two races
    assert result["disagreements"] == 0
    assert result["race_summary"]

    # A real disagreement is counted.
    theirs["threshold_hr"] = 150.0
    worse = SO.review(ours, theirs)
    assert worse["disagreements"] == 1


def test_review_survives_missing_data_entirely():
    empty = SO.review({}, {})
    assert empty["comparisons"] == 0 and empty["disagreements"] == 0
    assert empty["races"] == [] and empty["race_summary"] is None
    assert SO.review(None, None)["comparisons"] == 0

    # One side only is not a comparison.
    half = SO.review({"threshold_hr": 170.0}, {})
    assert half["comparisons"] == 0


def test_bands_are_ordered_and_symmetric():
    """The same size of gap reads the same whichever way round it is."""
    assert SO._band(0.0, 5, 12) == "agree"
    assert SO._band(5.0, 5, 12) == "agree"
    assert SO._band(-5.0, 5, 12) == "agree"
    assert SO._band(6.0, 5, 12) == "near"
    assert SO._band(-6.0, 5, 12) == "near"
    assert SO._band(13.0, 5, 12) == "differ"
    assert SO._band(-13.0, 5, 12) == "differ"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
