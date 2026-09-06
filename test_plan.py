"""Self-check for the training plan generator. Run: python test_plan.py"""
import plan as P

PACES = [("Easy", "most of your week", 330.0, 366.0),
         ("Marathon", "race-pace work", 268.0, 283.0),
         ("Threshold", "tempo", 250.0, 258.0),
         ("Interval", "VO2max", 234.0, 245.0),
         ("Repetition", "speed", 220.0, 232.0)]


def test_taper_weeks():
    assert P.taper_weeks(42195) == 3
    assert P.taper_weeks(21097) == 2
    assert P.taper_weeks(10000) == 1
    assert P.taper_weeks(5000) == 1
    # A longer race than any listed still gets the longest taper.
    assert P.taper_weeks(50000) == 3


def test_long_run_cap():
    assert P.long_run_cap(5000) == 16000
    assert P.long_run_cap(10000) == 22000
    assert P.long_run_cap(21097) == 32000
    assert P.long_run_cap(42195) == 38000
    # Nobody needs a 40 km run to race a 10K.
    assert P.long_run_cap(10000) < P.long_run_cap(42195)


def test_phase_for():
    weeks, taper = 16, 3
    phases = [P.phase_for(i, weeks, taper) for i in range(weeks)]
    assert phases[0] == "base"
    assert phases[-1] == "taper" and phases[-3] == "taper"
    assert phases[-4] != "taper"
    assert set(phases) == {"base", "build", "peak", "taper"}
    # Phases only ever move forwards.
    order = {p: i for i, p in enumerate(P.PHASES)}
    assert all(order[b] >= order[a] for a, b in zip(phases, phases[1:])), phases


def test_weekly_volumes_ramp_and_back_off():
    vols = P.weekly_volumes(50000, 12, taper=2)
    assert len(vols) == 12
    assert all(v > 0 for v in vols)

    # Every fourth week eases off.
    assert vols[3] < vols[2], (vols[2], vols[3])
    assert vols[7] < vols[6]

    # The ramp never exceeds the cap between consecutive BUILDING weeks. The
    # week after an easy week climbs back to where the block was, which is the
    # whole point of an easy week rather than a ramp violation.
    for i in range(1, 10):
        if (i % P.CYCLE) == 0:          # previous week was the easy one
            continue
        a, b = vols[i - 1], vols[i]
        if b > a:
            assert (b / a) - 1.0 <= P.MAX_RAMP + 1e-9, (i, a, b)

    # And that rebound really does happen, rather than the block losing its place.
    assert vols[4] > vols[3], "the week after an easy week should pick the build back up"

    # And the plan never runs away from where it started.
    assert max(vols) <= 50000 * P.MAX_TOTAL_GROWTH + 1

    # The taper comes down, and keeps coming down.
    assert vols[-1] < vols[-2] < vols[-3]

    assert P.weekly_volumes(0, 12, 2) == []
    assert P.weekly_volumes(50000, 0, 2) == []


def test_long_run_is_a_share_of_the_week_and_capped():
    # A big week for a 10K is still capped by the race.
    assert P.long_run_for(100000, 10000) == 22000
    # A normal week is a share of it.
    assert abs(P.long_run_for(50000, 42195) - 15000) < 1
    assert P.long_run_for(50000, 42195) < 50000


def test_build_shape():
    weeks = 16
    p = P.build(50000, 42195, weeks, PACES)
    assert len(p) == weeks
    assert [w["week"] for w in p] == list(range(1, weeks + 1))
    assert p[0]["to_go"] == weeks and p[-1]["to_go"] == 1
    for w in p:
        assert w["phase"] in P.PHASES
        assert w["sessions"]
        # The week's parts add up to the week.
        assert abs(w["long_run_m"] + w["easy_m"] - w["distance_m"]) < 1
        assert w["long_run_m"] <= P.long_run_cap(42195) + 1
    assert p[-1]["phase"] == "taper"
    assert sum(1 for w in p if w["easy_week"]) >= 2


