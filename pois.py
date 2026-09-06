"""Things worth knowing about along a route.

Toilets, water, coffee, beaches, pools. The map layers a runner actually plans
around, pulled from OpenStreetMap.

One rule holds this together: the match rules below are the single source of
truth. The Overpass selector for a layer is *generated* from the same rules used
to label the results, so the query and the labelling can never drift apart.

Pure functions. No I/O, no dependencies. See test_pois.py.
"""

# Radius around the route corridor, in metres. A toilet has to be close enough
# to be worth the detour; a beach is worth knowing about from further away.
NEAR = 120
WIDE = 300

# Values of `fee` and `access` that mean "not simply free to walk into".
PAID = frozenset(("yes", "some"))
SHUT = frozenset(("private", "customers", "permit", "no", "members"))


class Layer:
    """One toggleable map layer.

    `match` is a list of tag sets; an element belongs to this layer if it matches
    any one of them completely. A value of None means "this key, any value".
    """

    def __init__(self, id, label, icon, group, match, radius=NEAR, fee_matters=False):
        self.id = id
        self.label = label
        self.icon = icon
        self.group = group
        self.match = match
        self.radius = radius
        self.fee_matters = fee_matters      # worth filtering by "free only"

    def selectors(self):
        """OverpassQL tag selectors for this layer, one per match set."""
        out = []
        for rule in self.match:
            parts = []
            for key, value in sorted(rule.items()):
                parts.append('["%s"]' % key if value is None else '["%s"="%s"]' % (key, value))
            out.append("".join(parts))
        return out

    def matches(self, tags):
        return any(all(tags.get(k) == v if v is not None else k in tags
                       for k, v in rule.items())
                   for rule in self.match)


# Order matters: the first layer that matches an element wins, so the specific
# ones (a coffee shop) come before the general ones (somewhere that sells food).
LAYERS = [
    # --- the body ---
    Layer("toilets", "Toilets", "\U0001F6BB", "Body",
          [{"amenity": "toilets"}], NEAR, fee_matters=True),
    Layer("water", "Drinking water", "\U0001F6B0", "Body",
          [{"amenity": "drinking_water"},
           {"man_made": "water_tap", "drinking_water": "yes"},
           {"amenity": "fountain", "drinking_water": "yes"}]),
    Layer("shower", "Showers", "\U0001F6BF", "Body",
          [{"amenity": "shower"}], NEAR, fee_matters=True),
    Layer("pharmacy", "Pharmacy", "\U0001F48A", "Body",
          [{"amenity": "pharmacy"}]),

    # --- fuel ---
    Layer("coffee", "Coffee", "☕", "Fuel",
          [{"amenity": "cafe"}, {"shop": "coffee"}, {"cuisine": "coffee_shop"}]),
    Layer("food", "Food", "\U0001F374", "Fuel",
          [{"amenity": "restaurant"}, {"amenity": "fast_food"}]),
    Layer("shop", "Shops", "\U0001F3EA", "Fuel",
          [{"shop": "convenience"}, {"shop": "supermarket"}, {"shop": "bakery"}]),

    # --- water ---
    Layer("beach", "Beaches", "\U0001F3D6", "Water",
          [{"natural": "beach"}, {"leisure": "beach_resort"}], WIDE),
    Layer("waterpark", "Water parks", "\U0001F3A2", "Water",
          [{"leisure": "water_park"}], WIDE),
    Layer("pool", "Pools & lidos", "\U0001F3CA", "Water",
          [{"leisure": "swimming_pool"}, {"leisure": "swimming_area"}],
          WIDE, fee_matters=True),

    # --- getting round ---
    Layer("viewpoint", "Viewpoints", "\U0001F5FB", "Along the way",
          [{"tourism": "viewpoint"}]),
    Layer("shelter", "Shelter", "⛺", "Along the way",
          [{"amenity": "shelter"}]),
    Layer("bench", "Benches", "\U0001FA91", "Along the way",
          [{"amenity": "bench"}]),
    Layer("playground", "Playgrounds", "\U0001F6DD", "Along the way",
          [{"leisure": "playground"}], WIDE),
    Layer("bikerepair", "Bike repair", "\U0001F527", "Along the way",
          [{"amenity": "bicycle_repair_station"}]),
    Layer("parking", "Parking", "\U0001F17F", "Getting there",
          [{"amenity": "parking"}], WIDE),
    Layer("transit", "Transit", "\U0001F689", "Getting there",
          [{"railway": "station"}, {"railway": "tram_stop"}, {"highway": "bus_stop"}]),
]

