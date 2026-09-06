"""Trail coverage: which named trails you have actually run, end to end.

territory.py asks "have I been in this square?". This asks the harder question:
"have I run the *whole* of that trail?" -- the CityStrides model, pointed at
trails instead of streets.

Every path-ish OSM way becomes a SEGMENT whose geometry is resampled to nodes a
fixed 25 m apart. An activity hits a node when its track passes within tolerance
of it. A named trail is every segment sharing that name -- OSM splits a trail
into dozens of ways wherever a tag changes, so the name is the only real
identity -- and completion is hit nodes over total nodes.

Two things make the numbers honest rather than flattering. Tracks are densified
to 10 m before matching, so a watch recording every 30 seconds cannot step over
a node it obviously ran past; and long jumps in a track are breaks, never
interpolated, so driving between two trailheads does not paint every trail on
the way. Coverage is then replayed oldest-first, so a node counts for the outing
that first reached it and a repeat lap scores nothing.

Ported from the TrailTracker engine (engine.js), keeping its constants and
thresholds so both agree on the same data. Pure functions, standard library
only, no I/O -- Overpass JSON and lists of (lat, lng) go in, coverage comes out.
See test_trails.py.

Shapes used throughout:

  coords    [(lat, lng), ...] -- a resampled polyline. Node i of a segment is
            coords[i] and hit-mask byte i refers to that same node, so node
            indices are the one thing every function here agrees on.
  Segment   one OSM way; see the dataclass below. len(seg.coords) is its node
            count.
  hits      {way_id: bytearray} -- one byte per node, 1 = passed within
            tolerance. Segments a track never came near are absent, not zeroed,
            which is what keeps a city of trails out of every activity's record.
  activity  {"id": str, "date": "YYYY-MM-DD", "hits": hits} -- what chronology()
            and union_coverage() replay. Other keys are ignored.
"""
import math
from dataclasses import dataclass
from datetime import date

M_PER_DEG_LAT = 111320      # good to a tenth of a percent anywhere that has trails
NODE_STEP_M = 25            # trail node spacing -- matches CityStrides' 25 m feel
TRACK_STEP_M = 10           # tracks are densified to this so they cannot skip a node
TRACK_GAP_M = 150           # a longer jump is a GPS pause or a drive, never a route
DEFAULT_TOL_M = 25          # how close to a node counts as having been there
DEFAULT_COMPLETE_AT = 0.9   # done at 90%: the last stub is usually a car park spur,
                            # a mapping artefact, or a bit of private land
JOIN_TOL_M = 50             # way ends this close are the same junction, for stitching


# --------------------------------------------------------------------------- #
# geometry
# --------------------------------------------------------------------------- #
def dist_m(a_lat, a_lng, b_lat, b_lng):
    """Metres between two points, equirectangular.

    Trails are local, so flattening the earth about the midpoint latitude is
    exact enough and much cheaper than haversine -- and this runs once per
    (track point, candidate node) pair, which is millions of times per import.
    """
    dy = (b_lat - a_lat) * M_PER_DEG_LAT
    dx = (b_lng - a_lng) * M_PER_DEG_LAT * math.cos(math.radians((a_lat + b_lat) / 2.0))
    return math.sqrt(dx * dx + dy * dy)


def _finite(line):
    """[(lat, lng)] with the junk removed: None, NaN, strings, off-Earth points.

    Watches and half-parsed files emit all of these. The JS original let a NaN
    propagate into the maths; in Python math.floor() would raise instead, so the
    filtering happens up front, once.
    """
    out = []
    for p in line or ():
        if not p or len(p) < 2:
            continue
        try:
            lat, lng = float(p[0]), float(p[1])
        except (TypeError, ValueError):
            continue
        if math.isfinite(lat) and math.isfinite(lng) and abs(lat) <= 90 and abs(lng) <= 180:
            out.append((lat, lng))
    return out


