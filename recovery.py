"""Overnight recovery: what the night before says about today.

fitness.py measures the training you did. This measures what it cost you, and
those are different questions. Two athletes can carry the same CTL and the same
negative TSB while one is absorbing the block and the other is quietly coming
apart. The difference shows up overnight -- in heart-rate variability, resting
heart rate and sleep -- hours before it shows up in a session.

Everything here is relative. An HRV of 45 ms means nothing in the abstract and
everything against your own usual 60: HRV varies more between people than any
other number a watch records, so a population reference would be worse than no
reference at all. Every metric is therefore read as standard deviations from the
athlete's own rolling baseline, and where there is not enough history to have a
baseline, the answer is None rather than an invented one.

What comes out is a traffic light, not a measurement. A readiness score of 71 is
not meaningfully different from 68; what is meaningful is whether you are in the
green, the amber or the red, and whether you have been there one day or five. A
single low morning is noise -- a late meal, a warm room, a glass of wine. The run
of days is the signal, which is what trend() is for.

None of this is a health judgement. It reads training signals and says how the
training might go.

Pure functions. No I/O, no dependencies. See test_recovery.py.
"""
import math

# The baseline window. Sixty days is long enough to swallow one bad week and
# short enough to follow a real change -- baselines drift with fitness, altitude,
# a new job -- and a fortnight of readings is the least that gives a spread worth
# dividing by. Below that the standard deviation is mostly the sensor.
BASELINE_DAYS = 60
MIN_BASELINE_SAMPLES = 14

# A flat history has no spread to divide by, so the sd is floored at this
# fraction of the mean and the result is capped. See z_score().
FLAT_SD_FRACTION = 0.01
MAX_Z = 4.0

# HRV bands, in standard deviations from the athlete's own mean.
HRV_HIGH_Z = 1.0
HRV_LOW_Z = -1.0
HRV_VERY_LOW_Z = -2.0

TREND_DAYS = 7
MIN_TREND_SAMPLES = 3
TREND_PCT_PER_DAY = 0.5    # under half a percent a day is inside the noise


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _num(value):
    """Float, or None for missing, non-numeric and NaN readings."""
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return None if v != v else v


def _usable(values):
    """The real numbers in a series, in order. Missing nights simply vanish."""
    return [v for v in (_num(x) for x in (values or [])) if v is not None]


def _clamp(value, lo=0.0, hi=100.0):
    return max(lo, min(hi, value))


# --------------------------------------------------------------------------- #
# the personal baseline
# --------------------------------------------------------------------------- #
def baseline(values, days=BASELINE_DAYS, min_samples=MIN_BASELINE_SAMPLES):
    """Rolling personal baseline for one nightly metric. -> dict or None.

    `values` is one reading per day, oldest first, with None for the nights the
    watch spent on the charger. The window is counted in days rather than in
    readings, so a fortnight of missed nights shortens the baseline instead of
    silently reaching back two months for material to fill it with.

    None when there is not enough history. A mean over four mornings is not a
    baseline and a standard deviation over four mornings is noise wearing a
    range's clothes; handing either to the caller would produce a confident
    verdict that moves fifteen percent the next time a reading lands.

    Population sd, not sample sd: this is the spread of the nights that actually
    happened, not an estimate of some wider population's.
    """
    window = _usable(list(values or [])[-days:])
    if len(window) < min_samples:
        return None
    mean = sum(window) / len(window)
    var = sum((v - mean) ** 2 for v in window) / len(window)
    return {"mean": mean, "sd": math.sqrt(var), "n": len(window)}


def z_score(value, base):
    """How far today sits from the personal baseline, in standard deviations.

    None if either side is missing -- there is no answer to "how unusual is
    this" without a usual.

    A perfectly flat history has an sd of zero: a resting heart rate that has
    read 48 every morning for a month is common enough, because the watch
    reports whole beats. Dividing by that would turn one beat of difference into
    infinity. The sd is floored at a small fraction of the mean instead, which
    keeps the sign and the ordering honest, and the result is capped at MAX_Z so
    a flat history produces a strong reading rather than an absurd one.
    """
    v = _num(value)
    if v is None or not base:
        return None
    mean = _num(base.get("mean"))
    if mean is None:
        return None
    spread = max(_num(base.get("sd")) or 0.0, FLAT_SD_FRACTION * abs(mean))
    if spread <= 0:
        # A baseline of zeros with no spread: nothing to measure against.
        return 0.0 if v == mean else math.copysign(MAX_Z, v - mean)
    return _clamp((v - mean) / spread, -MAX_Z, MAX_Z)


