"""How hard was that week, really?

Volume answers almost nothing. Two runners with identical weekly hours can sit
on opposite sides of the most repeatable finding in endurance training: the ones
who keep the easy days genuinely easy, so the hard days can be genuinely hard,
improve -- and the ones who spend every session at a comfortably uncomfortable
middle pace mostly do not.

Telling those two apart needs time in each heart-rate zone, and *time* is the
word that matters. A watch samples unevenly: every second while you run, once a
minute while it thinks you have stopped, and not at all across a dropout. Count
samples per zone and the sparse stretches quietly vanish from the week. So
everything here integrates the seconds between samples instead.

On top of the five Friel zones sit the three buckets coaches actually argue
about -- easy, the grey zone, and hard -- the published polarisation index that
puts one number on the shape, and aerobic decoupling for whether a single run
held together.

Pure functions over stream samples. No I/O, no dependencies. See test_zones.py.

A sample is (seconds, metres, hr, lat, lon, elevation_m); everything after the
first two may be missing or None.
"""
import math
from datetime import timedelta

# Friel's zones as fractions of lactate-threshold HR -- the same numbers
# fitness.HR_ZONE_BANDS shows on the dashboard, except that the top band is left
# open: time-in-zone has to put 108% of threshold somewhere.
ZONE_BANDS = (
    ("Z1", "Recovery", 0.00, 0.81),
    ("Z2", "Aerobic", 0.81, 0.90),
    ("Z3", "Tempo", 0.90, 0.94),
    ("Z4", "Threshold", 0.94, 1.00),
    ("Z5", "VO2max", 1.00, float("inf")),
)
ZONES = tuple(band[0] for band in ZONE_BANDS)

# The three buckets the polarisation argument is about. Z3 is the grey zone:
# above the aerobic ceiling, below the threshold that would make it worth it.
EASY_ZONES = ("Z1", "Z2")
MODERATE_ZONES = ("Z3",)
HARD_ZONES = ("Z4", "Z5")

# Longer than this between two rows and the watch was paused, in a tunnel, or
# sitting in a cafe -- not running for two minutes at the heart rate it last saw.
MAX_GAP_S = 120.0

# Where one distribution stops being another. Round numbers on purpose: these
# are the coaching rules of thumb, not measurements.
TOO_HARD_SHARE = 0.30          # more than this at threshold-and-above is not sustainable
THRESHOLD_HEAVY_SHARE = 0.20   # more than this in the grey zone is the classic mistake
POLARISED_EASY_MIN = 0.65
POLARISED_MODERATE_MAX = 0.10
POLARISED_HARD_MIN = 0.10

MIN_DECOUPLING_SAMPLES = 8


def _clean(samples):
    """Sorted (t, d, hr) triples with monotonic distance. Junk rows dropped.

    Streams arrive from a device, so they contain everything: short rows, Nones,
    NaNs, out-of-order timestamps and GPS that briefly runs backwards.
    """
    out = []
    for s in samples:
        if not s or len(s) < 2 or s[0] is None or s[1] is None:
            continue
        try:
            t, d = float(s[0]), float(s[1])
        except (TypeError, ValueError):
            continue
        if t != t or d != d:
            continue
        hr = None
        if len(s) > 2 and s[2] is not None:
            try:
                hr = float(s[2])
            except (TypeError, ValueError):
                hr = None
            if hr is not None and (hr != hr or hr <= 0):
                hr = None
        out.append((t, d, hr))
    out.sort(key=lambda p: p[0])

    clean, last = [], None
    for t, d, hr in out:
        d = d if last is None else max(d, last)
        clean.append((t, d, hr))
        last = d
    return clean


def zone_of(hr, thr_hr, bands=ZONE_BANDS):
    """Which zone a single heart rate falls in, as a key. None if unplaceable.

    Zones are read against threshold HR rather than max HR because threshold is
    the number the app can estimate from the athlete's own history without
    asking them to go and run themselves into the ground.
    """
    if not hr or not thr_hr or hr <= 0 or thr_hr <= 0:
        return None
    fraction = hr / thr_hr
    for key, _name, lo, hi in bands:
        if lo <= fraction < hi:
            return key
    # Only reachable if a caller passes bands with a closed top: anything above
    # the last ceiling still belongs to the last zone.
    return bands[-1][0] if fraction >= bands[-1][2] else None


