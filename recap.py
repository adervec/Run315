"""A career, rather than a rolling twelve-week window.

Every training app forgets. Fitness is a 42-day average, form is a 7-day one, and
the dashboard resets every January. That is the right way to answer "am I ready
for Saturday" and the wrong way to answer "what have I actually done".

Taiwan's 馬拉松普查 -- a civilian-run national marathon census, started by one
veteran runner -- keeps a lifetime ledger instead, with awards at 10, 30, 60, 100
marathons and beyond, and a published, argued-over standard for what counts as
one. That is a completely different relationship to your own history, and no
Western app offers anything like it.

Two things here:

  * **The year.** What you did, against what you did the year before -- the same
    comparison, honestly made, rather than a highlight reel.
  * **The career.** Cumulative distance, time and races, with the next milestone
    named so it is something to walk towards.

Streaks are deliberately counted in weeks rather than days. A daily run streak
rewards running on days you should not, which is a mechanic this app declines to
build; a week with a run in it is a habit rather than a compulsion.

Pure functions. No I/O, no dependencies. See test_recap.py.
"""
from datetime import date, timedelta

# Career milestones. Distance in kilometres, races as a count -- both chosen to
# be reachable rather than aspirational, which is the point of a ladder.
DISTANCE_TIERS_KM = (100, 500, 1000, 2500, 5000, 10000, 25000, 50000)
RACE_TIERS = (1, 5, 10, 25, 50, 100, 200, 500)
# The earth's circumference, because at some point the ladder should end
# somewhere worth arriving at.
EQUATOR_KM = 40075

# Below this share of the current year, last year's record is too thin to be a
# comparison rather than an accident of when tracking started.
THIN_BASELINE = 0.25


def _year_of(when):
    return when.year if hasattr(when, "year") else None


def totals(activities):
    """Distance, time and count over whatever is passed. -> dict."""
    distance = sum(a.get("distance_m") or 0.0 for a in activities)
    seconds = sum(a.get("moving_s") or 0.0 for a in activities)
    ascent = sum(a.get("elev_gain_m") or 0.0 for a in activities)
    return {"runs": len(activities), "distance_m": distance,
            "seconds": seconds, "ascent_m": ascent}


def by_year(activities):
    """Totals per calendar year, most recent first. -> [dict]."""
    buckets = {}
    for a in activities:
        year = _year_of(a.get("start"))
        if year is None:
            continue
        buckets.setdefault(year, []).append(a)
    out = []
    for year in sorted(buckets, reverse=True):
        row = totals(buckets[year])
        row["year"] = year
        row["longest_m"] = max((a.get("distance_m") or 0.0
                                for a in buckets[year]), default=0.0)
        out.append(row)
    return out


def busiest_month(activities, year):
    """The month of `year` with the most distance. -> (month, metres)|None."""
    months = {}
    for a in activities:
        when = a.get("start")
        if _year_of(when) != year:
            continue
        months[when.month] = months.get(when.month, 0.0) + (a.get("distance_m") or 0.0)
    if not months:
        return None
    month = max(months, key=lambda m: months[m])
    return (month, months[month])


def week_streak(activities, today=None):
    """Consecutive weeks containing at least one run. -> dict.

    Counted in weeks on purpose. A daily streak rewards running on the days you
    should not, and this app is not going to hand out a badge for that.
    """
    today = today or date.today()
    weeks = set()
    for a in activities:
        when = a.get("start")
        if when is None:
            continue
        day = when.date() if hasattr(when, "date") else when
        weeks.add(day - timedelta(days=day.weekday()))
    if not weeks:
        return {"current": 0, "longest": 0, "weeks_run": 0}

    ordered = sorted(weeks)
    longest = run = 1
    for previous, current in zip(ordered, ordered[1:]):
        run = run + 1 if (current - previous).days == 7 else 1
        longest = max(longest, run)

    # The current streak may end this week or last: a week still in progress
    # should not break it.
    this_week = today - timedelta(days=today.weekday())
    current = 0
    cursor = this_week if this_week in weeks else this_week - timedelta(days=7)
    while cursor in weeks:
        current += 1
        cursor -= timedelta(days=7)
    return {"current": current, "longest": longest, "weeks_run": len(weeks)}


