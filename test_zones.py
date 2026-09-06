"""Self-check for heart-rate zones and polarisation. Run: python test_zones.py"""
from datetime import datetime, timedelta

import zones as Z

NOW = datetime(2026, 8, 19, 12, 0)
THR = 170.0            # threshold HR every fixture is written against


def build(legs, sample_s=5.0):
    """Stream from [(seconds, hr, speed_m_s[, sample_s]), ...] legs.

    Each leg holds its heart rate for its whole duration; the optional fourth
    field says how often the watch wrote a row, which is exactly what these
    tests need to vary. `hr` may be a number, None, or a function of the
    fraction through the leg. A closing sample is written at the very end so the
    last leg's time is bounded like every other one.
    """
    def hr_at(hr, fraction):
        return hr(fraction) if callable(hr) else hr

    out, t, d = [], 0.0, 0.0
    for leg in legs:
        secs, hr, speed = leg[0], leg[1], leg[2]
        every = leg[3] if len(leg) > 3 else sample_s
        steps = max(int(round(secs / every)), 1)
        dt = secs / steps
        for k in range(steps):
            out.append((t, d, hr_at(hr, k / steps), None, None, None))
            t += dt
            d += speed * dt
    if legs:
        out.append((t, d, hr_at(legs[-1][1], 1.0), None, None, None))
    return out


def zone_dict(z1=0.0, z2=0.0, z3=0.0, z4=0.0, z5=0.0):
    """A time_in_zones()-shaped dict, written straight rather than measured."""
    return {"Z1": z1, "Z2": z2, "Z3": z3, "Z4": z4, "Z5": z5}


def empty_zones():
    return {z: 0.0 for z in Z.ZONES}


def activity(day, samples):
    return {"start": datetime.combine(day, datetime.min.time()) + timedelta(hours=9),
            "samples": samples}


def test_zone_boundaries():
    """A band owns its lower bound, not its upper -- and Z5 has no ceiling."""
    assert Z.zone_of(80, 100) == "Z1"
    assert Z.zone_of(81, 100) == "Z2"
    assert Z.zone_of(89, 100) == "Z2"
    assert Z.zone_of(90, 100) == "Z3"
    assert Z.zone_of(94, 100) == "Z4"
    assert Z.zone_of(99, 100) == "Z4"
    assert Z.zone_of(100, 100) == "Z5"
    assert Z.zone_of(125, 100) == "Z5"
    assert Z.zone_of(None, 100) is None
    assert Z.zone_of(150, None) is None
    assert Z.zone_of(150, 0) is None


def test_uneven_sampling_is_integrated_not_counted():
    """Five rows a minute apart are five minutes of training, not five units.

    This is the whole reason the module exists: counting samples would score the
    hard stretch below at 5 against the easy stretch's 300.
    """
    run = build([(300, 150, 3.0, 1.0),      # 300 rows of easy running
                 (300, 176, 4.0, 60.0)])    # 5 rows of the same amount of hard
    z = Z.time_in_zones(run, THR)
    assert abs(z["Z2"] - 300.0) < 1e-6, z
    assert abs(z["Z5"] - 300.0) < 1e-6, z
    assert abs(sum(z.values()) - 600.0) < 1e-6
    # The sparse half is not a rounding error against the dense one.
    assert z["Z5"] > 60.0


def test_every_zone_is_present_and_the_time_adds_up():
    run = build([(600, 150, 3.0),      # Z2
                 (300, 158, 3.6),      # Z3
                 (240, 163, 4.0),      # Z4
                 (120, 176, 4.6),      # Z5
                 (300, 130, 2.6)])     # Z1
    z = Z.time_in_zones(run, THR)
    assert sorted(z) == sorted(Z.ZONES)
    assert abs(z["Z1"] - 300.0) < 1e-6, z
    assert abs(z["Z2"] - 600.0) < 1e-6, z
    assert abs(z["Z3"] - 300.0) < 1e-6, z
    assert abs(z["Z4"] - 240.0) < 1e-6, z
    assert abs(z["Z5"] - 120.0) < 1e-6, z
    assert abs(sum(z.values()) - 1560.0) < 1e-6


