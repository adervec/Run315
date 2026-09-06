"""Self-check for durability. Run: python test_durability.py"""
import durability as D


def stream(duration_s, speed_at, hr_at, step_s=10, elevation_at=None):
    """Build a synthetic stream. `speed_at`/`hr_at` are f(elapsed) -> value."""
    out, metres = [], 0.0
    for i in range(int(duration_s / step_s) + 1):
        t = i * step_s
        if i:
            metres += speed_at(t) * step_s
        ele = elevation_at(t) if elevation_at else 100.0
        out.append((float(t), metres, hr_at(t), 50.0, 8.0, ele,
                    170.0, 1.2, 240.0, 8.0))
    return out


def steady(duration_s=100 * 60, speed=3.2, hr=150.0, drift_bpm=0.0):
    """A long run at one pace, with an optional linear heart-rate drift."""
    return stream(duration_s,
                  lambda t: speed,
                  lambda t: hr + drift_bpm * (t / duration_s))


def test_critical_speed_fits_the_line():
    # Points generated from a known model: d = 4.0*t + 120
    bests = [(4.0 * t + 120.0, t) for t in (150, 300, 600, 900)]
    fit = D.critical_speed(bests)
    assert fit is not None
    cs, d_prime = fit
    assert abs(cs - 4.0) < 1e-6, cs
    assert abs(d_prime - 120.0) < 1e-6, d_prime


def test_critical_speed_uses_only_the_middle_efforts():
    """A sprint and a marathon must not drag the fit."""
    good = [(4.0 * t + 120.0, t) for t in (150, 300, 600, 900)]
    # A 30 s sprint and a 3 h effort both sit off the line.
    polluted = good + [(200.0, 30.0), (38000.0, 11000.0)]
    assert D.critical_speed(good) == D.critical_speed(polluted)


def test_critical_speed_needs_enough_points():
    assert D.critical_speed([]) is None
    assert D.critical_speed([(1000.0, 240.0), (2000.0, 500.0)]) is None
    # Efforts all outside the window give nothing, however many there are.
    assert D.critical_speed([(200.0, 40.0), (400.0, 80.0), (600.0, 110.0)]) is None


def test_critical_speed_rejects_impossible_fits():
    # Times that get *slower* per metre in the wrong direction produce a
    # negative reserve, which is a sign the efforts are not comparable.
    assert D.critical_speed([(1000.0, 300.0), (2000.0, 400.0), (5000.0, 700.0)]) is None


def test_a_steady_run_does_not_decouple():
    result = D.analyse(steady(), hr_max=190.0, cs=4.0)
    assert result is not None
    assert abs(result["decoupling"] - 1.0) < 0.01, result["decoupling"]
    assert result["band"] == "low"
    assert result["onset_m"] is None, "nothing drifted, so nothing started"


def test_heart_rate_drift_at_constant_pace_is_decoupling():
    """The textbook case: same pace, rising heart rate."""
    result = D.analyse(steady(drift_bpm=20.0), hr_max=190.0, cs=4.0)
    assert result["decoupling"] > 1.05, result["decoupling"]
    assert result["onset_m"] is not None
    assert 0 < result["onset_m"] < result["distance_m"]


def test_slowing_down_at_constant_heart_rate_is_also_decoupling():
    """Fading shows up as slowing too -- which is how the fit fade, per Takayama."""
    duration = 100 * 60
    faded = stream(duration,
                   lambda t: 3.4 - 0.6 * (t / duration),   # slows through the run
                   lambda t: 150.0)
    result = D.analyse(faded, hr_max=190.0, cs=4.0)
    assert result["decoupling"] > 1.10, result["decoupling"]


def test_the_dose_gate_refuses_short_runs():
    """A 40 minute tempo carries no durability signal, so it must not report one."""
    assert D.analyse(steady(duration_s=40 * 60), 190.0, 4.0) is None
    # Long in time but short in distance (a hike) is refused too.
    slow = steady(duration_s=100 * 60, speed=1.5)
    assert D.analyse(slow, 190.0, 4.0) is None
    # And the gate is on the run, not on the data: plenty of samples, still short.
    assert D.analyse(stream(30 * 60, lambda t: 3.5, lambda t: 150.0,
                            step_s=1), 190.0, 4.0) is None


def test_missing_inputs_return_nothing_rather_than_a_guess():
    good = steady()
    assert D.analyse(good, None, 4.0) is None
    assert D.analyse(good, 190.0, None) is None
    assert D.analyse([], 190.0, 4.0) is None
    # A run with no heart rate at all cannot be decoupled.
    no_hr = stream(100 * 60, lambda t: 3.2, lambda t: None)
    assert D.analyse(no_hr, 190.0, 4.0) is None


