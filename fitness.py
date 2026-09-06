"""Fitness model: training load (CTL/ATL/TSB) and race-time projection.

Pure functions over activity dicts. No I/O, no third-party deps -- so it is
testable on its own (see test_fitness.py).

An activity dict needs: type, start (datetime), distance_m, moving_s,
elapsed_s, avg_hr.  Missing values may be None.
"""
import math
from datetime import timedelta

RUN_TYPES = {"running", "trail_running", "treadmill_running", "track_running",
             "virtual_run", "indoor_running"}
CARDIO_TYPES = RUN_TYPES | {
    "cycling", "road_biking", "indoor_cycling", "mountain_biking", "gravel_cycling",
    "virtual_ride", "commuting", "lap_swimming", "open_water_swimming", "walking",
    "hiking", "rowing", "indoor_rowing", "elliptical", "stair_climbing",
    "fitness_equipment", "cardio", "other",
}

# Distance buckets for picking one best effort per range (metres).
BUCKETS = ((1500, 3200), (3200, 7000), (7000, 13000), (13000, 25000), (25000, 60000))

RIEGEL = 1.06          # textbook fatigue exponent, used as fallback + normaliser
MIN_EXPONENT, MAX_EXPONENT = 1.01, 1.20   # physiologically plausible range
CTL_DAYS, ATL_DAYS = 42, 7
HALF_LIFE_DAYS = 90.0  # recency weighting of past efforts in the fit

STANDARD_RACES = (
    ("5K", 5000), ("10K", 10000), ("15K", 15000), ("10 mi", 16093),
    ("Half marathon", 21097), ("Marathon", 42195), ("50K", 50000),
)


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def percentile(values, q):
    """Linear-interpolated percentile. q in [0,1]. None for empty input."""
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    k = (len(vals) - 1) * q
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    if lo == hi:
        return float(vals[lo])
    return vals[lo] + (vals[hi] - vals[lo]) * (k - lo)


def fmt_time(seconds):
    """Seconds -> h:mm:ss or m:ss."""
    if seconds is None:
        return "--"
    s = int(round(seconds))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return "%d:%02d:%02d" % (h, m, sec) if h else "%d:%02d" % (m, sec)


def fmt_pace(seconds, metres):
    """Pace as m:ss /km."""
    if not seconds or not metres:
        return "--"
    return fmt_time(seconds / (metres / 1000.0)) + " /km"


def fmt_speed(seconds, metres):
    """Speed as km/h -- how riders and rowers read their efforts."""
    if not seconds or not metres:
        return "--"
    return "%.1f km/h" % (metres / 1000.0 / (seconds / 3600.0))


SPEED_TYPES = {"cycling", "road_biking", "indoor_cycling", "mountain_biking",
               "gravel_cycling", "virtual_ride", "commuting", "rowing", "indoor_rowing"}


def fmt_effort(activity):
    """Pace for runs and walks, speed for rides -- whichever the athlete thinks in."""
    secs = activity.get("moving_s") or activity.get("elapsed_s")
    dist = activity.get("distance_m")
    fmt = fmt_speed if activity.get("type") in SPEED_TYPES else fmt_pace
    return fmt(secs, dist)


# --------------------------------------------------------------------------- #
# training load
# --------------------------------------------------------------------------- #
def thresholds(activities):
    """Self-calibrating threshold HR and per-sport threshold speed.

    The 95th percentile of activity-average HR sits close to lactate threshold
    for anyone who does the occasional hard session -- no user input needed.
    """
    thr_hr = percentile([a.get("avg_hr") for a in activities], 0.95)
    by_sport = {}
    for a in activities:
        d, t = a.get("distance_m"), a.get("moving_s")
        if d and t and t > 0:
            by_sport.setdefault(a.get("type"), []).append(d / t)
    thr_spd = {k: percentile(v, 0.95) for k, v in by_sport.items()}
    return thr_hr, thr_spd


