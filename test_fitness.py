"""Self-check for the fitness model. Run: python test_fitness.py"""
from datetime import date, datetime, timedelta

import fitness as F

NOW = datetime(2026, 8, 18, 12, 0)


def run(dist_m, secs, days_ago, hr=155):
    return {"type": "running", "start": NOW - timedelta(days=days_ago),
            "distance_m": dist_m, "moving_s": secs, "elapsed_s": secs, "avg_hr": hr}


def test_percentile():
    assert F.percentile([], 0.5) is None
    assert F.percentile([1, 2, 3], 0.5) == 2.0
    assert F.percentile([1, 2, 3, 4], 0.5) == 2.5
    assert F.percentile([5, None, 1], 0.0) == 1.0


def test_fmt():
    assert F.fmt_time(65) == "1:05"
    assert F.fmt_time(3725) == "1:02:05"
    assert F.fmt_time(None) == "--"
    assert F.fmt_pace(1200, 5000) == "4:00 /km"


def test_power_law_matches_riegel():
    """5K in 20:00 + 10K in 42:00 -> exponent near the textbook 1.06."""
    fit = F.fit_power_law(F.best_efforts([run(5000, 1200, 10), run(10000, 2520, 20)], NOW))
    _, b, pts = fit
    assert len(pts) == 2
    assert 1.05 < b < 1.09, b
    marathon = F.base_prediction(fit, 42195)
    assert 11000 < marathon < 12500, marathon          # ~3:16, sane for that pair
    # Round-trips its own inputs.
    assert abs(F.base_prediction(fit, 5000) - 1200) < 20


def test_single_effort_falls_back_to_riegel():
    fit = F.fit_power_law(F.best_efforts([run(5000, 1200, 3)], NOW))
    assert fit[1] == F.RIEGEL
    assert abs(F.base_prediction(fit, 5000) - 1200) < 1


def test_exponent_is_clamped():
    """A pathological pair must not produce a nonsense exponent."""
    fit = F.fit_power_law(F.best_efforts([run(2000, 700, 5), run(20000, 3800, 5)], NOW))
    assert 1.01 <= fit[1] <= 1.20, fit[1]


def test_junk_efforts_are_dropped():
    acts = [
        run(1000, 300, 5),        # too short
        run(5000, 300, 5),        # 1:00/km, impossible
        run(5000, 5400, 5),       # 18:00/km, a walk mislabelled
        run(5000, 1200, 400),     # older than the window
        {"type": "cycling", "start": NOW, "distance_m": 40000, "moving_s": 4800,
         "elapsed_s": 4800, "avg_hr": 140},
        run(5000, 1200, 5),       # the only keeper
    ]
    efforts = F.best_efforts(acts, NOW)
    assert efforts == [(5000, 1200, 5)], efforts


def test_easy_long_runs_do_not_set_the_curve():
    """A hard 5K plus a pile of easy 12Ks must not look like severe fade."""
    acts = [run(12000, 3600, d, hr=140) for d in range(1, 90, 3)]
    acts.append(run(5000, 1200, 6, hr=178))
    s = F.summarise(acts, NOW)
    assert s["fit"][1] < 1.20, s["fit"][1]                 # not pinned to the clamp
    half = F.project_race(s, 21097)["seconds"]
    assert 5200 < half < 6600, half                        # ~1:27-1:50, not 2h+


def test_hr_filter_relaxes_when_it_would_starve_the_fit():
    """Only one hard run -> fall back to using everything rather than give up."""
    acts = [run(12000, 3600, d, hr=140) for d in (3, 9, 15)]
    acts.append(run(5000, 1200, 6, hr=178))
    efforts = F.best_efforts(acts, NOW, thr_hr=178.0)
    assert len(efforts) == 4, efforts                      # kept the easy runs too
    assert F.fit_power_law(efforts) is not None