def test_hr_dropouts_lose_only_their_own_time():
    """A blind stretch is left out, not filled in with the last reading."""
    run = build([(300, 150, 3.0), (300, None, 3.0), (300, 176, 3.0)])
    z = Z.time_in_zones(run, THR)
    assert abs(z["Z2"] - 300.0) < 1e-6, z
    assert abs(z["Z5"] - 300.0) < 1e-6, z
    assert abs(sum(z.values()) - 600.0) < 1e-6      # the missing 300 s stays missing


def test_a_paused_watch_does_not_dump_an_hour_into_one_zone():
    """An hour between two rows is a pause or a dropout, not an hour of running."""
    run = [(0.0, 0.0, 150), (10.0, 30.0, 150), (3610.0, 40.0, 150), (3620.0, 70.0, 150)]
    z = Z.time_in_zones(run, THR)
    assert abs(z["Z2"] - (10.0 + Z.MAX_GAP_S + 10.0)) < 1e-6, z


def test_samples_need_not_arrive_in_order():
    run = build([(300, 150, 3.0), (300, 176, 4.0)])
    assert Z.time_in_zones(list(reversed(run)), THR) == Z.time_in_zones(run, THR)


def test_degenerate_streams():
    assert Z.time_in_zones([], THR) == empty_zones()
    assert Z.time_in_zones([(0.0, 0.0, 150)], THR) == empty_zones()          # one sample
    assert Z.time_in_zones(build([(600, None, 3.0)]), THR) == empty_zones()  # no HR at all
    assert Z.time_in_zones([(None, None, None), (0, 0)], THR) == empty_zones()
    # No threshold estimate yet: the zones are unknowable, not zero-ish.
    good = build([(600, 150, 3.0)])
    assert Z.time_in_zones(good, None) == empty_zones()
    assert Z.time_in_zones(good, 0) == empty_zones()


def test_weekly_rollup():
    monday = NOW.date() - timedelta(days=NOW.date().weekday())
    easy = build([(600, 150, 3.0)])
    hard = build([(600, 176, 4.5)])
    acts = [activity(monday, easy),
            activity(monday + timedelta(days=2), hard),
            activity(monday - timedelta(days=7), easy),
            activity(monday - timedelta(weeks=20), easy)]     # outside the window

    weekly = Z.weekly_zones(acts, THR, weeks=4, now=NOW)
    assert len(weekly) == 4
    assert weekly[-1][0] == monday                            # most recent last
    assert [w for w, _ in weekly] == sorted(w for w, _ in weekly)
    assert abs(weekly[-1][1]["Z2"] - 600.0) < 1e-6, weekly[-1]
    assert abs(weekly[-1][1]["Z5"] - 600.0) < 1e-6, weekly[-1]
    assert abs(weekly[-2][1]["Z2"] - 600.0) < 1e-6
    assert sum(weekly[0][1].values()) == 0.0                  # empty weeks are kept
    assert weekly[-2][1]["Z5"] == 0.0                         # last week had no hard work


def test_weekly_rollup_edges():
    monday = NOW.date() - timedelta(days=NOW.date().weekday())
    easy = build([(600, 150, 3.0)])
    assert Z.weekly_zones([], THR) == []
    # Activities without a stream, or without a start, cannot be placed.
    assert Z.weekly_zones([{"start": NOW, "samples": []}], THR) == []
    assert Z.weekly_zones([{"samples": easy}], THR) == []
    # With no `now`, the window ends at the newest activity.
    weekly = Z.weekly_zones([activity(monday - timedelta(days=7), easy)], THR, weeks=2)
    assert weekly[-1][0] == monday - timedelta(days=7)
    assert abs(weekly[-1][1]["Z2"] - 600.0) < 1e-6
    # A stream under the other key the app uses for it still counts.
    alt = [{"start": NOW, "stream": easy}]
    assert abs(Z.weekly_zones(alt, THR, weeks=1)[-1][1]["Z2"] - 600.0) < 1e-6