def activity_load(activity, thr_hr, thr_spd):
    """TSS-style load: hours * intensity^2 * 100."""
    secs = activity.get("moving_s") or activity.get("elapsed_s") or 0
    hours = secs / 3600.0
    if hours <= 0:
        return 0.0

    hr, sport = activity.get("avg_hr"), activity.get("type")
    dist, mov = activity.get("distance_m"), activity.get("moving_s")
    if hr and thr_hr:
        intensity = hr / thr_hr
    elif dist and mov and thr_spd.get(sport):
        intensity = (dist / mov) / thr_spd[sport]
    else:
        # ponytail: no HR and no pace baseline -> assume a steady aerobic effort.
        intensity = 0.75
    intensity = max(0.4, min(1.15, intensity))
    return hours * intensity * intensity * 100.0


def daily_loads(activities, thr_hr, thr_spd):
    """{date: total load} over cardio activities."""
    out = {}
    for a in activities:
        if a.get("type") not in CARDIO_TYPES or not a.get("start"):
            continue
        day = a["start"].date()
        out[day] = out.get(day, 0.0) + activity_load(a, thr_hr, thr_spd)
    return out


def load_curve(daily, end_date, days=180):
    """[(date, load, ctl, atl, tsb)] -- CTL/ATL are exponential moving averages."""
    kc = 1.0 - math.exp(-1.0 / CTL_DAYS)
    ka = 1.0 - math.exp(-1.0 / ATL_DAYS)
    ctl = atl = 0.0
    start = end_date - timedelta(days=days)
    curve = []
    # Warm the averages up over an equal-length run-in so day one is not zero.
    day = start - timedelta(days=days)
    while day <= end_date:
        load = daily.get(day, 0.0)
        ctl += (load - ctl) * kc
        atl += (load - atl) * ka
        if day >= start:
            curve.append((day, load, ctl, atl, ctl - atl))
        day += timedelta(days=1)
    return curve


# --------------------------------------------------------------------------- #
# race projection
# --------------------------------------------------------------------------- #
HARD_HR_FRACTION = 0.88   # of threshold HR -- below this it is a training run


def _bucket_index(distance_m):
    for i, (lo, hi) in enumerate(BUCKETS):
        if lo <= distance_m < hi:
            return i
    return None


def best_efforts(activities, now, days=180, thr_hr=None):
    """[(distance_m, time_s, age_days)] of plausible running *efforts*.

    An easy long run is not an effort, and letting one into the fit makes the
    athlete look like they fade badly over distance. When heart rate is
    available we keep only the genuinely hard runs; that filter is dropped if it
    would leave too little to fit.
    """
    cand = []
    for a in activities:
        if a.get("type") not in RUN_TYPES:
            continue
        d = a.get("distance_m") or 0.0
        t = a.get("moving_s") or a.get("elapsed_s") or 0.0
        if d < 1500 or t <= 0 or not a.get("start"):
            continue
        pace = t / (d / 1000.0)          # s/km
        if pace < 120 or pace > 720:     # 2:00 - 12:00 /km, drops GPS junk
            continue
        age = (now.date() - a["start"].date()).days
        if 0 <= age <= days:
            cand.append((d, t, age, a.get("avg_hr")))

    if thr_hr:
        hard = [c for c in cand if c[3] and c[3] >= HARD_HR_FRACTION * thr_hr]
        if len({_bucket_index(c[0]) for c in hard}) >= 2:
            cand = hard
    return [(d, t, age) for d, t, age, _ in cand]


def implied_exponent(e1, e2):
    """Fatigue exponent implied by two efforts, or None if they are the same distance."""
    (d1, t1), (d2, t2) = (e1[0], e1[1]), (e2[0], e2[1])
    if d1 <= 0 or d2 <= 0 or abs(math.log(d2) - math.log(d1)) < 1e-9:
        return None
    return (math.log(t2) - math.log(t1)) / (math.log(d2) - math.log(d1))


def bucket_bests(efforts):
    """One best effort per distance bucket, keeping only plausible race efforts.

    A bucket's best is dropped when the exponent it implies against the athlete's
    strongest performance is outside the physiological range -- that is what an
    easy long run looks like, and letting one in fakes a severe fade. A genuinely
    slower-over-distance runner still implies an in-range exponent, so real
    long-distance results survive this.
    """
    def norm(e):
        return e[1] * (10000.0 / e[0]) ** RIEGEL

    picks = []
    for lo, hi in BUCKETS:
        cand = [e for e in efforts if lo <= e[0] < hi]
        if cand:
            picks.append(min(cand, key=norm))
    if len(picks) < 2:
        return picks

    anchor = min(picks, key=norm)
    kept = []
    for p in picks:
        if p is anchor:
            kept.append(p)
            continue
        short, long_ = sorted((anchor, p), key=lambda e: e[0])
        b = implied_exponent(short, long_)
        if b is not None and MIN_EXPONENT <= b <= MAX_EXPONENT:
            kept.append(p)
    return kept


