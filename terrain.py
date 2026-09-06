"""Was that hard because of you, or because of the hill?

Pace means nothing on a route you have never run. A 5:30/km on the flat and a
5:30/km up a fell are different efforts, and every summary that averages them
together is throwing the interesting part away.

Two questions here, and they are not the same one:

  * **How hard was the route?** Answered against an external, published standard
    -- Naismith's rule, with Langmuir's descent corrections. This is what the
    hiking world has used since 1892 and what Taiwan's and Korea's national trail
    databases still quote as the official time for a course. It knows nothing
    about you, which is exactly why it is useful as a yardstick.

  * **How well do *you* climb?** Answered against the metabolic model. Minetti's
    energy-cost polynomial says what a given gradient should cost an average
    runner. Fitting your own observed slowdown against it says whether hills cost
    you more or less than the model expects -- a personal number that ordinary
    grade-adjusted pace hides, because GAP *applies* the model rather than
    testing it.

The second one is the interesting half and, as far as the survey went, nobody
ships it. Strava's GAP adjusts for grade but has no ground truth to check itself
against, so it can never tell you that you are a good climber.

Naismith: 5 km/h on the flat, plus one hour for every 600 m of ascent
(Naismith, Scottish Mountaineering Club Journal, 1892). Langmuir's corrections
subtract 10 minutes per 300 m of gentle descent and add 10 minutes per 300 m of
steep descent (Langmuir, *Mountaincraft and Leadership*, 1984).

Pure functions. Depends on racecraft for the Minetti model. See test_terrain.py.
"""
import racecraft as RC

# Naismith's constants, in the units the rule was written in.
FLAT_SPEED_KMH = 5.0
ASCENT_M_PER_HOUR = 600.0

# Langmuir: gentle descent is quicker than flat, steep descent is slower.
GENTLE_DESCENT = (-0.20, -0.05)     # grade band that earns the bonus
DESCENT_BONUS_S_PER_M = -10 * 60.0 / 300.0
DESCENT_PENALTY_S_PER_M = 10 * 60.0 / 300.0
STEEP_DESCENT = -0.20

# Grade bands for describing a route, and the ascent-per-km that defines them.
DIFFICULTY = ((5.0, "flat"), (15.0, "rolling"), (30.0, "hilly"), (60.0, "steep"))

# Fitting the personal climb cost. Segments flatter than this carry no
# information about climbing, and anything past the Minetti model's range is
# outside what the polynomial was fitted on.
MIN_GRADE = 0.02
MAX_GRADE = 0.30
MIN_SEGMENTS = 8
MIN_FLAT_SEGMENTS = 3


def book_time(distance_m, ascent_m=0.0, descent_m=0.0, descent_grade=None):
    """Naismith's rule with Langmuir's descent corrections. -> seconds.

    This is a *walking* standard, so a runner will come in well under it. That is
    fine and expected: it is a fixed yardstick, not a prediction.
    """
    if distance_m <= 0:
        return 0.0
    seconds = (distance_m / 1000.0) / FLAT_SPEED_KMH * 3600.0
    seconds += (ascent_m or 0.0) / ASCENT_M_PER_HOUR * 3600.0
    if descent_m and descent_grade is not None:
        if descent_grade <= STEEP_DESCENT:
            seconds += descent_m * DESCENT_PENALTY_S_PER_M
        elif GENTLE_DESCENT[0] < descent_grade <= GENTLE_DESCENT[1]:
            seconds += descent_m * DESCENT_BONUS_S_PER_M
    return max(seconds, 0.0)


def difficulty(distance_m, ascent_m):
    """A word for how hilly a route is, from ascent per kilometre."""
    if distance_m <= 0:
        return None
    per_km = (ascent_m or 0.0) / (distance_m / 1000.0)
    for limit, name in DIFFICULTY:
        if per_km < limit:
            return name
    return "mountainous"


