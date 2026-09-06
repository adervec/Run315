"""Self-check for the POI layer catalogue. Run: python test_pois.py"""
import pois as P


def test_catalogue_is_coherent():
    ids = [l.id for l in P.LAYERS]
    assert len(ids) == len(set(ids)), "duplicate layer id"
    assert len(P.LAYERS) >= 15
    for layer in P.LAYERS:
        assert layer.label and layer.icon and layer.group
        assert layer.match, layer.id
        assert layer.radius > 0
        for rule in layer.match:
            assert isinstance(rule, dict) and rule
    # The things that cost money are the ones flagged for a free filter.
    paid = {l.id for l in P.LAYERS if l.fee_matters}
    assert paid == {"toilets", "shower", "pool"}, paid


def test_groups_preserve_order_and_cover_everything():
    gs = P.groups()
    assert [g for g, _ in gs] == ["Body", "Fuel", "Water", "Along the way", "Getting there"]
    covered = [l.id for _g, layers in gs for l in layers]
    assert sorted(covered) == sorted(l.id for l in P.LAYERS)


def test_selectors_are_generated_from_the_match_rules():
    water = P.BY_ID["water"]
    sels = water.selectors()
    assert '["amenity"="drinking_water"]' in sels
    # A two-tag rule becomes a two-clause selector, sorted for stability.
    assert '["drinking_water"="yes"]["man_made"="water_tap"]' in sels
    assert P.BY_ID["beach"].selectors() == ['["natural"="beach"]',
                                            '["leisure"="beach_resort"]']


def test_classify():
    assert P.classify({"amenity": "toilets"}).id == "toilets"
    assert P.classify({"natural": "beach"}).id == "beach"
    assert P.classify({"leisure": "water_park"}).id == "waterpark"
    assert P.classify({"shop": "coffee"}).id == "coffee"
    assert P.classify({"highway": "bus_stop"}).id == "transit"
    assert P.classify({"amenity": "bench"}).id == "bench"
    assert P.classify({}) is None
    assert P.classify({"amenity": "nightclub"}) is None
    # A partial match on a two-tag rule is not a match.
    assert P.classify({"man_made": "water_tap"}) is None
    assert P.classify({"man_made": "water_tap", "drinking_water": "yes"}).id == "water"
    # Coffee is listed before food, so a cafe is coffee.
    assert P.classify({"amenity": "cafe", "cuisine": "coffee_shop"}).id == "coffee"


def test_is_free():
    assert P.is_free({"fee": "no"}) is True
    assert P.is_free({"access": "public"}) is True
    assert P.is_free({"fee": "yes"}) is False
    assert P.is_free({"fee": "Yes"}) is False              # case does not matter
    assert P.is_free({"access": "customers"}) is False
    assert P.is_free({"access": "private"}) is False
    assert P.is_free({}) is None                           # nobody has said
    # Locked beats free: a toilet marked fee=no behind a private door is not free.
    assert P.is_free({"fee": "no", "access": "private"}) is False


def test_thin():
    assert P.thin([]) == []
    assert P.thin([(1, 2)]) == [(1.0, 2.0)]
    line = [(47.0 + i * 0.001, 8.0) for i in range(1000)]
    out = P.thin(line, limit=50)
    assert len(out) == 50
    assert out[0] == line[0] and out[-1] == line[-1]       # both ends kept
    # Junk is dropped, not crashed on.
    assert P.thin([(None, 1), ("x", 2), (47.0, 8.0), (999, 8.0),
                   (float("nan"), 8.0)]) == [(47.0, 8.0)]


def test_build_query():
    line = [(47.37, 8.54), (47.38, 8.55), (47.39, 8.56)]
    q = P.build_query(line, ["toilets", "beach"])
    assert q.startswith("[out:json][timeout:60];(")
    assert q.endswith("out center tags %d;" % P.MAX_RESULTS)
    assert '["amenity"="toilets"]' in q and '["natural"="beach"]' in q
    assert "nwr(around:%d," % P.NEAR in q                  # toilets: close
    assert "nwr(around:%d," % P.WIDE in q                  # beach: wider
    assert "47.37000,8.54000" in q
    # Everything asked for goes in one union, not one query per layer.
    assert q.count("[out:json]") == 1

    assert P.build_query(line, []) is None
    assert P.build_query(line, ["nonsense"]) is None
    assert P.build_query([(47.0, 8.0)], ["toilets"]) is None
    assert P.build_query([], ["toilets"]) is None


def test_build_query_caps_the_corridor():
    long_line = [(47.0 + i * 0.0001, 8.0) for i in range(5000)]
    q = P.build_query(long_line, ["toilets"])
    assert q.count("47.") <= P.MAX_CORRIDOR_POINTS + 2


def test_parse():
    data = {"elements": [
        {"type": "node", "id": 1, "lat": 47.1, "lon": 8.1,
         "tags": {"amenity": "toilets", "fee": "no", "name": "Park WC"}},
        {"type": "node", "id": 2, "lat": 47.2, "lon": 8.2,
         "tags": {"amenity": "toilets", "fee": "yes"}},
        {"type": "way", "id": 3, "center": {"lat": 47.3, "lon": 8.3},
         "tags": {"natural": "beach", "name": "Strandbad"}},
        {"type": "node", "id": 4, "lat": 47.4, "lon": 8.4,
         "tags": {"amenity": "nightclub"}},                # not in any layer
        {"type": "node", "id": 5, "lat": 47.5, "lon": 8.5, "tags": {}},
        {"type": "way", "id": 6, "tags": {"leisure": "water_park"}},   # no centre
    ]}
    out = P.parse(data)
    ids = [(o["layer"], o["name"]) for o in out]
    assert ("toilets", "Park WC") in ids
    assert ("beach", "Strandbad") in ids
    assert len(out) == 3, ids                              # nightclub, bare node, no-centre dropped

    free = {o["name"]: o["free"] for o in out if o["layer"] == "toilets"}
    assert free["Park WC"] is True
    assert free["Toilets"] is False                        # unnamed, falls back to the label

    # Ways get their centre, and areas come through as points.
    beach = [o for o in out if o["layer"] == "beach"][0]
    assert beach["lat"] == 47.3 and beach["lon"] == 8.3

    # free_only drops the paid one but keeps things where fee is irrelevant.
    only_free = P.parse(data, free_only=True)
    assert [o["name"] for o in only_free if o["layer"] == "toilets"] == ["Park WC"]
    assert any(o["layer"] == "beach" for o in only_free)

    # Asking for one layer returns only that layer.
    assert {o["layer"] for o in P.parse(data, ["beach"])} == {"beach"}
    assert P.parse({}) == [] and P.parse(None) == []


def test_parse_dedupes_and_carries_detail():
    data = {"elements": [
        {"type": "node", "id": 9, "lat": 47.1, "lon": 8.1,
         "tags": {"amenity": "cafe", "name": "Kaffee", "opening_hours": "Mo-Fr 07:00-18:00",
                  "wheelchair": "yes"}},
        {"type": "node", "id": 9, "lat": 47.1, "lon": 8.1,
         "tags": {"amenity": "cafe", "name": "Kaffee"}},    # same element twice
    ]}
    out = P.parse(data)
    assert len(out) == 1
    assert out[0]["hours"] == "Mo-Fr 07:00-18:00"
    assert out[0]["wheelchair"] == "yes"
    assert out[0]["icon"] == P.BY_ID["coffee"].icon
    assert out[0]["fee_matters"] is False
    assert out[0]["free"] is None                          # fee is irrelevant for a cafe


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
