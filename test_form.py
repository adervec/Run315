"""Self-check for running form analysis. Run: python test_form.py"""
import form as F


def build(legs, sample_s=1.0, hr=150, start_lat=47.3769, start_lon=8.5417, ele=400.0):
    """Build a stream from [(seconds, speed_m_s, cadence, stride, gct, vosc)] legs.

    One sample a second, which is what a Garmin records at. A leg with speed 0 is
    standing still: time passes, distance does not. Any dynamics value may be
    None, which is what a run without a strap looks like.
    """
    out, t, d = [], 0.0, 0.0
    lat = start_lat
    for secs, speed, cadence, stride, gct, vosc in legs:
        steps = max(int(secs / sample_s), 1)
        for _ in range(steps):
            step_s = secs / steps
            t += step_s
            d += speed * step_s
            lat += speed * step_s / 111320.0
            out.append((round(t, 2), round(d, 3), hr, round(lat, 6), start_lon, ele,
                        cadence, stride, gct, vosc))
    return out


def steady(secs=900, speed=3.3, cadence=178, stride=1.2, gct=240, vosc=8.0):
    """One unremarkable leg, for tests that only care about one thing."""
    return build([(secs, speed, cadence, stride, gct, vosc)])


def by_metric(findings):
    return {f["metric"]: f for f in findings}


# --------------------------------------------------------------------------- #
# the running portion only
# --------------------------------------------------------------------------- #
def test_averages_ignore_stops_and_warm_up():
    """A long stand-around must not drag the averages of the running down."""
    run = build([(120, 1.3, 112, 0.72, 330, 6.0),     # warm-up walk to the park
                 (600, 3.3, 178, 1.20, 240, 8.0),
                 (300, 0.0, 60, 0.40, 420, 3.0),      # standing at a level crossing
                 (600, 3.3, 178, 1.20, 240, 8.0)])
    s = F.summarise(run)
    assert s is not None

    # What a naive whole-file average would have said, for contrast.
    naive = sum(row[6] for row in run) / len(run)
    assert naive < 160, naive

    assert abs(s["cadence"]["mean"] - 178) < 0.5, s["cadence"]
    assert abs(s["gct_ms"]["mean"] - 240) < 1.0, s["gct_ms"]
    assert abs(s["stride_m"]["mean"] - 1.20) < 0.01
    assert s["cadence"]["sd"] < 0.5          # nothing but the running got in
    # Only the running is counted as time on feet, not the 300 s stop.
    assert 1100 < s["seconds"] < 1250, s["seconds"]
    assert s["n"] < len(run)


def test_a_whole_run_below_running_speed_has_no_form():
    walk = build([(600, 1.4, 110, 0.70, 340, 5.5)])
    assert F.summarise(walk) is None
    assert F.cadence_by_pace(walk) == []
    assert F.fatigue_drift(walk) is None


def test_threshold_is_a_parameter():
    """A treadmill jog at 2.2 m/s is running if the caller says so."""
    slow = build([(600, 2.2, 172, 1.05, 255, 8.0)])
    assert F.summarise(slow) is None
    s = F.summarise(slow, min_speed=2.0)
    assert s and abs(s["cadence"]["mean"] - 172) < 0.5


# --------------------------------------------------------------------------- #
# cadence counted over one foot
# --------------------------------------------------------------------------- #
def test_halved_cadence_is_detected():
    assert F.looks_halved([88, 87, 89, 90]) is True
    assert F.looks_halved([176, 178, 174]) is False
    assert F.looks_halved([]) is False
    assert F.looks_halved([None, None]) is False
    assert F.looks_halved([20, 21]) is False          # junk, not a halved cadence
    # 110 is where a brisk walk lives; above it, take the number as given.
    assert F.looks_halved([112, 114, 113]) is False


def test_halved_cadence_is_doubled():
    vals, doubled = F.normalise_cadence([88, None, 90])
    assert doubled is True
    assert vals == [176.0, None, 180.0]

    vals, doubled = F.normalise_cadence([176, 180])
    assert doubled is False and vals == [176, 180]

    single_leg = build([(600, 3.2, 88, 1.21, 245, 8.5)])
    s = F.summarise(single_leg)
    assert s["cadence_doubled"] is True
    assert abs(s["cadence"]["mean"] - 176) < 0.5, s["cadence"]
    # ...and it says so, so nobody wonders why the number moved.
    note = [f for f in F.assess(s) if "single-leg" in f["text"]]
    assert len(note) == 1 and note[0]["severity"] == "note"


