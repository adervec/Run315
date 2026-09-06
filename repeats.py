"""The routes you run again and again, and whether you are getting quicker on them.

Almost nobody runs somewhere new every day. Most training is a handful of routes
repeated for years, and that repetition is the most honest fitness test an
athlete owns: the same roads, the same corners, the same hill into the same
headwind, so the only thing that changed between March and September is you. A
lab test costs money and a race costs a weekend. The Tuesday loop is free, and
you have already run it fourteen times.

The hard part is deciding that two GPS traces are the same route. No two
recordings of the same roads share a single point, and matching lines against
each other properly means map matching, projections and a geometry library.

So don't look at the points. Look at the tiles from territory.py: every run
already claims a set of ~305 m squares, and two runs of the same route claim
almost exactly the same squares. Jaccard -- shared tiles over total tiles --
then answers "is this the same route" with two set operations and no
dependencies, over data the territory game computes for every run anyway.

One trap comes with it. A subset scores well: a 5 km out-and-back down the same
road claims half the tiles of the 10 km version and none that it does not, so
the ground agrees while the runs plainly do not. Distance has to agree too.

Pure functions over run dicts. No I/O, no dependencies beyond territory.
See test_repeats.py.

A run dict needs: garmin_id, start (datetime), distance_m, moving_s, and tiles
(a set, from signature()). Missing values may be None.
"""
import territory

DEFAULT_ZOOM = territory.DEFAULT_ZOOM

# Jaccard over z17 tiles. Two recordings of the same route score above 0.85 in
# practice -- the tiles only disagree where the trace wanders over a boundary --
# so the cutoff is not delicate. 0.6 leaves room for a different finish, a lap of
# the park at the end or a diversion round roadworks, while still refusing two
# routes that merely share the same river path out of town.
SAME_ROUTE = 0.6

# How far two runs may differ in length and still be the same route. Measured
# distance for identical roads varies by a percent or two, and a warm-up lap or
# an extra block at the end is worth maybe ten. Twenty accepts all of that; the
# case it exists to reject -- the same road run twice as far -- is fifty percent
# out, so there is a wide gap either side of the line.
DISTANCE_TOLERANCE = 0.20

MIN_REPEATS = 3            # fewer than three times is a route you tried, not one you run

# Riegel's fatigue exponent, the same one fitness.py projects race times with.
# ponytail: the textbook value, not this athlete's fitted one. Across the
# +/-20% window one route's distances wobble in, the difference between the two
# is under a percent -- fitting it here would be arithmetic for its own sake.
RIEGEL = 1.06

IMPROVEMENT = 0.02         # 2% of pace is about 7 s/km -- smaller than that is weather

# Fresh ground claimed per metre run, above which a route did not double back.
# Measured on real geometry: loops land at 1.2 (a turning route cuts tiles
# cornerwise, so it claims more than one per tile-width), out-and-backs at 0.55,
# because the way home is the way out. The line sits under both bands.
# ponytail: a crude shape test, and a route that does both reads as whichever
# half is longer. Good enough to name a route; nothing else depends on it.
LOOP_COVERAGE = 0.70


# --------------------------------------------------------------------------- #
# is this the same route?
# --------------------------------------------------------------------------- #
def signature(points, zoom=DEFAULT_ZOOM):
    """A run's ground, as the set of tiles it touched.

    This is the whole trick. A route identified by the squares it covers instead
    of by its points means two recordings of the same roads agree exactly, even
    though no two sets of GPS fixes ever do.
    """
    return territory.tiles_for_track(points or (), zoom)


def similarity(a, b):
    """Jaccard index of two tile sets: shared ground over total ground. 0..1.

    Two runs with no tiles at all are not the same route -- they are two
    unknowns -- so that case is 0.0 rather than an undefined 0/0.
    """
    a, b = set(a or ()), set(b or ())
    union = len(a | b)
    if not union:
        return 0.0
    return len(a & b) / float(union)


def _distance_agrees(a, b, tolerance=DISTANCE_TOLERANCE):
    """Whether two runs are close enough in length to be the same route.

    Tile overlap alone cannot tell a route from half of it: the shorter run's
    tiles are a subset of the longer one's, which scores far too well. The
    tolerance is taken against the longer distance, so the test is symmetric and
    a doubled route fails it however you order the pair.
    """
    da, db = a.get("distance_m"), b.get("distance_m")
    if not da or not db:
        return True        # nothing to check against; the tiles decide alone
    return abs(da - db) <= tolerance * max(da, db)