def test_quality_backstop_without_hr():
    """No HR at all: a wildly slow bucket best is still discarded."""
    efforts = [(5000, 1200, 5), (10000, 2520, 5), (20000, 9000, 5)]
    picks = F.bucket_bests(efforts)
    assert (20000, 9000, 5) not in picks, picks
    assert len(picks) == 2


def test_real_marathon_result_survives_the_filter():
    """A 20:00 5K + 3:45 marathon is a real (fading) athlete, not noise -- keep both."""
    picks = F.bucket_bests([(5000, 1200, 20), (42195, 13500, 40)])
    assert len(picks) == 2, picks
    fit = F.fit_power_law([(5000, 1200, 20), (42195, 13500, 40)])
    assert 1.10 < fit[1] < 1.16, fit[1]         # genuine fade, not clamped away
    assert abs(F.base_prediction(fit, 42195) - 13500) < 200


def test_no_data_returns_none():
    assert F.fit_power_law([]) is None
    assert F.base_prediction(None, 5000) is None
    assert F.project_race(F.summarise([], NOW), 10000) is None


def test_load_and_ramp():
    acts = [run(10000, 2700, d, hr=150) for d in range(0, 60, 2)]
    thr_hr, thr_spd = F.thresholds(acts)
    assert thr_hr == 150.0
    load = F.activity_load(acts[0], thr_hr, thr_spd)
    assert abs(load - 0.75 * 1.0 * 100.0) < 1.0, load     # 45 min at threshold
    curve = F.load_curve(F.daily_loads(acts, thr_hr, thr_spd), NOW.date())
    assert len(curve) == 181
    ctl = curve[-1][2]
    assert 20 < ctl < 60, ctl                              # ~37.5 load/day every other day
    assert all(c[2] >= 0 for c in curve)


def test_detraining_shows_up_as_negative_tsb_recovery():
    """Stop training and ATL must fall below CTL (i.e. TSB goes positive)."""
    acts = [run(10000, 2700, d) for d in range(30, 120)]   # nothing in the last 30 days
    s = F.summarise(acts, NOW)
    assert s["tsb"] > 0, s["tsb"]
    assert s["atl"] < s["ctl"]


def test_fitness_factor_direction_and_caps():
    assert F.fitness_factor(50, 40, 56) < 1.0              # building -> faster
    assert F.fitness_factor(30, 40, 56) > 1.0              # detraining -> slower
    assert F.fitness_factor(50, 40, 0) == 1.0              # race is today
    assert F.fitness_factor(0, 40, 30) == 1.0              # no data
    assert F.fitness_factor(500, 1, 365) >= 0.96           # cap holds
    assert F.fitness_factor(1, 500, 365) <= 1.04


def test_project_race_end_to_end():
    acts = ([run(5000, 1200, d) for d in (5, 40)] +
            [run(10000, 2520, d) for d in (12, 60)] +
            [run(21097, 5700, 25)] +
            [run(12000, 3600, d) for d in range(1, 90, 3)])
    s = F.summarise(acts, NOW)
    p = F.project_race(s, 42195, NOW.date() + timedelta(days=70), NOW.date())
    assert p["confidence"] in ("high", "medium", "low")
    assert 10000 < p["seconds"] < 15000, p["seconds"]
    assert p["days_to_race"] == 70
    assert 0.96 <= p["trend_factor"] <= 1.04
    assert len(p["based_on"]) >= 3
    assert len(s["weekly"]) == 12
    assert s["weekly"][-1][0] <= NOW.date()


def test_confidence_degrades_with_extrapolation():
    acts = [run(2500, 570, 3), run(5000, 1200, 5), run(10000, 2520, 7)]
    s = F.summarise(acts, NOW)
    near = F.project_race(s, 15000, NOW.date() + timedelta(days=30), NOW.date())
    far = F.project_race(s, 50000, NOW.date() + timedelta(days=30), NOW.date())
    assert near["confidence"] == "high"
    assert far["confidence"] == "low"