def fit_power_law(efforts):
    """Weighted log-log fit of time vs distance -> (intercept, exponent, points).

    Returns None when there is nothing to fit. The exponent is the athlete's
    personal fatigue factor; it is clamped because a 2-point fit on noisy data
    can otherwise produce nonsense.
    """
    pts = bucket_bests(efforts)
    if not pts:
        return None
    if len(pts) == 1:
        d, t, _ = pts[0]
        return (math.log(t) - RIEGEL * math.log(d), RIEGEL, pts)

    sw = swx = swy = swxx = swxy = 0.0
    for d, t, age in pts:
        w = 0.5 ** (age / HALF_LIFE_DAYS)
        x, y = math.log(d), math.log(t)
        sw += w
        swx += w * x
        swy += w * y
        swxx += w * x * x
        swxy += w * x * y
    den = sw * swxx - swx * swx
    if abs(den) < 1e-9:
        d, t, _ = pts[0]
        return (math.log(t) - RIEGEL * math.log(d), RIEGEL, pts)
    b = (sw * swxy - swx * swy) / den
    b = max(MIN_EXPONENT, min(MAX_EXPONENT, b))
    a = (swy - b * swx) / sw
    return (a, b, pts)


def base_prediction(fit, distance_m):
    """Predicted seconds at distance_m from current form, no trend applied."""
    if not fit:
        return None
    a, b, _ = fit
    return math.exp(a + b * math.log(distance_m))


def fitness_factor(ctl_now, ctl_before, days_to_race):
    """Multiplier on predicted time for fitness trending up (or down).

    ponytail: heuristic -- time scales as fitness ** -0.15, capped at +/-4%.
    Upgrade path: fit the exponent per user once there is race-result history.
    """
    if not ctl_now or not ctl_before or ctl_before <= 0 or not days_to_race:
        return 1.0
    if days_to_race <= 0:
        return 1.0
    weekly_growth = (ctl_now / ctl_before) ** (1.0 / 6.0) - 1.0
    weeks = min(days_to_race / 7.0, 12.0)          # do not extrapolate past ~3 months
    projected = (1.0 + weekly_growth) ** weeks
    if projected <= 0:
        return 1.0
    return max(0.96, min(1.04, projected ** -0.15))


def confidence(fit, distance_m):
    """How much to trust this projection: high / medium / low / none."""
    if not fit:
        return "none"
    _, _, pts = fit
    if len(pts) < 2:
        return "low"
    longest = max(p[0] for p in pts)
    fresh = min(p[2] for p in pts)
    stretch = distance_m / longest
    if len(pts) >= 3 and stretch <= 1.6 and fresh <= 45:
        return "high"
    if stretch <= 3.0 and fresh <= 120:
        return "medium"
    return "low"


def summarise(activities, now, segment_efforts=None):
    """Current-form snapshot shared by the dashboard, the projections and the coach.

    `segment_efforts` is [(distance_m, seconds, age_days)] of true best efforts
    measured inside activities. They are strictly better evidence than a whole
    run, so they compete for -- and normally win -- each distance bucket.
    """
    thr_hr, thr_spd = thresholds(activities)
    daily = daily_loads(activities, thr_hr, thr_spd)
    curve = load_curve(daily, now.date())
    ctl_now = curve[-1][2] if curve else 0.0
    ctl_before = curve[-43][2] if len(curve) >= 43 else (curve[0][2] if curve else 0.0)

    efforts = best_efforts(activities, now, thr_hr=thr_hr)
    if segment_efforts:
        efforts = efforts + [e for e in segment_efforts if 0 <= e[2] <= 180]
    fit = fit_power_law(efforts)

    return {
        "curve": curve,
        "daily": daily,
        "ctl": ctl_now,
        "atl": curve[-1][3] if curve else 0.0,
        "tsb": curve[-1][4] if curve else 0.0,
        "ctl_6w_ago": ctl_before,
        "threshold_hr": thr_hr,
        "fit": fit,
        "efforts": efforts,
        "weekly": weekly_totals(activities, now),
        "paces": training_paces(fit),
        "zones": hr_zones(thr_hr),
        "spike": session_spike([(a["start"].date(), a["distance_m"])
                                for a in activities
                                if a.get("type") in RUN_TYPES and a.get("distance_m")]),
        "threshold_pace": threshold_pace(fit),
    }


