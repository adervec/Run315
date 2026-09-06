"""Racing a course, not a distance.

Two jobs, either side of the day:

  strategy    given the course and a target time, what should each kilometre
              take? Even *pace* is the wrong answer on a hilly course; even
              *effort* is the right one, and they are not the same plan.
  postmortem  given what you actually ran, where did the time go, and was it
              the hills, the heat or going out too hard?

The gradient model is Minetti's energy cost of running (2002): the metabolic
cost per metre as a polynomial in gradient. Cost relative to flat gives the pace
multiplier, which is the basis every grade-adjusted pace uses.

Pure functions. No I/O, no dependencies. See test_racecraft.py.
"""
import math

EARTH_R = 6371000.0

# Minetti et al. 2002, J/kg/m. Flat is 3.6.
_MINETTI = (155.4, -30.4, -43.3, 46.3, 19.5, 3.6)
FLAT_COST = 3.6

# The polynomial was fitted between -45% and +45%, and it keeps getting cheaper
# down to about -20%, which would have you running a steep descent twice as fast
# as the flat. Nobody does: you brake, and your quads pay for it. So the benefit
# is floored.
# ponytail: a flat floor, not a braking model. Fit the floor per athlete from
# their own downhill splits if this ever needs to be better.
MIN_RATIO = 0.80
MAX_RATIO = 3.00
GRADE_LIMIT = 0.30

CLIMB_GRADE = 0.03          # what counts as a hill worth naming
CLIMB_MIN_M = 200.0         # ...and long enough to matter


def haversine(a, b):
    """Metres between two (lat, lon) points."""
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2)
    return 2 * EARTH_R * math.asin(min(1.0, math.sqrt(h)))


def cost_ratio(grade):
    """How much more a metre costs at this gradient than on the flat."""
    if grade is None:
        return 1.0
    g = max(-GRADE_LIMIT, min(GRADE_LIMIT, float(grade)))
    cost = 0.0
    for coefficient in _MINETTI:
        cost = cost * g + coefficient
    return max(MIN_RATIO, min(MAX_RATIO, cost / FLAT_COST))


def grade_adjusted_pace(pace_s_per_km, grade):
    """What a hill pace is worth on the flat. Lower is better, as always."""
    if not pace_s_per_km:
        return None
    return pace_s_per_km / cost_ratio(grade)


def clean_course(points):
    """[(lat, lon, ele_or_None)] with junk dropped."""
    out = []
    for p in points or []:
        if not p or len(p) < 2:
            continue
        try:
            lat, lon = float(p[0]), float(p[1])
        except (TypeError, ValueError):
            continue
        if lat != lat or lon != lon:
            continue
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            continue
        ele = None
        if len(p) > 2 and p[2] is not None:
            try:
                ele = float(p[2])
                if ele != ele:
                    ele = None
            except (TypeError, ValueError):
                ele = None
        out.append((lat, lon, ele))
    return out


def smooth_elevation(points, window_m=100.0):
    """Elevation smoothed over distance.

    Raw barometric and GPS elevation is noisy enough that a flat road can read as
    a series of 5% ramps, which would wreck every gradient below.
    """
    pts = clean_course(points)
    if not pts:
        return []
    cum, total = [0.0], 0.0
    for a, b in zip(pts, pts[1:]):
        total += haversine(a, b)
        cum.append(total)

    out, lo, hi = [], 0, 0
    half = window_m / 2.0
    for i, p in enumerate(pts):
        while lo < i and cum[i] - cum[lo] > half:
            lo += 1
        while hi + 1 < len(pts) and cum[hi + 1] - cum[i] <= half:
            hi += 1
        window = [pts[k][2] for k in range(lo, hi + 1) if pts[k][2] is not None]
        ele = (sum(window) / len(window)) if window else None
        out.append((p[0], p[1], ele, cum[i]))
    return out


def segment_course(points, step_m=1000.0):
    """Split a course into even chunks. -> [dict] with distance, climb, grade.

    The last chunk is whatever is left, so a marathon ends with a 195 m segment
    rather than pretending the course is a round number.
    """
    pts = smooth_elevation(points)
    if len(pts) < 2 or step_m <= 0:
        return []
    total = pts[-1][3]

    segments, start_i, n = [], 0, 1
    while start_i < len(pts) - 1:
        edge = min(n * step_m, total)
        end_i = start_i
        while end_i < len(pts) - 1 and pts[end_i][3] < edge:
            end_i += 1
        if end_i <= start_i:
            break

        span = pts[end_i][3] - pts[start_i][3]
        up = down = 0.0
        for a, b in zip(pts[start_i:end_i], pts[start_i + 1:end_i + 1]):
            if a[2] is None or b[2] is None:
                continue
            delta = b[2] - a[2]
            if delta > 0:
                up += delta
            else:
                down -= delta
        e0, e1 = pts[start_i][2], pts[end_i][2]
        grade = ((e1 - e0) / span) if (e0 is not None and e1 is not None and span > 0) else None

        segments.append({
            "n": n,
            "from_m": pts[start_i][3], "to_m": pts[end_i][3],
            "distance_m": span,
            "climb_m": up, "drop_m": down,
            "grade": grade,
            "cost": cost_ratio(grade),
            "lat": pts[start_i][0], "lon": pts[start_i][1],
        })
        start_i, n = end_i, n + 1
        if edge >= total:
            break
    return segments


