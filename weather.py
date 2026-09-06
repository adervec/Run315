"""What the weather did to the run.

A summer easy run at the same heart rate is simply slower, and comparing it
against a January one without saying so makes an athlete think they have lost
fitness in a heatwave. So the pace gets corrected for the conditions before it
gets compared to anything.

The correction is built on two well-established observations:

  * running slows in a roughly quadratic way once the air is above about 13 C,
    which is where most published heat-and-pace tables put the inflection
  * humidity matters through the heat index, not on its own -- 25 C at 30%
    humidity and 25 C at 90% are very different runs

Everything here is an approximation of a population effect. Individuals
acclimatise at different rates and the same athlete responds differently in
April and in August. It is a lens, not a measurement.

Pure functions. No I/O, no dependencies. See test_weather.py.
"""
import math

# Below this, temperature is not what is slowing you down.
NEUTRAL_C = 13.0

# Fraction slower per degree above neutral, applied quadratically. Calibrated so
# 20 C costs about 1.5%, 25 C about 4% and 30 C about 8-9%, which is where the
# published heat-and-pace tables sit.
# ponytail: one curve for everybody. An acclimatised athlete suffers far less;
# fit the coefficient per athlete once there are enough hot runs to fit it from.
HEAT_K = 0.0003

# The heat index is built for perceived comfort standing still, and it amplifies
# humidity hard. Applying the pace curve to the raw index double-counts it, so
# only half the amplification is carried through.
HUMIDITY_WEIGHT = 0.5

MAX_PENALTY = 0.15          # a run you finished was not 25% slower
COLD_C = -5.0               # below this, cold and footing start costing time too
COLD_K = 0.0012


def heat_index_c(temp_c, humidity_pct):
    """Apparent temperature in Celsius, or the plain temperature if unknown.

    The Rothfusz regression is defined in Fahrenheit, so the conversion happens
    here rather than leaving a magic table in the caller. Below about 27 C the
    regression is not meaningful and the dry temperature is the honest answer.
    """
    if temp_c is None:
        return None
    if humidity_pct is None:
        return float(temp_c)
    humidity = max(0.0, min(100.0, float(humidity_pct)))
    t_f = float(temp_c) * 9.0 / 5.0 + 32.0
    if t_f < 80.0:
        return float(temp_c)

    hi = (-42.379 + 2.04901523 * t_f + 10.14333127 * humidity
          - 0.22475541 * t_f * humidity - 0.00683783 * t_f * t_f
          - 0.05481717 * humidity * humidity + 0.00122874 * t_f * t_f * humidity
          + 0.00085282 * t_f * humidity * humidity
          - 0.00000199 * t_f * t_f * humidity * humidity)
    return (hi - 32.0) * 5.0 / 9.0


def penalty(temp_c, humidity_pct=None, dew_point_c=None):
    """How much slower these conditions make you, as a fraction. 0 when benign.

    Dew point is the better single number for how hard it is to shed heat, so it
    wins when the watch reports it; humidity is the fallback.
    """
    if temp_c is None:
        return 0.0
    index = heat_index_c(temp_c, humidity_pct)
    felt = float(temp_c) + HUMIDITY_WEIGHT * (index - float(temp_c))
    if dew_point_c is not None:
        # Above a dew point of about 15 C sweat stops evaporating usefully, and
        # each further degree costs more than the dry temperature alone implies.
        muggy = max(0.0, float(dew_point_c) - 15.0)
        felt = max(felt, float(temp_c) + muggy * 0.8)

    if felt > NEUTRAL_C:
        over = felt - NEUTRAL_C
        return min(MAX_PENALTY, HEAT_K * over * over)
    if felt < COLD_C:
        return min(MAX_PENALTY, COLD_K * (COLD_C - felt))
    return 0.0


def adjust(pace_s_per_km, temp_c, humidity_pct=None, dew_point_c=None):
    """What this pace would have been in neutral conditions. Lower is better."""
    if not pace_s_per_km:
        return None
    return pace_s_per_km / (1.0 + penalty(temp_c, humidity_pct, dew_point_c))


def describe(temp_c, humidity_pct=None, dew_point_c=None):
    """One line on the conditions and what they cost."""
    if temp_c is None:
        return None
    cost = penalty(temp_c, humidity_pct, dew_point_c)
    felt = heat_index_c(temp_c, humidity_pct)
    bits = ["%.0f C" % temp_c]
    if humidity_pct is not None:
        bits.append("%.0f%% humidity" % humidity_pct)
    if dew_point_c is not None:
        bits.append("%.0f C dew point" % dew_point_c)
    if felt is not None and abs(felt - temp_c) >= 1.0:
        bits.append("feels like %.0f C" % felt)

    conditions = ", ".join(bits)
    if cost < 0.005:
        return "%s -- good conditions, no correction worth making." % conditions
    return ("%s -- worth about %.1f%%, so your corrected pace is what matters."
            % (conditions, cost * 100))


def season_summary(rows):
    """Group runs by how hot they were, to show the effect over a whole year.

    `rows` is [(temp_c, pace_s_per_km, humidity, dew_point)]. -> [dict] per band,
    coldest first, with the raw and corrected mean pace in each.
    """
    bands = ((-99.0, 5.0, "Under 5 C"), (5.0, 13.0, "5-13 C"),
             (13.0, 20.0, "13-20 C"), (20.0, 26.0, "20-26 C"),
             (26.0, 99.0, "Over 26 C"))
    out = []
    for lo, hi, label in bands:
        got = [r for r in rows
               if r and r[0] is not None and r[1] and lo <= r[0] < hi]
        if not got:
            continue
        raw = sum(r[1] for r in got) / len(got)
        corrected = [adjust(r[1], r[0],
                            r[2] if len(r) > 2 else None,
                            r[3] if len(r) > 3 else None) for r in got]
        out.append({
            "label": label, "runs": len(got),
            "mean_pace": raw,
            "mean_adjusted": sum(corrected) / len(corrected),
            "mean_temp": sum(r[0] for r in got) / len(got),
        })
    return out