def weekly_totals(activities, now, weeks=12):
    """[(week_start_date, km, hours, load)] most recent last."""
    thr_hr, thr_spd = thresholds(activities)
    monday = now.date() - timedelta(days=now.date().weekday())
    buckets = {}
    for a in activities:
        if a.get("type") not in CARDIO_TYPES or not a.get("start"):
            continue
        d = a["start"].date()
        wk = d - timedelta(days=d.weekday())
        if not (monday - timedelta(weeks=weeks - 1) <= wk <= monday):
            continue
        km, hrs, load = buckets.get(wk, (0.0, 0.0, 0.0))
        buckets[wk] = (
            km + (a.get("distance_m") or 0) / 1000.0,
            hrs + (a.get("moving_s") or a.get("elapsed_s") or 0) / 3600.0,
            load + activity_load(a, thr_hr, thr_spd),
        )
    return [(monday - timedelta(weeks=i),) + buckets.get(monday - timedelta(weeks=i), (0.0, 0.0, 0.0))
            for i in range(weeks - 1, -1, -1)]


def project_race(summary, distance_m, race_date=None, today=None):
    """Projection for one race from a summarise() snapshot. None with no data."""
    fit = summary.get("fit")
    base = base_prediction(fit, distance_m)
    if base is None:
        return None
    days_to_race = (race_date - today).days if (race_date and today) else 0
    factor = fitness_factor(summary["ctl"], summary["ctl_6w_ago"], days_to_race)
    _, exponent, pts = fit
    return {
        "seconds": base * factor,
        "base_seconds": base,
        "trend_factor": factor,
        "exponent": exponent,
        "confidence": confidence(fit, distance_m),
        "based_on": [{"distance_m": d, "seconds": t, "age_days": age} for d, t, age in pts],
        "days_to_race": days_to_race,
    }


# --------------------------------------------------------------------------- #
# best efforts inside an activity
# --------------------------------------------------------------------------- #
# The fastest continuous stretch of each length within a run. This is what makes
# a 5K inside a long run count, and it is the input Strava's predictor uses.
BEST_EFFORT_DISTANCES = (400, 800, 1000, 1609, 3000, 5000, 10000,
                         15000, 16093, 21097, 42195)


def _monotonic(samples):
    """Sorted, distance-monotonic (time_s, distance_m) pairs. GPS can go backwards."""
    pts = sorted((float(t), float(d)) for t, d in samples
                 if t is not None and d is not None)
    clean, last = [], -1.0
    for t, d in pts:
        d = max(d, last)
        clean.append((t, d))
        last = d
    return clean


def best_effort_curve(samples, distances=BEST_EFFORT_DISTANCES):
    """Fastest time for each distance within one activity. -> {distance_m: seconds}.

    `samples` is [(elapsed_seconds, cumulative_metres)]. Uses a sliding window and
    interpolates the window start, so a 400m best is not skewed by sample spacing.
    """
    pts = _monotonic(samples)
    if len(pts) < 2:
        return {}
    total = pts[-1][1] - pts[0][1]

    out = {}
    for target in distances:
        if target <= 0 or target > total:
            continue
        best, i = None, 0
        for j in range(len(pts)):
            # advance to the tightest window ending at j that still spans `target`
            while i + 1 < len(pts) and pts[j][1] - pts[i + 1][1] >= target:
                i += 1
            if pts[j][1] - pts[i][1] < target:
                continue
            start_t = pts[i][0]
            if i + 1 < len(pts):
                need = pts[j][1] - target
                d0, d1 = pts[i][1], pts[i + 1][1]
                if d1 > d0 and d0 <= need <= d1:
                    start_t += (pts[i + 1][0] - pts[i][0]) * (need - d0) / (d1 - d0)
            span = pts[j][0] - start_t
            if span > 0 and (best is None or span < best):
                best = span
        # A 400m "best" of 40 seconds is a GPS artefact, not a runner.
        if best and 120 <= best / (target / 1000.0) <= 900:
            out[target] = best
    return out


