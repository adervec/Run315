"""What 2,700 metres of climbing actually looks like.

Cumulative ascent is the least legible number in running. Nobody has an
intuition for what 2,700 m means, and the usual presentation -- a total, in a
box, next to a distance -- does nothing to build one.

Korea's Runday maps stair-climbing onto world landmark buildings, which is the
right idea in the wrong sport: the useful move is to turn a number nobody can
picture into a thing everybody can. "You have climbed three and a half Eiffel
Towers this month" is a better answer than 1,150 m, and it is the same fact.

Heights are structural, to the architectural top rather than the tip of an
aerial, because that is the figure people picture. The natural features are
prominence above sea level. Both are stable, published numbers that will not
need maintaining.

Pure functions. No I/O, no dependencies. See test_landmarks.py.
"""

# (name, metres, where). Ordered small to large; the picker relies on it.
LANDMARKS = (
    ("the Statue of Liberty", 93, "New York"),
    ("Big Ben", 96, "London"),
    ("Nelson's Column", 52, "London"),
    ("the Great Pyramid", 139, "Giza"),
    ("the Washington Monument", 169, "Washington DC"),
    ("the Golden Gate Bridge towers", 227, "San Francisco"),
    ("the Eiffel Tower", 300, "Paris"),
    ("the Chrysler Building", 319, "New York"),
    ("the Empire State Building", 381, "New York"),
    ("the Shard", 310, "London"),
    ("One World Trade Center", 541, "New York"),
    ("the CN Tower", 553, "Toronto"),
    ("the Burj Khalifa", 828, "Dubai"),
    ("Table Mountain", 1085, "Cape Town"),
    ("Ben Nevis", 1345, "Scotland"),
    ("Snowdon", 1085, "Wales"),
    ("Mount Fuji", 3776, "Japan"),
    ("the Matterhorn", 4478, "the Alps"),
    ("Mont Blanc", 4808, "the Alps"),
    ("Denali", 6190, "Alaska"),
    ("Everest", 8849, "the Himalaya"),
)

# How many repeats of a landmark still mean something. Past this the comparison
# stops being a picture and turns back into a number.
MAX_REPEATS = 12.0
MIN_REPEATS = 1.0


def compare(ascent_m, landmarks=LANDMARKS):
    """The landmark that best pictures this much climbing. -> dict|None.

    Picks the largest landmark you have climbed at least once, so the count stays
    small and imaginable. Below the smallest landmark there is nothing useful to
    say, and None is the honest answer.
    """
    if not ascent_m or ascent_m <= 0:
        return None

    best = None
    for name, height, where in landmarks:
        if height <= 0:
            continue
        repeats = ascent_m / height
        if repeats < MIN_REPEATS:
            continue
        # Prefer the tallest thing still climbed at least once; among those, the
        # one giving the most readable count.
        if best is None or height > best[1]:
            best = (name, height, where, repeats)

    if best is None:
        return None
    name, height, where, repeats = best
    return {"name": name, "height_m": height, "where": where,
            "repeats": repeats, "phrase": _phrase(name, repeats)}


def _phrase(name, repeats):
    """Say it the way a person would."""
    if repeats < 1.1:
        return name.capitalize() if name.startswith("the ") is False else name
    if repeats < 1.6:
        return "one and a half %s" % _plural(name)
    if repeats < 2.0:
        return "nearly two %s" % _plural(name)
    if repeats < MAX_REPEATS:
        return "%.1f %s" % (repeats, _plural(name))
    return "%.0f %s" % (repeats, _plural(name))


def _plural(name):
    """Rough pluralisation for the handful of shapes in the table."""
    stem = name[4:] if name.startswith("the ") else name
    if stem.endswith("s"):
        return stem
    if stem.endswith("y") and stem[-2:-1] not in "aeiou":
        return stem[:-1] + "ies"
    return stem + "s"


def ladder(ascent_m, landmarks=LANDMARKS):
    """Everything this much climbing has cleared, tallest first. -> [dict].

    Useful as a progress list: what you have passed, and what is next.
    """
    if not ascent_m or ascent_m <= 0:
        return []
    out = [{"name": name, "height_m": height, "where": where,
            "repeats": ascent_m / height, "cleared": ascent_m >= height}
           for name, height, where in landmarks]
    out.sort(key=lambda item: item["height_m"], reverse=True)
    return out


def next_up(ascent_m, landmarks=LANDMARKS):
    """The next landmark still out of reach. -> dict|None."""
    remaining = [(name, height, where) for name, height, where in landmarks
                 if height > (ascent_m or 0)]
    if not remaining:
        return None
    name, height, where = min(remaining, key=lambda item: item[1])
    return {"name": name, "height_m": height, "where": where,
            "to_go_m": height - (ascent_m or 0)}