def resample(line, step_m=NODE_STEP_M, max_gap_m=None):
    """Resample a polyline to even `step_m` spacing. -> (coords, length_m).

    Gaps longer than `max_gap_m` are breaks: both endpoints are kept, nothing is
    placed between them, and the jump is not counted as distance. Without that,
    the drive home paints every trail it passes.

    The true end of the line is appended unless a node already sits within half
    a step of it, so a trail's end never drifts inward by up to a full step.
    """
    if not (step_m and step_m > 0):
        raise ValueError("step_m must be a positive number of metres")
    pts = _finite(line)
    if not pts:
        return [], 0.0

    max_gap = math.inf if not max_gap_m else float(max_gap_m)
    out = [pts[0]]
    len_m = 0.0
    carry = 0.0     # distance already walked past the last node, carried across vertices
    for (a_lat, a_lng), (b_lat, b_lng) in zip(pts, pts[1:]):
        d = dist_m(a_lat, a_lng, b_lat, b_lng)
        if not (d > 0):
            continue
        if d > max_gap:
            out.append((b_lat, b_lng))
            carry = 0.0
            continue
        len_m += d
        t = step_m - carry
        while t <= d:
            f = t / d
            out.append((a_lat + (b_lat - a_lat) * f, a_lng + (b_lng - a_lng) * f))
            t += step_m
        carry = (carry + d) % step_m

    last = pts[-1]
    if dist_m(out[-1][0], out[-1][1], last[0], last[1]) > step_m * 0.5:
        out.append(last)
    return out, len_m


def bbox_of(coords):
    """(min_lat, min_lng, max_lat, max_lng), or None for an empty line."""
    if not coords:
        return None
    lats = [c[0] for c in coords]
    lngs = [c[1] for c in coords]
    return (min(lats), min(lngs), max(lats), max(lngs))


def _near(a, b, tol_m):
    return dist_m(a[0], a[1], b[0], b[1]) <= tol_m


def _line_len(pts):
    return sum(dist_m(a[0], a[1], b[0], b[1]) for a, b in zip(pts, pts[1:]))


# --------------------------------------------------------------------------- #
# segments
# --------------------------------------------------------------------------- #
@dataclass
class Segment:
    """One OSM way, resampled. Node i is coords[i] and hit-mask byte i.

    `len_m` is the true polyline length, not step * nodes -- coverage converts
    back to metres through it, so a way that ends in a short stub is not
    credited with a full node's worth of distance.
    """
    id: str
    coords: list
    len_m: float = 0.0
    name: str | None = None
    kind: str = "path"
    motor: bool = False
    bbox: tuple | None = None
    region: str | None = None


# Access tags that mean "you may" rather than "you may not". OSM writes several
# flavours of yes and they all count the same here.
_YES = frozenset(("yes", "designated", "permissive", "official", "customers"))


def way_kind(tags):
    """OSM tags -> (kind, motor).

    `kind` is the filter bucket the UI offers: path, track, cycleway, bridleway,
    steps, sidewalk. `motor` flags ways that quads, sleds or dirt bikes are
    allowed on, which is the difference between a trail and a road with mud on
    it. A track counts as motorised unless the tagging explicitly says no --
    that is what a track *is*.
    """
    tags = tags or {}
    h = tags.get("highway") or ""
    if h in ("track", "cycleway", "bridleway", "steps"):
        kind = h
    elif h == "footway" and tags.get("footway") in ("sidewalk", "crossing"):
        kind = "sidewalk"
    else:
        kind = "path"
    motor = (tags.get("atv") in _YES
             or tags.get("snowmobile") in _YES
             or tags.get("motor_vehicle") in _YES
             or tags.get("motorcycle") in _YES
             or (h == "track" and tags.get("motor_vehicle", "") != "no"))
    return kind, bool(motor)


def trail_key(seg):
    """Which trail a segment belongs to: 'n:<name>' or 'w:<way id>'.

    Name is the identity, lowercased so "Bruce trail" and "Bruce Trail" are one
    trail. Unnamed ways stand alone under their own id -- pooling them would
    build a single unfinishable mega-trail out of every scrap of dirt in the
    county.
    """
    return ("n:" + seg.name.lower()) if seg.name else ("w:" + str(seg.id))