def personal_records(effort_rows):
    """Best time per distance across all stored efforts.

    `effort_rows` is [(distance_m, seconds, date)] -> [(distance_m, seconds, date)]
    sorted by distance, one row per distance.
    """
    best = {}
    for dist, secs, when in effort_rows:
        if secs and (dist not in best or secs < best[dist][0]):
            best[dist] = (secs, when)
    return [(d, best[d][0], best[d][1]) for d in sorted(best)]


# --------------------------------------------------------------------------- #
# prescriptions: what to actually run
# --------------------------------------------------------------------------- #
def threshold_pace(fit):
    """Pace (s/km) you could hold for one hour, solved from your own fitted curve.

    Threshold is defined by duration, not distance, so it is read off the curve
    rather than assumed to be some fixed race distance.
    """
    if not fit:
        return None
    a, b, _ = fit
    try:
        distance = math.exp((math.log(3600.0) - a) / b)
    except (ValueError, OverflowError, ZeroDivisionError):
        return None
    if not (2000.0 <= distance <= 40000.0):
        return None
    return 3600.0 / (distance / 1000.0)


# Fractions of threshold speed. Slower fraction first -> slower pace bound.
TRAINING_PACE_BANDS = (
    ("Easy", "Most of your week. Conversational.", 0.70, 0.78),
    ("Marathon", "Race-pace work for the long stuff.", 0.90, 0.95),
    ("Threshold", "Tempo and cruise intervals. ~1 hour race effort.", 0.98, 1.02),
    ("Interval", "VO2max work. 3-5 minute reps.", 1.04, 1.09),
    ("Repetition", "Speed and economy. 200-600m reps.", 1.10, 1.16),
)


def training_paces(fit):
    """[(name, purpose, fast_s_per_km, slow_s_per_km)] from current fitness."""
    thr = threshold_pace(fit)
    if not thr:
        return []
    out = []
    for name, purpose, lo, hi in TRAINING_PACE_BANDS:
        # Faster fraction of threshold speed -> lower (faster) pace.
        out.append((name, purpose, thr / hi, thr / lo))
    return out


# Friel-style zones anchored on lactate-threshold HR.
HR_ZONE_BANDS = (
    ("Z1 Recovery", 0.00, 0.81),
    ("Z2 Aerobic", 0.81, 0.90),
    ("Z3 Tempo", 0.90, 0.94),
    ("Z4 Threshold", 0.94, 1.00),
    ("Z5 VO2max", 1.00, 1.15),
)


def hr_zones(thr_hr):
    """[(name, low_bpm, high_bpm)] from the estimated threshold HR."""
    if not thr_hr:
        return []
    return [(name, int(round(thr_hr * lo)), int(round(thr_hr * hi)))
            for name, lo, hi in HR_ZONE_BANDS]


# How far past your recent longest run a session has to go before it is worth
# mentioning, and where the evidence puts the elevated-risk band.
SPIKE_REFERENCE_DAYS = 30
SPIKE_NOTE = 0.10
SPIKE_HIGH = 0.30


# The fastest a human plausibly sustains each activity, in m/s, over a whole
# session. Well clear of world-record average pace -- this catches a mislabelled
# activity, not a fast one.
PLAUSIBLE_SPEED = {"running": 7.0, "trail_running": 6.5, "treadmill_running": 7.0,
                   "walking": 3.0, "hiking": 3.0,
                   "cycling": 20.0, "virtual_ride": 20.0}
PLAUSIBLE_DEFAULT = 25.0


