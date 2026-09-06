"""Self-check for terrain. Run: python test_terrain.py"""
import racecraft as RC
import terrain as T


def hilly_stream(grades, step_m=200.0, flat_speed=3.0, skill=1.0):
    """A run over a given sequence of gradients.

    The runner holds exactly the speed the Minetti model predicts for each
    gradient, multiplied by `skill` -- so skill=1.0 is a runner who matches the
    model exactly and climb_cost should recover 1.0.
    """
    samples, t, metres, elevation = [], 0.0, 0.0, 100.0
    samples.append((0.0, 0.0, 150.0, 50.0, 8.0, elevation, 170.0, 1.2, 240.0, 8.0))
    for grade in grades:
        speed = flat_speed / RC.cost_ratio(grade)
        if grade >= T.MIN_GRADE:
            speed *= skill                 # only climbing skill is under test
        t += step_m / speed
        metres += step_m
        elevation += step_m * grade
        samples.append((t, metres, 150.0, 50.0, 8.0, elevation,
                        170.0, 1.2, 240.0, 8.0))
    return samples


def test_book_time_matches_naismith_by_hand():
    # 10 km flat at 5 km/h is two hours.
    assert abs(T.book_time(10000.0) - 7200.0) < 1e-6
    # 600 m of ascent adds exactly one hour.
    assert abs(T.book_time(10000.0, ascent_m=600.0) - 10800.0) < 1e-6
    # 300 m of ascent adds half an hour.
    assert abs(T.book_time(10000.0, ascent_m=300.0) - 9000.0) < 1e-6
    assert T.book_time(0.0) == 0.0


def test_langmuir_descent_corrections():
    flat = T.book_time(10000.0)
    # Gentle descent earns a bonus: 300 m off a -10% slope saves ten minutes.
    gentle = T.book_time(10000.0, descent_m=300.0, descent_grade=-0.10)
    assert abs(gentle - (flat - 600.0)) < 1e-6, gentle
    # Steep descent costs instead.
    steep = T.book_time(10000.0, descent_m=300.0, descent_grade=-0.30)
    assert abs(steep - (flat + 600.0)) < 1e-6, steep
    # A moderate descent between the bands is neither.
    assert T.book_time(10000.0, descent_m=300.0, descent_grade=-0.03) == flat
    # Descent with no gradient given cannot be corrected either way.
    assert T.book_time(10000.0, descent_m=300.0) == flat


def test_book_time_never_goes_negative():
    """A huge gentle descent must not produce a negative predicted time."""
    assert T.book_time(1000.0, descent_m=20000.0, descent_grade=-0.10) >= 0.0


def test_difficulty_bands():
    assert T.difficulty(10000.0, 20.0) == "flat"
    assert T.difficulty(10000.0, 100.0) == "rolling"
    assert T.difficulty(10000.0, 250.0) == "hilly"
    assert T.difficulty(10000.0, 450.0) == "steep"
    assert T.difficulty(10000.0, 900.0) == "mountainous"
    assert T.difficulty(0.0, 100.0) is None


def test_terrain_ratio():
    # A runner doing 10 km flat in 50 min against a 2 h book time.
    r = T.terrain_ratio(3000.0, 10000.0)
    assert abs(r["ratio"] - 3000.0 / 7200.0) < 1e-9
    assert r["difficulty"] == "flat"

    # The same ratio on much hillier ground means a better day, because the
    # book time it is measured against is bigger.
    hilly = T.terrain_ratio(3000.0, 10000.0, ascent_m=600.0)
    assert hilly["ratio"] < r["ratio"]
    assert hilly["book_s"] > r["book_s"]
    assert hilly["difficulty"] == "mountainous"   # 60 m of climb per km

    assert T.terrain_ratio(0.0, 10000.0) is None
    assert T.terrain_ratio(3000.0, 0.0) is None


def test_a_runner_who_matches_the_model_scores_one():
    """The calibration anchor: skill=1.0 must come back as factor 1.0."""
    grades = [0.0, 0.05, 0.0, 0.08, 0.0, 0.06, 0.10, 0.0, 0.04, 0.0, 0.07, 0.0]
    result = T.climb_cost(hilly_stream(grades, skill=1.0))
    assert result is not None
    assert abs(result["factor"] - 1.0) < 1e-6, result["factor"]
    assert "about as the energy model expects" in result["verdict"]


