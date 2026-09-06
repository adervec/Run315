"""Does your engine hold up, or does it just start well?

Every other number in this app describes a runner who is fresh. Race prediction
fits a curve to your best efforts, threshold pace is a steady-state number, and
your training paces assume you can still hold them at the end. None of that says
anything about hour three, which is exactly where a marathon is decided.

Durability is the fourth axis of endurance, alongside VO2max, economy and
threshold (Maunder et al., Sports Medicine 2021). The field version of it is
*decoupling*: the drift between what your body is doing (heart rate) and what it
is producing (grade-adjusted speed) over a long run. Early on, a given pace costs
a given heart rate. Later, the same pace costs more. How much more, and how soon
it starts, is the measurement.

The method here follows Smyth, Maunder, Meyler, Hunter and Muniz-Pumares,
"Decoupling of Internal and External Workload During a Marathon", Sports Medicine
52(9), 2022 -- an analysis of 82,303 recreational runners using exactly the data
a GPS watch records:

    internal   = mean heart rate / maximum heart rate
    external   = mean grade-adjusted speed / critical speed
    ratio      = internal / external
    decoupling = ratio(late window) / ratio(early window)

Both sides are expressed as a fraction of the runner's own ceiling, which is what
makes the ratio dimensionless and comparable within an athlete.

Two things matter more than the arithmetic:

  * it needs a long run. Critical power does not budge after 40 or 80 minutes of
    heavy work and only falls after 120 (Clark et al. 2019). Below the dose gate
    there is nothing to measure, so this module returns None rather than a
    number, because a decoupling figure off a 40-minute tempo is noise with a
    decimal point.
  * it is not comparable between people. Elites run at ~96% of critical speed
    from the gun and have no room to drift, so their fade shows up as slowing
    rather than as a rising heart rate (Takayama and Aoyagi 2025). Women decouple
    less than men, and later (Smyth 2022; Jaen-Carrillo et al. 2026). Compare a
    runner with themselves, and with nobody else.

Critical speed comes from Smyth and Muniz-Pumares, "Calculation of Critical Speed
from Raw Training Data in Recreational Marathon Runners", MSSE 52(12), 2020: fit
distance = CS * time + Dprime across your own best efforts. CS is the slope,
Dprime the intercept -- the finite distance available above it.

Pure functions. No I/O, no dependencies beyond racecraft for the grade model.
See test_durability.py.
"""
import racecraft as RC

# The fitting window for critical speed. Shorter efforts are dominated by the
# anaerobic reserve, longer ones by pacing and fuelling, and both bend the line.
CS_MIN_S = 120.0
CS_MAX_S = 900.0
CS_MIN_POINTS = 3

# Below this there is no durability signal to find (Clark et al. 2019: critical
# power was unchanged at 40 and 80 minutes of heavy exercise, and fell at 120).
MIN_DURATION_S = 75 * 60.0
MIN_DISTANCE_M = 12000.0

# Windows as a fraction of the run. The opening is skipped because heart rate
# takes minutes to catch up with effort, and the finish because people race the
# last part of a long run.
EARLY = (0.10, 0.25)
LATE = (0.75, 0.90)

# Smyth's bands. The 1.025 onset trigger and the 1.1/1.2 cuts are described in
# the paper itself as arbitrary -- they are conventions with a large sample
# behind them, not physiological boundaries.
ONSET_TRIGGER = 1.025
BAND_LOW = 1.10
BAND_HIGH = 1.20

# Heat inflates decoupling and Smyth explicitly did not correct for it, so a hot
# run gets a caveat rather than an adjustment.
HOT_C = 20.0


def critical_speed(bests):
    """Fit distance = CS * time + Dprime to your best efforts.

    `bests` is [(distance_m, seconds)]. -> (cs_m_s, d_prime_m) or None.

    Only efforts of 2-15 minutes are used. Fit quality is deliberately not
    reported: three points on a near-linear relation always fit beautifully, and
    an R-squared of 0.9999 would say nothing about whether the model is right.
    """
    points = [(float(s), float(d)) for d, s in bests
              if d and s and CS_MIN_S <= s <= CS_MAX_S]
    if len(points) < CS_MIN_POINTS:
        return None

    n = len(points)
    sum_t = sum(t for t, _d in points)
    sum_d = sum(d for _t, d in points)
    sum_tt = sum(t * t for t, _d in points)
    sum_td = sum(t * d for t, d in points)
    denom = n * sum_tt - sum_t * sum_t
    if denom <= 0:
        return None

    cs = (n * sum_td - sum_t * sum_d) / denom
    d_prime = (sum_d - cs * sum_t) / n
    # A negative reserve, or a critical speed slower than a walk, means these
    # efforts did not come from the same athlete having the same kind of day.
    if cs <= 1.0 or d_prime < 0:
        return None
    return (cs, d_prime)


def _grade(previous, current):
    """Rise over run between two samples, as a fraction."""
    run = current[1] - previous[1]
    if run <= 0 or previous[5] is None or current[5] is None:
        return 0.0
    grade = (current[5] - previous[5]) / run
    return max(-0.45, min(0.45, grade))


def _windows(samples):
    """Split a stream into (early, late) sample lists by distance covered."""
    total = samples[-1][1] - samples[0][1]
    if total <= 0:
        return None, None
    start = samples[0][1]

    def slice_at(lo, hi):
        return [s for s in samples if lo <= (s[1] - start) / total <= hi]

    return slice_at(*EARLY), slice_at(*LATE)