def implausible(activity):
    """Is this activity moving faster than its own sport allows? -> str|None.

    Borrowed from Tranggle, the Korean tracker, which refuses to award anything
    to a "hike" recorded at 30 km/h. Strava will happily take a mislabelled bike
    ride as a run and put it in your personal bests, where it stays forever.

    Returns a sentence naming the problem, or None when the activity is fine.
    """
    kind = activity.get("type")
    distance = activity.get("distance_m")
    seconds = activity.get("moving_s") or activity.get("elapsed_s")
    if not kind or not distance or not seconds or seconds <= 0:
        return None

    speed = distance / seconds
    limit = PLAUSIBLE_SPEED.get(kind, PLAUSIBLE_DEFAULT)
    if speed <= limit:
        return None
    return ("recorded as %s but averaging %s -- faster than that sport goes, so "
            "it is probably mislabelled" % (kind.replace("_", " "),
                                            fmt_pace(seconds / (distance / 1000.0),
                                                     1000) if kind in RUN_TYPES
                                            else "%.1f km/h" % (speed * 3.6)))


def session_spike(runs, reference_days=SPIKE_REFERENCE_DAYS):
    """Was the most recent run longer than recent training supports?

    -> (ratio, distance_m, longest_recent_m, verdict) or None.

    `runs` is [(date, distance_m)] in any order. `ratio` is the session distance
    over the longest run of the preceding `reference_days`, so 1.0 means "as long
    as anything you have done lately" and 1.4 means half again as far.

    This replaces the acute:chronic workload ratio, which this app used to show
    and which does not survive scrutiny. Impellizzeri et al. (Sports Medicine
    2021, "Time to Dismiss ACWR and Its Underlying Theory") recomputed published
    ACWR results with the chronic load replaced by *random numbers* and
    reproduced the effect; the ratio predicted injury barely better than chance
    (c-statistic 0.574, against 0.544 for acute load alone) and only in-sample.
    The numerator and denominator also share data, so part of the correlation is
    definitional (Lolli et al., BJSM 2019).

    What replaced it is narrower and better evidenced. Frandsen et al., BJSM 2025
    followed 5,205 Garmin-tracked runners over 588,071 sessions and 1,820
    injuries, and compared three ways of expressing a spike. The single-session
    one won: distance relative to the longest run of the past 30 days. Against a
    rise of 10% or less, a rise of 10-30% carried a hazard rate ratio of 1.64
    (95% CI 1.31-2.05) and a rise of 30-100% one of 1.52 (1.16-2.00).

    Note the second number is *lower* than the first, so this is not a clean
    dose-response and the wording below does not pretend otherwise.
    """
    dated = sorted(((d, m) for d, m in runs if d and m and m > 0),
                   key=lambda r: r[0])
    if not dated:
        return None
    day, distance = dated[-1]
    window = [m for d, m in dated[:-1]
              if 0 <= (day - d).days <= reference_days]
    if not window:
        return None

    longest = max(window)
    ratio = distance / longest
    if ratio > 1.0 + SPIKE_HIGH:
        verdict = ("further than anything in the last month by a good margin -- "
                   "the sessions that precede injuries look like this one")
    elif ratio > 1.0 + SPIKE_NOTE:
        verdict = "a step up on your longest run of the last month"
    elif ratio > 1.0:
        verdict = "your longest run in a month, but only just"
    else:
        verdict = "within what you have been running"
    return (ratio, distance, longest, verdict)


def project_form(daily, today, race_date, taper_days=14, taper_factor=0.55):
    """Simulate CTL/ATL to race day, with and without a taper.

    Assumes you keep your recent average daily load. -> dict, or None if the race
    is not ahead of today.
    """
    days_out = (race_date - today).days
    if days_out is None or days_out <= 0:
        return None

    recent = sum(daily.get(today - timedelta(days=i), 0.0) for i in range(28)) / 28.0
    kc = 1.0 - math.exp(-1.0 / CTL_DAYS)
    ka = 1.0 - math.exp(-1.0 / ATL_DAYS)

    def simulate(taper):
        ctl = atl = 0.0
        day = today - timedelta(days=365)
        while day <= today:
            load = daily.get(day, 0.0)
            ctl += (load - ctl) * kc
            atl += (load - atl) * ka
            day += timedelta(days=1)
        for i in range(1, days_out + 1):
            load = recent
            if taper and (days_out - i) < taper_days:
                load *= taper_factor
            ctl += (load - ctl) * kc
            atl += (load - atl) * ka
        return ctl, atl

    flat_ctl, flat_atl = simulate(False)
    tap_ctl, tap_atl = simulate(True)
    return {
        "days_out": days_out,
        "avg_daily_load": recent,
        "tsb_no_taper": flat_ctl - flat_atl,
        "tsb_with_taper": tap_ctl - tap_atl,
        "ctl_race_day": tap_ctl,
        "taper_days": taper_days,
    }


