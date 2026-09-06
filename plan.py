"""Getting from where you are to the start line.

A training plan bought off a shelf starts from a distance and a number of weeks.
This one starts from what you are already doing -- your current weekly volume,
your current fitness, and the paces your own curve says you can hold -- because
the plan that matters is the one that continues your training rather than
replacing it.

Three rules shape every plan here, and they are the ones people break:

  * volume rises slowly and comes back down. Three weeks up, one week easy, and
    a cap on how fast the ramp can go, because the acute-to-chronic ratio is
    where overuse injuries live.
  * the long run is a share of the week, not a heroic number on its own. It is
    also capped by the race: nobody needs a 40 km run to race a 10K.
  * intensity is prescribed as a *pace band from your own fit*, never as a
    number off a chart.

Everything below is a schedule, not a prescription. It has no idea whether you
slept, and it says so on the page.

Pure functions. No I/O, no dependencies. See test_plan.py.
"""
import math

# Three up, one down. The easy week is what lets the next block land.
CYCLE = 4
EASY_WEEK_SHARE = 0.70

# How fast weekly volume may rise, week on week, inside a build.
MAX_RAMP = 0.10
# ...and how far above the starting point the plan will ever take you.
MAX_TOTAL_GROWTH = 1.60

# The long run grows as a share of the week through the block: early on it is
# just the longest run of an easy week, by the peak it is the session the whole
# week is arranged around.
LONG_RUN_SHARE = {"base": 0.26, "build": 0.30, "peak": 0.34, "taper": 0.25}
LONG_RUN_CAP_M = {5000: 16000, 10000: 22000, 21097: 32000, 42195: 38000}
DEFAULT_LONG_CAP_M = 30000

# Taper length by race distance. Longer races need longer to unload.
TAPER_WEEKS = ((42195, 3), (21097, 2), (10000, 1), (0, 1))

PHASES = ("base", "build", "peak", "taper")


def taper_weeks(distance_m):
    """How many weeks of unloading this race deserves."""
    for threshold, weeks in TAPER_WEEKS:
        if distance_m >= threshold:
            return weeks
    return 1


def long_run_cap(distance_m):
    """The longest single run worth doing for this race."""
    best = DEFAULT_LONG_CAP_M
    for race, cap in sorted(LONG_RUN_CAP_M.items()):
        if distance_m <= race:
            return cap
        best = cap
    return best


def phase_for(week_index, total_weeks, taper):
    """Which part of the block a week belongs to.

    Base builds the aerobic engine, build adds the hard work, peak sharpens it
    for the specific race, taper takes the fatigue off. The split is roughly
    40/35/25 of the non-taper weeks, which is the shape most periodised plans
    use whatever they call it.
    """
    working = max(total_weeks - taper, 1)
    if week_index >= working:
        return "taper"
    share = week_index / float(working)
    if share < 0.40:
        return "base"
    if share < 0.75:
        return "build"
    return "peak"


# What the taper leaves of the peak week, counting back from the race.
TAPER_SHARES = (0.75, 0.55, 0.35)


def weekly_volumes(start_m, weeks, taper, peak_cap=None):
    """Weekly distance targets, ramped and cut back. -> [metres] per week.

    The progression is spread across the whole build so the heaviest week lands
    just before the taper. Compounding a fixed percentage instead hits the
    ceiling early and then sits there, which is a ramp followed by a plateau
    rather than a plan -- and the flat weeks are where people get stale.

    The week-on-week ramp is still capped, and so is the total: a plan that
    doubles your mileage in twelve weeks is not a plan, it is an injury with a
    calendar.
    """
    if weeks <= 0 or start_m <= 0:
        return []
    peak = peak_cap or start_m * MAX_TOTAL_GROWTH
    build_weeks = max(weeks - taper, 1)

    out = []
    for i in range(build_weeks):
        share = i / float(max(build_weeks - 1, 1))
        target = start_m + (peak - start_m) * share
        # Every fourth week backs off, without losing the thread of the block.
        easy = bool(i and (i + 1) % CYCLE == 0)
        out.append(target * EASY_WEEK_SHARE if easy else target)

    # Hold the ramp even if a short block would otherwise ask for a big jump.
    for i in range(1, len(out)):
        previous = out[i - 1]
        if out[i] > previous * (1.0 + MAX_RAMP) and not (i and i % CYCLE == 0):
            out[i] = previous * (1.0 + MAX_RAMP)

    peak_week = max(out) if out else start_m
    for j in range(taper):
        if len(out) >= weeks:
            break
        share = TAPER_SHARES[min(j, len(TAPER_SHARES) - 1)]
        if taper < len(TAPER_SHARES):
            # A short taper should still finish light, so take the last shares.
            share = TAPER_SHARES[len(TAPER_SHARES) - taper + j]
        out.append(peak_week * share)
    return out[:weeks]