def _ratio(window, hr_max, cs):
    """Smyth's internal:external ratio for one window of samples. -> float|None.

    Grade-adjusted speed is computed per sample pair and averaged over time, so a
    long flat stretch counts for more than a brief climb.
    """
    if len(window) < 2:
        return None

    hr_sum = hr_seconds = 0.0
    speed_sum = speed_seconds = 0.0
    for previous, current in zip(window, window[1:]):
        dt = current[0] - previous[0]
        dd = current[1] - previous[1]
        if dt <= 0 or dd < 0:
            continue
        if current[2]:
            hr_sum += current[2] * dt
            hr_seconds += dt
        if dd > 0:
            # Convert to the equivalent flat speed, so a hilly late window is not
            # mistaken for fatigue.
            pace = dt / (dd / 1000.0)
            flat_pace = RC.grade_adjusted_pace(pace, _grade(previous, current))
            if flat_pace > 0:
                speed_sum += (1000.0 / flat_pace) * dt
                speed_seconds += dt

    if hr_seconds <= 0 or speed_seconds <= 0:
        return None
    internal = (hr_sum / hr_seconds) / hr_max
    external = (speed_sum / speed_seconds) / cs
    if external <= 0:
        return None
    return internal / external


def _onset(samples, hr_max, cs, early_ratio):
    """Where the drift starts and does not come back. -> metres from the start.

    Walks a rolling window forwards and takes the first point past the trigger
    that stays past it. A single hill can push one window over; a real onset does
    not recover.
    """
    if not early_ratio:
        return None
    total = samples[-1][1] - samples[0][1]
    start = samples[0][1]
    step = max(total / 20.0, 500.0)

    crossings = []
    at = start + total * EARLY[1]
    while at < start + total:
        window = [s for s in samples if at <= s[1] <= at + step]
        ratio = _ratio(window, hr_max, cs)
        if ratio:
            crossings.append((at - start, ratio / early_ratio))
        at += step

    onset = None
    for distance, drift in crossings:
        if drift > ONSET_TRIGGER:
            if onset is None:
                onset = distance
        else:
            onset = None       # came back down: not the onset after all
    return onset


def band(value):
    """Smyth's three groups. Lower is more durable."""
    if value is None:
        return None
    if value < BAND_LOW:
        return "low"
    if value < BAND_HIGH:
        return "moderate"
    return "high"


def _mean_intensity(samples, cs):
    """The run's average speed as a fraction of critical speed."""
    duration = samples[-1][0] - samples[0][0]
    distance = samples[-1][1] - samples[0][1]
    if duration <= 0 or cs <= 0:
        return None
    return (distance / duration) / cs


def _verdict(value, intensity):
    """One sentence, in the runner's terms."""
    percent = (value - 1.0) * 100.0
    if value < BAND_LOW:
        head = ("Your heart rate held its pace to the end -- %.0f%% drift, which "
                "is the durable end of the range." % percent)
    elif value < BAND_HIGH:
        head = ("%.0f%% drift between the start and the end: the ordinary amount "
                "of fade for a long run." % percent)
    else:
        head = ("%.0f%% drift -- the same pace cost markedly more by the end than "
                "it did at the start." % percent)
    if intensity and intensity > 0.90:
        head += (" You were running at %.0f%% of critical speed, quicker than a "
                 "long run usually goes, so some of this is the pace."
                 % (intensity * 100))
    return head


def analyse(samples, hr_max, cs, temperature_c=None):
    """Decoupling over one long run. -> dict, or None if the run cannot answer.

    `samples` is the 10-wide stream tuple: (seconds, metres, hr, lat, lon,
    elevation_m, cadence, stride, gct, vertical_oscillation).
    """
    if not samples or len(samples) < 20 or not hr_max or not cs:
        return None
    duration = samples[-1][0] - samples[0][0]
    distance = samples[-1][1] - samples[0][1]
    if duration < MIN_DURATION_S or distance < MIN_DISTANCE_M:
        return None

    early_samples, late_samples = _windows(samples)
    if not early_samples or not late_samples:
        return None
    early = _ratio(early_samples, hr_max, cs)
    late = _ratio(late_samples, hr_max, cs)
    if not early or not late:
        return None

    value = late / early
    intensity = _mean_intensity(samples, cs)
    return {
        "decoupling": value,
        "band": band(value),
        "onset_m": _onset(samples, hr_max, cs, early),
        "early_ratio": early,
        "late_ratio": late,
        "duration_s": duration,
        "distance_m": distance,
        "intensity": intensity,
        "hot": bool(temperature_c is not None and temperature_c >= HOT_C),
        "temperature_c": temperature_c,
        "verdict": _verdict(value, intensity),
    }


def trend(runs):
    """Decoupling over time on comparable runs. -> dict, or None.

    `runs` is [(date, analysis_dict)], oldest first. Only runs within a fifth of
    the longest are compared, because durability measured over 80 minutes and
    over three hours are not the same measurement. Hunter et al. (2025) lay the
    standardisation problem out and decline to solve it; this is the conservative
    reading of it.
    """
    usable = [(d, a) for d, a in runs if a and a.get("decoupling")]
    if len(usable) < 3:
        return None

    longest = max(a["duration_s"] for _d, a in usable)
    comparable = [(d, a) for d, a in usable if a["duration_s"] >= longest * 0.80]
    if len(comparable) < 3:
        return None

    half = len(comparable) // 2
    early = sum(a["decoupling"] for _d, a in comparable[:half]) / half
    late = sum(a["decoupling"] for _d, a in comparable[len(comparable) - half:]) / half
    change = late - early
    if change < -0.03:
        note = "You are holding together better over distance than you were."
    elif change > 0.03:
        note = "You are fading more over distance than you were."
    else:
        note = "Your durability is level across this block."
    return {"runs": len(comparable), "early": early, "late": late,
            "change": change, "note": note,
            "best": min(a["decoupling"] for _d, a in comparable)}