# --------------------------------------------------------------------------- #
# calibration: learn from races you actually ran
# --------------------------------------------------------------------------- #
CALIBRATION_HALF_LIFE_DAYS = 365.0
CALIBRATION_MAX_ADJUST = 0.06      # never move a projection more than 6% either way


def calibration(results, today):
    """How far off the model has been for this athlete. -> dict or None.

    `results` is [(predicted_s, actual_s, race_date)] for past races where both
    are known. The bias is a recency-weighted geometric mean of actual/predicted;
    it multiplies future projections. Two results minimum -- one race is an
    anecdote, not a pattern.
    """
    pairs = [(p, a, d) for p, a, d in results if p and a and p > 0 and a > 0]
    if len(pairs) < 2:
        return None
    sw = swl = 0.0
    for p, a, d in pairs:
        age = max((today - d).days, 0)
        w = 0.5 ** (age / CALIBRATION_HALF_LIFE_DAYS)
        sw += w
        swl += w * math.log(a / p)
    if sw <= 0:
        return None
    raw = math.exp(swl / sw)
    factor = max(1.0 - CALIBRATION_MAX_ADJUST, min(1.0 + CALIBRATION_MAX_ADJUST, raw))
    errors = [abs(a / p - 1.0) for p, a, _ in pairs]
    return {
        "factor": factor,
        "raw_factor": raw,
        "n": len(pairs),
        "mean_abs_error": sum(errors) / len(errors),
        "direction": ("slower than projected" if raw > 1.005
                      else "faster than projected" if raw < 0.995 else "on the money"),
    }


def apply_calibration(projection, cal):
    """Return a copy of a project_race() dict with the athlete's bias applied."""
    if not projection or not cal:
        return projection
    out = dict(projection)
    out["seconds"] = projection["seconds"] * cal["factor"]
    out["calibration_factor"] = cal["factor"]
    return out


# --------------------------------------------------------------------------- #
# per-activity analysis
# --------------------------------------------------------------------------- #
def km_splits(samples, split_m=1000.0):
    """Split times from a (time, distance) stream. -> [(km_index, seconds, pace_s_per_km)].

    Interpolates each split boundary so the result does not depend on where the
    watch happened to record a sample.
    """
    pts = _monotonic(samples)
    if len(pts) < 2:
        return []
    out, k, prev_t = [], 1, pts[0][0]
    i = 0
    total = pts[-1][1]
    while k * split_m <= total + 1e-6:
        target = k * split_m
        while i + 1 < len(pts) and pts[i + 1][1] < target:
            i += 1
        if i + 1 >= len(pts):
            break
        (t0, d0), (t1, d1) = pts[i], pts[i + 1]
        t_at = t0 + (t1 - t0) * (target - d0) / (d1 - d0) if d1 > d0 else t1
        secs = t_at - prev_t
        if secs > 0:
            out.append((k, secs, secs / (split_m / 1000.0)))
        prev_t = t_at
        k += 1
    # partial last split
    if total - (k - 1) * split_m > 100 and pts[-1][0] > prev_t:
        rem = total - (k - 1) * split_m
        secs = pts[-1][0] - prev_t
        out.append((k, secs, secs / (rem / 1000.0)))
    return out


def split_evenness(splits):
    """0 = perfectly even. Coefficient of variation of the full-km split paces."""
    paces = [p for k, s, p in splits[:-1]] if len(splits) > 1 else [p for _, _, p in splits]
    if len(paces) < 2:
        return None
    mean = sum(paces) / len(paces)
    if mean <= 0:
        return None
    var = sum((p - mean) ** 2 for p in paces) / len(paces)
    return math.sqrt(var) / mean


