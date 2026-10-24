"""Garmin Connect fetch: activities, every per-sample channel, laps, weather, gear,
the daily sweep and Garmin's own estimates. Used by garmin-export.py.

Garmin has no consumer OAuth, so garmin-export.py logs in once and keeps only the
session tokens (shared with garmin_mcp's ~/.garminconnect) -- never the password.
"""
import logging
from datetime import datetime

from garminconnect import Garmin
from garminconnect.activity_details import parse_activity_detail_metrics

log = logging.getLogger(__name__)

def _seconds(activity, *keys):
    for k in keys:
        v = activity.get(k)
        if v:
            return float(v)
    return None


def _parse_start(activity):
    raw = activity.get("startTimeLocal") or activity.get("startTimeGMT")
    if not raw:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    return None


def normalise(activity):
    """Garmin's activity JSON -> the flat shape fitness.py and the DB expect."""
    start = _parse_start(activity)
    if not start or not activity.get("activityId"):
        return None
    kind = (activity.get("activityType") or {}).get("typeKey") or "other"
    return {
        "garmin_id": str(activity["activityId"]),
        "name": activity.get("activityName") or kind.replace("_", " ").title(),
        "type": kind,
        "start": start,
        "distance_m": float(activity.get("distance") or 0) or None,
        "moving_s": _seconds(activity, "movingDuration", "duration", "elapsedDuration"),
        "elapsed_s": _seconds(activity, "elapsedDuration", "duration"),
        "avg_hr": float(activity["averageHR"]) if activity.get("averageHR") else None,
        "max_hr": float(activity["maxHR"]) if activity.get("maxHR") else None,
        "elev_gain_m": float(activity["elevationGain"]) if activity.get("elevationGain") else None,
        "calories": float(activity["calories"]) if activity.get("calories") else None,
    }


def _distance_scale(stream_max, known_m):
    """Garmin reports stream distance in the account's unit. Work out which one.

    Returns the factor that converts a stream value into metres.
    """
    if not known_m or not stream_max or stream_max <= 0:
        return 1.0
    ratio = known_m / stream_max
    for factor, lo, hi in ((1.0, 0.8, 1.25),            # already metres
                           (1000.0, 800.0, 1250.0),     # kilometres
                           (1609.344, 1300.0, 1900.0)): # miles
        if lo <= ratio <= hi:
            return factor
    log.warning("garmin: stream distance unit unrecognised (ratio %.3f), assuming metres",
                ratio)
    return 1.0


def fetch_streams(api, activity_id, known_distance_m=None):
    """Per-sample stream for one activity.

    (seconds, metres, hr, lat, lon, elevation_m, cadence_spm, stride_m,
     ground_contact_ms, vertical_oscillation_cm)

    Everything after distance may be None: indoor runs have no GPS, not everyone
    wears a strap, and elevation depends on the device. Returns [] when there is
    no usable distance/time series -- treadmill entries and manually added
    activities often do not have one.
    """
    return streams_from_channels(fetch_channels(api, activity_id, known_distance_m))


def streams_from_channels(channels):
    """The legacy 10-wide tuple view of a wide channel capture.

    Everything written before the wide capture expects this shape, and it stays
    the canonical form for the pure analysis modules. New work should read the
    channel dict directly.
    """
    if not channels or "seconds" not in channels:
        return []
    count = len(channels["seconds"])

    def column(name):
        values = channels.get(name)
        return values if values else [None] * count

    cadence = channels.get("cadence_spm") or channels.get("run_cadence_spm")
    # Barometric elevation is the better channel; a GPS-only watch falls back.
    elevation = channels.get("elevation_m") or channels.get("gps_elevation_m")
    return list(zip(channels["seconds"], channels["metres"],
                    column("hr"), column("lat"), column("lon"),
                    elevation if elevation else [None] * count,
                    cadence if cadence else [None] * count,
                    column("stride_m"), column("gct_ms"),
                    column("vertical_oscillation_cm")))


