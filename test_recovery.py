"""Self-check for overnight recovery. Run: python test_recovery.py"""
import recovery as R


def nights(mean, spread, n=40):
    """n nightly readings sitting exactly `spread` either side of `mean`.

    For even n the population mean is `mean` and the population sd is exactly
    `spread`, which is what makes every z-score below hand-checkable.
    """
    return [mean - spread if i % 2 else mean + spread for i in range(n)]


def bases(hrv=(60.0, 6.0), rhr=(48.0, 2.0)):
    """A runner whose HRV sits at 60 +/- 6 ms and resting HR at 48 +/- 2 bpm."""
    return {"hrv": R.baseline(nights(*hrv)), "rhr": R.baseline(nights(*rhr))}


def test_baseline_needs_enough_history():
    assert R.baseline(nights(60, 6, 12)) is None
    b = R.baseline(nights(60, 6, 14))
    assert b["n"] == 14
    assert abs(b["mean"] - 60.0) < 1e-9
    assert abs(b["sd"] - 6.0) < 1e-9
    # The caller may lower the bar, but not by accident.
    assert R.baseline(nights(60, 6, 8), min_samples=8)["n"] == 8


def test_baseline_counts_days_not_readings():
    # Thirty nights, the watch caught every third one: ten readings, not thirty.
    patchy = [60.0 if i % 3 == 0 else None for i in range(30)]
    assert R.baseline(patchy) is None
    assert R.baseline(patchy, min_samples=10)["n"] == 10

    # Older readings outside the window do not drag the baseline around.
    b = R.baseline(nights(90, 1, 40) + nights(50, 2, 20), days=20)
    assert abs(b["mean"] - 50.0) < 1e-9
    assert abs(b["sd"] - 2.0) < 1e-9


def test_baseline_ignores_junk():
    assert R.baseline([None] * 40) is None
    assert R.baseline(nights(60, 6, 20) + [None, "", "not a number"])["n"] == 20


def test_z_score_against_a_hand_computed_value():
    b = R.baseline(nights(60, 6))                    # mean 60, sd 6 exactly
    assert abs(R.z_score(48, b) - -2.0) < 1e-9
    assert abs(R.z_score(66, b) - 1.0) < 1e-9
    assert R.z_score(60, b) == 0.0
    assert R.z_score(None, b) is None
    assert R.z_score(60, None) is None


def test_a_flat_history_is_not_divided_by():
    """A watch reporting whole beats can read 48 every morning for a month."""
    flat = R.baseline([48.0] * 30)
    assert flat["sd"] == 0.0
    assert R.z_score(48, flat) == 0.0
    up = R.z_score(49, flat)
    assert up is not None and 0.0 < up <= R.MAX_Z
    assert R.z_score(47, flat) == -up
    # Capped rather than allowed to run away.
    assert R.z_score(200, flat) == R.MAX_Z

    # Flat *and* zero: no mean to take a fraction of either.
    zero = R.baseline([0.0] * 30)
    assert R.z_score(0, zero) == 0.0
    assert R.z_score(5, zero) == R.MAX_Z
    assert R.z_score(-5, zero) == -R.MAX_Z


def test_hrv_status_across_the_four_bands():
    b = R.baseline(nights(60, 6))
    assert R.hrv_status(75, b) == "high"            # z = +2.5
    assert R.hrv_status(63, b) == "balanced"        # z = +0.5
    assert R.hrv_status(60, b) == "balanced"
    assert R.hrv_status(53, b) == "low"             # z = -1.17
    assert R.hrv_status(45, b) == "very_low"        # z = -2.5
    # Band edges belong to the more serious side.
    assert R.hrv_status(66, b) == "high"            # z = +1.0
    assert R.hrv_status(54, b) == "low"             # z = -1.0
    assert R.hrv_status(48, b) == "very_low"        # z = -2.0


def test_hrv_status_needs_a_baseline():
    assert R.hrv_status(60, None) is None
    assert R.hrv_status(None, R.baseline(nights(60, 6))) is None