def _even_run(total_m, pace_s_per_km, step_m=10.0):
    """Samples for a perfectly even run."""
    out, d = [], 0.0
    while d <= total_m + 1e-9:
        out.append((d / 1000.0 * pace_s_per_km, d))
        d += step_m
    return out


def test_best_effort_curve_even_run():
    """A 10 km at 4:00/km: every sub-distance comes out at 4:00/km."""
    curve = F.best_effort_curve(_even_run(10000, 240.0))
    assert set(curve) == {400, 800, 1000, 1609, 3000, 5000, 10000}
    for dist, secs in curve.items():
        assert abs(secs - dist / 1000.0 * 240.0) < 1.0, (dist, secs)


def test_best_effort_curve_finds_the_surge():
    """A 5 km jog with a fast 1 km in the middle must find that 1 km."""
    samples, t, d = [(0.0, 0.0)], 0.0, 0.0
    for km in range(5):
        pace = 200.0 if km == 2 else 320.0          # 3:20/km surge inside a 5:20 jog
        for _ in range(100):                        # 10 m steps
            d += 10.0
            t += pace / 100.0
            samples.append((t, d))
    curve = F.best_effort_curve(samples)
    assert abs(curve[1000] - 200.0) < 2.0, curve[1000]
    assert abs(curve[3000] - (200.0 + 2 * 320.0)) < 4.0, curve[3000]
    assert 5000 in curve


def test_best_effort_curve_edges():
    assert F.best_effort_curve([]) == {}
    assert F.best_effort_curve([(0.0, 0.0)]) == {}
    assert 10000 not in F.best_effort_curve(_even_run(5000, 240.0))   # never ran that far
    # GPS drifting backwards must not create a negative-length window.
    jitter = [(0.0, 0.0), (10.0, 50.0), (20.0, 40.0), (30.0, 120.0), (400.0, 1200.0)]
    assert all(v > 0 for v in F.best_effort_curve(jitter).values())


def test_best_effort_curve_rejects_gps_artefacts():
    """A teleport that implies 30 s/km is dropped, not recorded as a world record."""
    bogus = [(0.0, 0.0), (12.0, 400.0), (600.0, 2000.0)]
    assert 400 not in F.best_effort_curve(bogus)


def test_personal_records():
    rows = [(5000, 1200, "2026-05-01"), (5000, 1150, "2026-07-01"),
            (10000, 2500, "2026-06-01"), (5000, 1300, "2026-08-01")]
    prs = F.personal_records(rows)
    assert prs == [(5000, 1150, "2026-07-01"), (10000, 2500, "2026-06-01")]
    assert F.personal_records([]) == []


def test_segment_efforts_beat_whole_activities():
    """A fast 5 km inside a long run should drive the fit, not the long run's average."""
    acts = [run(20000, 6600, d, hr=150) for d in range(1, 60, 3)]      # 5:30/km plods
    plain = F.summarise(acts, NOW)
    better = F.summarise(acts, NOW, segment_efforts=[(5000, 1150, 4)])
    assert F.base_prediction(better["fit"], 5000) < F.base_prediction(plain["fit"], 5000)
    assert abs(F.base_prediction(better["fit"], 5000) - 1150) < 60


def test_threshold_pace_and_training_paces():
    fit = F.fit_power_law([(5000, 1200, 5), (10000, 2520, 5)])
    thr = F.threshold_pace(fit)
    assert 240 < thr < 300, thr                     # between 5K and marathon pace
    paces = F.training_paces(fit)
    assert [p[0] for p in paces] == ["Easy", "Marathon", "Threshold", "Interval", "Repetition"]
    for _, _, fast, slow in paces:
        assert fast < slow                          # fast bound is the lower number
    easy, marathon, threshold, interval, rep = paces
    assert easy[2] > marathon[2] > threshold[2] > interval[2] > rep[2]
    assert F.training_paces(None) == []
    assert F.threshold_pace(None) is None