# Channels we know how to name. Anything else the device reports is kept anyway,
# under its own Garmin key -- the point is to stop choosing in the fetch layer.
CHANNEL_NAMES = {
    "directHeartRate": "hr",
    "directLatitude": "lat",
    "directLongitude": "lon",
    "directElevation": "elevation_m",
    "directGpsElevation": "gps_elevation_m",
    "directDoubleCadence": "cadence_spm",
    "directRunCadence": "run_cadence_spm",
    "directBikeCadence": "bike_cadence_rpm",
    "directFractionalCadence": "fractional_cadence",
    "directStrideLength": "stride_m",
    "directGroundContactTime": "gct_ms",
    "directGroundContactBalanceLeft": "gct_balance_left_pct",
    "directVerticalOscillation": "vertical_oscillation_cm",
    "directVerticalRatio": "vertical_ratio_pct",
    "directPower": "power_w",
    "directAirPower": "air_power_w",
    "directFormPower": "form_power_w",
    "directLegSpringStiffness": "leg_spring_stiffness",
    "directStepSpeedLoss": "step_speed_loss",
    "directRespirationRate": "respiration_brpm",
    "directAirTemperature": "air_temp_c",
    "directPerformanceCondition": "performance_condition",
    "directSpeed": "speed_m_s",
    "directVerticalSpeed": "vertical_speed_m_s",
    "directGrade": "grade_pct",
    "directStrokes": "strokes",
    "directCorePower": "core_power_w",
    "sumStep": "steps",
}

# Channels carrying the sample's position in the run rather than a measurement.
_TIME_KEYS = ("sumMovingDuration", "sumDuration", "sumElapsedDuration")


def fetch_channels(api, activity_id, known_distance_m=None, maxchart=2000):
    """Every per-sample channel this device recorded. -> dict of lists.

    Returns {"seconds": [...], "metres": [...], <channel>: [...]}, all the same
    length, with None where a sample lacked that channel.

    This deliberately does not choose which metrics matter. Watches differ, new
    firmware adds channels, and a metric dropped at fetch time cannot be analysed
    later without re-downloading a year of activities.
    """
    details = api.get_activity_details(activity_id, maxchart=maxchart, maxpoly=0)
    samples = parse_activity_detail_metrics(details)
    if not samples:
        return {}

    present = set()
    for sample in samples:
        present.update(sample.keys())

    rows, first_ts = [], None
    for sample in samples:
        dist = sample.get("sumDistance")
        if dist is None:
            continue
        secs = None
        for key in _TIME_KEYS:
            if sample.get(key) is not None:
                secs = float(sample[key])
                break
        if secs is None:
            ts = sample.get("directTimestamp")
            if ts is None:
                continue
            first_ts = ts if first_ts is None else first_ts
            secs = (float(ts) - float(first_ts)) / 1000.0
        rows.append((secs, float(dist), sample))

    if len(rows) < 2:
        return {}

    scale = _distance_scale(max(r[1] for r in rows), known_distance_m)
    out = {"seconds": [r[0] for r in rows],
           "metres": [r[1] * scale for r in rows]}

    for key in sorted(present):
        if key in _TIME_KEYS or key in ("sumDistance", "directTimestamp"):
            continue
        name = CHANNEL_NAMES.get(key, key)
        column = []
        for _secs, _dist, sample in rows:
            value = sample.get(key)
            if value is None:
                column.append(None)
                continue
            try:
                number = float(value)
            except (TypeError, ValueError):
                column.append(None)
                continue
            column.append(None if number != number else number)   # drop NaN
        # A channel that is empty everywhere tells us nothing and costs storage.
        if any(v is not None for v in column):
            out[name] = column
    return out


def fetch_weather(api, activity_id):
    """Conditions for one activity, or None. Never fatal -- weather is a bonus.

    Garmin has no weather for indoor runs, for old imports, or for anywhere its
    station data does not reach, and none of that should stop a sync.
    """
    try:
        return api.get_activity_weather(activity_id)
    except Exception as e:
        log.debug("garmin: no weather for %s (%s)", activity_id, e)
        return None


def _dig(blob, *paths):
    """First value found at any of these dotted paths. Garmin nests differently
    per endpoint and per firmware, so every read here is a search, not a lookup."""
    for path in paths:
        node = blob
        for key in path.split("."):
            if isinstance(node, list):
                node = node[0] if node else None
            if not isinstance(node, dict):
                node = None
                break
            node = node.get(key)
        if node is None:
            continue
        if isinstance(node, (int, float)):
            value = float(node)
            if value == value and value > 0:
                return value
    return None