def test_trend_reads_up_down_and_flat():
    assert R.trend([60, 60, 60, 60, 60, 60, 60]) == "flat"
    assert R.trend([50, 52, 54, 56, 58, 60, 62]) == "up"
    assert R.trend([62, 60, 58, 56, 54, 52, 50]) == "down"
    # A wobble that goes nowhere is not a trend.
    assert R.trend([60, 62, 59, 61, 60, 61, 60]) == "flat"
    # Only the recent window counts.
    assert R.trend([90, 80, 70] + [50] * 7) == "flat"


def test_trend_needs_a_few_days():
    assert R.trend(None) is None
    assert R.trend([]) is None
    assert R.trend([60]) is None
    assert R.trend([60, 65]) is None
    assert R.trend([60, 65, 70]) == "up"


def test_trend_survives_missing_nights():
    assert R.trend([60, None, 62, None, 64, None, 66]) == "up"
    assert R.trend([66, None, 64, None, 62, None, 60]) == "down"
    assert R.trend([60, None, None, None, None, None, 66]) is None


def test_readiness_with_only_tsb():
    r = R.readiness(tsb=10)
    assert r["used"] == ["tsb"]
    assert abs(r["score"] - 65.0) < 1e-9
    assert r["band"] == "ready"
    assert r["confidence"] == "low"                  # one input out of four
    assert abs(r["components"]["tsb"]["weight"] - 1.0) < 1e-9


def test_readiness_with_only_hrv():
    b = bases()
    assert R.readiness(hrv=60, baselines=b)["score"] == 50.0
    low = R.readiness(hrv=48, baselines=b)
    assert low["used"] == ["hrv"]
    assert low["score"] == 10.0                      # z = -2, twenty points per sd
    assert low["band"] == "depleted"
    assert low["hrv_status"] == "very_low"
    assert low["confidence"] == "low"


def test_readiness_with_everything_reports_what_it_used():
    r = R.readiness(hrv=66, rhr=46, sleep_hours=7.5, sleep_score=80, tsb=5,
                    baselines=bases())
    assert r["used"] == ["hrv", "rhr", "sleep_score", "tsb"]
    # The watch's own sleep score already has duration inside it.
    assert "sleep_hours" not in r["used"]
    assert r["components"]["sleep"]["source"] == "sleep_score"
    assert abs(r["coverage"] - 1.0) < 1e-9
    assert r["confidence"] == "high"
    assert abs(sum(c["weight"] for c in r["components"].values()) - 1.0) < 1e-9
    # 0.35*70 + 0.20*65 + 0.25*80 + 0.20*57.5
    assert abs(r["score"] - 69.0) < 1e-9
    assert r["band"] == "ready"


def test_readiness_falls_back_to_sleep_hours():
    r = R.readiness(sleep_hours=8.0, baselines=bases())
    assert r["used"] == ["sleep_hours"]
    assert r["components"]["sleep"]["source"] == "sleep_hours"
    assert r["score"] == 85.0
    assert r["confidence"] == "low"


def test_readiness_skips_what_it_cannot_ground():
    """A heart number with no history behind it is a number, not evidence."""
    assert R.readiness(hrv=60) is None
    assert R.readiness(hrv=60, rhr=48, baselines={"hrv": None}) is None
    assert R.readiness(hrv=60, baselines={"hrv": R.baseline([60, 61])}) is None
    # ...but the inputs that need no history still come through.
    r = R.readiness(hrv=60, tsb=0)
    assert r["used"] == ["tsb"]


def test_a_recovered_athlete_scores_high():
    r = R.readiness(hrv=75, rhr=43, sleep_score=92, tsb=12, baselines=bases())
    assert r["score"] > 80.0, r["score"]
    assert r["band"] == "primed"
    assert r["hrv_status"] == "high"
    assert "ready" in r["verdict"]


def test_a_dug_out_athlete_scores_low():
    r = R.readiness(hrv=45, rhr=53, sleep_hours=4.8, tsb=-22, baselines=bases())
    assert r["score"] < 30.0, r["score"]
    assert r["band"] == "depleted"
    assert r["hrv_status"] == "very_low"
    assert r["used"] == ["hrv", "rhr", "sleep_hours", "tsb"]