def test_hr_zones():
    zones = F.hr_zones(170)
    assert len(zones) == 5
    assert zones[3][0].startswith("Z4")
    assert zones[3][1] <= 170 <= zones[3][2]        # threshold sits in Z4
    for i in range(4):
        assert zones[i][2] == zones[i + 1][1]       # no gaps between zones
    assert F.hr_zones(None) == []


def test_session_spike():
    """Replaces the ACWR test: distance vs the longest run of the last 30 days."""
    today = date(2026, 8, 19)
    base = [(today - timedelta(days=d), 15000.0) for d in (28, 21, 14, 7)]

    # A run in line with recent training is not a spike.
    ratio, distance, longest, verdict = F.session_spike(base + [(today, 14000.0)])
    assert ratio < 1.0 and longest == 15000.0
    assert "within" in verdict

    # A big jump is flagged, and named for what the evidence actually says.
    ratio, _d, _l, verdict = F.session_spike(base + [(today, 22000.0)])
    assert ratio > 1.30
    assert "injur" in verdict

    # The reference is the longest recent run, not the average.
    mixed = [(today - timedelta(days=d), m)
             for d, m in ((20, 8000.0), (10, 20000.0), (3, 8000.0))]
    assert F.session_spike(mixed + [(today, 20000.0)])[2] == 20000.0

    # Runs outside the window do not count as the reference.
    old_long = [(today - timedelta(days=200), 40000.0),
                (today - timedelta(days=10), 10000.0)]
    assert F.session_spike(old_long + [(today, 12000.0)])[2] == 10000.0

    # Nothing to compare against says nothing.
    assert F.session_spike([]) is None
    assert F.session_spike([(today, 10000.0)]) is None


def test_project_form_taper_raises_freshness():
    from datetime import date
    today = date(2026, 8, 18)
    daily = {today - timedelta(days=i): 60.0 for i in range(400)}
    p = F.project_form(daily, today, today + timedelta(days=42))
    assert p["tsb_with_taper"] > p["tsb_no_taper"]
    assert p["days_out"] == 42
    assert abs(p["avg_daily_load"] - 60.0) < 0.01
    assert F.project_form(daily, today, today) is None
    assert F.project_form(daily, today, today - timedelta(days=1)) is None


def test_split_targets():
    splits = F.split_targets(10000, 2400)
    assert len(splits) == 10
    assert splits[-1][0] == "Finish"
    assert abs(splits[-1][2] - 2400) < 1.0                    # totals to the target
    assert all(b[2] > a[2] for a, b in zip(splits, splits[1:]))
    first_half = splits[4][2]
    assert first_half > 1200, first_half                      # negative split: slower start

    marathon = F.split_targets(42195, 12600)
    assert marathon[0][0] == "5K" and marathon[-1][0] == "Finish"
    assert abs(marathon[-1][2] - 12600) < 1.0
    assert F.split_targets(0, 100) == [] and F.split_targets(5000, 0) == []


def test_calibration():
    from datetime import date
    today = date(2026, 8, 18)
    assert F.calibration([], today) is None
    assert F.calibration([(2400, 2500, date(2026, 5, 1))], today) is None      # one is an anecdote

    # Consistently 3% slower than projected -> factor ~1.03
    res = [(2400, 2472, date(2026, 5, 1)), (5400, 5562, date(2026, 6, 1)),
           (1200, 1236, date(2026, 7, 1))]
    cal = F.calibration(res, today)
    assert 1.025 < cal["factor"] < 1.035, cal
    assert cal["n"] == 3 and cal["direction"] == "slower than projected"
    assert abs(cal["mean_abs_error"] - 0.03) < 0.001

    # A wild outlier is capped, not obeyed.
    wild = [(2400, 4800, date(2026, 5, 1)), (2400, 4800, date(2026, 6, 1))]
    assert F.calibration(wild, today)["factor"] == 1.0 + F.CALIBRATION_MAX_ADJUST

    # Recent results outweigh old ones.
    mixed = [(1000, 1100, date(2023, 1, 1)), (1000, 950, date(2026, 8, 1))]
    assert F.calibration(mixed, today)["raw_factor"] < 1.0

    p = {"seconds": 1000.0, "confidence": "high"}
    assert F.apply_calibration(p, cal)["seconds"] > 1000.0
    assert F.apply_calibration(p, None) is p
    assert "calibration_factor" in F.apply_calibration(p, cal)