def test_hills_do_not_masquerade_as_fatigue():
    """A run that finishes uphill at the same effort is not decoupling.

    Without grade adjustment the late window looks slow and the ratio jumps.
    """
    duration = 100 * 60

    # Slower over the ground on the climb, but at the same metabolic cost. The
    # equal-effort speed comes from the grade model rather than a guessed number,
    # so this test asserts what it claims to.
    import racecraft as RC
    GRADE = 0.03
    climb_speed = 3.2 / RC.cost_ratio(GRADE)

    def uphill_finish(t):
        # Flat for the first three quarters, then a steady climb. The rise is per
        # metre travelled, not per second, or the grade is not the one we paced.
        if t < duration * 0.75:
            return 100.0
        return 100.0 + (t - duration * 0.75) * GRADE * climb_speed

    def speed(t):
        return 3.2 if t < duration * 0.75 else climb_speed

    climbing = stream(duration, speed, lambda t: 150.0, elevation_at=uphill_finish)
    result = D.analyse(climbing, hr_max=190.0, cs=4.0)
    assert result is not None
    # The grade model should absorb most of the apparent slowdown.
    assert result["decoupling"] < 1.02, result["decoupling"]

    # Prove the adjustment is doing the work: flatten the hill and the same
    # slowdown becomes real decoupling.
    flat = stream(duration, speed, lambda t: 150.0)
    naive = D.analyse(flat, hr_max=190.0, cs=4.0)
    assert naive["decoupling"] > result["decoupling"] + 0.10, (
        naive["decoupling"], result["decoupling"])


def test_bands_match_the_published_cuts():
    assert D.band(1.05) == "low"
    assert D.band(1.15) == "moderate"
    assert D.band(1.35) == "high"
    assert D.band(None) is None
    # Boundaries belong to the gentler band.
    assert D.band(D.BAND_LOW) == "moderate"
    assert D.band(D.BAND_HIGH) == "high"


def test_the_reference_values_from_the_paper_land_in_the_right_bands():
    """Smyth 2022 reported mean 1.16, and tertile means of 1.01 / 1.15 / 1.33."""
    assert D.band(1.16) == "moderate"
    assert D.band(1.01) == "low"
    assert D.band(1.15) == "moderate"
    assert D.band(1.33) == "high"


def test_heat_is_flagged_not_corrected():
    hot = D.analyse(steady(drift_bpm=20.0), 190.0, 4.0, temperature_c=27.0)
    cool = D.analyse(steady(drift_bpm=20.0), 190.0, 4.0, temperature_c=8.0)
    assert hot["hot"] and not cool["hot"]
    # Same run, same number: the flag is a caveat, not an adjustment.
    assert hot["decoupling"] == cool["decoupling"]


def test_verdict_mentions_pace_when_the_run_was_quick():
    quick = D.analyse(steady(speed=3.9), hr_max=190.0, cs=4.0)
    easy = D.analyse(steady(speed=3.0), hr_max=190.0, cs=4.0)
    assert "critical speed" in quick["verdict"]
    assert "critical speed" not in easy["verdict"]


def test_trend_compares_only_comparable_runs():
    from datetime import date

    def run(decoupling, duration_s=100 * 60):
        return {"decoupling": decoupling, "duration_s": duration_s}

    improving = [(date(2026, 1, i + 1), run(1.30 - i * 0.05)) for i in range(4)]
    result = D.trend(improving)
    assert result is not None
    assert result["change"] < 0
    assert "better" in result["note"]
    assert abs(result["best"] - 1.15) < 1e-9

    # Too few runs says nothing.
    assert D.trend(improving[:2]) is None
    assert D.trend([]) is None

    # A short run is dropped rather than compared against long ones.
    mixed = improving + [(date(2026, 2, 1), run(1.05, duration_s=76 * 60))]
    assert D.trend(mixed)["runs"] == 4, "the 76-minute run is not comparable"


def test_trend_ignores_runs_that_could_not_be_analysed():
    from datetime import date
    runs = [(date(2026, 1, 1), None),
            (date(2026, 1, 2), {"decoupling": 1.2, "duration_s": 6000}),
            (date(2026, 1, 3), {"decoupling": 1.1, "duration_s": 6000}),
            (date(2026, 1, 4), {"decoupling": 1.0, "duration_s": 6000})]
    assert D.trend(runs)["runs"] == 3


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