def fetch_wellness(api, day):
    """One night's HRV, resting heart rate and sleep. -> dict, or None.

    Every part is optional and fetched separately: a watch that reports sleep may
    not report HRV, and one missing endpoint must not cost the others.
    """
    iso = day.strftime("%Y-%m-%d")
    out = {"day": iso, "hrv_ms": None, "rhr": None,
           "sleep_hours": None, "sleep_score": None}

    try:
        hrv = api.get_hrv_data(iso)
        out["hrv_ms"] = _dig(hrv or {}, "hrvSummary.lastNightAvg",
                             "hrvSummary.weeklyAvg", "lastNightAvg")
    except Exception as e:
        log.debug("garmin: no hrv for %s (%s)", iso, e)

    try:
        rhr = api.get_rhr_day(iso)
        out["rhr"] = _dig(rhr or {},
                          "allMetrics.metricsMap.WELLNESS_RESTING_HEART_RATE.value",
                          "restingHeartRate")
    except Exception as e:
        log.debug("garmin: no resting hr for %s (%s)", iso, e)

    try:
        sleep = api.get_sleep_data(iso) or {}
        seconds = _dig(sleep, "dailySleepDTO.sleepTimeSeconds", "sleepTimeSeconds")
        if seconds:
            out["sleep_hours"] = seconds / 3600.0
        out["sleep_score"] = _dig(sleep, "dailySleepDTO.sleepScores.overall.value",
                                  "sleepScores.overall.value")
    except Exception as e:
        log.debug("garmin: no sleep for %s (%s)", iso, e)

    if not any(out[k] for k in ("hrv_ms", "rhr", "sleep_hours", "sleep_score")):
        return None
    return out


# Garmin labels its own race predictions by these keys.
_RACE_KEYS = ((5000, "time5K", "time5k"),
              (10000, "time10K", "time10k"),
              (21097, "timeHalfMarathon", "timeHalf"),
              (42195, "timeMarathon", "timeFull"))


def fetch_derived(api, day=None):
    """Garmin's own estimates, for comparison against ours. -> dict.

    Every one of these is optional: they depend on the watch, on how much the
    athlete has run, and in several cases on wearing a chest strap. A missing
    endpoint must never cost the others, so each is fetched on its own.

    Values are returned raw. Whether they agree with this app's numbers is
    secondopinion.py's business, not this module's.
    """
    iso = (day or datetime.now().date()).strftime("%Y-%m-%d")
    out = {"threshold_hr": None, "threshold_speed_m_s": None, "vo2max": None,
           "endurance_score": None, "hill_score": None, "races": {}}

    try:
        lt = api.get_lactate_threshold(iso) or {}
        out["threshold_hr"] = _dig(lt, "lactateThresholdHeartRate",
                                   "heartRate", "lactateThresholdBpm")
        speed = _dig(lt, "lactateThresholdSpeed", "speed")
        # Garmin reports this in m/s; anything above 12 is not a running speed.
        if speed and speed < 12.0:
            out["threshold_speed_m_s"] = speed
    except Exception as e:
        log.debug("garmin: no lactate threshold (%s)", e)

    try:
        metrics = api.get_max_metrics(iso) or {}
        out["vo2max"] = _dig(metrics, "generic.vo2MaxPreciseValue",
                             "generic.vo2MaxValue", "vo2MaxPreciseValue")
    except Exception as e:
        log.debug("garmin: no vo2max (%s)", e)

    try:
        out["endurance_score"] = _dig(api.get_endurance_score(iso) or {},
                                      "overallScore", "enduranceScore")
    except Exception as e:
        log.debug("garmin: no endurance score (%s)", e)

    try:
        out["hill_score"] = _dig(api.get_hill_score(iso) or {},
                                 "overallScore", "hillScore")
    except Exception as e:
        log.debug("garmin: no hill score (%s)", e)

    try:
        predictions = api.get_race_predictions() or {}
        for distance, *keys in _RACE_KEYS:
            seconds = _dig(predictions, *keys)
            # A prediction of zero means "not enough data", not "instantaneous".
            if seconds and seconds > 60:
                out["races"][distance] = seconds
    except Exception as e:
        log.debug("garmin: no race predictions (%s)", e)

    if not any(out[k] for k in ("threshold_hr", "vo2max", "endurance_score",
                                "hill_score")) and not out["races"]:
        return None
    return out