def hrv_status(today, base):
    """Today's HRV against the athlete's own range. -> str or None.

      balanced   inside the usual night-to-night spread
      low        a standard deviation or more below it
      very_low   two or more below: the range that travels with a block gone
                 too far, or simply with a wretched night
      high       a standard deviation or more above

    One low morning is noise. HRV swings with a late meal, alcohol, a warm room
    and where you are in the training week, and the honest reading of a single
    low morning is "look again tomorrow". Three or four in a row is a different
    statement altogether, and that is the one worth acting on -- trend() makes
    it, this does not.

    `high` is the least interesting of the four: usually a genuinely restful
    night, occasionally the rebound after a very hard day, and one number cannot
    tell those apart.

    None without a baseline. An HRV of 45 with no history behind it is a number,
    not a status.
    """
    z = z_score(today, base)
    if z is None:
        return None
    if z >= HRV_HIGH_Z:
        return "high"
    if z > HRV_LOW_Z:
        return "balanced"
    if z > HRV_VERY_LOW_Z:
        return "low"
    return "very_low"


def trend(values, window=TREND_DAYS):
    """Is a metric drifting up, down or flat? -> "up" / "down" / "flat" / None.

    A least-squares slope through the recent days, expressed as a percentage of
    the window's own mean per day. Normalising like that is what lets one
    threshold serve HRV in milliseconds, resting heart rate in beats and sleep
    in hours; anything under TREND_PCT_PER_DAY -- about three percent across a
    week -- is called flat, because it is inside the noise of all three sensors.

    Direction only, and deliberately: three low HRV mornings in a row mean
    something a single low morning does not, and that is the whole reason this
    exists. Which direction is the good one depends on the metric, so the caller
    decides: HRV drifting down is a warning, resting heart rate drifting down is
    the opposite.

    Missing nights keep their place in the window rather than closing the gap,
    so a reading either side of a three-day hole does not read as a steep slope.

    None with fewer than MIN_TREND_SAMPLES readings in the window.

    ponytail: returns the sign, not the slope. Return the number alongside it
    when the dashboard wants to draw how steep the arrow is.
    """
    raw = list(values or [])[-window:]
    pts = [(float(i), v) for i, v in enumerate(_num(x) for x in raw) if v is not None]
    if len(pts) < MIN_TREND_SAMPLES:
        return None

    n = len(pts)
    mx = sum(x for x, _ in pts) / n
    my = sum(y for _, y in pts) / n
    den = sum((x - mx) ** 2 for x, _ in pts)
    if den <= 0 or my == 0:
        return "flat"
    slope = sum((x - mx) * (y - my) for x, y in pts) / den
    pct = 100.0 * slope / abs(my)
    if pct >= TREND_PCT_PER_DAY:
        return "up"
    if pct <= -TREND_PCT_PER_DAY:
        return "down"
    return "flat"


# --------------------------------------------------------------------------- #
# readiness
# --------------------------------------------------------------------------- #
# What each input is worth. The weights are renormalised over whatever actually
# arrived, so a call carrying nothing but TSB still spans the full 0-100.
#
# HRV leads because it is the most direct read on where the autonomic nervous
# system settled overnight, and because it moves first -- before resting heart
# rate, and days before a session feels wrong. It does not lead by more than
# this because it is also the noisiest of the four night to night.
#
# Sleep is next. It is the input the athlete can actually do something about
# tonight, and a short night predicts a bad session about as well as anything
# else here does.
#
# Resting heart rate tells much the same story as HRV -- the same system, read a
# blunter way -- so weighting the two equally would be counting one signal
# twice. It is also quantised to whole beats, which makes it coarse.
#
# TSB comes last on purpose. It is the plan's opinion of your fatigue, computed
# from the sessions you fed it, not a measurement of you: an athlete in the
# middle of a build is *meant* to be at -20, and that is not a reason to skip
# the session. It anchors the score when nothing else is available, and it is
# not allowed to outvote the body when something is.
#
# ponytail: fixed weights, one set for everybody. The upgrade path is to fit
# them per athlete against how the sessions actually went -- which needs a year
# of labelled days nobody has yet.
WEIGHTS = {"hrv": 0.35, "sleep": 0.25, "rhr": 0.20, "tsb": 0.20}

HRV_PER_SD = 20.0       # one sd below your own normal costs twenty points
HRV_CEILING = 90.0      # a high morning is good news, not a perfect score
RHR_PER_SD = 15.0       # gentler: RHR is whole beats, so its sd is small and
                        # its z-score swings hard on a single beat