def time_in_zones(samples, thr_hr, bands=ZONE_BANDS):
    """Seconds spent in each zone during one activity. -> {zone: seconds}.

    Every zone is present, so callers never have to guess whether a missing key
    means zero. Time is integrated between consecutive samples: a sample holds
    its heart rate until the next one arrives, which is how the device meant it
    to be read, and it is the only way a stretch recorded once a minute counts
    for the minute it actually lasted.

    A row without heart rate contributes nothing rather than being filled in --
    the total then honestly falls short of the elapsed time, which is a better
    signal than a confident guess.
    """
    out = {key: 0.0 for key, _name, _lo, _hi in bands}
    pts = _clean(samples)
    if not thr_hr or thr_hr <= 0 or len(pts) < 2:
        return out

    for (t0, _d0, hr0), (t1, _d1, _hr1) in zip(pts, pts[1:]):
        gap = t1 - t0
        if gap <= 0:
            continue
        zone = zone_of(hr0, thr_hr, bands)
        if zone is None:
            continue
        # ponytail: the interval goes whole to the zone it started in, so a
        # crossing between zones is credited to the wrong side of the boundary
        # for a few seconds. Upgrade path: interpolate the crossing point if
        # per-zone seconds ever need to be exact rather than indicative.
        out[zone] += min(gap, MAX_GAP_S)
    return out


def weekly_zones(activities, thr_hr, weeks=12, now=None):
    """Time in zone rolled up per ISO week. -> [(monday_date, {zone: seconds})].

    Oldest first, most recent last, with empty weeks present as zeros -- a week
    with no training is a fact about the block, not a hole to be skipped when
    the shape of a training phase is what you are looking at.

    An activity is a dict with `start` (datetime) and `samples` (or `stream`).
    `now` defaults to the newest activity, so a stored block reads the same way
    a year later as it did on the day.
    """
    rows = []
    for a in activities:
        start, samples = a.get("start"), (a.get("samples") or a.get("stream"))
        if not start or not samples:
            continue
        day = start.date() if hasattr(start, "date") else start
        rows.append((day, time_in_zones(samples, thr_hr)))
    if not rows:
        return []

    end = now.date() if hasattr(now, "date") else now
    if end is None:
        end = max(day for day, _ in rows)
    # Monday of the ISO week is what everyone means by "the week".
    monday = end - timedelta(days=end.weekday())

    # Weeks outside the window need no filtering: they simply never get read.
    buckets = {}
    for day, zone_seconds in rows:
        week = day - timedelta(days=day.weekday())
        acc = buckets.setdefault(week, {z: 0.0 for z in ZONES})
        for zone, secs in zone_seconds.items():
            acc[zone] = acc.get(zone, 0.0) + secs

    return [(monday - timedelta(weeks=i),
             buckets.get(monday - timedelta(weeks=i), {z: 0.0 for z in ZONES}))
            for i in range(weeks - 1, -1, -1)]


def three_buckets(zone_seconds):
    """(easy_s, moderate_s, hard_s) from a time_in_zones() dict."""
    def total(keys):
        return sum(zone_seconds.get(k) or 0.0 for k in keys)
    return total(EASY_ZONES), total(MODERATE_ZONES), total(HARD_ZONES)


def polarisation(zone_seconds):
    """What shape is this training, and is that the shape you wanted? -> dict.

    Five zones is too fine a grain to argue about. Collapsed to three -- easy
    below the aerobic ceiling, the grey zone in the middle, hard from threshold
    up -- the week takes one of four recognisable shapes, and the label is worth
    more to a runner than the percentages are.

    Shares are fractions of the time that could be placed in a zone at all, so
    they always sum to 1 even when the heart-rate trace has holes in it.
    """
    easy_s, moderate_s, hard_s = three_buckets(zone_seconds)
    total = easy_s + moderate_s + hard_s
    if total <= 0:
        return {"easy_s": 0.0, "moderate_s": 0.0, "hard_s": 0.0, "total_s": 0.0,
                "easy": 0.0, "moderate": 0.0, "hard": 0.0,
                "label": None, "verdict": verdict(None, 0.0, 0.0, 0.0)}

    easy, moderate, hard = easy_s / total, moderate_s / total, hard_s / total
    if hard > TOO_HARD_SHARE:
        label = "too-hard"
    elif moderate > THRESHOLD_HEAVY_SHARE:
        label = "threshold-heavy"
    elif (hard >= POLARISED_HARD_MIN and moderate <= POLARISED_MODERATE_MAX
            and easy >= POLARISED_EASY_MIN):
        label = "polarised"
    else:
        # Everything else slopes down from a broad easy base without the clean
        # gap in the middle that makes a week polarised.
        label = "pyramidal"

    return {"easy_s": easy_s, "moderate_s": moderate_s, "hard_s": hard_s,
            "total_s": total,
            "easy": easy, "moderate": moderate, "hard": hard,
            "label": label, "verdict": verdict(label, easy, moderate, hard)}