def test_one_slow_reading_is_not_doubled_on_its_own():
    """The whole stream is judged, not each sample: only the median decides."""
    mixed = [178.0] * 20 + [85.0]
    vals, doubled = F.normalise_cadence(mixed)
    assert doubled is False and vals[-1] == 85.0


# --------------------------------------------------------------------------- #
# vertical ratio
# --------------------------------------------------------------------------- #
def test_vertical_ratio_is_bounce_over_stride():
    # 8 cm of bounce on a 1.00 m stride: 0.08 m / 1.00 m = 8%.
    assert abs(F.vertical_ratio(8.0, 1.0) - 8.0) < 1e-9
    # 9 cm on a 1.20 m stride: 0.09 / 1.20 = 7.5%.
    assert abs(F.vertical_ratio(9.0, 1.2) - 7.5) < 1e-9
    # A shorter stride makes the same bounce more expensive.
    assert F.vertical_ratio(9.0, 0.9) > F.vertical_ratio(9.0, 1.3)
    assert F.vertical_ratio(None, 1.2) is None
    assert F.vertical_ratio(8.0, None) is None
    assert F.vertical_ratio(8.0, 0) is None
    assert F.vertical_ratio("x", 1.2) is None


def test_summary_carries_the_ratio():
    s = F.summarise(steady(stride=1.25, vosc=10.0))
    assert abs(s["vertical_ratio"] - 8.0) < 0.01, s["vertical_ratio"]
    # No stride channel, no ratio -- and no crash.
    bare = F.summarise(build([(600, 3.3, 178, None, 240, 10.0)]))
    assert bare["vertical_ratio"] is None
    assert bare["stride_m"] is None
    assert abs(bare["vert_osc_cm"]["mean"] - 10.0) < 0.01


# --------------------------------------------------------------------------- #
# cadence against pace
# --------------------------------------------------------------------------- #
def test_cadence_rises_with_pace():
    run = build([(600, 2.8, 168, 1.05, 265, 8.6),    # ~5:57/km
                 (600, 3.6, 180, 1.20, 235, 8.0),    # ~4:38/km
                 (300, 4.4, 188, 1.40, 215, 7.6)])   # ~3:47/km
    rows = F.cadence_by_pace(run)
    assert len(rows) >= 3

    # Buckets holding a handful of samples are pace transitions, not gears.
    solid = [r for r in rows if r["n"] >= 50]
    assert len(solid) == 3, [(r["label"], r["n"]) for r in solid]
    # Fastest bucket first, and cadence falls as the pace does.
    assert solid[0]["mean_pace"] < solid[1]["mean_pace"] < solid[2]["mean_pace"]
    assert solid[0]["cadence"] > solid[1]["cadence"] > solid[2]["cadence"]
    assert abs(solid[2]["cadence"] - 168) < 1, solid[2]
    assert "faster than 4:00 /km" == solid[0]["label"]
    assert all(r["label"] for r in rows)


def test_buckets_are_a_parameter():
    run = build([(600, 2.8, 168, 1.05, 265, 8.6), (600, 3.6, 180, 1.20, 235, 8.0)])
    rows = F.cadence_by_pace(run, buckets=(300.0,))
    assert len(rows) == 2
    assert rows[0]["label"] == "faster than 5:00 /km"
    assert rows[1]["label"] == "slower than 5:00 /km"
    assert rows[0]["cadence"] > rows[1]["cadence"]
    # No edges at all means one bucket holding everything.
    single = F.cadence_by_pace(run, buckets=())
    assert len(single) == 1 and single[0]["label"] == "all paces"


def test_cadence_by_pace_needs_a_cadence_channel():
    assert F.cadence_by_pace(build([(600, 3.3, None, 1.2, 240, 8.0)])) == []


# --------------------------------------------------------------------------- #
# fatigue drift
# --------------------------------------------------------------------------- #
def test_drift_catches_cadence_falling_and_contact_rising():
    """Same pace throughout, so the drift is form and not just slowing down."""
    run = build([(900, 3.3, 180, 1.22, 238, 8.0),
                 (900, 3.3, 171, 1.29, 262, 8.6)])
    d = F.fatigue_drift(run)
    assert d is not None
    assert abs(d["cadence_first"] - 180) < 0.5 and abs(d["cadence_second"] - 171) < 0.5
    assert d["cadence_delta"] < 0 and d["cadence_pct"] < -4
    assert d["gct_delta"] > 0 and d["gct_pct"] > 9
    assert d["breaking_down"] is True
    assert abs(d["pace_pct"]) < 1, d["pace_pct"]     # the pace was held