def normalise(raw):
    """Garmin's activity weather blob -> the fields we care about, or None.

    Garmin reports Fahrenheit for accounts set to imperial units and Celsius for
    everyone else, with no flag saying which. A "temperature" of 86 is not a
    summer's day in Celsius, so the unit is inferred from the value.
    """
    if not isinstance(raw, dict):
        return None

    def num(*keys):
        for key in keys:
            value = raw.get(key)
            if value is None:
                continue
            try:
                out = float(value)
            except (TypeError, ValueError):
                continue
            return None if out != out else out
        return None

    temp = num("temp", "temperature", "apparentTemp")
    dew = num("dewPoint", "dewpoint")
    # Nobody runs in 45 C and everyone has run in 5 C, so a high reading is F.
    if temp is not None and temp > 45.0:
        temp = (temp - 32.0) * 5.0 / 9.0
        if dew is not None:
            dew = (dew - 32.0) * 5.0 / 9.0

    humidity = num("relativeHumidity", "humidity")
    if humidity is not None and not (0.0 <= humidity <= 100.0):
        humidity = None

    if temp is None and humidity is None:
        return None
    return {
        "temp_c": temp,
        "humidity": humidity,
        "dew_point_c": dew,
        "wind_kph": num("windSpeed", "windSpeedKph"),
        "conditions": (raw.get("weatherTypeDTO") or {}).get("desc")
                      if isinstance(raw.get("weatherTypeDTO"), dict)
                      else (raw.get("weatherStationDTO") or {}).get("desc")
                      if isinstance(raw.get("weatherStationDTO"), dict) else None,
    }


# ---------------------------------------------------------------------------
# Heat acclimatisation
#
# Repeated exposure to running in the heat produces real, measurable adaptation:
# plasma volume expands, sweating starts earlier and more dilutely, and heart
# rate at a given effort falls. The classic protocol is 10-14 consecutive days
# of heat exposure, with most of the adaptation arriving in the first week
# (Periard, Racinais & Sawka, Scand J Med Sci Sports 2015, is the standard
# review). It also decays: roughly a quarter of the gain is lost within a week
# of stopping, and most of it within a month.
#
# What follows is a bookkeeping model, not a physiological one. It tracks how
# much heat exposure is in the recent past, decayed over time, and says where
# that puts you. It cannot measure your plasma volume, and does not pretend to.

ACCLIMATION_DAYS = 14        # the window the classic protocols use
ACCLIMATION_HALF_LIFE = 8.0  # days; decay is faster than the gain, as reported
HOT_RUN_C = 22.0             # below this a run does not count as heat exposure
FULL_EXPOSURE_MIN = 45.0     # minutes in the heat for a session to count fully
# Sessions needed for the bands. Ten to fourteen is the published protocol.
# Calibrated against the protocol rather than guessed: decay means 14 consecutive
# hot sessions bank ~8.5 units, not 14, so the top band sits there. Three
# consecutive hot days bank ~2.8, which should read as "starting", not "none".
ACCLIMATION_BANDS = ((0.5, "none"), (2.0, "starting"), (5.0, "partial"),
                     (8.0, "most of the way"))


def heat_exposure(runs, today, half_life=ACCLIMATION_HALF_LIFE):
    """How much heat training is still in the bank. -> dict.

    `runs` is [(date, temp_c, minutes)]. Each hot session counts for up to one
    unit, scaled by how long it lasted, then decayed by how long ago it was.
    """
    if not runs:
        return {"sessions": 0.0, "recent": 0, "band": "none", "hottest_c": None,
                "note": "No hot running on record recently."}

    total = 0.0
    recent = 0
    hottest = None
    for when, temp_c, minutes in runs:
        if temp_c is None or temp_c < HOT_RUN_C:
            continue
        day = when.date() if hasattr(when, "date") else when
        days_ago = (today - day).days
        if days_ago < 0:
            continue
        hottest = temp_c if hottest is None else max(hottest, temp_c)
        if days_ago <= ACCLIMATION_DAYS:
            recent += 1
        # A longer session in the heat is worth more, up to one whole unit.
        weight = min((minutes or 0.0) / FULL_EXPOSURE_MIN, 1.0)
        total += weight * (0.5 ** (days_ago / half_life))

    band = "none"
    for threshold, name in ACCLIMATION_BANDS:
        if total >= threshold:
            band = name
    return {"sessions": total, "recent": recent, "band": band,
            "hottest_c": hottest, "note": _acclimation_note(band, total)}


def _acclimation_note(band, sessions):
    if band == "none":
        return ("Nothing recent in the heat. A hot race would cost you more than "
                "the pace adjustment on this page suggests.")
    if band == "starting":
        return ("A couple of hot sessions in the bank. The first week of heat "
                "training is where most of the adaptation happens, so this is "
                "the part worth continuing.")
    if band == "partial":
        return ("Part-adapted: roughly %.0f sessions' worth of heat exposure "
                "still counting. Another week of it would finish the job."
                % sessions)
    return ("Well heat-adapted on paper -- around %.0f sessions' worth still in "
            "the bank. It fades within a few weeks of stopping." % sessions)