def verdict(label, easy, moderate, hard):
    """Say what the shape means, in the terms a coach would put it in."""
    e, m, h = easy * 100.0, moderate * 100.0, hard * 100.0
    if label == "polarised":
        return ("Polarised: %.0f%% easy, %.0f%% hard, and almost nothing in between. "
                "This is the shape the evidence keeps landing on -- the easy days are "
                "easy enough to recover from, which is what lets the hard days be hard."
                % (e, h))
    if label == "threshold-heavy":
        return ("Threshold-heavy: %.0f%% of your time sits in the grey zone between "
                "easy and hard. That is the classic mistake -- too hard to recover "
                "from, too easy to force an adaptation. Slow the easy days down and "
                "let the hard days go properly hard." % m)
    if label == "too-hard":
        return ("Too hard: %.0f%% of your time at threshold or above, with only "
                "%.0f%% easy. There is nothing left to recover with. This is the "
                "shape that plateaus first and breaks second." % (h, e))
    if label == "pyramidal":
        if h <= 0.0 and m <= 0.0:
            return ("All of it easy. A fine base, and a fine block to spend a few "
                    "weeks in, but there is no stimulus here to make you faster at "
                    "the sharp end.")
        return ("Pyramidal: %.0f%% easy, tapering through %.0f%% moderate to %.0f%% "
                "hard. A broad base with a point on it -- blunter than polarised, and "
                "it works, particularly early in a build." % (e, m, h))
    return "No heart-rate time to judge this on yet."


def polarisation_index(zone_seconds):
    """Treff's polarisation index: one number for the shape. -> float or None.

    PI = log10(Z1 / Z2 * Z3 * 100) with the three bucket shares as percentages;
    above 2.0 is the published cut for polarised training. It rewards a big easy
    base and a hollowed-out middle, and it is deliberately crude -- it is a way
    to plot the shape of a block over time, not a replacement for looking at the
    three shares themselves.

    None when any bucket is empty. A week with no hard running has no polarity
    to index, and the formula would divide by zero or take the log of it.
    """
    easy_s, moderate_s, hard_s = three_buckets(zone_seconds)
    total = easy_s + moderate_s + hard_s
    if total <= 0:
        return None
    z1, z2, z3 = (100.0 * part / total for part in (easy_s, moderate_s, hard_s))
    if z1 <= 0 or z2 <= 0 or z3 <= 0:
        return None
    return math.log10(z1 / z2 * z3 * 100.0)


def _hr_per_speed(chunk):
    """Heart rate per unit of speed across a slice of (t, d, hr). None if flat.

    The heart-rate average is time-weighted for the same reason time_in_zones
    integrates: on a stream that thins out when you slow down, a plain mean of
    the rows over-weights the fast, densely sampled parts.
    """
    if len(chunk) < 2:
        return None
    span_s = chunk[-1][0] - chunk[0][0]
    span_m = chunk[-1][1] - chunk[0][1]
    if span_s <= 0 or span_m <= 0:
        return None
    weighted = sum(hr0 * (t1 - t0)
                   for (t0, _d0, hr0), (t1, _d1, _hr1) in zip(chunk, chunk[1:]))
    avg_hr = weighted / span_s
    return avg_hr / (span_m / span_s)


def decoupling(samples):
    """Aerobic decoupling across one run: % change in HR-per-speed. -> % or None.

    The number that says whether an endurance run held together. Positive means
    the second half cost more heartbeats per metre than the first, which is the
    direction heat, dehydration and plain fatigue all push it; under about 5% on
    a steady aerobic run means the aerobic system carried the whole distance.

    The run is split at its halfway point in *time*, not at its middle sample.
    With uneven sampling those are different places, and the middle sample tends
    to sit wherever the watch happened to be chatty.
    """
    pts = [p for p in _clean(samples) if p[2]]
    if len(pts) < MIN_DECOUPLING_SAMPLES:
        return None
    mid_t = (pts[0][0] + pts[-1][0]) / 2.0
    first = [p for p in pts if p[0] <= mid_t]
    second = [p for p in pts if p[0] >= mid_t]

    before, after = _hr_per_speed(first), _hr_per_speed(second)
    if not before or not after:
        return None
    return (after / before - 1.0) * 100.0