def cluster(runs, threshold=SAME_ROUTE, tolerance=DISTANCE_TOLERANCE):
    """Group runs into routes. -> [[run, ...], ...], most-run route first.

    Each run is compared against one representative per route found so far --
    the first run of that route -- and joins whichever it matches best above
    `threshold`, or founds a new route of its own.

    Runs are taken oldest first, so a route's representative is the first time
    the athlete ran it. That keeps the grouping stable: syncing a new run never
    reshuffles the routes already on the page.

    Runs with no tiles are dropped. A treadmill hour covers no ground, and a
    route it could belong to cannot be told from any other.

    A tile set has no direction, so the same loop run backwards is the same
    route here. That is the answer an athlete wants -- it is the same hill and
    the same corners either way round.
    """
    # Greedy against a representative, not all pairs. All-pairs Jaccard is
    # O(n^2) set operations over an athlete's whole history -- hundreds of runs
    # is tens of thousands of comparisons, recomputed on every page load -- while
    # this is O(n * routes), and routes stays in the dozens no matter how long
    # the history gets.
    # ponytail: a fixed representative rather than average linkage. It can split
    # one route in two when the trace drifts (B matches A, C matches B but not
    # A). Compare against the core tiles of the route instead if that shows up.
    routes = []                                  # [(representative, [members])]
    for run in _oldest_first(runs):
        if not run.get("tiles"):
            continue
        best, score = None, 0.0
        for rep, members in routes:
            s = similarity(rep["tiles"], run["tiles"])
            if s < threshold or not _distance_agrees(rep, run, tolerance):
                continue
            if best is None or s > score:
                best, score = members, s
        if best is None:
            routes.append((run, [run]))
        else:
            best.append(run)

    out = [members for _rep, members in routes]
    out.sort(key=len, reverse=True)              # stable: ties stay in the order founded
    return out


def _oldest_first(runs):
    """Chronological, with undated runs left at the end in the order given."""
    dated = [r for r in runs if r and r.get("start") is not None]
    dated.sort(key=lambda r: r["start"])
    return dated + [r for r in runs if r and r.get("start") is None]


# --------------------------------------------------------------------------- #
# are you getting quicker on it?
# --------------------------------------------------------------------------- #
def _median(values):
    vals = sorted(v for v in values if v)
    if not vals:
        return None
    mid = len(vals) // 2
    if len(vals) % 2:
        return float(vals[mid])
    return (vals[mid - 1] + vals[mid]) / 2.0


def _pace(run, distance_m=None):
    """Seconds per km, normalised to `distance_m`. None without both numbers.

    Runs of one route are not all the same length -- a lap of the park at the
    end, a watch that measured 200 m short -- and raw pace reads that wobble as
    form: the longer day looks like a bad day even at identical effort. Riegel
    converts the time to what it would have been over the route's usual
    distance, which is what "your best time on this route" has to mean.
    """
    d, t = run.get("distance_m"), run.get("moving_s")
    if not d or not t or d <= 0 or t <= 0:
        return None
    if distance_m and distance_m > 0:
        t = t * (distance_m / float(d)) ** RIEGEL
        d = distance_m
    return t / (d / 1000.0)


def progression(cluster):
    """How one route has gone over time. -> dict, or None if it has no runs.

    `cluster` is a list of run dicts, as one entry of cluster(). Everything
    compared here is pace normalised to the route's median distance; times are
    reported raw, because a time is what the athlete remembers running.

    The trend splits the timed runs into an early half and a late half rather
    than fitting a line: it survives one heat wave or one race-pace day, needs
    no statistics, and answers the only question being asked -- is the recent
    version of you quicker round here than the older one.
    """
    runs = _oldest_first(cluster or ())
    if not runs:
        return None

    distance_m = _median([r.get("distance_m") for r in runs])
    timed = [(r, _pace(r, distance_m)) for r in runs]
    timed = [(r, p) for r, p in timed if p]

    best_run, best_pace = min(timed, key=lambda rp: rp[1]) if timed else (None, None)
    last_run, last_pace = timed[-1] if timed else (None, None)

    # An odd run out of the middle belongs to neither half -- it is the pivot.
    half = len(timed) // 2
    change = None
    if half:
        early = sum(p for _r, p in timed[:half]) / half
        late = sum(p for _r, p in timed[len(timed) - half:]) / half
        change = late / early - 1.0
    off_best = (last_pace / best_pace - 1.0) if best_pace else None

    starts = [r["start"] for r in runs if r.get("start") is not None]
    return {
        "count": len(runs),
        "timed": len(timed),
        "first": starts[0] if starts else None,
        "last": starts[-1] if starts else None,
        "days": (starts[-1] - starts[0]).days if len(starts) > 1 else 0,
        "distance_m": distance_m,
        "best": best_run,
        "best_s": best_run.get("moving_s") if best_run else None,
        "best_pace": best_pace,
        "best_at": best_run.get("start") if best_run else None,
        "latest": last_run,
        "latest_s": last_run.get("moving_s") if last_run else None,
        "latest_pace": last_pace,
        "change": change,                 # negative is quicker
        "off_best": off_best,             # how far the last one sits off the best
        "improving": None if change is None else change <= -IMPROVEMENT,
        "verdict": _verdict(len(timed), change, off_best),
    }


