"""What to carry, and when to take it.

The app will tell you what pace to run a marathon at and how your engine holds
up over three hours, and then says nothing at all about the thing that most
often ends those three hours badly. Running out of carbohydrate is not a pacing
error and no amount of grade-adjusted anything will save you from it.

The numbers here are the published consensus ranges, not invented ones:

  * **Under 45 minutes:** nothing needed. Muscle glycogen covers it.
  * **45-75 minutes:** small amounts, or a carbohydrate mouth rinse, which works
    through the brain rather than the gut.
  * **1-2.5 hours:** 30-60 g of carbohydrate per hour.
  * **Beyond ~2.5 hours:** up to 90 g per hour, but only using *multiple
    transportable carbohydrates* -- glucose and fructose together, roughly 2:1.
    Glucose transport alone saturates near 60 g/h, so a single-sugar gel taken
    faster than that mostly sits in your stomach.

That last point is the one people get wrong, and it is why the recommendation is
a sugar mix rather than simply "more gels".

Source: Jeukendrup, *A Step Towards Personalized Sports Nutrition: Carbohydrate
Intake During Exercise* (Sports Medicine 44, 2014), and the joint position stand
of the Academy of Nutrition and Dietetics, Dietitians of Canada and the ACSM
(2016). Both are consensus documents rather than single studies.

On fluid, this module deliberately gives a range and a warning rather than a
number. Drinking to a schedule regardless of thirst is how people end up
hyponatraemic, which is more dangerous than being a bit dehydrated and has
killed runners in big-city marathons. Thirst is the instrument.

Nothing here is medical advice, and gut tolerance is individual: 90 g/h is a
trained capacity, not a starting point.

Pure functions. No I/O, no dependencies. See test_fuelling.py.
"""

# Carbohydrate, grams per hour, by how long you will be out there.
# (duration_hours_at_least, low, high, note_key)
CARB_BANDS = (
    (0.0, 0, 0, "none"),
    (0.75, 0, 30, "rinse"),
    (1.0, 30, 60, "standard"),
    (2.5, 60, 90, "multiple"),
)

# Beyond this, a single sugar cannot be absorbed fast enough on its own.
SINGLE_SUGAR_CEILING = 60

# Fluid, millilitres per hour. A range, and the wide end is for heat.
FLUID_BASE = (400, 600)
FLUID_HOT = (500, 800)
HOT_C = 20.0

# Sodium, milligrams per litre of fluid, for efforts long enough to matter.
SODIUM_PER_LITRE = (300, 600)
SODIUM_MATTERS_H = 2.0

# Carbohydrate loading, grams per kilo per day, for races over this long.
LOADING_MATTERS_H = 1.5
LOADING_G_PER_KG = (8, 12)

# A gel is about this much carbohydrate, which is how people actually count.
GEL_G = 22


def carb_target(duration_s):
    """Carbohydrate per hour for an effort of this length. -> dict|None."""
    if not duration_s or duration_s <= 0:
        return None
    hours = duration_s / 3600.0
    low, high, key = 0, 0, "none"
    for threshold, lo, hi, note_key in CARB_BANDS:
        if hours >= threshold:
            low, high, key = lo, hi, note_key
    return {
        "hours": hours,
        "per_hour_low": low,
        "per_hour_high": high,
        "total_low": low * hours,
        "total_high": high * hours,
        "needs_mixed_sugars": high > SINGLE_SUGAR_CEILING,
        "note": _carb_note(key, low, high),
    }


def _carb_note(key, low, high):
    if key == "none":
        return ("Short enough that stored glycogen covers it. Carrying anything "
                "is optional.")
    if key == "rinse":
        return ("Around this length a carbohydrate mouth rinse works about as "
                "well as swallowing one -- the effect is on the brain, not the "
                "gut.")
    if key == "standard":
        return ("%d-%d g of carbohydrate an hour. A single sugar is fine at this "
                "rate; the gut absorbs it without help." % (low, high))
    return ("%d-%d g an hour, and above %d g it has to be a glucose-and-fructose "
            "mix, roughly 2:1. Glucose transport saturates near %d g/h, so "
            "taking more of a single-sugar gel mostly leaves it in your stomach."
            % (low, high, SINGLE_SUGAR_CEILING, SINGLE_SUGAR_CEILING))