def segments_from_overpass(data, region=None):
    """Overpass JSON -> [Segment]. Ways inherit a name from their route relation.

    Most of a long-distance trail's ways carry no name of their own; the name
    lives on the route relation they belong to. Without this, the Bruce Trail is
    four hundred anonymous paths.

    A way can belong to several routes, so hiking and foot routes outrank the
    rest: a path that is both a hiking route and a cycle route is, to someone on
    foot, the hiking route. The way's own name always wins over any of them.
    """
    elements = (data or {}).get("elements") or []

    rel_name = {}       # way id -> (name, preference)
    for el in elements:
        if el.get("type") != "relation":
            continue
        tags = el.get("tags") or {}
        name = tags.get("name")
        if not name:
            continue
        pref = 2 if tags.get("route") in ("hiking", "foot") else 1
        for m in el.get("members") or ():
            if m.get("type") != "way":
                continue
            ref = str(m.get("ref"))
            have = rel_name.get(ref)
            if have is None or have[1] < pref:
                rel_name[ref] = (name, pref)

    out = []
    for el in elements:
        if el.get("type") != "way":
            continue
        geometry = el.get("geometry") or []
        if len(geometry) < 2:
            continue
        coords, len_m = resample([(p.get("lat"), p.get("lon")) for p in geometry],
                                 NODE_STEP_M)
        if len(coords) < 2:
            continue        # under half a node step long: a stub, not a trail
        tags = el.get("tags") or {}
        kind, motor = way_kind(tags)
        way_id = str(el.get("id"))
        name = tags.get("name")
        if not name and way_id in rel_name:
            name = rel_name[way_id][0]
        out.append(Segment(id=way_id, coords=coords, len_m=len_m, name=name,
                           kind=kind, motor=motor, bbox=bbox_of(coords), region=region))
    return out


# --------------------------------------------------------------------------- #
# spatial index and matching
# --------------------------------------------------------------------------- #
@dataclass
class Index:
    """Hash grid over every node of every segment. Built by build_index()."""
    segs: list
    cells: dict           # (row, col) -> [(segment index, node index), ...]
    cell_lat: float
    cell_lng: float
    tol_m: float


def build_index(segs, tol_m=DEFAULT_TOL_M):
    """Hash-grid spatial index over trail nodes, sized from the tolerance.

    Cells are at least 1.6x the tolerance wide, so the 3x3 neighbourhood of a
    track point always contains everything within tolerance of it. That is what
    lets mark_hits() compare each track point against a few dozen candidates
    instead of every node in the county.
    """
    cell_m = max(60.0, tol_m * 1.6)

    # ponytail: one reference latitude sizes the whole grid, so cells stretch if
    # a region ever spans several degrees of latitude -- harmless (cells only
    # have to be roughly square), but split the index into latitude bands if
    # someone loads a whole country.
    ref_lat = 44.0
    for s in segs:
        if s.coords:
            ref_lat = s.coords[0][0]
            break

    cell_lat = cell_m / M_PER_DEG_LAT
    cell_lng = cell_m / (M_PER_DEG_LAT * math.cos(math.radians(ref_lat)))
    cells = {}
    for si, seg in enumerate(segs):
        for ni, (lat, lng) in enumerate(seg.coords):
            key = (math.floor(lat / cell_lat), math.floor(lng / cell_lng))
            cells.setdefault(key, []).append((si, ni))
    return Index(list(segs), cells, cell_lat, cell_lng, float(tol_m))


def mark_hits(index, coords, tol_m=None):
    """Mark every trail node this track passed within tolerance of.

    -> {way_id: bytearray}, one byte per node of that segment. `coords` should
    already be densified (resample at TRACK_STEP_M): matching is point-to-node,
    so a sparsely recorded track would otherwise stride over nodes it ran past.
    """
    tol = float(tol_m) if tol_m else index.tol_m
    segs, cells = index.segs, index.cells
    hits = {}
    for lat, lng in _finite(coords):
        ci = math.floor(lat / index.cell_lat)
        cj = math.floor(lng / index.cell_lng)
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for si, ni in cells.get((ci + di, cj + dj), ()):
                    seg = segs[si]
                    node = seg.coords[ni]
                    if dist_m(lat, lng, node[0], node[1]) > tol:
                        continue
                    mask = hits.get(seg.id)
                    if mask is None:
                        mask = hits[seg.id] = bytearray(len(seg.coords))
                    mask[ni] = 1
    return hits