def terrain_ratio(actual_s, distance_m, ascent_m=0.0, descent_m=0.0,
                  descent_grade=None):
    """Your time against the published standard for that ground. -> dict|None.

    Lower is stronger. Because the standard is a walking pace the number will
    look small, so what matters is comparing it between your own outings: the
    same ratio on a much hillier route is a better day.
    """
    book = book_time(distance_m, ascent_m, descent_m, descent_grade)
    if not book or not actual_s or actual_s <= 0:
        return None
    return {
        "ratio": actual_s / book,
        "book_s": book,
        "actual_s": actual_s,
        "difficulty": difficulty(distance_m, ascent_m),
        "ascent_per_km": (ascent_m or 0.0) / (distance_m / 1000.0),
    }


def _segments(samples, step_m=200.0):
    """Chop a stream into fixed-distance pieces. -> [(grade, speed_m_s)].

    200 m is long enough that GPS and barometric noise average out, and short
    enough that a segment has one gradient rather than several.
    """
    if not samples or len(samples) < 4:
        return []
    out = []
    anchor = samples[0]
    for sample in samples[1:]:
        run = sample[1] - anchor[1]
        if run < step_m:
            continue
        seconds = sample[0] - anchor[0]
        if seconds > 0 and anchor[5] is not None and sample[5] is not None:
            grade = (sample[5] - anchor[5]) / run
            if -MAX_GRADE <= grade <= MAX_GRADE:
                out.append((grade, run / seconds))
        anchor = sample
    return out


def climb_cost(samples, step_m=200.0):
    """How much hills actually cost you, against what the model predicts.

    -> dict, or None when the run has nothing to say about climbing.

    The method is deliberately simple: take the runner's own speed on the flat
    parts of this run as the reference, then for each climbing segment compare
    the speed they actually held with the speed Minetti's cost model says they
    should have held for the same metabolic outlay. The average of those is the
    factor.

        factor < 1  -- hills cost you more than the model expects
        factor > 1  -- you climb better than the model expects

    This is a *within-run* comparison, so it is unaffected by fitness, weather or
    how hard the day was: everything cancels except the gradient.
    """
    segments = _segments(samples, step_m)
    if len(segments) < MIN_SEGMENTS:
        return None

    flat = [speed for grade, speed in segments if abs(grade) < MIN_GRADE]
    climbs = [(grade, speed) for grade, speed in segments if grade >= MIN_GRADE]
    if len(flat) < MIN_FLAT_SEGMENTS or not climbs:
        return None

    flat_speed = sum(flat) / len(flat)
    if flat_speed <= 0:
        return None

    ratios = []
    for grade, speed in climbs:
        # What the model says you should manage on this gradient for the same
        # cost as your flat running.
        expected = flat_speed / RC.cost_ratio(grade)
        if expected > 0:
            ratios.append(speed / expected)
    if not ratios:
        return None

    factor = sum(ratios) / len(ratios)
    return {
        "factor": factor,
        "flat_speed": flat_speed,
        "climb_segments": len(climbs),
        "flat_segments": len(flat),
        "mean_climb_grade": sum(g for g, _s in climbs) / len(climbs),
        "verdict": _climb_verdict(factor),
    }


def _climb_verdict(factor):
    percent = abs(factor - 1.0) * 100.0
    if factor >= 1.05:
        return ("You hold %.0f%% more speed on the climbs than the energy model "
                "expects. Hills are a strength." % percent)
    if factor <= 0.95:
        return ("Climbs cost you %.0f%% more than the energy model expects -- "
                "the flat is where your running is strongest." % percent)
    return "You climb about as the energy model expects. No particular bias."


def profile(runs):
    """Average the climbing factor over several runs. -> dict|None.

    `runs` is [climb_cost_result]. One hilly run is a mood; a dozen is a trait.
    """
    usable = [r for r in runs if r and r.get("factor")]
    if len(usable) < 3:
        return None
    weight = sum(r["climb_segments"] for r in usable)
    if weight <= 0:
        return None
    # Weighted by how much climbing each run actually contained, so a run with
    # two hills does not count as much as one that was uphill all day.
    factor = sum(r["factor"] * r["climb_segments"] for r in usable) / weight
    return {"factor": factor, "runs": len(usable), "climb_segments": weight,
            "verdict": _climb_verdict(factor)}