def hr_drift(samples_hr):
    """Cardiac drift: % rise in HR-to-speed between the halves of a steady run.

    `samples_hr` is [(time_s, distance_m, hr)]. Above ~5% on an easy run means it
    was hotter, longer, or harder than it should have been. -> percentage or None.
    """
    pts = [(t, d, h) for t, d, h in samples_hr if h and t is not None and d is not None]
    if len(pts) < 20:
        return None
    pts.sort()
    mid = len(pts) // 2
    first, second = pts[:mid], pts[mid:]

    def ratio(chunk):
        dt = chunk[-1][0] - chunk[0][0]
        dd = chunk[-1][1] - chunk[0][1]
        if dt <= 0 or dd <= 0:
            return None
        avg_hr = sum(h for _, _, h in chunk) / len(chunk)
        return avg_hr / (dd / dt)

    r1, r2 = ratio(first), ratio(second)
    if not r1 or not r2:
        return None
    return (r2 / r1 - 1.0) * 100.0


def classify_run(activity, thr_hr, thr_pace):
    """Label a run by what it was: easy, long, tempo, intervals, race, or unknown."""
    dist = activity.get("distance_m") or 0
    secs = activity.get("moving_s") or activity.get("elapsed_s") or 0
    hr = activity.get("avg_hr")
    if not dist or not secs:
        return "unknown"
    pace = secs / (dist / 1000.0)
    intensity = (hr / thr_hr) if (hr and thr_hr) else (thr_pace / pace if thr_pace else None)
    if intensity is None:
        return "unknown"
    if intensity >= 0.98 and dist >= 3000:
        return "race"
    if intensity >= 0.92:
        return "tempo" if secs >= 1200 else "intervals"
    if secs >= 5400 or dist >= 18000:
        return "long"
    if intensity < 0.85:
        return "easy"
    return "steady"


# --------------------------------------------------------------------------- #
# weekly digest
# --------------------------------------------------------------------------- #
def week_digest(activities, now, thr_hr, thr_spd):
    """Numbers for the weekly summary: this week vs last, and the standouts."""
    monday = now.date() - timedelta(days=now.date().weekday())
    prev_monday = monday - timedelta(days=7)

    def bucket(start, end):
        km = hrs = load = 0.0
        runs = []
        for a in activities:
            if a.get("type") not in CARDIO_TYPES or not a.get("start"):
                continue
            d = a["start"].date()
            if not (start <= d < end):
                continue
            km += (a.get("distance_m") or 0) / 1000.0
            hrs += (a.get("moving_s") or a.get("elapsed_s") or 0) / 3600.0
            load += activity_load(a, thr_hr, thr_spd)
            if a.get("type") in RUN_TYPES:
                runs.append(a)
        return {"km": km, "hours": hrs, "load": load, "runs": runs}

    this = bucket(monday, monday + timedelta(days=7))
    last = bucket(prev_monday, monday)
    longest = max(this["runs"], key=lambda a: a.get("distance_m") or 0, default=None)

    def pace_of(a):
        d, s = a.get("distance_m") or 0, a.get("moving_s") or a.get("elapsed_s") or 0
        return s / (d / 1000.0) if d >= 1500 and s else None

    paced = [(pace_of(a), a) for a in this["runs"] if pace_of(a)]
    fastest = min(paced, key=lambda x: x[0], default=(None, None))[1]
    return {
        "week_start": monday,
        "this": this, "last": last,
        "km_delta": this["km"] - last["km"],
        "load_delta": this["load"] - last["load"],
        "longest": longest, "fastest": fastest,
    }


def split_targets(distance_m, seconds, negative_split=0.01):
    """Checkpoint splits for a race. -> [(label, metres, cumulative_seconds)].

    Slightly negative: the first half is run `negative_split` slower than average
    and the second half that much faster, which is how the distance is best run.
    """
    if not distance_m or not seconds:
        return []
    step = 1000.0 if distance_m <= 12000 else 5000.0
    marks = []
    d = step
    while d < distance_m - 1:
        marks.append(d)
        d += step
    marks.append(distance_m)

    half = distance_m / 2.0
    avg = seconds / distance_m           # s per metre
    slow, fast = avg * (1 + negative_split), avg * (1 - negative_split)

    out = []
    for m in marks:
        first = min(m, half)
        second = max(0.0, m - half)
        cumulative = first * slow + second * fast
        label = "Finish" if abs(m - distance_m) < 1 else "%gK" % round(m / 1000.0, 2)
        out.append((label, m, cumulative))
    return out