# Every daily endpoint worth having, as
# (column, method, args, *dotted paths to search for the value).
# Each is fetched independently so one unsupported watch feature cannot cost the
# rest, and each is a *search* rather than a lookup because Garmin nests the same
# figure differently per endpoint and per firmware.
DAILY_METRICS = (
    ("steps", "get_daily_steps", "range",
     "totalSteps", "steps"),
    ("floors", "get_floors", "day",
     "floorsAscended", "floorValuesArray"),
    ("stress_avg", "get_stress_data", "day",
     "avgStressLevel", "overallStressLevel"),
    ("stress_max", "get_stress_data", "day",
     "maxStressLevel"),
    ("body_battery_high", "get_body_battery", "range",
     "charged", "bodyBatteryValuesArray"),
    ("body_battery_low", "get_body_battery", "range",
     "drained"),
    ("spo2_avg", "get_spo2_data", "day",
     "averageSpO2", "avgSleepSpO2"),
    ("spo2_low", "get_spo2_data", "day",
     "lowestSpO2"),
    ("respiration_avg", "get_respiration_data", "day",
     "avgSleepRespirationValue", "avgWakingRespirationValue"),
    ("intensity_minutes", "get_intensity_minutes_data", "day",
     "moderateIntensityMinutes", "weeklyModerate"),
    ("vigorous_minutes", "get_intensity_minutes_data", "day",
     "vigorousIntensityMinutes", "weeklyVigorous"),
    ("weight_kg", "get_body_composition", "range",
     "totalAverage.weight", "weight"),
    ("body_fat_pct", "get_body_composition", "range",
     "totalAverage.bodyFat", "bodyFat"),
    ("training_readiness", "get_training_readiness", "day",
     "score", "level"),
    ("calories_total", "get_stats", "day",
     "totalKilocalories"),
    ("calories_active", "get_stats", "day",
     "activeKilocalories"),
    ("fitness_age", "get_fitnessage_data", "day",
     "chronologicalAge", "fitnessAge"),
)

# Sleep breaks down further than "hours", and the stages are the interesting part.
SLEEP_FIELDS = (
    ("deep_s", "dailySleepDTO.deepSleepSeconds", "deepSleepSeconds"),
    ("light_s", "dailySleepDTO.lightSleepSeconds", "lightSleepSeconds"),
    ("rem_s", "dailySleepDTO.remSleepSeconds", "remSleepSeconds"),
    ("awake_s", "dailySleepDTO.awakeSleepSeconds", "awakeSleepSeconds"),
    ("restless_count", "restlessMomentsCount", "dailySleepDTO.restlessMomentsCount"),
    ("avg_stress", "dailySleepDTO.avgSleepStress", "avgSleepStress"),
)


def _call(api, method, mode, iso):
    """Call one daily endpoint, whatever argument shape it wants."""
    fn = getattr(api, method, None)
    if fn is None:
        return None
    if mode == "range":
        return fn(iso, iso)
    return fn(iso)


def fetch_daily(api, day):
    """One day of everything the watch recorded off the run. -> dict|None.

    Seventeen metrics from a dozen endpoints, each isolated: a watch without a
    pulse oximeter must still give up its stress and steps.
    """
    iso = day.strftime("%Y-%m-%d")
    out = {"day": iso}
    cache = {}

    for column, method, mode, *paths in DAILY_METRICS:
        key = (method, mode)
        if key not in cache:
            try:
                cache[key] = _call(api, method, mode, iso)
            except Exception as e:
                log.debug("garmin: %s unavailable for %s (%s)", method, iso, e)
                cache[key] = None
        blob = cache[key]
        if blob is None:
            out[column] = None
            continue
        out[column] = _dig(blob, *paths)

    # Sleep stages come from one call, so fetch it once and pick it apart.
    try:
        sleep = api.get_sleep_data(iso) or {}
    except Exception as e:
        log.debug("garmin: no sleep detail for %s (%s)", iso, e)
        sleep = {}
    for column, *paths in SLEEP_FIELDS:
        out[column] = _dig(sleep, *paths)

    # Garmin reports body mass in grams. A 70,200 kg athlete would be notable.
    if out.get("weight_kg") and out["weight_kg"] > 500:
        out["weight_kg"] = out["weight_kg"] / 1000.0

    if not any(v for k, v in out.items() if k != "day"):
        return None
    return out