# --------------------------------------------------------------------------- #
# coverage
# --------------------------------------------------------------------------- #
def union_coverage(activities, allow_seg=None):
    """OR every activity's hits together. -> {way_id: bytearray}.

    `allow_seg(way_id)` returns False for segments the current filters exclude
    (wrong region, motorised, sidewalks off). Filtering here rather than at
    import means the toggles are instant and nothing has to be re-matched.
    """
    cover = {}
    for act in activities:
        for way_id, mask in ((act.get("hits") or {}).items()):
            if allow_seg and not allow_seg(way_id):
                continue
            have = cover.get(way_id)
            if have is None:
                cover[way_id] = bytearray(mask)      # copied: never mutate an activity
                continue
            for i in range(min(len(mask), len(have))):
                have[i] |= mask[i]
    return cover


def count_bits(mask):
    """Nodes covered in a hit mask. Bytes are 0 or 1, so a sum is the popcount."""
    return sum(mask)


def covered_runs(mask):
    """Contiguous covered stretches as [(first_node, last_node)], inclusive.

    The runs are what a map draws and what "you have done km 0-4 and 7-9" reads
    off; a bare percentage cannot tell a solid half from a dotted whole.
    """
    runs, i, n = [], 0, len(mask)
    while i < n:
        if not mask[i]:
            i += 1
            continue
        j = i
        while j < n and mask[j]:
            j += 1
        runs.append((i, j - 1))
        i = j
    return runs


# --------------------------------------------------------------------------- #
# chronology
# --------------------------------------------------------------------------- #
def chronology(activities, segments, allow_seg=None, key_fn=trail_key,
               complete_at=DEFAULT_COMPLETE_AT):
    """Replay every activity oldest-first, crediting each node to its first visit.

    Running your usual loop twice does not cover it twice, so new ground is the
    only honest per-activity number, and it depends on the order things happened
    in. One pass gives all of it: new metres per outing, the date each trail
    crossed the completion line, and the cumulative curve.

    -> {"per_act": {activity id: {"new_m", "new_nodes", "finished"}},
        "done_on":  {trail key: date the trail was completed},
        "timeline": [{"date", "cum_m", "new_m"}] in chronological order,
        "total_m":  metres of distinct trail covered}
    """
    info, trail_total = {}, {}
    for s in segments:
        if allow_seg and not allow_seg(s.id):
            continue
        n = len(s.coords)
        key = key_fn(s)
        # Metres per node, so a partial mask converts to distance without
        # walking the geometry again.
        info[s.id] = (n, (s.len_m / n if n else 0.0), key)
        trail_total[key] = trail_total.get(key, 0) + n

    # Undated activities sort last -- they cannot claim first touch of anything
    # a dated outing already reached. Id breaks ties so the result is stable.
    order = sorted(activities,
                   key=lambda a: (str(a.get("date") or "9999"), str(a.get("id"))))

    seen, trail_hit = {}, {}      # way id -> nodes ever hit; trail key -> node count
    per_act, done_on, timeline = {}, {}, []
    cum_m = 0.0
    for act in order:
        new_m, new_nodes, finished = 0.0, 0, []
        for way_id, mask in ((act.get("hits") or {}).items()):
            inf = info.get(way_id)
            if inf is None:
                continue                     # filtered out, or from an unloaded region
            n, m_per_node, key = inf
            cur = seen.get(way_id)
            if cur is None:
                cur = seen[way_id] = bytearray(n)
            add = 0
            for k in range(min(len(mask), len(cur))):
                if mask[k] and not cur[k]:
                    cur[k] = 1
                    add += 1
            if not add:
                continue
            new_nodes += add
            new_m += add * m_per_node
            before = trail_hit.get(key, 0)
            after = before + add
            total = trail_total.get(key) or 1
            trail_hit[key] = after
            # The crossing, not the state: a trail is finished once, on the day
            # the outing that pushed it over the line happened.
            if before / total < complete_at <= after / total:
                done_on[key] = act.get("date") or ""
                finished.append(key)
        cum_m += new_m
        per_act[act.get("id")] = {"new_m": new_m, "new_nodes": new_nodes,
                                  "finished": finished}
        timeline.append({"date": act.get("date") or "", "cum_m": cum_m, "new_m": new_m})
    return {"per_act": per_act, "done_on": done_on, "timeline": timeline,
            "total_m": cum_m}


