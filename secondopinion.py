"""Two estimates disagreeing is information. One estimate alone is not.

This app infers a threshold heart rate from the 95th percentile of your hard
running, and projects race times from a power law fitted to your best efforts.
Both are estimates. So are Garmin's, which are computed by an entirely different
method (Firstbeat's, from the heart-rate/speed relationship) on the same runs.

Where two independent methods agree, the number is probably close. Where they
disagree, one of them is wrong and you should know which questions to ask. That
is worth more than either figure presented alone with a confident font.

Neither side is ground truth, and this module does not pretend otherwise:

  * Garmin's lactate threshold detection moved from a chest-strap protocol using
    HRV-derived respiration to automatic detection from optical wrist heart rate
    in late 2024. Independent validation of the wrist-based era is thin, and the
    Fenix 7 was measured underestimating threshold pace by about 12%.
  * Garmin's VO2max carries a MAPE around 5-8% with a chest strap and degrades at
    both ends of the fitness range. This app deliberately computes no VO2max of
    its own, because a heart-rate-derived one adds no information beyond the
    heart-rate/pace relationship it came from -- it just adds a familiar unit and
    a false precision.

So the comparisons below are framed as agreement or disagreement, never as
"Garmin says you are wrong".

Pure functions. No I/O, no dependencies. See test_secondopinion.py.
"""

# How close two estimates have to be before it is not worth mentioning.
HR_CLOSE_BPM = 5.0
HR_FAR_BPM = 12.0
PACE_CLOSE = 0.03          # 3% of pace
PACE_FAR = 0.08
TIME_CLOSE = 0.02          # 2% of a race time
TIME_FAR = 0.06


def _band(difference, close, far):
    """-> 'agree' | 'near' | 'differ'."""
    size = abs(difference)
    if size <= close:
        return "agree"
    if size <= far:
        return "near"
    return "differ"


def threshold_hr(ours, theirs):
    """Compare two threshold heart-rate estimates. -> dict|None.

    `ours` is this app's inferred value, `theirs` Garmin's measured one.
    """
    if not ours or not theirs:
        return None
    difference = ours - theirs
    band = _band(difference, HR_CLOSE_BPM, HR_FAR_BPM)
    if band == "agree":
        note = ("Both methods put your threshold within a few beats of the same "
                "place, which is about as much agreement as either can offer.")
    elif difference > 0:
        note = ("This app reads your threshold %.0f beats higher than Garmin "
                "does. If your zones feel too hard, Garmin's is the more "
                "conservative number to train off." % abs(difference))
    else:
        note = ("This app reads your threshold %.0f beats lower than Garmin "
                "does. If your easy runs feel too easy, that gap is why."
                % abs(difference))
    return {"ours": ours, "theirs": theirs, "difference": difference,
            "band": band, "note": note}


def threshold_pace(ours_s_per_km, theirs_s_per_km):
    """Compare two threshold pace estimates. -> dict|None."""
    if not ours_s_per_km or not theirs_s_per_km:
        return None
    relative = (ours_s_per_km - theirs_s_per_km) / theirs_s_per_km
    return {"ours": ours_s_per_km, "theirs": theirs_s_per_km,
            "difference_s": ours_s_per_km - theirs_s_per_km,
            "relative": relative,
            "band": _band(relative, PACE_CLOSE, PACE_FAR)}


def races(ours, theirs):
    """Compare race projections distance by distance. -> [dict].

    Both arguments are {distance_m: seconds}. Only distances present in both are
    compared, because a missing projection is not a disagreement.
    """
    out = []
    for distance in sorted(set(ours or {}) & set(theirs or {})):
        mine, garmin = ours[distance], theirs[distance]
        if not mine or not garmin:
            continue
        relative = (mine - garmin) / garmin
        out.append({
            "distance_m": distance,
            "ours": mine,
            "theirs": garmin,
            "difference_s": mine - garmin,
            "relative": relative,
            "band": _band(relative, TIME_CLOSE, TIME_FAR),
        })
    return out


def race_summary(comparisons):
    """One sentence about the whole set of race projections. -> str|None.

    A consistent bias across every distance means something different from
    scatter, so the wording distinguishes them.
    """
    if not comparisons:
        return None
    relatives = [c["relative"] for c in comparisons]
    mean = sum(relatives) / len(relatives)
    optimistic = sum(1 for r in relatives if r < -TIME_CLOSE)
    pessimistic = sum(1 for r in relatives if r > TIME_CLOSE)
    total = len(relatives)

    if abs(mean) <= TIME_CLOSE and not optimistic and not pessimistic:
        return ("Both models land within a couple of per cent at every distance. "
                "That is the good case: two different methods, one answer.")
    if optimistic == total:
        return ("This app is quicker than Garmin at every distance, by %.1f%% on "
                "average. A consistent offset like that usually means the two "
                "disagree about your threshold rather than about any one race."
                % abs(mean * 100))
    if pessimistic == total:
        return ("This app is slower than Garmin at every distance, by %.1f%% on "
                "average. Garmin leans optimistic for runners whose long-distance "
                "work is thin, so check the longer projections against a real "
                "race before trusting them." % abs(mean * 100))
    return ("The two models agree at some distances and not others, which points "
            "at the shape of the curve rather than at its level -- the fitted "
            "fade exponent is where to look.")


def review(ours, theirs):
    """Everything comparable, in one call. -> dict.

    `ours` and `theirs` are dicts with any of: threshold_hr, threshold_pace,
    races. Missing pieces simply do not appear.
    """
    ours = ours or {}
    theirs = theirs or {}
    race_rows = races(ours.get("races"), theirs.get("races"))
    result = {
        "threshold_hr": threshold_hr(ours.get("threshold_hr"),
                                     theirs.get("threshold_hr")),
        "threshold_pace": threshold_pace(ours.get("threshold_pace"),
                                         theirs.get("threshold_pace")),
        "races": race_rows,
        "race_summary": race_summary(race_rows),
    }
    result["comparisons"] = sum(
        1 for key in ("threshold_hr", "threshold_pace") if result[key]
    ) + len(race_rows)
    result["disagreements"] = sum(
        1 for key in ("threshold_hr", "threshold_pace")
        if result[key] and result[key]["band"] == "differ"
    ) + sum(1 for r in race_rows if r["band"] == "differ")
    return result