def test_sessions_carry_the_athletes_own_paces():
    p = P.build(50000, 42195, 16, PACES)
    build_week = [w for w in p if w["phase"] == "build"][0]
    names = [s[0] for s in build_week["sessions"]]
    assert "Threshold" in names and "Intervals" in names
    # Every session with a band carries the real numbers, not a chart.
    for _name, _desc, band in build_week["sessions"]:
        if band:
            fast, slow = band
            assert fast < slow
            assert 200 < fast < 400

    # A 5K peak sharpens differently from a marathon peak.
    five = P.build(50000, 5000, 16, PACES)
    peak5 = [w for w in five if w["phase"] == "peak"][0]
    peak42 = [w for w in p if w["phase"] == "peak"][0]
    assert "Race pace" in [s[0] for s in peak42["sessions"]]
    assert "Race pace" not in [s[0] for s in peak5["sessions"]]
    assert "Intervals" in [s[0] for s in peak5["sessions"]]

    # No paces available: the plan still builds, the bands are just empty.
    bare = P.build(50000, 42195, 8, None)
    assert bare and all(w["sessions"] for w in bare)
    assert all(s[2] is None for w in bare for s in w["sessions"])


def test_build_edges():
    assert P.build(0, 42195, 12, PACES) == []
    assert P.build(50000, 42195, 0, PACES) == []
    assert P.build(50000, 0, 12, PACES) == []
    # A two-week "plan" must not taper for longer than it exists.
    tiny = P.build(50000, 42195, 2, PACES)
    assert len(tiny) == 2
    assert sum(1 for w in tiny if w["phase"] == "taper") <= 1


def test_summarise():
    p = P.build(50000, 42195, 16, PACES)
    s = P.summarise(p, 42195)
    assert s["weeks"] == 16
    assert s["taper_weeks"] == 3
    assert s["peak_week_m"] == max(w["distance_m"] for w in p)
    assert 1 <= s["peak_week_n"] <= 16
    assert s["longest_run_m"] <= P.long_run_cap(42195) + 1
    assert s["total_m"] > s["peak_week_m"]
    assert 0 < s["growth"] <= P.MAX_TOTAL_GROWTH
    assert P.summarise([]) is None


def test_sanity_warnings():
    assert P.sanity([], 50000) == []
    # A sensible plan off a real base has nothing to complain about.
    good = P.build(50000, 42195, 16, PACES)
    assert P.sanity(good, 50000) == [], P.sanity(good, 50000)
    # A short block says so.
    short = P.build(50000, 42195, 6, PACES)
    assert any("eight weeks" in n for n in P.sanity(short, 50000))
    # A plan built off a much smaller current base is flagged as provisional.
    assert any("above what you are running now" in n
               for n in P.sanity(good, 20000))


def test_the_peak_lands_late_in_the_build():
    """Regression: compounding a fixed ramp hit the ceiling at week 7 of 16 and
    then sat flat for six weeks. The heaviest week belongs just before the taper.
    """
    p = P.build(45000, 42195, 16, PACES)
    s = P.summarise(p, 42195)
    build_weeks = len(p) - s["taper_weeks"]
    assert s["peak_week_n"] >= build_weeks - 1, (s["peak_week_n"], build_weeks)

    # And the build genuinely progresses rather than plateauing: no more than a
    # couple of weeks share the top volume.
    top = s["peak_week_m"]
    assert sum(1 for w in p if w["distance_m"] > top * 0.99) <= 2

    # The long run grows through the block rather than being flat.
    early = [w for w in p if w["phase"] == "base" and not w["easy_week"]][0]
    late = [w for w in p if w["phase"] == "peak" and not w["easy_week"]][-1]
    assert late["long_run_m"] > early["long_run_m"] * 1.5


def test_a_bigger_base_earns_a_bigger_long_run():
    """A 70 km/week athlete should reach the marathon long-run cap; 45 should not."""
    small = P.summarise(P.build(45000, 42195, 16, PACES), 42195)
    big = P.summarise(P.build(70000, 42195, 16, PACES), 42195)
    assert big["longest_run_m"] > small["longest_run_m"]
    assert big["longest_run_m"] <= P.long_run_cap(42195) + 1
    assert small["longest_run_m"] < P.long_run_cap(42195)


def test_a_realistic_marathon_block():
    """Read the plan the way an athlete would, and check it is sane."""
    p = P.build(45000, 42195, 16, PACES)
    s = P.summarise(p, 42195)
    peak_km = s["peak_week_m"] / 1000.0
    long_km = s["longest_run_m"] / 1000.0
    assert 45 < peak_km < 80, peak_km            # a real build, not a fantasy
    assert 20 < long_km <= 38, long_km           # a real long run, capped
    assert p[-1]["distance_m"] < p[0]["distance_m"], "race week should be light"
    # The heaviest week is not the last one before the race.
    assert s["peak_week_n"] <= len(p) - s["taper_weeks"]


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
