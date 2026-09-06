"""Track and interval analysis: find the reps inside a run.

Garmin only records laps if the athlete remembered to press the button, and on a
track nobody presses it for the recovery. So the reps are recovered from the pace
stream instead: an interval session is bimodal -- hard bits and jog bits -- and
the split between them is found rather than assumed.

Pure functions over stream samples. No I/O, no dependencies. See
test_intervals.py.

A sample is (seconds, cumulative_metres, hr_or_None) or any longer tuple whose
first three entries are those; extra fields (lat, lon) are ignored.
"""
import math

# What counts as a rep. Anything briefer is a traffic light or a GPS wobble.
MIN_REP_S = 18.0
MIN_REP_M = 120.0
MERGE_GAP_S = 6.0          # two "reps" this close are one rep with a glitch
SMOOTH_S = 9.0             # pace smoothing window; shorter and GPS noise wins

# A run only counts as intervals if the hard bits are genuinely a different gear.
MIN_SPEED_RATIO = 1.15     # fast cluster this much faster than the jog
MIN_PACE_GAP_S = 25.0      # ...and at least this many seconds per km quicker

# Standing still is not a recovery jog. Traffic lights make any steady run look
# bimodal, so stationary samples are kept out of the clustering entirely.
# ponytail: this also means a session run with standing recoveries will not be
# detected. Jog recoveries are the common case; revisit by treating long stops
# as rep separators if that stops being true.
STANDING_SPEED = 0.8

# In a real session the reps are a minority of the running -- roughly half, with
# recovery in between. A long run with one walk break is 95% "fast", which is how
# you tell the two apart.
MAX_FAST_SHARE = 0.80

# Standard track and road rep distances, in metres. A GPS lap of a 400 m oval
# routinely measures 385-415, so measured distances get snapped to these.
TRACK_DISTANCES = (100, 200, 300, 400, 600, 800, 1000, 1200, 1600, 2000, 3000, 5000)
SNAP_TOLERANCE = 0.08      # within 8% of a standard distance counts as that rep

# A 400 m oval and its infield fit inside about 180 x 100 m.
TRACK_BBOX_M = 260.0
TRACK_LOOP_RATIO = 6.0     # distance run over bbox diagonal: high means laps


def _clean(samples):
    """Sorted (t, d, hr) with monotonic distance and no junk."""
    out = []
    for s in samples:
        if not s or len(s) < 2:
            continue
        t, d = s[0], s[1]
        if t is None or d is None:
            continue
        try:
            t, d = float(t), float(d)
        except (TypeError, ValueError):
            continue
        if t != t or d != d:          # NaN
            continue
        hr = s[2] if len(s) > 2 else None
        out.append((t, d, float(hr) if hr else None))
    out.sort(key=lambda p: p[0])

    clean, last_d = [], None
    for t, d, hr in out:
        if last_d is not None and d < last_d:
            d = last_d                # GPS distance never goes backwards
        clean.append((t, d, hr))
        last_d = d
    return clean


def speed_series(samples, smooth_s=SMOOTH_S):
    """[(t, d, speed_m_s, hr)] with speed smoothed over `smooth_s`.

    Central differences, then a time-windowed mean. Raw GPS speed is far too
    noisy to threshold directly -- a single bad fix would split a rep in two.
    """
    pts = _clean(samples)
    if len(pts) < 3:
        return []

    raw = []
    for i, (t, d, hr) in enumerate(pts):
        a = pts[max(i - 1, 0)]
        b = pts[min(i + 1, len(pts) - 1)]
        dt = b[0] - a[0]
        raw.append((t, d, ((b[1] - a[1]) / dt) if dt > 0 else 0.0, hr))

    # Windowed mean over a moving index range; the stream is time-ordered so the
    # window edges only ever move forward.
    out, lo, hi = [], 0, 0
    half = smooth_s / 2.0
    for i, (t, d, _sp, hr) in enumerate(raw):
        while lo < i and raw[lo][0] < t - half:
            lo += 1
        while hi + 1 < len(raw) and raw[hi + 1][0] <= t + half:
            hi += 1
        window = raw[lo:hi + 1] or [raw[i]]
        out.append((t, d, sum(w[2] for w in window) / len(window), hr))
    return out