def test_a_run_that_held_together_is_not_flagged():
    run = build([(900, 3.3, 179, 1.20, 240, 8.0), (900, 3.3, 179, 1.20, 240, 8.0)])
    d = F.fatigue_drift(run)
    assert d["breaking_down"] is False
    assert abs(d["cadence_pct"]) < F.DRIFT_PCT
    assert abs(d["gct_pct"]) < F.DRIFT_PCT


def test_drift_reports_the_fade_that_explains_it():
    """Cadence falling because you slowed down is still reported, with the pace."""
    run = build([(900, 3.6, 182, 1.24, 235, 8.0),
                 (900, 2.9, 172, 1.19, 258, 8.5)])
    d = F.fatigue_drift(run)
    assert d["breaking_down"] is True
    assert d["pace_pct"] > 15, d["pace_pct"]         # second half a lot slower
    assert d["pace_second"] > d["pace_first"]
    text = by_metric(F.assess(F.summarise(run), drift=d))["drift"]["text"]
    assert "slowed" in text


def test_drift_needs_enough_samples():
    assert F.fatigue_drift(build([(10, 3.3, 180, 1.2, 240, 8.0)])) is None
    assert F.fatigue_drift([]) is None
    # Pace only, no dynamics at all: nothing to say about form.
    assert F.fatigue_drift([(t, t * 3.3) for t in range(600)]) is None


# --------------------------------------------------------------------------- #
# plain English
# --------------------------------------------------------------------------- #
SEVERITIES = ("good", "watch", "note")


def test_assess_flags_a_low_cadence_run():
    low = F.summarise(build([(900, 3.0, 152, 1.05, 305, 13.0)]))
    f = by_metric(F.assess(low))
    assert f["cadence"]["severity"] == "watch"
    assert "170" in f["cadence"]["text"] and "152" in f["cadence"]["text"]
    # ...while being honest that the band is guidance.
    assert "guidance" in f["cadence"]["text"]
    assert f["gct_ms"]["severity"] == "watch"
    assert f["vertical_ratio"]["severity"] == "watch"


def test_assess_is_happy_with_a_healthy_run():
    good = F.summarise(build([(900, 3.3, 178, 1.22, 232, 7.4)]))
    f = by_metric(F.assess(good))
    assert f["cadence"]["severity"] == "good"
    assert f["gct_ms"]["severity"] == "good"
    assert f["vertical_ratio"]["severity"] == "good"
    assert all(x["severity"] in SEVERITIES and x["text"] for x in F.assess(good))


def test_assess_sits_on_the_fence_in_the_middle():
    """The fuzzy zone gets a note, not a verdict either way."""
    middling = F.summarise(build([(900, 3.1, 166, 1.12, 272, 11.5)]))
    f = by_metric(F.assess(middling))
    assert f["cadence"]["severity"] == "note"
    assert f["gct_ms"]["severity"] == "note"
    assert f["vertical_ratio"]["severity"] == "note"


def test_assess_reports_drift_and_the_pace_swing():
    breaking = build([(900, 3.3, 181, 1.21, 236, 8.0),
                      (900, 3.3, 170, 1.29, 265, 8.7)])
    f = by_metric(F.assess(F.summarise(breaking), drift=F.fatigue_drift(breaking)))
    assert f["drift"]["severity"] == "watch"
    assert "second half" in f["drift"]["text"]

    held = build([(900, 3.3, 179, 1.20, 240, 8.0), (900, 3.3, 179, 1.20, 240, 8.0)])
    f = by_metric(F.assess(F.summarise(held), drift=F.fatigue_drift(held)))
    assert f["drift"]["severity"] == "good"

    swinging = build([(600, 2.7, 162, 1.00, 275, 9.0),
                      (600, 4.2, 188, 1.34, 220, 7.8)])
    f = by_metric(F.assess(F.summarise(swinging), by_pace=F.cadence_by_pace(swinging)))
    assert f["cadence_swing"]["severity"] == "watch"
    assert "rule of thumb" in f["cadence_swing"]["text"]

    settled = build([(600, 2.9, 176, 1.00, 258, 8.4),
                     (600, 4.0, 182, 1.32, 224, 7.9)])
    f = by_metric(F.assess(F.summarise(settled), by_pace=F.cadence_by_pace(settled)))
    assert f["cadence_swing"]["severity"] == "good"