def course_stats(points):
    """Headline numbers for a course."""
    segments = segment_course(points)
    if not segments:
        return None
    climb = sum(s["climb_m"] for s in segments)
    drop = sum(s["drop_m"] for s in segments)
    length = segments[-1]["to_m"]
    graded = [s for s in segments if s["grade"] is not None]
    return {
        "length_m": length,
        "climb_m": climb,
        "drop_m": drop,
        "segments": segments,
        "steepest": max(graded, key=lambda s: s["grade"], default=None),
        "has_elevation": bool(graded),
        # Effort cost of the whole course against the same distance on the flat.
        "difficulty": (sum(s["distance_m"] * s["cost"] for s in segments) / length)
                      if length else 1.0,
    }


def pace_plan(segments, target_s, negative_split=0.01):
    """Per-segment targets that spend even effort and total the target time.

    Even pace up a hill means uneven effort, and uneven effort is how people
    blow up. So each segment's pace is scaled by what its gradient costs, then
    the whole plan is normalised to land exactly on the target.
    """
    if not segments or not target_s or target_s <= 0:
        return []
    total_m = sum(s["distance_m"] for s in segments)
    if total_m <= 0:
        return []
    half = total_m / 2.0

    # Weight = how much of the target this segment deserves.
    weights, seen = [], 0.0
    for s in segments:
        mid = seen + s["distance_m"] / 2.0
        bias = (1 + negative_split) if mid < half else (1 - negative_split)
        weights.append(s["distance_m"] * s["cost"] * bias)
        seen += s["distance_m"]

    scale = target_s / sum(weights)
    plan, cumulative = [], 0.0
    for s, w in zip(segments, weights):
        secs = w * scale
        cumulative += secs
        km = s["distance_m"] / 1000.0
        plan.append(dict(s,
                         target_s=secs,
                         target_pace=(secs / km) if km > 0 else None,
                         cumulative_s=cumulative))
    return plan


def hard_sections(segments, grade=CLIMB_GRADE, min_m=CLIMB_MIN_M):
    """Contiguous climbs worth warning about. -> [dict] longest first."""
    out, run = [], []
    for s in segments:
        if s["grade"] is not None and s["grade"] >= grade:
            run.append(s)
            continue
        if run:
            out.append(run)
            run = []
    if run:
        out.append(run)

    sections = []
    for group in out:
        span = sum(s["distance_m"] for s in group)
        if span < min_m:
            continue
        climb = sum(s["climb_m"] for s in group)
        sections.append({
            "from_m": group[0]["from_m"], "to_m": group[-1]["to_m"],
            "distance_m": span, "climb_m": climb,
            "grade": (climb / span) if span else 0.0,
            "segments": [s["n"] for s in group],
        })
    sections.sort(key=lambda s: -s["climb_m"])
    return sections


# --------------------------------------------------------------------------- #
# after the race
# --------------------------------------------------------------------------- #
def actual_segments(samples, step_m=1000.0):
    """Per-segment splits from a run's stream. -> [dict] matching segment_course."""
    pts = []
    for s in samples or []:
        if not s or len(s) < 2 or s[0] is None or s[1] is None:
            continue
        try:
            t, d = float(s[0]), float(s[1])
        except (TypeError, ValueError):
            continue
        hr = s[2] if len(s) > 2 else None
        ele = s[5] if len(s) > 5 else None
        pts.append((t, d, hr, ele))
    if len(pts) < 2:
        return []
    pts.sort()

    total = pts[-1][1] - pts[0][1]
    out, i, n = [], 0, 1
    while i < len(pts) - 1:
        edge = min(n * step_m, total)
        j = i
        while j < len(pts) - 1 and (pts[j][1] - pts[0][1]) < edge:
            j += 1
        if j <= i:
            break
        span = pts[j][1] - pts[i][1]
        secs = pts[j][0] - pts[i][0]
        hrs = [p[2] for p in pts[i:j + 1] if p[2]]
        e0, e1 = pts[i][3], pts[j][3]
        grade = ((e1 - e0) / span) if (e0 is not None and e1 is not None and span > 0) else None
        if span > 0 and secs > 0:
            out.append({
                "n": n,
                "from_m": pts[i][1] - pts[0][1], "to_m": pts[j][1] - pts[0][1],
                "distance_m": span, "seconds": secs,
                "pace": secs / (span / 1000.0),
                "avg_hr": (sum(hrs) / len(hrs)) if hrs else None,
                "grade": grade,
                "gap": grade_adjusted_pace(secs / (span / 1000.0), grade),
            })
        i, n = j, n + 1
        if edge >= total:
            break
    return out