def day_diff(a, b):
    """Whole days from ISO date `a` to ISO date `b`. None if either will not parse."""
    try:
        return (date.fromisoformat(b) - date.fromisoformat(a)).days
    except (TypeError, ValueError):
        return None


def streaks(days, today=None):
    """Consecutive-day runs over the days that broke new ground.

    -> {"current", "best", "days"}. The current streak only counts when the last
    new-ground day was today or yesterday; anything older is a streak you have
    already lost, and displaying it would be a lie.

    `today` is a parameter rather than a look at the clock, so the result is
    testable and so a caller can ask what this looked like back in June.
    """
    uniq = sorted({d for d in days if d})
    best = run = 0
    prev = None
    for d in uniq:
        run = run + 1 if (prev and day_diff(prev, d) == 1) else 1
        best = max(best, run)
        prev = d
    current = 0
    if uniq:
        gap = day_diff(uniq[-1], today or date.today().isoformat())
        current = run if gap in (0, 1) else 0
    return {"current": current, "best": best, "days": len(uniq)}


def climb_m(eles, min_step=1.0):
    """Total metres climbed over an elevation stream. -> int.

    Barometric and GPS altitude wander by a metre while you stand still, so a
    rise has to clear `min_step` before it counts -- otherwise a flat run climbs
    a hundred metres of noise. Pass 0 for a line drawn off a smooth elevation
    model, which would otherwise lose a third of its real climb to the filter.
    """
    vals = [float(e) for e in eles
            if isinstance(e, (int, float)) and math.isfinite(e)]
    up = sum(b - a for a, b in zip(vals, vals[1:]) if b - a > min_step)
    return int(up + 0.5)      # matches JS Math.round; Python's round() goes to even


# --------------------------------------------------------------------------- #
# stitching
# --------------------------------------------------------------------------- #
def stitch_trail(segs, join_tol_m=JOIN_TOL_M):
    """Chain a trail's ways end to end. -> [{"pts": [(lat, lng)...], "len_m": float}].

    A trail arrives as an unordered bag of OSM ways pointing whichever way the
    mapper drew them. Reading it as "km 4 to km 9", or handing it to a watch,
    needs them in order. Greedy and longest-first, so chains grow out from the
    trail's spine; a way whose ends meet nothing stays its own chain, which is
    exactly what a spur or a gap in the mapping is.
    """
    pool = [list(s.coords) for s in segs if len(s.coords) > 1]
    pool.sort(key=len, reverse=True)
    chains = []
    while pool:
        chain = pool.pop(0)
        grew = True
        while grew:
            grew = False
            for i, g in enumerate(pool):
                start, end = chain[0], chain[-1]
                # The shared point is dropped from the piece being added, so a
                # junction does not become a zero-length duplicate node.
                if _near(end, g[0], join_tol_m):
                    chain = chain + g[1:]
                elif _near(end, g[-1], join_tol_m):
                    chain = chain + list(reversed(g[:-1]))
                elif _near(start, g[-1], join_tol_m):
                    chain = g[:-1] + chain
                elif _near(start, g[0], join_tol_m):
                    chain = list(reversed(g[1:])) + chain
                else:
                    continue
                pool.pop(i)
                grew = True
                break
        chains.append({"pts": chain, "len_m": _line_len(chain)})
    chains.sort(key=lambda c: c["len_m"], reverse=True)
    return chains