SLEEP_SHORT_H, SLEEP_GOOD_H = 5.0, 8.0
SLEEP_SHORT_SCORE, SLEEP_GOOD_SCORE = 20.0, 85.0

TSB_PER_POINT = 1.5
TSB_CEILING = 85.0      # being rested is not the same as being fit

# Coverage: how much of the total weight the inputs actually accounted for.
CONFIDENT_WEIGHT = 0.70
FAIR_WEIGHT = 0.45

# Score floor, machine-readable band, and the phrase a human would use.
BANDS = (
    (80.0, "primed", "fresh and ready"),
    (62.0, "ready", "ready to train"),
    (45.0, "steady", "trainable, not sharp"),
    (30.0, "strained", "carrying fatigue"),
    (0.0, "depleted", "dug out"),
)

INPUT_LABELS = {
    "hrv": "HRV", "rhr": "resting heart rate", "sleep_hours": "sleep length",
    "sleep_score": "sleep quality", "tsb": "training load",
}


def sleep_hours_score(hours):
    """0-100 for the length of a night. -> float or None.

    The one place in this module that is not relative to the athlete. HRV is
    meaningless without your own baseline; six hours is short for everybody. So
    this is an absolute band -- linear from SLEEP_SHORT_H to SLEEP_GOOD_H and
    clamped either side, because eleven hours in bed does not leave you more
    ready than nine did.

    ponytail: absolute band, no personal history. Blend in a sleep baseline once
    there are enough nights of it to be worth trusting.
    """
    h = _num(hours)
    if h is None:
        return None
    frac = (h - SLEEP_SHORT_H) / (SLEEP_GOOD_H - SLEEP_SHORT_H)
    return _clamp(SLEEP_SHORT_SCORE + frac * (SLEEP_GOOD_SCORE - SLEEP_SHORT_SCORE),
                  10.0, 90.0)


def tsb_score(tsb):
    """0-100 for training stress balance: the plan's view of freshness.

    Roughly +20 TSB reads as tapered and -20 as deep in a block. The top is
    capped: a TSB of +40 means you have stopped training, which is restfulness
    rather than readiness.
    """
    t = _num(tsb)
    if t is None:
        return None
    return _clamp(50.0 + t * TSB_PER_POINT, 0.0, TSB_CEILING)


def band(score):
    """Score -> (band, short verdict phrase)."""
    for floor, name, phrase in BANDS:
        if score >= floor:
            return name, phrase
    return BANDS[-1][1], BANDS[-1][2]


def readiness(hrv=None, rhr=None, sleep_hours=None, sleep_score=None, tsb=None,
              baselines=None):
    """Everything the night knows, in one number. -> dict or None.

    `baselines` is {"hrv": ..., "rhr": ...} of baseline() results. The two heart
    measures are scored against them and are skipped entirely when the matching
    baseline is missing, because an HRV of 45 with no history behind it says
    nothing at all. Sleep and TSB carry their own meaning and need no history.

    Every input that arrives contributes its weight and the weights are then
    renormalised over what was used, so the score always spans 0-100: with TSB
    alone it still answers, with everything it answers better. `used` names the
    inputs that made it in, so a caller can honestly say "based on HRV and
    sleep", and `confidence` says how much of the picture they covered.

    Where both sleep numbers arrive, the watch's own sleep score wins and the
    raw hours sit it out -- the score already has duration inside it, and
    averaging the two would count the same night twice.

    None when nothing usable arrived. Returning 50 for an empty morning would
    look exactly like a measurement, and be one.
    """
    baselines = baselines or {}
    parts, used = {}, []

    hrv_z = z_score(hrv, baselines.get("hrv"))
    if hrv_z is not None:
        parts["hrv"] = {
            "score": _clamp(50.0 + hrv_z * HRV_PER_SD, 0.0, HRV_CEILING),
            "z": hrv_z, "value": _num(hrv),
            "status": hrv_status(hrv, baselines.get("hrv")),
        }
        used.append("hrv")

    rhr_z = z_score(rhr, baselines.get("rhr"))
    if rhr_z is not None:
        # Inverted: a resting heart rate above your own normal is the bad way.
        parts["rhr"] = {"score": _clamp(50.0 - rhr_z * RHR_PER_SD),
                        "z": rhr_z, "value": _num(rhr)}
        used.append("rhr")

    watch_sleep = _num(sleep_score)
    if watch_sleep is not None:
        parts["sleep"] = {"score": _clamp(watch_sleep), "value": watch_sleep,
                          "source": "sleep_score"}
        used.append("sleep_score")
    else:
        hours = sleep_hours_score(sleep_hours)
        if hours is not None:
            parts["sleep"] = {"score": hours, "value": _num(sleep_hours),
                              "source": "sleep_hours"}
            used.append("sleep_hours")

    freshness = tsb_score(tsb)
    if freshness is not None:
        parts["tsb"] = {"score": freshness, "value": _num(tsb)}
        used.append("tsb")

    if not parts:
        return None

    coverage = sum(WEIGHTS[k] for k in parts)
    score = sum(parts[k]["score"] * WEIGHTS[k] for k in parts) / coverage
    for k in parts:
        parts[k]["weight"] = WEIGHTS[k] / coverage

    name, phrase = band(score)
    confidence = ("high" if coverage >= CONFIDENT_WEIGHT
                  else "medium" if coverage >= FAIR_WEIGHT else "low")
    return {
        "score": score,
        "band": name,
        "verdict": phrase,
        "used": used,
        "coverage": coverage,
        "confidence": confidence,
        "components": parts,
        "hrv_status": parts.get("hrv", {}).get("status"),
    }