def fetch_activity_extras(api, activity_id):
    """Laps and time-in-zone for one activity. -> dict.

    Splits are the athlete's own structure -- the intervals they pressed lap for
    -- which is better evidence than anything inferred from the pace trace.
    """
    out = {"laps": [], "hr_zones": None, "power_zones": None}

    try:
        splits = api.get_activity_splits(activity_id) or {}
        for lap in (splits.get("lapDTOs") or splits.get("splits") or []):
            out["laps"].append({
                "index": lap.get("lapIndex"),
                "distance_m": lap.get("distance"),
                "duration_s": lap.get("duration") or lap.get("movingDuration"),
                "avg_hr": lap.get("averageHR"),
                "max_hr": lap.get("maxHR"),
                "avg_speed": lap.get("averageSpeed"),
                "elev_gain_m": lap.get("elevationGain"),
                "avg_cadence": lap.get("averageRunCadence")
                               or lap.get("averageBikeCadence"),
                "avg_power": lap.get("averagePower"),
            })
    except Exception as e:
        log.debug("garmin: no splits for %s (%s)", activity_id, e)

    for key, method in (("hr_zones", "get_activity_hr_in_timezones"),
                        ("power_zones", "get_activity_power_in_timezones")):
        try:
            zones = getattr(api, method)(activity_id)
            if zones:
                out[key] = zones
        except Exception as e:
            log.debug("garmin: no %s for %s (%s)", key, activity_id, e)
    return out


def fetch_personal_records(api):
    """Garmin's own record book. -> [dict]."""
    try:
        raw = api.get_personal_record() or []
    except Exception as e:
        log.debug("garmin: no personal records (%s)", e)
        return []
    out = []
    for record in raw:
        value = record.get("value")
        if value is None:
            continue
        out.append({"type_id": record.get("typeId"),
                    "label": record.get("activityName") or record.get("typeId"),
                    "value": value,
                    "activity_id": record.get("activityId"),
                    "when": record.get("prStartTimeGmtFormatted")
                            or record.get("prStartTimeGmt")})
    return out


def fetch_gear(api, profile_number):
    """The athlete's shoes and bikes. -> [dict] with the fields we display."""
    try:
        raw = api.get_gear(profile_number) or []
    except Exception as e:
        log.warning("garmin: could not read gear (%s)", e)
        return []

    out = []
    for item in raw:
        uuid = item.get("uuid") or item.get("gearPk")
        if not uuid:
            continue
        out.append({
            "uuid": str(uuid),
            "name": (item.get("displayName") or item.get("customMakeModel")
                     or item.get("gearMakeName") or "Unnamed gear"),
            "brand": item.get("gearMakeName"),
            "model": item.get("gearModelName"),
            "type": (item.get("gearTypeName") or "").lower() or "gear",
            "retired": bool(item.get("gearStatusName") == "retired"
                            or item.get("dateEnd")),
            # Garmin stores the athlete's own replace-at figure in metres.
            "limit_m": item.get("maximumMeters") or None,
        })
    return out


def fetch_activity_gear(api, activity_id):
    """Which gear was used for one activity. -> [uuid]."""
    try:
        raw = api.get_activity_gear(activity_id) or []
    except Exception as e:
        log.debug("garmin: no gear for activity %s (%s)", activity_id, e)
        return []
    return [str(g.get("uuid")) for g in raw if g.get("uuid")]


def fetch_activities(api, start_date, end_date=None):
    """-> [activity]. Dates are `date` objects."""
    raw = api.get_activities_by_date(
        start_date.strftime("%Y-%m-%d"),
        (end_date or datetime.now().date()).strftime("%Y-%m-%d"),
    )
    out = []
    for a in raw or []:
        n = normalise(a)
        if n:
            out.append(n)
    log.info("garmin: fetched %d activities since %s", len(out), start_date)
    return out