def test_km_splits_even_and_surge():
    even = F.km_splits(_even_run(5000, 240.0))
    assert len(even) == 5
    assert all(abs(p - 240.0) < 0.5 for _, _, p in even), even
    assert F.split_evenness(even) < 0.005

    samples, t, d = [(0.0, 0.0)], 0.0, 0.0
    for km in range(4):
        pace = 200.0 if km == 1 else 300.0
        for _ in range(100):
            d += 10.0; t += pace / 100.0
            samples.append((t, d))
    sp = F.km_splits(samples)
    assert [round(p) for _, _, p in sp] == [300, 200, 300, 300], sp
    assert F.split_evenness(sp) > 0.1
    assert F.km_splits([]) == [] and F.split_evenness([]) is None

    # A partial final split (5.4 km) is reported at its own pace.
    part = F.km_splits(_even_run(5400, 240.0))
    assert len(part) == 6 and abs(part[-1][2] - 240.0) < 2.0


def test_hr_drift():
    # HR rises 5% at constant pace -> drift ~ +5%.
    pts = [(t, t * 3.0, 150.0 if t < 1800 else 157.5) for t in range(0, 3600, 10)]
    drift = F.hr_drift(pts)
    assert 4.5 < drift < 5.5, drift
    assert F.hr_drift(pts[:5]) is None
    assert F.hr_drift([(t, t * 3.0, None) for t in range(0, 3600, 10)]) is None


def test_classify_run():
    def act(dist, secs, hr):
        return {"distance_m": dist, "moving_s": secs, "avg_hr": hr}
    thr = 175.0
    assert F.classify_run(act(5000, 1200, 176), thr, None) == "race"
    assert F.classify_run(act(10000, 2700, 165), thr, None) == "tempo"
    assert F.classify_run(act(6000, 1000, 165), thr, None) == "intervals"
    assert F.classify_run(act(22000, 6600, 150), thr, None) == "long"
    assert F.classify_run(act(8000, 2700, 140), thr, None) == "easy"
    assert F.classify_run(act(8000, 2500, 155), thr, None) == "steady"
    assert F.classify_run(act(0, 0, 150), thr, None) == "unknown"
    # falls back to pace when there is no HR
    assert F.classify_run(act(5000, 1200, None), None, 245.0) == "race"


def test_week_digest():
    monday = NOW.date() - timedelta(days=NOW.date().weekday())
    def on(day, dist, secs, hr=150):
        return {"type": "running", "start": datetime.combine(day, datetime.min.time()),
                "distance_m": dist, "moving_s": secs, "elapsed_s": secs, "avg_hr": hr}
    acts = [on(monday, 10000, 3000), on(monday + timedelta(days=1), 20000, 6000),
            on(monday - timedelta(days=3), 8000, 2400)]
    thr_hr, thr_spd = F.thresholds(acts)
    dg = F.week_digest(acts, NOW, thr_hr, thr_spd)
    assert dg["week_start"] == monday
    assert abs(dg["this"]["km"] - 30.0) < 0.01
    assert abs(dg["last"]["km"] - 8.0) < 0.01
    assert abs(dg["km_delta"] - 22.0) < 0.01
    assert dg["longest"]["distance_m"] == 20000
    assert dg["fastest"]["distance_m"] in (10000, 20000)


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