def test_a_strong_climber_scores_above_one():
    grades = [0.0, 0.05, 0.0, 0.08, 0.0, 0.06, 0.10, 0.0, 0.04, 0.0, 0.07, 0.0]
    result = T.climb_cost(hilly_stream(grades, skill=1.15))
    assert abs(result["factor"] - 1.15) < 1e-6, result["factor"]
    assert "strength" in result["verdict"]


def test_a_weak_climber_scores_below_one():
    grades = [0.0, 0.05, 0.0, 0.08, 0.0, 0.06, 0.10, 0.0, 0.04, 0.0, 0.07, 0.0]
    result = T.climb_cost(hilly_stream(grades, skill=0.85))
    assert abs(result["factor"] - 0.85) < 1e-6, result["factor"]
    assert "cost you" in result["verdict"]


def test_the_factor_is_independent_of_how_fit_or_fresh_you_are():
    """Everything except the gradient must cancel out.

    A runner half as fast overall, with the same climbing bias, scores the same.
    """
    grades = [0.0, 0.06, 0.0, 0.09, 0.0, 0.05, 0.0, 0.07, 0.0, 0.08]
    quick = T.climb_cost(hilly_stream(grades, flat_speed=4.0, skill=1.10))
    slow = T.climb_cost(hilly_stream(grades, flat_speed=2.0, skill=1.10))
    assert abs(quick["factor"] - slow["factor"]) < 1e-9
    assert quick["flat_speed"] > slow["flat_speed"]


def test_climb_cost_needs_hills_and_flat_to_compare():
    # All flat: no climbing to judge.
    assert T.climb_cost(hilly_stream([0.0] * 12)) is None
    # All uphill: no flat reference to judge it against.
    assert T.climb_cost(hilly_stream([0.06] * 12)) is None
    # Too short to say anything.
    assert T.climb_cost(hilly_stream([0.0, 0.05, 0.0])) is None
    assert T.climb_cost([]) is None


def test_segments_ignore_samples_without_elevation():
    """A watch with no barometer must produce nothing rather than nonsense."""
    grades = [0.0, 0.05, 0.0, 0.08, 0.0, 0.06, 0.10, 0.0, 0.04, 0.0, 0.07, 0.0]
    stream = hilly_stream(grades)
    blind = [s[:5] + (None,) + s[6:] for s in stream]
    assert T.climb_cost(blind) is None


def test_absurd_gradients_are_dropped():
    """A GPS elevation spike must not be read as a cliff."""
    grades = [0.0, 0.05, 0.0, 0.08, 0.0, 0.06, 0.0, 0.04, 0.0, 0.07, 0.0]
    clean = T.climb_cost(hilly_stream(grades))
    spiked = hilly_stream(grades)
    # Insert a 60% "gradient" -- beyond anything the model was fitted on.
    spiked = spiked[:5] + [(spiked[5][0], spiked[5][1], 150.0, 50.0, 8.0,
                            spiked[5][5] + 200.0) + spiked[5][6:]] + spiked[6:]
    result = T.climb_cost(spiked)
    assert result is not None
    # The spike is excluded, so the factor stays close to the clean run.
    assert abs(result["factor"] - clean["factor"]) < 0.05, (
        result["factor"], clean["factor"])


def test_profile_weights_by_how_much_climbing_each_run_had():
    def run(factor, segments):
        return {"factor": factor, "climb_segments": segments}

    # One big hilly run should dominate two runs with a single hill each.
    result = T.profile([run(1.20, 40), run(0.90, 2), run(0.90, 2)])
    assert result["factor"] > 1.15, result["factor"]
    assert result["runs"] == 3 and result["climb_segments"] == 44

    # Too few runs is not a trait.
    assert T.profile([run(1.2, 10), run(1.1, 10)]) is None
    assert T.profile([]) is None
    assert T.profile([None, None, None]) is None


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