def otsu_threshold(values, bins=64):
    """The split that best separates two clusters. None if there is only one.

    Otsu's method: pick the cut maximising between-class variance. It needs no
    tuning, which matters because a 400 m rep session and a fartlek have very
    different "fast".
    """
    vals = [v for v in values if v is not None]
    if len(vals) < 4:
        return None
    lo, hi = min(vals), max(vals)
    if hi - lo < 1e-9:
        return None

    hist = [0] * bins
    for v in vals:
        hist[min(int((v - lo) / (hi - lo) * bins), bins - 1)] += 1
    total = len(vals)
    grand = sum((i + 0.5) * hist[i] for i in range(bins))

    best_var, best_cut, w0, sum0 = -1.0, None, 0, 0.0
    for i in range(bins):
        w0 += hist[i]
        if w0 == 0:
            continue
        w1 = total - w0
        if w1 == 0:
            break
        sum0 += (i + 0.5) * hist[i]
        between = w0 * w1 * (sum0 / w0 - (grand - sum0) / w1) ** 2
        if between > best_var:
            best_var, best_cut = between, lo + (i + 1) / bins * (hi - lo)
    return best_cut


def separation(values, cut):
    """How far apart the two clusters either side of `cut` really are.

    -> (fast_mean, slow_mean, ratio), or None if either side is empty.

    Otsu always returns *a* threshold, including for a steady run where there is
    nothing to separate. Without this check a hilly easy hour gets chopped into
    twenty imaginary reps.
    """
    fast = [v for v in values if v is not None and v >= cut]
    slow = [v for v in values if v is not None and v < cut]
    if not fast or not slow:
        return None
    fm, sm = sum(fast) / len(fast), sum(slow) / len(slow)
    if sm <= 0:
        return None
    return (fm, sm, fm / sm)


def is_interval_shaped(values, cut):
    """True when the pace really is bimodal, not just noisy.

    Both tests have to pass: the hard bits must be proportionally faster *and*
    faster by an amount a runner would notice.
    """
    sep = separation(values, cut)
    if not sep:
        return False
    fast, slow, ratio = sep
    if ratio < MIN_SPEED_RATIO:
        return False
    share = sum(1 for v in values if v is not None and v >= cut) / float(len(values))
    if share > MAX_FAST_SHARE:
        return False                              # one slow patch, not a session
    pace_gap = 1000.0 / slow - 1000.0 / fast      # seconds per km
    return pace_gap >= MIN_PACE_GAP_S


def snap_distance(metres):
    """Nearest standard rep distance, or None if it is not close to one."""
    if not metres or metres <= 0:
        return None
    best = min(TRACK_DISTANCES, key=lambda d: abs(d - metres))
    return best if abs(best - metres) / best <= SNAP_TOLERANCE else None


def detect_reps(samples, min_rep_s=MIN_REP_S, min_rep_m=MIN_REP_M,
                merge_gap_s=MERGE_GAP_S):
    """Find the work intervals in a run. -> list of rep dicts.

    Each rep carries its own numbers plus the recovery that followed it, which is
    the half of a session people actually argue about.
    """
    series = speed_series(samples)
    if len(series) < 8:
        return []
    # Exclude standing samples *and* the smoothed ramp either side of them. The
    # ramp is an artefact of the smoothing window, not running, and on its own it
    # is enough to fake a slow cluster and turn every red light into a rep.
    blocked = [False] * len(series)
    for i, row in enumerate(series):
        if row[2] >= STANDING_SPEED:
            continue
        j = i
        while j >= 0 and row[0] - series[j][0] <= SMOOTH_S:
            blocked[j] = True
            j -= 1
        j = i
        while j < len(series) and series[j][0] - row[0] <= SMOOTH_S:
            blocked[j] = True
            j += 1

    moving = [series[i][2] for i in range(len(series)) if not blocked[i]]
    cut = otsu_threshold(moving)
    if cut is None or not is_interval_shaped(moving, cut):
        return []

    # Contiguous stretches above the cut.
    spans, start = [], None
    for i, (t, _d, sp, _hr) in enumerate(series):
        if sp >= cut and start is None:
            start = i
        elif sp < cut and start is not None:
            spans.append((start, i - 1))
            start = None
    if start is not None:
        spans.append((start, len(series) - 1))

    # A dropped fix mid-rep splits it; stitch those back together.
    merged = []
    for span in spans:
        if merged and series[span[0]][0] - series[merged[-1][1]][0] <= merge_gap_s:
            merged[-1] = (merged[-1][0], span[1])
        else:
            merged.append(span)

    reps = []
    for i0, i1 in merged:
        t0, d0 = series[i0][0], series[i0][1]
        t1, d1 = series[i1][0], series[i1][1]
        secs, dist = t1 - t0, d1 - d0
        if secs < min_rep_s or dist < min_rep_m:
            continue
        hrs = [s[3] for s in series[i0:i1 + 1] if s[3]]
        reps.append({
            "start_s": t0, "end_s": t1,
            "seconds": secs, "distance_m": dist,
            "pace": secs / (dist / 1000.0),
            "speed": dist / secs,
            "avg_hr": (sum(hrs) / len(hrs)) if hrs else None,
            "snapped_m": snap_distance(dist),
            "recovery_s": None, "recovery_m": None,
        })

    for a, b in zip(reps, reps[1:]):
        a["recovery_s"] = b["start_s"] - a["end_s"]
        a["recovery_m"] = None
    # Recovery distance needs the stream again, so fill it in one pass.
    for a, b in zip(reps, reps[1:]):
        span = [s for s in series if a["end_s"] <= s[0] <= b["start_s"]]
        if len(span) > 1:
            a["recovery_m"] = span[-1][1] - span[0][1]

    for n, rep in enumerate(reps, 1):
        rep["n"] = n
    return reps


