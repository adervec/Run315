"""Why did you stop?

Every run has interruptions. A GPS trace records all of them identically, but a
red light, a water fountain and running out of legs are three different things,
and only one of them is a training signal worth acting on.

They are told apart by evidence rather than by duration alone:

  crossing    a full stop, brief, heart rate barely moves -- no time to recover
  rest        a full stop, long enough that heart rate actually comes down
  climb       still moving, but slow because the ground went up
  exhaustion  still moving, slow, heart rate stays high anyway, and the running
              after it is worse than the running before -- that is the tell
  eased       a slow patch with none of the above; not everything means something

Pure functions over stream samples. No I/O, no dependencies. See test_stops.py.

A sample is (seconds, metres, hr, lat, lon, elevation_m); everything after the
first two may be missing or None.
"""
import math

STOP_SPEED = 0.7           # m/s -- below this you are standing, not running
RUN_SPEED = 2.4            # m/s -- below this you are not running either (~6:56/km)
MIN_INTERRUPTION_S = 6.0   # shorter than this is a GPS wobble, not an event
SMOOTH_S = 7.0

CROSSING_MAX_S = 50.0      # a light cycle; longer and it was a decision
CROSSING_MAX_HR_DROP = 12.0
REST_MIN_HR_DROP = 10.0

CLIMB_GRADE = 0.04         # 4% up is enough to explain a slow patch
LATE_RUN = 0.55            # "late" starts past here, as a fraction of the run
FATIGUE_HR_SHARE = 0.88    # HR this high vs the run average while going slowly
PENALTY = 0.04             # running 4% slower afterwards than before

WINDOW_M = 250.0           # how much running either side to judge the damage
M_PER_DEG = 111320.0


def _norm(samples):
    """Sorted, distance-monotonic samples padded to (t, d, hr, lat, lon, ele)."""
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

        def at(i):
            if len(s) <= i or s[i] is None:
                return None
            try:
                v = float(s[i])
            except (TypeError, ValueError):
                return None
            return None if v != v else v

        out.append((t, d, at(2), at(3), at(4), at(5)))
    out.sort(key=lambda p: p[0])

    clean, last = [], None
    for row in out:
        d = row[1] if last is None else max(row[1], last)
        clean.append((row[0], d) + row[2:])
        last = d
    return clean


def speed_at(pts, smooth_s=SMOOTH_S):
    """[(t, d, speed_m_s, hr, lat, lon, ele)] with speed smoothed over time."""
    if len(pts) < 3:
        return []
    raw = []
    for i, row in enumerate(pts):
        a, b = pts[max(i - 1, 0)], pts[min(i + 1, len(pts) - 1)]
        dt = b[0] - a[0]
        raw.append(((b[1] - a[1]) / dt) if dt > 0 else 0.0)

    out, lo, hi = [], 0, 0
    half = smooth_s / 2.0
    for i, row in enumerate(pts):
        while lo < i and pts[lo][0] < row[0] - half:
            lo += 1
        while hi + 1 < len(pts) and pts[hi + 1][0] <= row[0] + half:
            hi += 1
        window = raw[lo:hi + 1] or [raw[i]]
        out.append((row[0], row[1], sum(window) / len(window)) + row[2:])
    return out


def _pace_over(series, i0, i1):
    """Seconds per km across a slice, or None if it covers no ground."""
    if i1 <= i0:
        return None
    dist = series[i1][1] - series[i0][1]
    secs = series[i1][0] - series[i0][0]
    return (secs / (dist / 1000.0)) if dist > 20 and secs > 0 else None


def _window_before(series, i, metres=WINDOW_M):
    j = i
    while j > 0 and series[i][1] - series[j][1] < metres:
        j -= 1
    return _pace_over(series, j, i)


def _window_after(series, i, metres=WINDOW_M):
    j = i
    while j < len(series) - 1 and series[j][1] - series[i][1] < metres:
        j += 1
    return _pace_over(series, i, j)


