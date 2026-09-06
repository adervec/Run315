"""Self-check for landmarks. Run: python test_landmarks.py"""
import landmarks as L


def test_heights_are_sane():
    """Guard the table itself: these are facts and should stay facts."""
    by_name = {name: height for name, height, _where in L.LANDMARKS}
    assert by_name["Everest"] == 8849
    assert by_name["the Eiffel Tower"] == 300
    assert by_name["the Burj Khalifa"] == 828
    assert by_name["Ben Nevis"] == 1345
    # Everest is the tallest thing in the table, and nothing is negative.
    assert max(h for _n, h, _w in L.LANDMARKS) == 8849
    assert all(h > 0 for _n, h, _w in L.LANDMARKS)
    # No duplicate names.
    names = [n for n, _h, _w in L.LANDMARKS]
    assert len(names) == len(set(names))


def test_compare_picks_the_tallest_thing_you_have_cleared():
    # 900 m clears the Burj Khalifa (828) but not Table Mountain (1085).
    result = L.compare(900.0)
    assert result["name"] == "the Burj Khalifa"
    assert 1.0 <= result["repeats"] < 1.1

    # 2,700 m clears Ben Nevis (1345) but not Fuji.
    big = L.compare(2700.0)
    assert big["name"] == "Ben Nevis"
    assert 2.0 < big["repeats"] < 2.1


def test_nothing_to_say_below_the_smallest_landmark():
    assert L.compare(10.0) is None
    assert L.compare(0.0) is None
    assert L.compare(None) is None
    # Nelson's Column is the smallest at 52 m.
    assert L.compare(51.0) is None
    assert L.compare(53.0)["name"] == "Nelson's Column"


def test_phrases_read_like_a_person_wrote_them():
    """Phrasing is tested against a one-entry table, because against the real one
    `compare` would keep picking a taller landmark and the multiple would change.
    """
    only = (("the Eiffel Tower", 300, "Paris"),)
    assert "one and a half" in L.compare(450.0, only)["phrase"]
    assert "nearly two" in L.compare(570.0, only)["phrase"]
    # A plain multiple reads as a number and a plural.
    phrase = L.compare(900.0, only)["phrase"]
    assert phrase.startswith("3.0 ") and "Eiffel Towers" in phrase
    # Just over once is named, not counted.
    assert L.compare(305.0, only)["phrase"] == "the Eiffel Tower"


def test_pluralisation():
    assert L._plural("the Eiffel Tower") == "Eiffel Towers"
    assert L._plural("Everest") == "Everests"
    # Already plural stays put rather than becoming "towerss".
    assert L._plural("the Golden Gate Bridge towers") == "Golden Gate Bridge towers"


def test_ladder_is_tallest_first_and_marks_what_is_cleared():
    rungs = L.ladder(1000.0)
    assert rungs[0]["name"] == "Everest"
    heights = [r["height_m"] for r in rungs]
    assert heights == sorted(heights, reverse=True)
    cleared = [r for r in rungs if r["cleared"]]
    assert all(r["height_m"] <= 1000 for r in cleared)
    assert all(not r["cleared"] for r in rungs if r["height_m"] > 1000)
    assert L.ladder(0.0) == []


def test_next_up_is_the_nearest_thing_still_out_of_reach():
    # Just past the Eiffel Tower (300), the next rung is the Shard (310).
    nxt = L.next_up(305.0)
    assert nxt["name"] == "the Shard"
    assert abs(nxt["to_go_m"] - 5.0) < 1e-9

    # Past Everest there is nothing left to chase.
    assert L.next_up(9000.0) is None
    # From nothing, the smallest is next.
    assert L.next_up(0.0)["name"] == "Nelson's Column"


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
