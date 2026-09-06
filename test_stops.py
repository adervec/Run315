"""Self-check for stop and slow-down analysis. Run: python test_stops.py"""
import stops as S


def build(legs, hr_profile=None, start_lat=47.3769, start_lon=8.5417, ele0=400.0,
          sample_m=5.0):
    """Build a stream from [(metres, speed_m_s, hr, climb_m), ...] legs.

    A leg with speed 0 is a standing stop of `metres` SECONDS (there is no other
    sane way to express standing still in a distance-based fixture).
    """
    out, t, d, ele = [], 0.0, 0.0, ele0
    lat, lon = start_lat, start_lon
    out.append((0.0, 0.0, hr_profile or 150, lat, lon, ele))
    for leg in legs:
        metres, speed, hr, climb = leg
        if speed == 0:
            # metres is seconds here; time passes, nothing else does.
            steps = max(int(metres / 2), 1)
            for k in range(steps):
                t += metres / steps
                # HR decays toward 110 while standing.
                cur = hr if not callable(hr) else hr(k / steps)
                out.append((round(t, 2), round(d, 2), cur, lat, lon, round(ele, 1)))
            continue
        steps = max(int(metres / sample_m), 1)
        for k in range(steps):
            step_m = metres / steps
            d += step_m
            t += step_m / speed
            ele += climb / steps
            lat += step_m / 111320.0
            cur = hr if not callable(hr) else hr(k / steps)
            out.append((round(t, 2), round(d, 2), cur, round(lat, 6), lon, round(ele, 1)))
    return out


def test_no_interruptions_on_a_clean_run():
    steady = build([(6000, 3.3, 150, 0)])
    assert S.find_interruptions(steady) == []
    assert S.analyse(steady) is None


def test_short_full_stop_is_a_crossing():
    run = build([(1500, 3.3, 160, 0), (25, 0, 158, 0), (1500, 3.3, 160, 0)])
    found = S.find_interruptions(run)
    assert len(found) == 1, found
    it = found[0]
    assert it["full_stop"] is True
    assert 18 < it["seconds"] < 35, it["seconds"]
    label, conf, _why = S.classify(it)
    assert label == "crossing", (label, it)
    assert conf > 0.5


def test_long_stop_with_recovery_is_a_rest():
    def decay(f):
        return 165 - 45 * f            # HR falls a long way while standing
    run = build([(1500, 3.3, 165, 0), (180, 0, decay, 0), (1500, 3.3, 165, 0)])
    found = S.find_interruptions(run)
    assert len(found) == 1
    it = found[0]
    assert it["seconds"] > S.CROSSING_MAX_S
    assert it["hr_drop"] >= S.REST_MIN_HR_DROP, it["hr_drop"]
    assert S.classify(it)[0] == "rest"


def test_slow_on_a_climb_is_a_climb():
    run = build([(1500, 3.3, 155, 0), (300, 1.7, 168, 30), (1500, 3.3, 155, 0)])
    found = S.find_interruptions(run)
    assert len(found) == 1
    it = found[0]
    assert it["full_stop"] is False
    assert it["grade"] is not None and it["grade"] > S.CLIMB_GRADE, it["grade"]
    assert S.classify(it)[0] == "climb"


def test_late_slow_with_high_hr_and_a_penalty_is_exhaustion():
    """Walk break at 70% distance, HR stays up, and the running afterwards is worse."""
    run = build([(7000, 3.3, 168, 0),      # the bulk of the run
                 (200, 1.4, 172, 0),       # walking, HR still high
                 (2000, 2.7, 170, 0)])     # noticeably slower afterwards
    found = S.find_interruptions(run)
    assert len(found) >= 1
    it = [x for x in found if not x["full_stop"]][0]
    assert it["position"] > S.LATE_RUN, it["position"]
    assert it["penalty"] > S.PENALTY, it["penalty"]
    label, conf, why = S.classify(it)
    assert label == "exhaustion", (label, it)
    assert conf >= 0.6 and "fatigue" in why


def test_early_slow_that_costs_nothing_is_just_eased():
    run = build([(800, 3.3, 150, 0), (200, 2.0, 140, 0), (6000, 3.3, 150, 0)])
    found = S.find_interruptions(run)
    assert len(found) == 1
    it = found[0]
    assert it["position"] < S.LATE_RUN
    assert S.classify(it)[0] == "eased"


def test_a_hill_late_in_a_run_is_still_a_hill():
    """Grade is checked before fatigue, so a climb is not blamed on tiredness."""
    run = build([(7000, 3.3, 165, 0), (300, 1.6, 175, 28), (1500, 3.0, 165, 0)])
    it = [x for x in S.find_interruptions(run) if not x["full_stop"]][0]
    assert it["position"] > S.LATE_RUN
    assert S.classify(it)[0] == "climb"


def test_start_and_finish_shuffling_is_ignored():
    """The walk to the door and the stop at the end are not events."""
    run = build([(40, 1.0, 110, 0), (5000, 3.3, 155, 0), (40, 1.0, 120, 0)])
    assert S.find_interruptions(run) == []