def compare(plan, actual):
    """Line the plan up against what happened. -> [dict] per segment."""
    out = []
    for i, act in enumerate(actual):
        want = plan[i] if i < len(plan) else None
        delta = (act["seconds"] - want["target_s"]) if want else None
        out.append({
            "n": act["n"],
            "from_m": act["from_m"], "to_m": act["to_m"],
            "target_s": want["target_s"] if want else None,
            "target_pace": want["target_pace"] if want else None,
            "seconds": act["seconds"], "pace": act["pace"],
            "delta_s": delta,
            "avg_hr": act["avg_hr"], "grade": act["grade"], "gap": act["gap"],
        })
    return out


def postmortem(plan, actual, target_s=None):
    """What the race actually did, and the honest reason. -> dict or None."""
    if not actual:
        return None
    rows = compare(plan or [], actual)
    total = sum(a["seconds"] for a in actual)
    planned = sum(p["target_s"] for p in plan) if plan else None

    paced = [r for r in rows if r["delta_s"] is not None]
    lost = sum(r["delta_s"] for r in paced if r["delta_s"] > 0)
    gained = -sum(r["delta_s"] for r in paced if r["delta_s"] < 0)
    worst = max(paced, key=lambda r: r["delta_s"], default=None)

    # Equal counts either side, and mean pace rather than summed time: an odd
    # number of kilometres would otherwise compare two against three and report
    # a perfectly even race as a 50% fade.
    paces = [a["pace"] for a in actual if a.get("pace")]
    fade = None
    if len(paces) >= 2:
        h = len(paces) // 2
        early = sum(paces[:h]) / h
        late = sum(paces[-h:]) / h
        fade = (late / early - 1.0) if early > 0 else None

    # Effort, not pace: on a hilly course the two tell different stories.
    gaps = [a["gap"] for a in actual if a["gap"]]
    gap_fade = None
    if len(gaps) >= 4:
        h = len(gaps) // 2
        early = sum(gaps[:h]) / h
        late = sum(gaps[-h:]) / h
        gap_fade = (late / early - 1.0) if early > 0 else None

    hrs = [a["avg_hr"] for a in actual if a["avg_hr"]]
    hr_drift = None
    if len(hrs) >= 4:
        h = len(hrs) // 2
        hr_drift = (sum(hrs[-h:]) / h) - (sum(hrs[:h]) / h)

    # Where the climbs were, so a slow split on a hill is not called a blow-up.
    uphill = [a for a in actual if a["grade"] is not None and a["grade"] >= CLIMB_GRADE]
    uphill_loss = sum(r["delta_s"] for r in paced
                      if r["grade"] is not None and r["grade"] >= CLIMB_GRADE
                      and r["delta_s"] > 0)

    return {
        "rows": rows,
        "total_s": total,
        "planned_s": planned,
        "delta_s": (total - planned) if planned else None,
        "target_s": target_s,
        "vs_target_s": (total - target_s) if target_s else None,
        "lost_s": lost, "gained_s": gained,
        "worst": worst,
        "fade": fade, "gap_fade": gap_fade,
        "hr_drift": hr_drift,
        "uphill_segments": len(uphill),
        "uphill_loss_s": uphill_loss,
        "verdict": verdict(fade, gap_fade, lost, uphill_loss, hr_drift),
    }


def verdict(fade, gap_fade, lost_s, uphill_loss_s, hr_drift):
    """One line on how the race was run."""
    if fade is None:
        return "Not enough of the race recorded to judge how it was run."
    if fade > 0.06:
        if gap_fade is not None and gap_fade < fade - 0.03:
            return ("You slowed a long way, but the course did most of it -- on "
                    "effort you held together better than the splits suggest.")
        if hr_drift is not None and hr_drift < 3:
            return ("Second half %.0f%% slower with heart rate flat: the legs went "
                    "before the engine did." % (fade * 100))
        return ("Second half %.0f%% slower. You went out too hard."
                % (fade * 100))
    if lost_s and uphill_loss_s >= 0.6 * lost_s:
        return "Paced it well; almost all the lost time was on the climbs."
    if fade < -0.02:
        return "Negative split. Exactly how it is supposed to be done."
    return "Evenly run, start to finish."
