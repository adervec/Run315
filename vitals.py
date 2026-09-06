"""Which of your numbers actually respond to your training?

A watch now records two dozen things a day. Almost every app displays them as
two dozen separate dials, which pushes the only interesting question onto the
athlete: *does any of this have anything to do with my running?*

For a given person the answer is usually "three of them do". Which three is
individual -- one runner's sleep collapses after hard days while their resting
heart rate never moves, and the next runner is the other way round. Population
studies wash this out by averaging over people who differ; a single athlete's own
record does not have that problem.

So this module correlates every daily metric against training load, at several
lags, and reports the ones that stand up. The lag matters: stress responds the
same night, sleep architecture the night after, body mass over weeks.

**The statistics are the hard part, and getting them wrong here would be worse
than not doing it at all.** Two guards:

  * **Multiple comparisons.** Twenty-three metrics times four lags is ninety-two
    tests. At the usual 5% threshold you would expect four or five to look
    "significant" from noise alone. Every threshold here is Bonferroni-corrected
    by the number of tests actually run, and the uncorrected count is reported
    alongside so the difference is visible rather than hidden.
  * **Autocorrelation.** Daily training load is not independent day to day --
    hard days cluster, and so do bad nights. That inflates significance for any
    naive test, this one included. The correction above does not fix it, so the
    effective sample size is smaller than the number of days and everything here
    is reported as *worth looking at*, never as established.

Correlation is not causation and a daily record cannot separate the two. What it
can do is tell you which dials are worth glancing at and which have never once
moved with your training.

Pure functions, standard library only. See test_vitals.py.
"""
import math
from statistics import NormalDist

# Lags to test, in days. Same-day, next-day, and two slower windows for the
# things that move over weeks rather than nights.
LAGS = (0, 1, 2, 7)

# Minimum paired days before a correlation means anything at all.
MIN_POINTS = 20

# Significance before correction. Corrected by the number of tests run.
ALPHA = 0.05

# Correlations below this are not worth a sentence even when "significant",
# because with enough days almost anything clears a threshold.
MIN_INTERESTING = 0.25

# Metrics that ARE the training rather than a response to it. Calories burned
# correlating with running is not a finding, it is arithmetic, and letting these
# sit at the top of the list buries the signals that took work to find.
MECHANICAL = {"calories_total", "calories_active", "intensity_minutes",
              "vigorous_minutes", "steps", "floors"}

# Metrics where a *higher* number is the worse outcome, so the wording flips.
HIGHER_IS_WORSE = {"stress_avg", "stress_max", "avg_stress", "restless_count",
                   "awake_s", "body_fat_pct", "fitness_age", "respiration_avg"}

# Human names, because "spo2_low" on a page is a failure of nerve.
LABELS = {
    "steps": "daily steps", "floors": "floors climbed",
    "stress_avg": "average stress", "stress_max": "peak stress",
    "body_battery_high": "body battery peak",
    "body_battery_low": "body battery low point",
    "spo2_avg": "blood oxygen", "spo2_low": "lowest blood oxygen",
    "respiration_avg": "breathing rate",
    "intensity_minutes": "intensity minutes",
    "vigorous_minutes": "vigorous minutes",
    "weight_kg": "body mass", "body_fat_pct": "body fat",
    "training_readiness": "Garmin readiness",
    "calories_total": "total calories", "calories_active": "active calories",
    "fitness_age": "fitness age",
    "deep_s": "deep sleep", "light_s": "light sleep", "rem_s": "REM sleep",
    "awake_s": "time awake", "restless_count": "restlessness",
    "avg_stress": "overnight stress",
    "hrv_ms": "HRV", "rhr": "resting heart rate",
    "sleep_hours": "sleep length", "sleep_score": "sleep score",
}


def label(name):
    return LABELS.get(name, name.replace("_", " "))


def pearson(xs, ys):
    """Correlation of two equal-length series, ignoring pairs with a gap."""
    pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    if len(pairs) < 3:
        return None
    n = len(pairs)
    mean_x = sum(x for x, _y in pairs) / n
    mean_y = sum(y for _x, y in pairs) / n
    sxx = sum((x - mean_x) ** 2 for x, _y in pairs)
    syy = sum((y - mean_y) ** 2 for _x, y in pairs)
    if sxx <= 0 or syy <= 0:
        return None                     # a flat series correlates with nothing
    sxy = sum((x - mean_x) * (y - mean_y) for x, y in pairs)
    return sxy / math.sqrt(sxx * syy)