BY_ID = {layer.id: layer for layer in LAYERS}
# An around: polyline this long already blankets the route -- more points only
# make the query heavier for the same answer, and Overpass starts refusing.
MAX_CORRIDOR_POINTS = 80
MAX_RESULTS = 600


def groups():
    """[(group name, [layers])] in catalogue order, for building the UI."""
    out, seen = [], {}
    for layer in LAYERS:
        if layer.group not in seen:
            seen[layer.group] = []
            out.append((layer.group, seen[layer.group]))
        seen[layer.group].append(layer)
    return out


def is_free(tags):
    """True / False / None (nobody has said). Only meaningful where fee matters."""
    fee = (tags.get("fee") or "").strip().lower()
    access = (tags.get("access") or "").strip().lower()
    if access in SHUT:
        return False
    if fee in PAID:
        return False
    if fee == "no" or access in ("yes", "public", "permissive"):
        return True
    return None


def thin(points, limit=MAX_CORRIDOR_POINTS):
    """Evenly reduce a route to at most `limit` points, keeping both ends."""
    clean = []
    for p in points or []:
        if not p or len(p) < 2:
            continue
        try:
            lat, lon = float(p[0]), float(p[1])
        except (TypeError, ValueError):
            continue
        if lat != lat or lon != lon:
            continue
        if -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0:
            clean.append((lat, lon))
    if len(clean) <= limit:
        return clean
    step = (len(clean) - 1) / float(limit - 1)
    return [clean[int(round(i * step))] for i in range(limit)]


def build_query(points, layer_ids, timeout=60):
    """OverpassQL for every requested layer along a route corridor.

    All layers go in one union so this is a single request no matter how many
    boxes are ticked -- Overpass is donated infrastructure and one query that
    asks for everything is far kinder than fifteen that each ask for one thing.
    """
    corridor = thin(points)
    if len(corridor) < 2:
        return None
    wanted = [BY_ID[i] for i in layer_ids if i in BY_ID]
    if not wanted:
        return None

    line = ",".join("%.5f,%.5f" % (lat, lon) for lat, lon in corridor)
    parts = []
    for layer in wanted:
        for sel in layer.selectors():
            # nwr, not node: a beach or a pool is an area, not a pin.
            parts.append("nwr(around:%d,%s)%s;" % (layer.radius, line, sel))
    return ("[out:json][timeout:%d];(%s);out center tags %d;"
            % (timeout, "".join(parts), MAX_RESULTS))


def classify(tags):
    """Which layer an element belongs to, or None."""
    for layer in LAYERS:
        if layer.matches(tags):
            return layer
    return None


def parse(data, layer_ids=None, free_only=False):
    """Overpass JSON -> [{lat, lon, layer, label, name, free, ...}].

    Elements are labelled by re-matching their tags, so a cafe that came back
    because it is also a shop still lands in exactly one layer.
    """
    allowed = set(layer_ids) if layer_ids else None
    out, seen = [], set()
    for el in (data or {}).get("elements") or []:
        tags = el.get("tags") or {}
        layer = classify(tags)
        if not layer or (allowed and layer.id not in allowed):
            continue

        lat, lon = el.get("lat"), el.get("lon")
        if lat is None or lon is None:              # ways and relations
            centre = el.get("center") or {}
            lat, lon = centre.get("lat"), centre.get("lon")
        if lat is None or lon is None:
            continue

        free = is_free(tags) if layer.fee_matters else None
        if free_only and layer.fee_matters and free is False:
            continue

        key = (el.get("type"), el.get("id"))
        if key in seen:
            continue
        seen.add(key)

        out.append({
            "lat": round(float(lat), 6),
            "lon": round(float(lon), 6),
            "layer": layer.id,
            "icon": layer.icon,
            "name": (tags.get("name") or "").strip() or layer.label,
            "free": free,
            "fee_matters": layer.fee_matters,
            "hours": (tags.get("opening_hours") or "").strip() or None,
            "wheelchair": tags.get("wheelchair"),
        })
    return out