def _grade(series, i0, i1):
    """Rise over run across a span, as a fraction. None without elevation."""
    e0, e1 = series[i0][6], series[i1][6]
    run = series[i1][1] - series[i0][1]
    if e0 is None or e1 is None or run < 20:
        return None
    return (e1 - e0) / run


def find_interruptions(samples, min_s=MIN_INTERRUPTION_S):
    """Every stretch where the running stopped or dropped to a walk.

    -> list of dicts, each describing one interruption and the running around it.
    """
    pts = _norm(samples)
    series = speed_at(pts)
    if len(series) < 8:
        return []

    total_s = series[-1][0] - series[0][0]
    hrs = [r[3] for r in series if r[3]]
    run_hr = (sum(hrs) / len(hrs)) if hrs else None

    spans, start = [], None
    for i, row in enumerate(series):
        if row[2] < RUN_SPEED and start is None:
            start = i
        elif row[2] >= RUN_SPEED and start is not None:
            spans.append((start, i - 1))
            start = None
    if start is not None:
        spans.append((start, len(series) - 1))

    out = []
    for i0, i1 in spans:
        secs = series[i1][0] - series[i0][0]
        if secs < min_s:
            continue
        # The very start and end of a file are the warm-up walk to the door.
        if series[i0][1] < 100 or series[-1][1] - series[i1][1] < 100:
            continue

        dist = series[i1][1] - series[i0][1]
        speeds = [series[k][2] for k in range(i0, i1 + 1)]
        span_hrs = [series[k][3] for k in range(i0, i1 + 1) if series[k][3]]
        mean_speed = sum(speeds) / len(speeds)

        # Smoothing bleeds running speed into the edges of a stop, so the span's
        # mean is not stationary even when the athlete plainly was. The minimum
        # is: nothing that is still moving ever reads near zero.
        min_speed = min(speeds)
        stopped_s = 0.0
        for k in range(i0, i1):
            if series[k][2] < STOP_SPEED:
                stopped_s += series[k + 1][0] - series[k][0]
        before, after = _window_before(series, i0), _window_after(series, i1)

        out.append({
            "start_s": series[i0][0], "end_s": series[i1][0], "seconds": secs,
            "at_m": series[i0][1], "distance_m": dist,
            "mean_speed": mean_speed,
            "min_speed": min_speed,
            "stopped_s": stopped_s,
            "full_stop": min_speed < STOP_SPEED,
            "hr_in": span_hrs[0] if span_hrs else None,
            "hr_out": span_hrs[-1] if span_hrs else None,
            "hr_drop": (span_hrs[0] - min(span_hrs)) if span_hrs else None,
            "hr_mean": (sum(span_hrs) / len(span_hrs)) if span_hrs else None,
            "run_hr": run_hr,
            "pace_before": before, "pace_after": after,
            "penalty": ((after / before - 1.0) if before and after else None),
            "grade": _grade(series, i0, i1),
            "position": (series[i0][0] - series[0][0]) / total_s if total_s > 0 else 0.0,
            "lat": series[i0][4], "lon": series[i0][5],
        })
    return out