def critical_r(n, alpha=ALPHA, tests=1):
    """The smallest correlation that clears significance. -> float|None.

    Uses the normal approximation to the t distribution, which is close enough
    past about thirty paired days, and applies a Bonferroni correction for the
    number of tests actually run.
    """
    if n < 4:
        return None
    adjusted = alpha / max(tests, 1)
    if not 0 < adjusted < 1:
        return None
    z = NormalDist().inv_cdf(1.0 - adjusted / 2.0)
    return z / math.sqrt(n - 2 + z * z)


def _shift(load_by_day, days, lag):
    """Training load `lag` days before each day in `days`."""
    from datetime import timedelta
    return [load_by_day.get(day - timedelta(days=lag)) for day in days]


def correlate(daily, load_by_day, metrics=None, lags=LAGS):
    """Every metric against training load, at every lag. -> dict.

    `daily` is [(date, {metric: value})]; `load_by_day` is {date: load}.
    """
    if not daily:
        return {"findings": [], "tested": 0, "days": 0, "critical_r": None}

    days = [d for d, _row in daily]
    columns = {}
    for name in (metrics or _metric_names(daily)):
        columns[name] = [row.get(name) for _d, row in daily]

    # Count the tests first, so the correction is honest rather than applied to
    # whatever survived.
    tested = 0
    candidates = []
    for name, values in columns.items():
        for lag in lags:
            loads = _shift(load_by_day, days, lag)
            paired = sum(1 for a, b in zip(values, loads)
                         if a is not None and b is not None)
            if paired < MIN_POINTS:
                continue
            tested += 1
            r = pearson(values, loads)
            if r is not None:
                candidates.append((name, lag, r, paired))

    cut = None
    findings = []
    for name, lag, r, paired in candidates:
        threshold = critical_r(paired, tests=tested)
        cut = threshold if cut is None else max(cut, threshold)
        if threshold is None or abs(r) < max(threshold, MIN_INTERESTING):
            continue
        findings.append({
            "metric": name, "label": label(name), "lag": lag, "r": r,
            "days": paired, "threshold": threshold,
            "note": _finding_note(name, lag, r),
        })

    # Strongest first, and only the best lag per metric: the same signal showing
    # up at lag 0 and lag 1 is one finding, not two.
    findings.sort(key=lambda f: -abs(f["r"]))
    best, mechanical, seen = [], [], set()
    for finding in findings:
        if finding["metric"] in seen:
            continue
        seen.add(finding["metric"])
        (mechanical if finding["metric"] in MECHANICAL else best).append(finding)

    return {"findings": best, "mechanical": mechanical,
            "tested": tested, "days": len(days),
            "critical_r": cut,
            "uncorrected": sum(1 for _n, _l, r, p in candidates
                               if abs(r) >= (critical_r(p, tests=1) or 1.0))}


def _metric_names(daily):
    names = set()
    for _d, row in daily:
        names.update(k for k, v in row.items() if v is not None)
    return sorted(names)


def _finding_note(name, lag, r):
    direction = "rises" if r > 0 else "falls"
    when = {0: "on a hard day itself", 1: "the day after a hard day",
            2: "two days after a hard day"}.get(lag, "about a week after a hard day")
    worse = (r > 0) == (name in HIGHER_IS_WORSE)
    tail = (" That is the direction that costs you."
            if worse else " That is the direction you would hope for.")
    if lag >= 7:
        # Training is weekly, so a seven-day lag is nearly the same phase as no
        # lag at all. Saying so is more useful than pretending otherwise.
        tail += (" Careful with this one: training runs on a weekly rhythm, so a "
                 "seven-day lag lands on almost the same phase as no lag, and the "
                 "two are hard to tell apart.")
    return ("Your %s %s %s (r = %+.2f).%s"
            % (label(name), direction, when, r, tail))