def test_the_body_outvotes_the_plan():
    """TSB says tapered; HRV, resting HR and sleep all say otherwise."""
    on_paper = R.readiness(tsb=25)
    assert on_paper["band"] == "primed"
    real = R.readiness(hrv=48, rhr=52, sleep_hours=5.0, tsb=25, baselines=bases())
    assert real["components"]["tsb"]["score"] > 80.0      # the plan has not changed
    assert real["score"] < 45.0, real["score"]
    assert real["band"] in ("strained", "depleted")


def test_sleep_hours_are_read_absolutely():
    """Six hours is short for everybody -- the one metric with no baseline."""
    assert R.sleep_hours_score(8.0) > R.sleep_hours_score(6.0) > R.sleep_hours_score(4.0)
    # Another hour in bed past a full night buys nothing.
    assert R.sleep_hours_score(11.0) == R.sleep_hours_score(9.0) == 90.0
    assert R.sleep_hours_score(2.0) == 10.0


def test_tsb_score_is_capped_at_the_top():
    assert R.tsb_score(0) == 50.0
    assert R.tsb_score(-20) == 20.0
    assert R.tsb_score(-40) == 0.0
    assert R.tsb_score(40) == R.TSB_CEILING          # rested is not the same as fit


def test_bands_line_up_with_the_score():
    assert R.band(100.0)[0] == "primed"
    assert R.band(80.0)[0] == "primed"
    assert R.band(79.9)[0] == "ready"
    assert R.band(0.0)[0] == "depleted"
    assert R.band(-5.0)[0] == "depleted"


def test_advice_differs_when_a_hard_session_is_planned():
    good = R.readiness(hrv=66, rhr=46, sleep_score=80, tsb=5, baselines=bases())
    assert good["band"] == "ready"
    assert R.advice(good, planned_hard=True) != R.advice(good)

    bad = R.readiness(hrv=50, rhr=52, sleep_hours=5.2, tsb=-15, baselines=bases())
    assert bad["band"] in ("strained", "depleted"), bad["score"]
    easy, hard = R.advice(bad), R.advice(bad, planned_hard=True)
    assert easy != hard
    assert "session" in hard


def test_advice_says_what_it_was_based_on():
    r = R.readiness(hrv=60, sleep_score=70, baselines=bases())
    assert r["confidence"] == "medium"
    text = R.advice(r)
    assert "HRV" in text and "sleep quality" in text
    assert "thin evidence" not in text

    thin = R.advice(R.readiness(tsb=0))
    assert "training load" in thin and "thin evidence" in thin

    assert "as planned" in R.advice(None)


def test_advice_only_points_elsewhere_when_the_body_said_so():
    """A low score built from TSB alone means the training did it, as intended."""
    from_the_log = R.advice(R.readiness(tsb=-30))
    assert "doctor" not in from_the_log
    from_the_body = R.advice(R.readiness(hrv=45, rhr=54, sleep_hours=4.5, tsb=-30,
                                         baselines=bases()))
    assert "doctor" in from_the_body
    assert "not health" in from_the_body


def test_advice_makes_no_medical_claims():
    banned = ("illness", "infection", "sick", "diagnos", "immune", "syndrome")
    seen = set()
    for tsb in (30, 10, 0, -12, -30):                # one per band
        for hard in (False, True):
            r = R.readiness(tsb=tsb)
            seen.add(r["band"])
            text = R.advice(r, planned_hard=hard)
            assert text.endswith("."), text
            assert not any(word in text.lower() for word in banned), text
    assert seen == {"primed", "ready", "steady", "strained", "depleted"}


def test_degenerate_input():
    assert R.baseline(None) is None
    assert R.baseline([]) is None
    assert R.baseline([60.0]) is None
    assert R.baseline([None] * 40) is None
    assert R.baseline(["", "x", None]) is None
    assert R.baseline([60.0], min_samples=1)["sd"] == 0.0
    assert R.trend(None) is None
    assert R.z_score(None, None) is None
    assert R.hrv_status(None, None) is None
    assert R.readiness() is None
    assert R.readiness(hrv=None, rhr=None, sleep_hours=None, sleep_score=None,
                       tsb=None, baselines=None) is None
    assert R.sleep_hours_score(None) is None
    assert R.tsb_score(None) is None
    assert R.advice({}) == R.advice(None)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