def milestone(value, tiers, unit="km"):
    """Where a running total sits on a ladder. -> dict|None.

    Reports the last tier passed and the next one coming, so the number always
    has somewhere to be going.
    """
    if value is None or value < 0 or not tiers:
        return None
    passed = [t for t in tiers if value >= t]
    ahead = [t for t in tiers if value > t or value < t]
    upcoming = [t for t in tiers if t > value]
    return {
        "value": value,
        "last": passed[-1] if passed else None,
        "next": upcoming[0] if upcoming else None,
        "to_go": (upcoming[0] - value) if upcoming else None,
        "progress": (value / upcoming[0]) if upcoming else 1.0,
        "unit": unit,
        "cleared": len(passed),
    }


def career(activities, races_finished=0, today=None):
    """The lifetime ledger. -> dict."""
    life = totals(activities)
    km = life["distance_m"] / 1000.0
    first = min((a["start"] for a in activities if a.get("start")), default=None)
    return {
        "totals": life,
        "km": km,
        "years": _span_years(first, today),
        "first_run": first,
        "distance_milestone": milestone(km, DISTANCE_TIERS_KM, "km"),
        "race_milestone": milestone(races_finished, RACE_TIERS, "races"),
        "races_finished": races_finished,
        "equator": km / EQUATOR_KM,
        "streak": week_streak(activities, today),
    }


def _span_years(first, today=None):
    """How long the record covers, in years. -> float|None."""
    if not first:
        return None
    today = today or date.today()
    start = first.date() if hasattr(first, "date") else first
    return max((today - start).days / 365.25, 0.0)


def compare_years(rows, year):
    """This year against last. -> dict|None.

    Only compares the part of last year that has already elapsed this year, so a
    half-finished year is not held against a complete one.
    """
    current = next((r for r in rows if r["year"] == year), None)
    previous = next((r for r in rows if r["year"] == year - 1), None)
    if not current or not previous or not previous["distance_m"]:
        return None
    change = current["distance_m"] / previous["distance_m"] - 1.0
    return {"year": year, "distance_m": current["distance_m"],
            "previous_m": previous["distance_m"], "change": change,
            "note": _year_note(change)}


def _year_note(change):
    percent = abs(change) * 100.0
    if change > 0.10:
        return "%.0f%% more running than the year before." % percent
    if change < -0.10:
        return "%.0f%% less running than the year before." % percent
    return "About the same as the year before."


def partial_year_compare(activities, year, today=None):
    """This year so far against the same span of last year. -> dict|None.

    The comparison every app gets wrong: eleven months of this year against
    twelve of last is not a decline.
    """
    today = today or date.today()
    if year != today.year:
        return None
    cutoff = today.timetuple().tm_yday

    def upto(target_year):
        return sum(a.get("distance_m") or 0.0 for a in activities
                   if _year_of(a.get("start")) == target_year
                   and a["start"].timetuple().tm_yday <= cutoff)

    now, before = upto(year), upto(year - 1)
    if not before:
        return None
    change = now / before - 1.0

    # A record that only started partway through last year is not a training
    # comparison, it is an artefact of when you began. Expressing it as a
    # percentage produces things like "26,090% more running", which is true and
    # useless.
    thin = before < now * THIN_BASELINE
    note = ("Last year's record does not go back far enough to compare against "
            "-- this is effectively your first full year." if thin
            else _year_note(change))
    return {"so_far_m": now, "same_point_last_year_m": before,
            "change": change, "day_of_year": cutoff,
            "thin_baseline": thin, "note": note}