def _verdict(timed, change, off_best):
    """One line on the route, in the terms a runner would use."""
    if not timed:
        return "Never timed this route."
    if change is None:
        return "Only one timed run on this route -- nothing to compare it to yet."
    if change <= -IMPROVEMENT:
        return "%.1f%% quicker over %d runs on the same ground." % (-change * 100, timed)
    if change >= IMPROVEMENT:
        return "%.1f%% slower here than when you started running it." % (change * 100)
    if off_best is not None and off_best < 0.005:
        return "Level across %d runs, but the last one was your best." % timed
    return "Level across %d runs -- this route is not testing you." % timed


# --------------------------------------------------------------------------- #
# naming the thing
# --------------------------------------------------------------------------- #
def shape(tiles, distance_m, zoom=DEFAULT_ZOOM):
    """"loop" or "out and back", from how much ground the tiles cover per metre.

    The tile count already knows the answer, so the points do not need looking
    at again: running out and back down one road claims each tile twice and so
    covers about half the ground of a loop of the same length.
    """
    if not tiles or not distance_m:
        return "route"
    rows = sorted(t[1] for t in tiles)
    metres = territory.tile_size_m(rows[len(rows) // 2], zoom)
    covered = len(tiles) * metres / float(distance_m)
    return "loop" if covered >= LOOP_COVERAGE else "out and back"


def name_for(tiles, distance_m, zoom=DEFAULT_ZOOM):
    """A name the athlete would recognise: "8.4 km loop", "5.0 km out and back".

    ponytail: distance and shape only. The athlete knows which 8 km loop it is;
    if two of them ever collide, name them from the streets the core tiles cover
    (pois.py already talks to Overpass) or just let the athlete rename it.
    """
    if not distance_m:
        return "Unnamed route"
    return "%.1f km %s" % (distance_m / 1000.0, shape(tiles, distance_m, zoom))


def _core_tiles(members):
    """Tiles claimed on at least half of a route's runs -- the route, no detours.

    One run's diversion round a closed bridge is not part of the route, and
    drawing the union would show every such diversion at once.
    """
    counts = {}
    for r in members:
        for t in r.get("tiles") or ():
            counts[t] = counts.get(t, 0) + 1
    need = len(members) / 2.0
    return {t for t, n in counts.items() if n >= need}


# --------------------------------------------------------------------------- #
# the pipeline
# --------------------------------------------------------------------------- #
def summarise(runs, min_repeats=MIN_REPEATS, threshold=SAME_ROUTE,
              tolerance=DISTANCE_TOLERANCE, zoom=DEFAULT_ZOOM):
    """Runs in, repeated routes out, most-run first. -> [dict, ...].

    Routes run fewer than `min_repeats` times are dropped. A one-off is a nice
    memory but it says nothing about form, and left in, the exploring an athlete
    does on holiday would bury the loop they actually train on.
    """
    out = []
    for members in cluster(runs, threshold, tolerance):
        if len(members) < min_repeats:
            continue
        prog = progression(members)
        tiles = _core_tiles(members)
        out.append({
            "name": name_for(tiles, prog["distance_m"], zoom),
            "shape": shape(tiles, prog["distance_m"], zoom),
            "count": len(members),
            "distance_m": prog["distance_m"],
            "tiles": tiles,
            "runs": members,
            "garmin_ids": [r.get("garmin_id") for r in members],
            "progression": prog,
        })
    out.sort(key=lambda r: r["count"], reverse=True)
    return out