def test_wobbles_are_too_short_to_count():
    run = build([(2000, 3.3, 155, 0), (4, 0, 155, 0), (2000, 3.3, 155, 0)])
    assert S.find_interruptions(run) == []


def test_standing_and_walking_are_told_apart_by_the_minimum():
    """Regression: a stop used to be judged by the span's *mean* speed.

    Smoothing bleeds running speed into a stop's edges, so on a sparsely sampled
    stream the mean of a red light can rise above walking pace. That made a late
    traffic light look like a walk break and get blamed on fatigue. The minimum
    is the honest discriminator: standing reads near zero, walking never does.
    """
    light = build([(5000, 3.3, 158, 0), (20, 0, 156, 0), (2000, 3.3, 158, 0)],
                  sample_m=50.0)
    it = S.find_interruptions(light)[0]
    assert it["position"] > S.LATE_RUN, it["position"]
    assert it["min_speed"] < S.STOP_SPEED
    assert it["full_stop"] is True
    # The standing time is measured, not taken from the whole span, so the
    # smoothed ramp cannot inflate a 20 s light past the crossing cutoff.
    assert it["stopped_s"] <= it["seconds"]
    assert S.classify(it)[0] == "crossing"

    walk = build([(5000, 3.3, 168, 0), (250, 1.4, 172, 0), (2000, 2.9, 170, 0)],
                 sample_m=50.0)
    w = [x for x in S.find_interruptions(walk) if x["at_m"] > 4000][0]
    assert w["min_speed"] >= S.STOP_SPEED, w["min_speed"]
    assert w["full_stop"] is False
    assert S.classify(w)[0] == "exhaustion"


def test_junction_tiles_need_repetition():
    def at(lat, lon):
        return {"full_stop": True, "lat": lat, "lon": lon}
    corner, oneoff = (47.3800, 8.5500), (47.3900, 8.5600)
    runs = [[at(*corner)], [at(*corner)], [at(*corner)], [at(*oneoff)]]
    j = S.junction_tiles(runs, min_runs=3)
    assert (round(corner[0], 4), round(corner[1], 4)) in j
    assert (round(oneoff[0], 4), round(oneoff[1], 4)) not in j
    # Stopping twice at the same corner within ONE run is still one run.
    assert S.junction_tiles([[at(*corner), at(*corner)]], min_runs=2) == set()
    assert S.junction_tiles([]) == set()


def test_junction_evidence_overrides_duration():
    """A long-ish stop somewhere you always stop is still a crossing."""
    it = {"full_stop": True, "seconds": 60.0, "hr_drop": 20.0, "grade": None,
          "hr_mean": 150, "run_hr": 155, "penalty": 0.0, "position": 0.4,
          "lat": 47.38, "lon": 8.55}
    assert S.classify(it, junction=False)[0] == "rest"
    assert S.classify(it, junction=True)[0] == "crossing"


def test_analyse_summarises_a_messy_run():
    def decay(f):
        return 168 - 40 * f
    run = build([(1500, 3.3, 160, 0),
                 (25, 0, 158, 0),          # crossing
                 (2500, 3.3, 162, 0),
                 (150, 0, decay, 0),       # rest stop
                 (3000, 3.3, 168, 0),
                 (250, 1.4, 172, 0),       # fatigue walk
                 (1500, 2.7, 170, 0)])
    a = S.analyse(run)
    assert a is not None
    assert a["count"] >= 3
    assert a["counts"].get("crossing", 0) >= 1
    assert a["counts"].get("rest", 0) >= 1
    assert a["counts"].get("exhaustion", 0) >= 1
    assert a["lost_s"] > a["stopped_s"] > 0
    assert a["first_fatigue_m"] and a["first_fatigue_m"] > 6000
    assert "fatigue" in a["verdict"]
    for row in a["interruptions"]:
        assert row["label"] in ("crossing", "rest", "climb", "exhaustion", "eased")
        assert row["reason"]


def test_verdict_wording():
    assert S.verdict({}, []) is None
    assert "came apart" in S.verdict({"exhaustion": 4}, [{"x": 1}])
    assert "deliberate stop" in S.verdict({"rest": 1}, [{"x": 1}])
    assert "traffic" in S.verdict({"crossing": 2}, [{"x": 1}])
    assert "climbs" in S.verdict({"climb": 2}, [{"x": 1}])


def test_junk_input():
    assert S.find_interruptions([]) == []
    assert S.find_interruptions([(0, 0)]) == []
    assert S.find_interruptions([(None, None, None)]) == []
    assert S.analyse([]) is None
    # Missing HR and elevation must not crash the classifier.
    bare = [(t, t * 3.0) for t in range(0, 600, 5)]
    assert S.find_interruptions(bare) == []
    mixed = build([(1500, 3.3, None, 0), (25, 0, None, 0), (1500, 3.3, None, 0)])
    found = S.find_interruptions(mixed)
    assert len(found) == 1 and found[0]["hr_drop"] is None
    assert S.classify(found[0])[0] == "crossing"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
