"""Self-check for weather correction. Run: python test_weather.py"""
import weather as W


def test_heat_index():
    assert W.heat_index_c(None, 50) is None
    # Below the regression's range, the dry temperature is the honest answer.
    assert W.heat_index_c(10.0, 90) == 10.0
    assert W.heat_index_c(20.0, None) == 20.0
    # Hot and humid feels hotter than the thermometer says.
    assert W.heat_index_c(32.0, 80) > 36.0
    # Hot and dry barely does.
    assert abs(W.heat_index_c(32.0, 20) - 32.0) < 3.0
    # Humidity is clamped rather than trusted blindly.
    assert W.heat_index_c(32.0, 500) == W.heat_index_c(32.0, 100)


def test_penalty_shape():
    assert W.penalty(None) == 0.0
    assert W.penalty(10.0) == 0.0                    # cool is free
    assert W.penalty(W.NEUTRAL_C) == 0.0
    # It grows with heat, and faster than linearly.
    p20, p25, p30 = W.penalty(20.0), W.penalty(25.0), W.penalty(30.0)
    assert 0 < p20 < p25 < p30
    assert (p30 - p25) > (p25 - p20), "should be quadratic, not linear"
    # A hot humid day costs several percent, but never absurdly much.
    assert 0.03 < W.penalty(30.0, 85) < W.MAX_PENALTY
    assert W.penalty(55.0, 100) <= W.MAX_PENALTY
    # Real cold costs something too.
    assert W.penalty(-15.0) > 0


def test_penalty_matches_published_guidance():
    """Pinned against the reference points the heat-and-pace tables agree on.

    These are the numbers the whole module is calibrated to; if they drift, the
    correction has quietly become someone else's opinion.
    """
    assert W.penalty(15.0, 60) < 0.01                # barely anything
    assert 0.010 < W.penalty(20.0, 60) < 0.025       # ~1.5%
    assert 0.030 < W.penalty(25.0, 70) < 0.055       # ~4%
    assert 0.070 < W.penalty(30.0, 60) < 0.115       # ~10%
    # Even a brutal day stays inside a believable ceiling.
    assert W.penalty(38.0, 95) == W.MAX_PENALTY


def test_humidity_and_dew_point_matter():
    dry = W.penalty(30.0, 25)
    humid = W.penalty(30.0, 90)
    assert humid > dry, (dry, humid)
    # A high dew point is worse than the dry temperature alone suggests.
    assert W.penalty(24.0, None, 20.0) > W.penalty(24.0, None, 5.0)
    assert W.penalty(24.0, None, 5.0) == W.penalty(24.0)


def test_adjust():
    assert W.adjust(None, 30.0) is None
    assert W.adjust(300.0, 10.0) == 300.0            # nothing to correct
    hot = W.adjust(300.0, 30.0, 85)
    assert hot < 300.0, hot                          # corrected pace is quicker
    # The correction is exactly the penalty, no more.
    assert abs(hot * (1 + W.penalty(30.0, 85)) - 300.0) < 0.01


def test_describe():
    assert W.describe(None) is None
    cool = W.describe(9.0)
    assert "no correction" in cool
    hot = W.describe(31.0, 85)
    assert "%" in hot and "31 C" in hot and "85% humidity" in hot
    assert "feels like" in hot


def test_season_summary():
    rows = [(2.0, 300.0), (3.0, 302.0),               # cold
            (16.0, 305.0),                            # neutral
            (30.0, 330.0), (31.0, 335.0)]             # hot
    out = W.season_summary(rows)
    labels = [b["label"] for b in out]
    assert labels == ["Under 5 C", "13-20 C", "Over 26 C"], labels
    cold, hot = out[0], out[-1]
    assert cold["runs"] == 2 and hot["runs"] == 2
    # Raw pace looks much worse in the heat...
    assert hot["mean_pace"] > cold["mean_pace"]
    # ...and the correction closes some of that gap, without inverting it.
    assert hot["mean_adjusted"] < hot["mean_pace"]
    assert abs(cold["mean_adjusted"] - cold["mean_pace"]) < 1.0
    assert W.season_summary([]) == []
    assert W.season_summary([(None, 300.0), (20.0, None)]) == []


def test_normalise_units():
    assert W.normalise(None) is None
    assert W.normalise({}) is None
    assert W.normalise("nope") is None

    metric = W.normalise({"temp": 22, "relativeHumidity": 60, "dewPoint": 14})
    assert metric["temp_c"] == 22.0
    assert metric["humidity"] == 60.0
    assert metric["dew_point_c"] == 14.0

    # 86 is not a Celsius running day, so it must be read as Fahrenheit.
    imperial = W.normalise({"temp": 86, "dewPoint": 68, "relativeHumidity": 55})
    assert 29.0 < imperial["temp_c"] < 31.0, imperial["temp_c"]
    assert 19.0 < imperial["dew_point_c"] < 21.0, imperial["dew_point_c"]

    # Nonsense humidity is dropped rather than believed.
    assert W.normalise({"temp": 20, "relativeHumidity": 900})["humidity"] is None
    assert W.normalise({"temp": "warm"}) is None
    assert W.normalise({"temp": float("nan"), "relativeHumidity": 50})["temp_c"] is None


def test_a_summer_run_stops_looking_like_lost_fitness():
    """The point of all this: same effort, two seasons, one comparable number."""
    winter, summer = 300.0, 322.0                     # 5:00 vs 5:22 per km
    w_adj = W.adjust(winter, 4.0, 70)
    s_adj = W.adjust(summer, 29.0, 80)
    assert summer - winter > 20                       # looks like a big loss
    assert abs(s_adj - w_adj) < (summer - winter)     # corrected, much of it goes
    assert s_adj < summer


def test_heat_acclimation_bands_match_the_protocol():
    """Pinned against the 10-14 day protocol, allowing for the decay."""
    from datetime import date, timedelta
    today = date(2026, 8, 20)

    def hot_days(n, ago=0, temp=27.0, minutes=60.0):
        return [(today - timedelta(days=ago + i), temp, minutes) for i in range(n)]

    assert W.heat_exposure([], today)["band"] == "none"

    # Three consecutive hot days is the start of something.
    three = W.heat_exposure(hot_days(3), today)
    assert three["band"] == "starting", three
    assert three["recent"] == 3

    # A full two-week protocol is the top band.
    full = W.heat_exposure(hot_days(14), today)
    assert full["band"] == "most of the way", full
    assert full["sessions"] > three["sessions"]

    # The same block six weeks ago has decayed away, which is the point.
    stale = W.heat_exposure(hot_days(14, ago=42), today)
    assert stale["band"] == "none", stale
    assert stale["recent"] == 0
    assert stale["sessions"] < full["sessions"] * 0.1


def test_only_genuinely_hot_runs_count():
    from datetime import date, timedelta
    today = date(2026, 8, 20)
    mild = [(today - timedelta(days=i), 14.0, 60.0) for i in range(14)]
    assert W.heat_exposure(mild, today)["sessions"] == 0.0
    assert W.heat_exposure(mild, today)["hottest_c"] is None

    # A short hot run counts for less than a long one.
    short = W.heat_exposure([(today, 30.0, 15.0)], today)
    long_run = W.heat_exposure([(today, 30.0, 90.0)], today)
    assert short["sessions"] < long_run["sessions"]
    assert long_run["sessions"] <= 1.0, "one session cannot bank more than one"

    # Future-dated runs are ignored rather than counted backwards.
    future = W.heat_exposure([(today + timedelta(days=5), 30.0, 60.0)], today)
    assert future["sessions"] == 0.0


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))