def long_run_for(week_m, distance_m, phase="build"):
    """The week's long run: a share of the week, capped by the race."""
    share = LONG_RUN_SHARE.get(phase, LONG_RUN_SHARE["build"])
    return min(week_m * share, long_run_cap(distance_m))


def key_sessions(phase, distance_m, paces, week_m):
    """The two or three sessions that give a week its purpose.

    `paces` is fitness.training_paces() output: (name, purpose, fast, slow).
    Everything is expressed as a band from the athlete's own curve, so the plan
    stays correct as they get fitter rather than going stale the day it is made.
    """
    band = {name: (fast, slow) for name, _purpose, fast, slow in (paces or [])}

    def at(name):
        return band.get(name)

    out = []
    if phase == "base":
        out.append(("Steady", "20-30 min continuous, comfortably hard", at("Marathon")))
        out.append(("Strides", "6 x 20 s relaxed and fast off a jog", at("Repetition")))
    elif phase == "build":
        out.append(("Threshold", "3 x 8 min with 2 min jog", at("Threshold")))
        out.append(("Intervals", "6 x 3 min hard with 2 min jog", at("Interval")))
    elif phase == "peak":
        if distance_m >= 21097:
            out.append(("Race pace", "2 x 20 min at goal pace inside the long run",
                        at("Marathon")))
            out.append(("Threshold", "4 x 8 min with 2 min jog", at("Threshold")))
        else:
            out.append(("Intervals", "5 x 1000 m with 3 min jog", at("Interval")))
            out.append(("Threshold", "20 min continuous", at("Threshold")))
    else:
        out.append(("Sharpener", "10 min easy, 6 x 90 s at race effort, 10 min easy",
                    at("Threshold")))
    return out


def build(start_week_m, race_distance_m, weeks, paces=None, peak_cap=None):
    """A week-by-week plan. -> [dict] one per week, first week first.

    `start_week_m` is what the athlete is actually running now, not what they
    wish they were running.
    """
    if weeks <= 0 or start_week_m <= 0 or race_distance_m <= 0:
        return []
    taper = min(taper_weeks(race_distance_m), max(weeks - 1, 1))
    volumes = weekly_volumes(start_week_m, weeks, taper, peak_cap)

    plan = []
    for i, week_m in enumerate(volumes):
        phase = phase_for(i, weeks, taper)
        long_m = long_run_for(week_m, race_distance_m, phase)
        easy_m = max(week_m - long_m, 0.0)
        plan.append({
            "week": i + 1,
            "to_go": weeks - i,
            "phase": phase,
            "distance_m": week_m,
            "long_run_m": long_m,
            "easy_m": easy_m,
            "sessions": key_sessions(phase, race_distance_m, paces, week_m),
            "easy_week": bool(i and (i + 1) % CYCLE == 0 and phase != "taper"),
        })
    return plan


def summarise(plan, race_distance_m=None):
    """Headline numbers for a built plan, or None when there is no plan."""
    if not plan:
        return None
    peak = max(plan, key=lambda w: w["distance_m"])
    longest = max(plan, key=lambda w: w["long_run_m"])
    return {
        "weeks": len(plan),
        "peak_week_m": peak["distance_m"],
        "peak_week_n": peak["week"],
        "longest_run_m": longest["long_run_m"],
        "total_m": sum(w["distance_m"] for w in plan),
        "taper_weeks": sum(1 for w in plan if w["phase"] == "taper"),
        "growth": (peak["distance_m"] / plan[0]["distance_m"]) - 1.0
                  if plan[0]["distance_m"] else 0.0,
        "race_distance_m": race_distance_m,
    }


def sanity(plan, current_week_m):
    """Warnings worth showing before anyone follows this. -> [str].

    A generated plan should be able to say when it is asking for something
    unreasonable, rather than presenting every number with equal confidence.
    """
    notes = []
    if not plan:
        return notes
    peak = max(w["distance_m"] for w in plan)
    if current_week_m and peak > current_week_m * MAX_TOTAL_GROWTH + 1:
        notes.append("This peaks a long way above what you are running now. "
                     "Treat the later weeks as provisional.")
    if len(plan) < 8:
        notes.append("Under eight weeks is short for a real build -- expect to "
                     "arrive fit rather than peaked.")
    # The week after an easy week climbs back to where the build was, which is
    # the point of an easy week -- it is not a ramp violation. Compare each week
    # against the last one that was actually part of the build.
    jumps = []
    for previous, week in zip(plan, plan[1:]):
        if previous["easy_week"] or previous["distance_m"] <= 0:
            continue
        if week["distance_m"] > previous["distance_m"]:
            jumps.append(week["distance_m"] / previous["distance_m"] - 1.0)
    if jumps and max(jumps) > MAX_RAMP + 0.005:
        notes.append("One week rises faster than the %d%% ramp this plan is "
                     "meant to hold to." % round(MAX_RAMP * 100))
    return notes