def test_all_easy_is_all_easy():
    p = Z.polarisation(zone_dict(z1=3000, z2=3000))
    assert p["easy"] == 1.0
    assert p["moderate"] == 0.0 and p["hard"] == 0.0
    assert p["total_s"] == 6000
    assert p["label"] == "pyramidal"
    assert "All of it easy" in p["verdict"]
    assert "base" in p["verdict"]


def test_polarised_week():
    """80% easy, a sliver of grey, the rest hard: the shape everyone is after."""
    p = Z.polarisation(zone_dict(z1=4800, z2=1600, z3=200, z4=800, z5=600))
    assert abs(p["easy"] - 0.80) < 0.005, p
    assert abs(p["hard"] - 0.175) < 0.005, p
    assert p["label"] == "polarised"
    assert "80% easy" in p["verdict"]
    assert Z.polarisation_index(zone_dict(z1=4800, z2=1600, z3=200, z4=800, z5=600)) > 2.0


def test_threshold_heavy_week():
    """The grey zone eats the week: not the same problem as training too hard."""
    p = Z.polarisation(zone_dict(z1=2000, z2=2000, z3=3000, z4=800, z5=200))
    assert p["label"] == "threshold-heavy"
    assert abs(p["moderate"] - 0.375) < 0.005, p       # the grey zone is the problem
    assert abs(p["hard"] - 0.125) < 0.005, p           # not the hard running
    assert "grey zone" in p["verdict"]


def test_pyramidal_week():
    """Easy > moderate > hard, with no gap in the middle: broad, not polarised."""
    p = Z.polarisation(zone_dict(z1=3600, z2=2000, z3=1440, z4=800, z5=160))
    assert p["label"] == "pyramidal"
    assert p["easy"] > p["moderate"] > p["hard"]
    assert abs(p["moderate"] - 0.18) < 0.005, p          # what stops it being polarised
    assert "Pyramidal" in p["verdict"]


def test_too_hard_week():
    p = Z.polarisation(zone_dict(z1=2000, z2=1000, z3=1200, z4=2400, z5=1400))
    assert p["label"] == "too-hard"
    assert abs(p["hard"] - 0.475) < 0.005, p       # nearly half the week at threshold+
    assert abs(p["easy"] - 0.375) < 0.005, p
    assert "recover" in p["verdict"]


def test_polarisation_with_nothing_to_judge():
    p = Z.polarisation(empty_zones())
    assert p["label"] is None
    assert p["total_s"] == 0.0
    assert p["easy"] == 0.0
    assert p["verdict"]
    assert Z.polarisation({})["label"] is None


def test_polarisation_index_matches_the_formula():
    """80 / 10 / 10 -> log10(80/10 * 10 * 100) = log10(8000) = 3.9031."""
    pi = Z.polarisation_index(zone_dict(z1=4800, z2=3200, z3=1000, z4=600, z5=400))
    assert abs(pi - 3.9031) < 0.001, pi
    assert pi > 2.0
    # Same shares, ten times the volume: the index is about shape, not hours.
    bigger = Z.polarisation_index(zone_dict(z1=48000, z2=32000, z3=10000,
                                            z4=6000, z5=4000))
    assert abs(bigger - pi) < 1e-9
    # Hollowing out the middle raises it; filling the middle lowers it.
    hollow = Z.polarisation_index(zone_dict(z1=8000, z3=100, z4=1900))
    grey = Z.polarisation_index(zone_dict(z1=5000, z3=4000, z4=1000))
    assert hollow > pi > grey, (hollow, pi, grey)