def fluid_target(duration_s, temp_c=None):
    """Fluid per hour, as a range. -> dict|None.

    A range on purpose. Sweat rates vary several-fold between people and this
    module knows nothing about yours.
    """
    if not duration_s or duration_s <= 0:
        return None
    hot = temp_c is not None and temp_c >= HOT_C
    low, high = FLUID_HOT if hot else FLUID_BASE
    hours = duration_s / 3600.0
    return {
        "per_hour_low": low, "per_hour_high": high,
        "total_low": low * hours, "total_high": high * hours,
        "hot": hot,
        "note": ("Drink to thirst inside this range rather than to a schedule. "
                 "Overdrinking dilutes your blood sodium, which is more "
                 "dangerous than mild dehydration and does put runners in "
                 "hospital every year."),
    }


def sodium_target(duration_s, temp_c=None):
    """Sodium, for efforts long enough for it to matter. -> dict|None."""
    if not duration_s or duration_s / 3600.0 < SODIUM_MATTERS_H:
        return None
    fluid = fluid_target(duration_s, temp_c)
    if not fluid:
        return None
    low = SODIUM_PER_LITRE[0] * fluid["total_low"] / 1000.0
    high = SODIUM_PER_LITRE[1] * fluid["total_high"] / 1000.0
    return {"per_litre_low": SODIUM_PER_LITRE[0],
            "per_litre_high": SODIUM_PER_LITRE[1],
            "total_low": low, "total_high": high,
            "note": ("Most sports drinks land in this range already. It matters "
                     "more the longer and hotter the race, and more again if you "
                     "finish races with salt on your face.")}


def loading(duration_s, weight_kg=None):
    """Whether a carbohydrate load is worth doing, and how much. -> dict|None."""
    if not duration_s or duration_s / 3600.0 < LOADING_MATTERS_H:
        return None
    low, high = LOADING_G_PER_KG
    out = {"g_per_kg_low": low, "g_per_kg_high": high, "days": 2,
           "note": ("For a race this long, 36-48 hours of high-carbohydrate "
                    "eating beforehand measurably helps. It is about eating "
                    "more carbohydrate, not more food -- and the training taper "
                    "is what makes room for it.")}
    if weight_kg:
        out["grams_low"] = low * weight_kg
        out["grams_high"] = high * weight_kg
    return out


def schedule(duration_s, carbs_per_hour=None, gel_g=GEL_G):
    """When to take something, in minutes from the start. -> [dict].

    Spaced evenly rather than crammed late, because the gut empties at a rate
    and a backlog does not clear once you are working hard.
    """
    target = carb_target(duration_s)
    if not target or not target["per_hour_high"]:
        return []
    per_hour = carbs_per_hour or (target["per_hour_low"] + target["per_hour_high"]) / 2.0
    if per_hour <= 0 or gel_g <= 0:
        return []

    hours = duration_s / 3600.0
    count = int(round(per_hour * hours / gel_g))
    if count < 1:
        return []
    # Nothing in the last ten minutes: it will not be absorbed in time.
    usable = max(duration_s - 600.0, 0.0)
    if usable <= 0:
        return []
    gap = usable / count
    return [{"at_s": gap * (i + 1) - gap / 2.0,
             "at_min": (gap * (i + 1) - gap / 2.0) / 60.0,
             "grams": gel_g,
             "cumulative_g": gel_g * (i + 1)} for i in range(count)]


def plan(duration_s, temp_c=None, weight_kg=None):
    """Everything for one race. -> dict|None."""
    carbs = carb_target(duration_s)
    if not carbs:
        return None
    return {
        "duration_s": duration_s,
        "carbs": carbs,
        "fluid": fluid_target(duration_s, temp_c),
        "sodium": sodium_target(duration_s, temp_c),
        "loading": loading(duration_s, weight_kg),
        "schedule": schedule(duration_s),
        "temp_c": temp_c,
    }