def consistency(reps):
    """Coefficient of variation of rep pace. 0 means metronomic. None if < 2."""
    paces = [r["pace"] for r in reps if r.get("pace")]
    if len(paces) < 2:
        return None
    mean = sum(paces) / len(paces)
    if mean <= 0:
        return None
    var = sum((p - mean) ** 2 for p in paces) / len(paces)
    return math.sqrt(var) / mean


def fade(reps):
    """How much the second half of the set slowed relative to the first, as a
    fraction. Positive means you faded; negative means you negative-split it."""
    paces = [r["pace"] for r in reps if r.get("pace")]
    if len(paces) < 4:
        return None
    half = len(paces) // 2
    first = sum(paces[:half]) / half
    second = sum(paces[-half:]) / half
    return (second / first - 1.0) if first > 0 else None


def looks_like_track(points):
    """Was this run done on a 400 m oval? -> (bool, bbox_diagonal_m).

    A track session covers a lot of distance inside a very small box. That ratio
    separates it from a road loop far more reliably than distance alone.
    """
    coords = [(p[0], p[1]) for p in points
              if p and len(p) >= 2 and p[0] is not None and p[1] is not None]
    if len(coords) < 20:
        return (False, None)
    lats = [c[0] for c in coords]
    lons = [c[1] for c in coords]
    mid = math.radians(sum(lats) / len(lats))
    dy = (max(lats) - min(lats)) * 111320.0
    dx = (max(lons) - min(lons)) * 111320.0 * math.cos(mid)
    diag = math.hypot(dx, dy)
    if diag <= 0:
        return (False, diag)

    run = 0.0
    for a, b in zip(coords, coords[1:]):
        run += math.hypot((b[0] - a[0]) * 111320.0,
                          (b[1] - a[1]) * 111320.0 * math.cos(mid))
    return (diag <= TRACK_BBOX_M and run / diag >= TRACK_LOOP_RATIO, diag)


def describe(reps):
    """A one-line name for the session, the way a coach would write it.

    "8 x 400 m" when the set is uniform, "6 reps, 400-1000 m" when it is not.
    """
    if not reps:
        return None
    snapped = [r["snapped_m"] for r in reps]
    if all(s is not None for s in snapped) and len(set(snapped)) == 1:
        return "%d x %d m" % (len(reps), snapped[0])
    known = [s for s in snapped if s is not None]
    if len(known) == len(reps) and known:
        return "%d reps, %d-%d m" % (len(reps), min(known), max(known))
    lo = min(r["distance_m"] for r in reps)
    hi = max(r["distance_m"] for r in reps)
    if abs(hi - lo) / max(hi, 1.0) < 0.1:
        return "%d x ~%d m" % (len(reps), round((lo + hi) / 2 / 10) * 10)
    return "%d reps, %d-%d m" % (len(reps), round(lo), round(hi))


def analyse(samples, points=None):
    """Full session analysis. -> dict, or None when there is no rep structure."""
    reps = detect_reps(samples)
    if len(reps) < 2:
        return None
    on_track, diag = looks_like_track(points or [])
    work_s = sum(r["seconds"] for r in reps)
    work_m = sum(r["distance_m"] for r in reps)
    recoveries = [r["recovery_s"] for r in reps if r["recovery_s"]]
    return {
        "reps": reps,
        "count": len(reps),
        "name": describe(reps),
        "work_s": work_s,
        "work_m": work_m,
        "avg_pace": work_s / (work_m / 1000.0) if work_m else None,
        "fastest": min(r["pace"] for r in reps),
        "slowest": max(r["pace"] for r in reps),
        "consistency": consistency(reps),
        "fade": fade(reps),
        "avg_recovery_s": (sum(recoveries) / len(recoveries)) if recoveries else None,
        "on_track": on_track,
        "bbox_m": diag,
        "uniform": len({r["snapped_m"] for r in reps}) == 1
                   and reps[0]["snapped_m"] is not None,
    }