def test_polarisation_index_needs_all_three_buckets():
    assert Z.polarisation_index(zone_dict(z1=3600)) is None            # nothing hard
    assert Z.polarisation_index(zone_dict(z1=3600, z3=600)) is None    # still nothing hard
    assert Z.polarisation_index(zone_dict(z1=3600, z4=600)) is None    # no grey zone
    assert Z.polarisation_index(zone_dict(z3=600, z4=600)) is None     # nothing easy
    assert Z.polarisation_index(empty_zones()) is None
    assert Z.polarisation_index({}) is None


def test_decoupling_is_zero_on_a_run_that_held_together():
    steady = build([(3600, 150, 3.0)], sample_s=10.0)
    assert abs(Z.decoupling(steady)) < 1e-6


def test_decoupling_is_positive_when_hr_climbs_at_the_same_pace():
    def drift(fraction):
        return 145 + 20 * fraction
    run = build([(3600, drift, 3.0)], sample_s=10.0)
    d = Z.decoupling(run)
    assert d is not None
    assert 5.0 < d < 10.0, d           # ~150 bpm then ~160 bpm for the same speed


def test_decoupling_is_positive_when_the_pace_fades_at_the_same_hr():
    """The other half of the ratio: same heart rate, less speed for it."""
    faded = build([(1800, 155, 3.0), (1800, 155, 2.7)], sample_s=10.0)
    assert Z.decoupling(faded) > 8.0, Z.decoupling(faded)
    # And a negative split with a flat heart rate reads negative, as it should.
    strong = build([(1800, 155, 2.7), (1800, 155, 3.0)], sample_s=10.0)
    assert Z.decoupling(strong) < 0.0


def test_decoupling_splits_on_time_not_on_sample_count():
    """Half the rows are not half the run when the watch samples unevenly.

    The first half hour is recorded every second and the second every minute;
    the middle *sample* sits well inside the first half hour, so a naive split
    would compare 25 minutes of steady running against 35 minutes of drift.
    """
    run = build([(1800, 150, 3.0, 1.0), (1800, 165, 3.0, 60.0)])
    d = Z.decoupling(run)
    assert d is not None
    assert 9.0 < d < 11.0, d           # 165/150 - 1 = 10%, cleanly split at 1800 s


def test_decoupling_degenerate_streams():
    assert Z.decoupling([]) is None
    assert Z.decoupling([(0.0, 0.0, 150)]) is None
    assert Z.decoupling(build([(600, None, 3.0)])) is None       # no HR
    assert Z.decoupling(build([(600, 150, 0.0)])) is None        # went nowhere
    assert Z.decoupling(build([(600, 150, 3.0)], sample_s=200.0)) is None   # too few rows


def test_a_real_week_of_streams():
    """End to end: three easy runs and two sessions should read as polarised."""
    monday = NOW.date() - timedelta(days=NOW.date().weekday())
    easy = build([(3600, 150, 3.0)], sample_s=10.0)
    session = build([(300, 150, 3.0),     # warm-up, easy
                     (120, 158, 4.0),     # a couple of minutes through the grey zone
                     (1200, 176, 4.5),    # the work
                     (180, 150, 3.0)])    # jog home
    acts = [activity(monday + timedelta(days=i), easy) for i in (0, 2, 5)]
    acts += [activity(monday + timedelta(days=i), session) for i in (1, 3)]

    weekly = Z.weekly_zones(acts, THR, weeks=1, now=NOW)
    total = weekly[-1][1]
    assert abs(sum(total.values()) - (3 * 3600 + 2 * 1800)) < 1e-6, total

    p = Z.polarisation(total)
    assert p["label"] == "polarised", p
    assert abs(p["easy"] - 11760 / 14400.0) < 0.01, p
    assert abs(p["hard"] - 2400 / 14400.0) < 0.01, p
    pi = Z.polarisation_index(total)
    assert pi > 2.0, pi
    assert Z.decoupling(easy) is not None


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