def sleep_architecture(daily):
    """How the night is built, against the usual adult proportions. -> dict|None.

    Reference shares for adults are roughly 13-23% deep, 20-25% REM, the rest
    light. They are population figures and individual variation is wide, so this
    reports where you sit rather than whether you pass.
    """
    stages = []
    for _day, row in daily:
        deep, light, rem = row.get("deep_s"), row.get("light_s"), row.get("rem_s")
        if not deep or not light or not rem:
            continue
        total = deep + light + rem
        if total <= 0:
            continue
        stages.append((deep / total, light / total, rem / total, total))
    if len(stages) < 7:
        return None

    n = len(stages)
    deep = sum(s[0] for s in stages) / n
    light = sum(s[1] for s in stages) / n
    rem = sum(s[2] for s in stages) / n
    asleep = sum(s[3] for s in stages) / n
    return {
        "nights": n,
        "deep_share": deep, "light_share": light, "rem_share": rem,
        "asleep_s": asleep,
        "deep_typical": 0.13 <= deep <= 0.23,
        "rem_typical": 0.20 <= rem <= 0.25,
        "note": _sleep_note(deep, rem),
    }


def _sleep_note(deep, rem):
    parts = []
    if deep < 0.13:
        parts.append("less deep sleep than the usual adult range")
    elif deep > 0.23:
        parts.append("more deep sleep than the usual adult range")
    if rem < 0.20:
        parts.append("less REM than typical")
    elif rem > 0.25:
        parts.append("more REM than typical")
    if not parts:
        return ("Your nights are built in roughly the usual adult proportions. "
                "Sleep staging from a wrist device is an estimate, so read this "
                "as a shape rather than a measurement.")
    return ("Your nights show %s. Wrist-based sleep staging is an estimate and "
            "disagrees with a sleep lab often enough that this is worth watching "
            "for a trend, not acting on from one week." % " and ".join(parts))


def trend(daily, metric, window=14):
    """Where a metric is heading. -> dict|None.

    Compares the mean of the last `window` days with the window before it, which
    is blunt and survives missing days, and reports the change relative to the
    metric's own spread so a number in kilograms and one in beats per minute can
    sit in the same table.
    """
    values = [(d, row.get(metric)) for d, row in daily if row.get(metric) is not None]
    if len(values) < window + 4:
        return None
    values.sort(key=lambda item: item[0])
    recent = [v for _d, v in values[-window:]]
    before = [v for _d, v in values[-2 * window:-window]]
    if len(before) < 4:
        return None

    recent_mean = sum(recent) / len(recent)
    before_mean = sum(before) / len(before)
    everything = [v for _d, v in values]
    spread = _stdev(everything)
    change = recent_mean - before_mean
    return {
        "metric": metric, "label": label(metric),
        "recent": recent_mean, "before": before_mean,
        "change": change,
        "relative": (change / before_mean) if before_mean else None,
        "z": (change / spread) if spread else None,
        "notable": bool(spread and abs(change) > spread * 0.5),
        "better": _is_better(metric, change),
    }


def _is_better(metric, change):
    if change == 0:
        return None
    return (change < 0) if metric in HIGHER_IS_WORSE else (change > 0)


def _stdev(values):
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    return math.sqrt(sum((v - mean) ** 2 for v in values) / (len(values) - 1))


def outliers(daily, metric, sigma=2.5):
    """Days where one metric was genuinely unlike the others. -> [dict]."""
    values = [(d, row.get(metric)) for d, row in daily if row.get(metric) is not None]
    if len(values) < MIN_POINTS:
        return []
    numbers = [v for _d, v in values]
    mean = sum(numbers) / len(numbers)
    spread = _stdev(numbers)
    if spread <= 0:
        return []
    return [{"day": d, "metric": metric, "label": label(metric), "value": v,
             "z": (v - mean) / spread}
            for d, v in values if abs(v - mean) / spread >= sigma]


def odd_days(daily, sigma=2.0, min_metrics=3):
    """Days that were unusual across *several* metrics at once. -> [dict].

    One metric out of range is noise. Four at once, on the same day, is the day
    you were coming down with something -- and that is a pattern a per-metric
    chart cannot show you.
    """
    if len(daily) < MIN_POINTS:
        return []
    # Mechanical metrics spike on every long run, which is not the day being
    # unusual -- it is the day being long. An odd day should be about your body.
    names = [n for n in _metric_names(daily) if n not in MECHANICAL]
    by_day = {}
    for name in names:
        for hit in outliers(daily, name, sigma=sigma):
            by_day.setdefault(hit["day"], []).append(hit)
    out = [{"day": day, "count": len(hits),
            "metrics": sorted(hits, key=lambda h: -abs(h["z"]))}
           for day, hits in by_day.items() if len(hits) >= min_metrics]
    out.sort(key=lambda item: (-item["count"], item["day"]))
    return out
