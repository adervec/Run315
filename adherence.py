"""Did you actually do the plan?

A plan generator that never looks back is a horoscope. It produces a tidy table
of what you ought to do, the athlete does something else, and nobody finds out
until the race.

This closes that loop. It compares the plan week by week against what was really
run, and reports the thing that matters -- not a compliance percentage, but
*which way* you drifted, because the two directions mean opposite things:

  * consistently under the plan: the plan was too much, or life was. Either way
    the projections built on it are optimistic.
  * consistently over the plan: the plan is not the thing governing your
    training, and the easy weeks it prescribes are the ones being skipped.

Missing a session is normal. The literature on training plans is mostly a
literature on people not finishing them. What is worth flagging is a *pattern*,
so nothing here complains about a single week.

Deliberately not built: a streak, a compliance grade, or anything that rewards
hitting a number on a week you should have rested. The readiness read exists
precisely to override the plan, and a scoring system that punishes you for
listening to it would be working against the rest of the app.

Pure functions. No I/O, no dependencies. See test_adherence.py.
"""
from datetime import timedelta

# How far off a week's target still counts as having done it. Training is not
# surgery, and a plan hit to within a tenth is a plan followed.
ON_TARGET = 0.10
# Below or above this, the week is not a near miss -- it is a different week.
WAY_OFF = 0.30
# A pattern needs this many weeks before it is worth naming.
MIN_WEEKS = 3
# What share of weeks have to lean the same way to count as a drift.
DRIFT_SHARE = 0.60


def week_bounds(start_date, index):
    """The Monday-to-Sunday span of plan week `index` (0-based)."""
    monday = start_date - timedelta(days=start_date.weekday())
    begin = monday + timedelta(days=7 * index)
    return begin, begin + timedelta(days=6)


def actual_week(activities, begin, end):
    """What was really run in one week. -> dict."""
    inside = []
    for a in activities:
        when = a.get("start")
        if when is None:
            continue
        day = when.date() if hasattr(when, "date") else when
        if begin <= day <= end:
            inside.append(a)
    distance = sum(a.get("distance_m") or 0.0 for a in inside)
    longest = max((a.get("distance_m") or 0.0 for a in inside), default=0.0)
    return {"distance_m": distance, "longest_m": longest, "runs": len(inside)}


def compare_week(planned, actual):
    """One planned week against one real one. -> dict.

    `planned` is a row from plan.build(); `actual` from actual_week().
    """
    target = planned.get("distance_m") or 0.0
    done = actual["distance_m"]
    if target <= 0:
        return None
    share = done / target
    if abs(share - 1.0) <= ON_TARGET:
        verdict = "on target"
    elif share < 1.0 - WAY_OFF:
        verdict = "well under"
    elif share < 1.0:
        verdict = "under"
    elif share > 1.0 + WAY_OFF:
        verdict = "well over"
    else:
        verdict = "over"

    long_target = planned.get("long_run_m") or 0.0
    long_done = actual["longest_m"]
    return {
        "week": planned.get("week"),
        "phase": planned.get("phase"),
        "easy_week": planned.get("easy_week"),
        "planned_m": target,
        "actual_m": done,
        "share": share,
        "verdict": verdict,
        "runs": actual["runs"],
        "long_planned_m": long_target,
        "long_actual_m": long_done,
        "long_share": (long_done / long_target) if long_target > 0 else None,
        "long_done": bool(long_target and long_done >= long_target * (1.0 - ON_TARGET)),
    }


def review(plan, activities, start_date, today=None):
    """The whole plan against the whole record. -> dict|None.

    Only weeks that have already finished are judged. A week still in progress is
    not a week you failed.
    """
    if not plan or not start_date:
        return None
    rows = []
    for index, planned in enumerate(plan):
        begin, end = week_bounds(start_date, index)
        if today and end >= today:
            break                      # not finished yet, so not judged
        row = compare_week(planned, actual_week(activities, begin, end))
        if row:
            row["begin"], row["end"] = begin, end
            rows.append(row)
    if not rows:
        return None

    planned_total = sum(r["planned_m"] for r in rows)
    actual_total = sum(r["actual_m"] for r in rows)
    on = [r for r in rows if r["verdict"] == "on target"]
    under = [r for r in rows if r["verdict"] in ("under", "well under")]
    over = [r for r in rows if r["verdict"] in ("over", "well over")]
    long_runs = [r for r in rows if r["long_planned_m"]]

    return {
        "weeks": len(rows),
        "rows": rows,
        "planned_m": planned_total,
        "actual_m": actual_total,
        "share": (actual_total / planned_total) if planned_total else None,
        "on_target": len(on),
        "under": len(under),
        "over": len(over),
        "long_runs_done": sum(1 for r in long_runs if r["long_done"]),
        "long_runs_planned": len(long_runs),
        "drift": _drift(rows),
        "note": _note(rows, actual_total, planned_total),
    }


def _drift(rows):
    """Which way the athlete leans, if consistently. -> str|None."""
    if len(rows) < MIN_WEEKS:
        return None
    under = sum(1 for r in rows if r["verdict"] in ("under", "well under"))
    over = sum(1 for r in rows if r["verdict"] in ("over", "well over"))
    if under >= len(rows) * DRIFT_SHARE:
        return "under"
    if over >= len(rows) * DRIFT_SHARE:
        return "over"
    return None


def _note(rows, actual_total, planned_total):
    """The sentence worth reading, which depends on the direction."""
    if len(rows) < MIN_WEEKS:
        return ("Too early in the block to see a pattern -- one week either way "
                "is just a week.")
    drift = _drift(rows)
    share = (actual_total / planned_total) if planned_total else 1.0

    if drift == "under":
        return ("You are running %.0f%% of what the plan asks, most weeks. That "
                "is worth taking seriously in the other direction: the race "
                "projections assume the training in the plan, so either the plan "
                "needs to come down to meet you, or they are optimistic."
                % (share * 100))
    if drift == "over":
        skipped = [r for r in rows if r["easy_week"] and r["share"] > 1.0 + ON_TARGET]
        tail = ""
        if skipped:
            tail = (" %d of the easy weeks were run through, which is the part "
                    "that costs you later." % len(skipped))
        return ("You are running %.0f%% of the plan, most weeks over rather than "
                "under.%s" % (share * 100, tail))
    on_target = sum(1 for r in rows if r["verdict"] == "on target")
    if on_target >= len(rows) * DRIFT_SHARE:
        return ("You are tracking the plan closely -- within a tenth on most "
                "weeks, which is as close as anyone follows a schedule.")
    # Neither a consistent drift nor consistent accuracy: the weeks disagree
    # with each other, which is its own finding and should not be dressed up as
    # either success or failure.
    return ("Your weeks land on both sides of the plan rather than drifting one "
            "way -- %d of %d on target, and the rest split. The totals come out "
            "at %.0f%%, so the volume is roughly right and the week-to-week "
            "shape is not." % (on_target, len(rows), share * 100))


def next_session(plan, start_date, today):
    """The week the athlete is in now, and what it asks for. -> dict|None."""
    if not plan or not start_date or not today:
        return None
    for index, planned in enumerate(plan):
        begin, end = week_bounds(start_date, index)
        if begin <= today <= end:
            out = dict(planned)
            out["begin"], out["end"] = begin, end
            out["days_left"] = (end - today).days + 1
            return out
    return None