def test_assess_says_nothing_about_channels_it_does_not_have():
    """Only heart rate and pace on this one, plus cadence. No invented findings."""
    part = F.summarise(build([(900, 3.3, 176, None, None, None)]))
    metrics = {f["metric"] for f in F.assess(part)}
    assert "cadence" in metrics
    assert "gct_ms" not in metrics and "vertical_ratio" not in metrics
    assert F.assess(None) == []
    assert F.assess({}) == []
    assert F.assess(part, drift=None, by_pace=[]) == F.assess(part)


def test_a_short_run_is_called_thin():
    f = by_metric(F.assess(F.summarise(steady(secs=120))))
    assert f["data"]["severity"] == "note"
    assert "indicative" in f["data"]["text"]
    assert "data" not in by_metric(F.assess(F.summarise(steady(secs=900))))


# --------------------------------------------------------------------------- #
# ragged, missing and plain broken input
# --------------------------------------------------------------------------- #
def test_empty_and_tiny_input():
    assert F.summarise([]) is None
    assert F.summarise(None) is None
    assert F.cadence_by_pace([]) == []
    assert F.cadence_by_pace(None) == []
    assert F.fatigue_drift([]) is None
    # A single sample has no speed, so there is nothing to say about it.
    assert F.summarise([(0.0, 0.0, 150, 47.4, 8.5, 400.0, 178, 1.2, 240, 8.0)]) is None
    assert F.summarise([(0, 0)]) is None


def test_no_dynamics_fields_at_all():
    """A watch with no strap: a perfectly good run with no form data in it."""
    bare = [(t, t * 3.3) for t in range(600)]
    assert F.summarise(bare) is None
    assert F.cadence_by_pace(bare) == []
    assert F.fatigue_drift(bare) is None

    with_hr = [(t, t * 3.3, 150) for t in range(600)]
    assert F.summarise(with_hr) is None


def test_short_tuples_lose_only_what_they_are_missing():
    full = steady(secs=600)
    ragged = [row if i % 2 else row[:6] for i, row in enumerate(full)]
    s = F.summarise(ragged)
    assert s is not None
    assert abs(s["cadence"]["mean"] - 178) < 0.5
    assert 0 < s["cadence"]["n"] < s["n"], (s["cadence"]["n"], s["n"])
    # Truncated after distance is still a usable pace stream.
    assert F.summarise([row[:2] for row in full]) is None


def test_nones_scattered_through_the_stream():
    full = steady(secs=600)
    holes = [(row[:6] + (None, None, None, None)) if i % 3 == 0 else row
             for i, row in enumerate(full)]
    s = F.summarise(holes)
    assert abs(s["cadence"]["mean"] - 178) < 0.5
    assert abs(s["gct_ms"]["mean"] - 240) < 0.5
    assert s["cadence"]["n"] < s["n"]
    d = F.fatigue_drift(holes)
    assert d is not None and d["breaking_down"] is False


def test_impossible_values_are_dropped():
    """Garmin writes zeros when the pod has nothing to say."""
    zeros = build([(600, 3.3, 0, 0, 0, 0)])
    assert F.summarise(zeros) is None
    # One absurd reading does not move the average.
    run = steady(secs=600)
    run[10] = run[10][:6] + (900, 12.0, 5000, 90.0)
    s = F.summarise(run)
    assert abs(s["cadence"]["mean"] - 178) < 0.5
    assert s["cadence"]["max"] <= 178


def test_junk_types_do_not_crash():
    assert F.summarise([("x", "y"), (None, 5), (1, None)]) is None
    nan = float("nan")
    assert F.summarise([(0, 0), (1, nan), (2, nan)]) is None
    messy = [(t, t * 3.3, 150, None, None, None, "178", 1.2, 240, 8.0)
             for t in range(300)]
    s = F.summarise(messy)
    assert abs(s["cadence"]["mean"] - 178) < 0.5    # numeric strings are numbers
    assert F.summarise([None, (), (0, 0, 0)]) is None


def test_samples_out_of_order_and_gps_going_backwards():
    run = steady(secs=300)
    forwards = F.summarise(run)
    backwards = F.summarise(list(reversed(run)))
    assert abs(backwards["cadence"]["mean"] - forwards["cadence"]["mean"]) < 1e-9
    assert abs(backwards["distance_m"] - forwards["distance_m"]) < 1e-6
    # A distance that jumps backwards is clamped, not treated as a stop.
    jumpy = list(run)
    jumpy[100] = (jumpy[100][0], jumpy[100][1] - 40.0) + jumpy[100][2:]
    s = F.summarise(jumpy)
    assert abs(s["cadence"]["mean"] - 178) < 0.5


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