def classify(it, junction=False):
    """Label one interruption. -> (label, confidence 0-1, plain-English reason)."""
    hr_drop = it["hr_drop"]
    grade = it["grade"]
    # For a stop, judge on the time actually spent standing -- the smoothed ramp
    # either side would otherwise turn a 20 s light into a 35 s "decision".
    secs = (it.get("stopped_s") or it["seconds"]) if it["full_stop"] else it["seconds"]

    if it["full_stop"]:
        if junction and secs <= CROSSING_MAX_S * 1.5:
            return ("crossing", 0.9,
                    "Stopped dead where you often stop -- a junction, not a decision.")
        if secs <= CROSSING_MAX_S and (hr_drop is None or hr_drop <= CROSSING_MAX_HR_DROP):
            return ("crossing", 0.75,
                    "Short full stop with heart rate barely moving: a road crossing.")
        if secs > CROSSING_MAX_S and (hr_drop is None or hr_drop >= REST_MIN_HR_DROP):
            return ("rest", 0.8,
                    "Stood still long enough for heart rate to come down: a real break.")
        if secs > CROSSING_MAX_S:
            return ("rest", 0.55,
                    "A long stop, though heart rate stayed up -- a queue or a chat.")
        return ("crossing", 0.5, "Brief full stop.")

    # Still moving, just not running.
    if grade is not None and grade >= CLIMB_GRADE:
        return ("climb", 0.8,
                "Slowed on a %.0f%% climb -- the hill explains this one." % (grade * 100))

    hot = (it["hr_mean"] is not None and it["run_hr"]
           and it["hr_mean"] >= FATIGUE_HR_SHARE * it["run_hr"])
    worse = it["penalty"] is not None and it["penalty"] > PENALTY
    late = it["position"] >= LATE_RUN

    if late and hot and worse:
        return ("exhaustion", 0.85,
                "Late, heart rate still high while barely moving, and you never got "
                "the pace back: this was fatigue.")
    if late and (hot or worse):
        return ("exhaustion", 0.6,
                "Late in the run and the pace afterwards was worse -- probably fatigue.")
    if grade is not None and grade <= -CLIMB_GRADE:
        return ("eased", 0.6, "Slow patch on a descent -- most likely terrain underfoot.")
    return ("eased", 0.4, "Eased off briefly with nothing else to explain it.")


def junction_tiles(runs, min_runs=3, precision=4):
    """Places you stop on many different runs. -> set of rounded (lat, lon).

    A spot where you stop dead on run after run is a road crossing. No map data
    needed: your own history says so. `runs` is [[interruption, ...], ...].
    """
    seen = {}
    for idx, interruptions in enumerate(runs):
        here = set()
        for it in interruptions:
            if not it.get("full_stop") or it.get("lat") is None:
                continue
            here.add((round(it["lat"], precision), round(it["lon"], precision)))
        for cell in here:
            seen.setdefault(cell, set()).add(idx)
    return {cell for cell, hits in seen.items() if len(hits) >= min_runs}


def analyse(samples, junctions=None):
    """Classify every interruption in one run and summarise them. -> dict or None."""
    found = find_interruptions(samples)
    if not found:
        return None
    junctions = junctions or set()

    labelled = []
    for it in found:
        near = (it["lat"] is not None
                and (round(it["lat"], 4), round(it["lon"], 4)) in junctions)
        label, confidence, reason = classify(it, junction=near)
        row = dict(it)
        row.update(label=label, confidence=confidence, reason=reason, junction=near)
        labelled.append(row)

    counts = {}
    for row in labelled:
        counts[row["label"]] = counts.get(row["label"], 0) + 1
    lost = sum(r["seconds"] for r in labelled)
    fatigue = [r for r in labelled if r["label"] == "exhaustion"]

    return {
        "interruptions": labelled,
        "count": len(labelled),
        "counts": counts,
        "lost_s": lost,
        "stopped_s": sum(r.get("stopped_s") or 0.0 for r in labelled),
        "fatigue_count": len(fatigue),
        "first_fatigue_m": min((r["at_m"] for r in fatigue), default=None),
        "verdict": verdict(counts, labelled),
    }


def verdict(counts, rows):
    """One line summing the run up, in the terms a runner would use."""
    if not rows:
        return None
    fatigue = counts.get("exhaustion", 0)
    if fatigue >= 3:
        return "You came apart in the back half -- %d fatigue breaks." % fatigue
    if fatigue:
        return "Mostly held together, with %d fatigue break%s late on." % (
            fatigue, "" if fatigue == 1 else "s")
    if counts.get("rest"):
        return "Clean running either side of %d deliberate stop%s." % (
            counts["rest"], "" if counts["rest"] == 1 else "s")
    if counts.get("crossing"):
        return "Only traffic broke this one up -- %d crossing%s, no fade." % (
            counts["crossing"], "" if counts["crossing"] == 1 else "s")
    if counts.get("climb"):
        return "The only slow patches were climbs."
    return "A few easy patches, nothing that reads as fatigue."