# --------------------------------------------------------------------------- #
# what to do about it
# --------------------------------------------------------------------------- #
# (band, planned_hard) -> what to do. Every one of these is a sentence about the
# session, never about the athlete's health.
ADVICE = {
    ("primed", True): "Everything is at or above your own normal, so run the hard "
                      "session as planned and spend it properly.",
    ("primed", False): "You are fresher than usual. Nothing needs changing, though "
                       "this is a good morning to pull a hard session forward if one "
                       "is due later in the week.",
    ("ready", True): "Nothing here argues against the hard session. Run it as "
                     "planned and judge it on the first rep.",
    ("ready", False): "Train as planned.",
    ("steady", True): "A middling morning. Do the session, but warm up properly and "
                      "be willing to drop the last rep or two rather than grind them "
                      "out.",
    ("steady", False): "Train as planned, and keep the easy running properly easy.",
    ("strained", True): "Today reads low, so take the easy version of the session "
                        "-- fewer reps, or the same reps a shade slower -- rather "
                        "than forcing the planned one.",
    ("strained", False): "Today reads low. An easy hour, or a short one; nothing "
                         "that needs recovering from tomorrow.",
    ("depleted", True): "This is a morning to move the hard session rather than "
                        "survive it. Easy running or nothing at all today, and take "
                        "the session again once the numbers come back.",
    ("depleted", False): "Take the day off, or walk. One low morning is noise, but "
                         "this is low enough that a day costs you nothing and buys "
                         "you the week.",
}

# Only attached to the bottom two bands, and only when a body signal put them
# there: a low score built from TSB alone means the training did it, which is
# what training is for. Phrased as a pointer rather than a worry, and it names no
# cause because this module can see none.
REFERRAL = ("Several mornings like this with no hard training behind them are worth "
            "raising with a coach or a doctor; this score reads training signals, "
            "not health.")
BODY_INPUTS = ("hrv", "rhr", "sleep_hours", "sleep_score")


def _inputs_phrase(used):
    """'HRV, sleep quality and training load' -- what the score was built from."""
    names = [INPUT_LABELS.get(u, u) for u in (used or [])]
    if not names:
        return "nothing"
    if len(names) == 1:
        return names[0]
    return "%s and %s" % (", ".join(names[:-1]), names[-1])


def advice(result, planned_hard=False):
    """One thing to do with today, in a sentence or two. -> str.

    Concrete and non-alarmist. The worst thing this could do is tell a healthy
    athlete that something is wrong with them, so it talks about the session and
    nothing else: no illness, no diagnosis, no physiology it cannot see. A run of
    low mornings with no training to explain it is worth taking to a person, and
    the bottom two bands say so -- without naming a cause, and only when it was
    an overnight number rather than the training log that put them there.

    `planned_hard` changes the answer, because the decision is the whole point of
    the score. An amber morning is a perfectly good day for an easy hour and a
    poor day for a threshold session, and one sentence cannot cover both.
    """
    if not result:
        return ("No overnight data for today, so there is nothing here to weigh. "
                "Train as planned and go on feel.")

    name = result.get("band")
    used = result.get("used") or []
    body = ADVICE.get((name, bool(planned_hard))) or ADVICE[("steady", bool(planned_hard))]

    tail = "Based on %s." % _inputs_phrase(used)
    if result.get("confidence") == "low":
        tail += " That is thin evidence, so let the warm-up have the final say."
    if name in ("strained", "depleted") and any(u in BODY_INPUTS for u in used):
        tail += " " + REFERRAL
    return "%s %s" % (body, tail)
