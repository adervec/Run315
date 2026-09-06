"""Self-check for fuelling. Run: python test_fuelling.py"""
import fuelling as FU


def test_carb_bands_match_the_published_guidance():
    # Under 45 minutes: nothing needed.
    short = FU.carb_target(30 * 60)
    assert short["per_hour_high"] == 0
    assert "glycogen covers it" in short["note"]

    # 45-75 minutes: small amounts or a mouth rinse.
    rinse = FU.carb_target(60 * 60 - 1)
    assert rinse["per_hour_high"] == 30
    assert "mouth rinse" in rinse["note"]

    # 1-2.5 hours: the familiar 30-60 g/h.
    standard = FU.carb_target(90 * 60)
    assert (standard["per_hour_low"], standard["per_hour_high"]) == (30, 60)
    assert standard["needs_mixed_sugars"] is False

    # Beyond 2.5 hours: up to 90, and only with mixed sugars.
    long_race = FU.carb_target(3 * 3600)
    assert (long_race["per_hour_low"], long_race["per_hour_high"]) == (60, 90)
    assert long_race["needs_mixed_sugars"] is True
    assert "fructose" in long_race["note"]


def test_the_mixed_sugar_ceiling_is_the_point():
    """Above the single-transporter ceiling the advice must change, not just scale."""
    below = FU.carb_target(2 * 3600)
    above = FU.carb_target(4 * 3600)
    assert below["per_hour_high"] <= FU.SINGLE_SUGAR_CEILING
    assert above["per_hour_high"] > FU.SINGLE_SUGAR_CEILING
    assert not below["needs_mixed_sugars"] and above["needs_mixed_sugars"]
    assert "fructose" not in below["note"]


def test_carb_totals_scale_with_duration():
    two = FU.carb_target(2 * 3600)
    assert abs(two["total_low"] - 60) < 1e-9        # 30 g/h for 2 h
    assert abs(two["total_high"] - 120) < 1e-9
    assert FU.carb_target(0) is None
    assert FU.carb_target(None) is None


def test_fluid_widens_in_the_heat_and_warns_about_overdrinking():
    cool = FU.fluid_target(3 * 3600, temp_c=8.0)
    hot = FU.fluid_target(3 * 3600, temp_c=28.0)
    assert hot["per_hour_high"] > cool["per_hour_high"]
    assert hot["hot"] and not cool["hot"]
    # The hyponatraemia warning is a safety point, not decoration.
    assert "thirst" in cool["note"] and "sodium" in cool["note"]
    # No temperature at all is treated as not hot rather than crashing.
    assert FU.fluid_target(3600)["hot"] is False
    assert FU.fluid_target(0) is None


def test_sodium_only_appears_when_it_matters():
    assert FU.sodium_target(60 * 60) is None          # an hour: not yet
    long_race = FU.sodium_target(3 * 3600, temp_c=25.0)
    assert long_race is not None
    assert long_race["per_litre_low"] == 300
    assert long_race["total_high"] > long_race["total_low"] > 0


def test_loading_only_for_races_long_enough_to_need_it():
    assert FU.loading(45 * 60) is None
    marathon = FU.loading(3.5 * 3600, weight_kg=70)
    assert marathon["g_per_kg_low"] == 8
    assert abs(marathon["grams_low"] - 560) < 1e-9   # 8 g/kg x 70 kg
    assert abs(marathon["grams_high"] - 840) < 1e-9
    # Without a weight it still gives the per-kilo figures.
    assert "grams_low" not in FU.loading(3.5 * 3600)


def test_schedule_spaces_intake_and_stops_before_the_finish():
    items = FU.schedule(3 * 3600)
    assert items, "a three-hour race needs a schedule"
    # Nothing in the last ten minutes: it would not be absorbed in time.
    assert all(i["at_s"] <= 3 * 3600 - 600 for i in items)
    # Evenly spaced, so no gap is more than a little larger than any other.
    gaps = [b["at_s"] - a["at_s"] for a, b in zip(items, items[1:])]
    if gaps:
        assert max(gaps) - min(gaps) < 1.0
    # Cumulative total lands inside the recommended band.
    target = FU.carb_target(3 * 3600)
    total = items[-1]["cumulative_g"]
    assert target["total_low"] * 0.8 <= total <= target["total_high"] * 1.2, total

    # A short run needs no schedule at all.
    assert FU.schedule(20 * 60) == []
    assert FU.schedule(0) == []


def test_schedule_respects_a_custom_rate():
    """An athlete who has trained their gut can ask for more."""
    default = FU.schedule(3 * 3600)
    trained = FU.schedule(3 * 3600, carbs_per_hour=90)
    assert len(trained) > len(default)
    assert trained[-1]["cumulative_g"] > default[-1]["cumulative_g"]


def test_plan_assembles_the_parts_that_apply():
    marathon = FU.plan(3.5 * 3600, temp_c=24.0, weight_kg=70)
    assert marathon["carbs"]["needs_mixed_sugars"]
    assert marathon["fluid"]["hot"]
    assert marathon["sodium"] and marathon["loading"]
    assert marathon["schedule"]

    # A parkrun gets carbohydrate advice saying "none" and nothing else.
    parkrun = FU.plan(22 * 60)
    assert parkrun["carbs"]["per_hour_high"] == 0
    assert parkrun["sodium"] is None and parkrun["loading"] is None
    assert parkrun["schedule"] == []

    assert FU.plan(0) is None


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
