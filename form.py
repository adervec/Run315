"""Running form: how the pace was produced, not just what it was.

Pace is an outcome. Cadence, stride length, ground contact time and vertical
oscillation are the mechanics that produced it, and unlike pace they are things
a runner can deliberately change on the next run:

  cadence      steps per minute over both feet. Turnover. Too slow and the foot
               lands out in front of the hips, braking on every step.
  stride       metres covered per step. Cadence times stride is speed, so
               neither number means anything read on its own.
  contact      milliseconds the foot spends on the ground. Time on the ground
               is time not spent travelling.
  oscillation  centimetres of bounce per step. Vertical work is wasted work --
               but only relative to how far the step went, which is why the
               ratio below is the number coaches quote, not the raw height.

None of these channels is guaranteed. Treadmill runs have no GPS, plenty of runs
have no heart rate, and running dynamics need a chest strap or a compatible
watch. So every function here degrades field by field: a missing channel gives a
missing answer, never an exception, and a ragged tuple loses only what it is
actually short of.

The reference points in assess() are population guidance from coaching and from
the ranges the watch manufacturers publish. They are not laws. Cadence rises
with pace and falls with height; a tall runner cruising easily at 165 is not
doing anything wrong. Treat them as a reason to look, not as a verdict.

Pure functions over stream samples. No I/O, no dependencies. See test_form.py.

A sample is (seconds, metres, hr, lat, lon, elevation_m, cadence_spm, stride_m,
gct_ms, vert_osc_cm). Everything after the first two may be None or absent.
"""
import math

RUN_SPEED = 2.4            # m/s -- below this you are not running (~6:56/km)
SMOOTH_S = 7.0             # speed smoothing window; shorter and GPS noise wins

# Plausibility windows. Garmin writes 0 into these fields whenever the pod has
# nothing to say -- standing at a light, or no strap paired at all -- and a zero
# dragged into an average is far worse than no average. The windows are wide on
# purpose: they exist to drop impossible values, not to judge anybody.
CADENCE_RANGE = (30.0, 260.0)
STRIDE_RANGE = (0.3, 3.0)
GCT_RANGE = (100.0, 600.0)
VOSC_RANGE = (2.0, 25.0)

# Garmin's directDoubleCadence counts both feet, but some fields -- and some
# third-party exports -- carry single-leg cadence instead, which reads around
# 80-90 while running. Nobody runs at 85 steps a minute; that is a stroll. So a
# running median below this is one foot being counted, not a slow runner.
HALVED_MAX_SPM = 110.0

# What "normal" looks like across a lot of runners. Fuzzy, and deliberately so.
CADENCE_TYPICAL = (170.0, 180.0)
CADENCE_LOW = 160.0        # below this at running pace is worth a look
CADENCE_HIGH = 190.0       # above this is unusual, not wrong
GCT_GOOD_MS = 250.0
GCT_LONG_MS = 300.0
VERTICAL_RATIO_GOOD = 10.0
VERTICAL_RATIO_HIGH = 12.0

# Pace bucket edges in seconds per km, fastest first once binned.
PACE_BUCKETS = (240.0, 270.0, 300.0, 330.0, 360.0, 420.0)
MIN_BUCKET_SAMPLES = 10    # fewer than this is a transition, not a gear

MIN_DRIFT_SAMPLES = 20     # halves of ten samples each say nothing
DRIFT_PCT = 1.0            # noise floor for a half-to-half change, not a finding
CADENCE_SWING_SPM = 12.0   # rule of thumb for "changes a lot with pace"
THIN_RUN_S = 300.0         # under five minutes of running, averages are thin


# --------------------------------------------------------------------------- #
# reading the stream
# --------------------------------------------------------------------------- #
def _num(value, window=None):
    """Float, or None for missing, non-numeric, NaN or implausible values."""
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v != v:                                   # NaN
        return None
    if window and not (window[0] <= v <= window[1]):
        return None
    return v


def _clean(samples):
    """Sorted, distance-monotonic (t, d, cadence, stride, gct, vosc).

    Heart rate and position are dropped -- nothing here needs them. Each dynamics
    field is read independently, so a tuple that stops after elevation simply has
    no dynamics rather than being thrown away.
    """
    rows = []
    for s in samples or []:
        if not s or len(s) < 2:
            continue
        t, d = _num(s[0]), _num(s[1])
        if t is None or d is None:
            continue

        def field(i, window):
            return _num(s[i], window) if len(s) > i else None

        rows.append((t, d, field(6, CADENCE_RANGE), field(7, STRIDE_RANGE),
                     field(8, GCT_RANGE), field(9, VOSC_RANGE)))
    rows.sort(key=lambda r: r[0])

    clean, last = [], None
    for row in rows:
        d = row[1] if last is None else max(row[1], last)   # GPS goes backwards
        clean.append((row[0], d) + row[2:])
        last = d
    return clean


def _series(samples, smooth_s=SMOOTH_S):
    """[(t, d, speed_m_s, cadence, stride, gct, vosc)] with speed smoothed.

    Speed decides what counts as running, and a raw sample-to-sample speed off a
    metre-quantised distance stream flickers either side of any threshold you
    pick. Smoothing over a few seconds is what makes that decision stable.
    """
    pts = _clean(samples)
    if len(pts) < 2:
        return []

    raw = []
    for i in range(len(pts)):
        a, b = pts[max(i - 1, 0)], pts[min(i + 1, len(pts) - 1)]
        dt = b[0] - a[0]
        raw.append(((b[1] - a[1]) / dt) if dt > 0 else 0.0)

    out, lo, hi = [], 0, 0
    half = smooth_s / 2.0
    for i, row in enumerate(pts):
        while lo < i and pts[lo][0] < row[0] - half:
            lo += 1
        while hi + 1 < len(pts) and pts[hi + 1][0] <= row[0] + half:
            hi += 1
        window = raw[lo:hi + 1] or [raw[i]]
        out.append((row[0], row[1], sum(window) / len(window)) + row[2:])
    return out


def _running(series, min_speed=RUN_SPEED):
    """Only the samples where the athlete was actually running."""
    return [r for r in series if r[2] >= min_speed]


def _running_totals(series, min_speed=RUN_SPEED):
    """(seconds, metres) actually spent running, charged forward per sample."""
    secs = dist = 0.0
    for i, row in enumerate(series[:-1]):
        if row[2] >= min_speed:
            secs += series[i + 1][0] - row[0]
            dist += series[i + 1][1] - row[1]
    return secs, dist


# --------------------------------------------------------------------------- #
# small arithmetic
# --------------------------------------------------------------------------- #
def _mean(values):
    """Mean of the values that exist, or None if none do."""
    vals = [v for v in values if v is not None]
    return (sum(vals) / len(vals)) if vals else None


def _median(values):
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    mid = len(vals) // 2
    return vals[mid] if len(vals) % 2 else (vals[mid - 1] + vals[mid]) / 2.0


def _stats(values):
    """{mean, sd, n, min, max} over the values that exist, or None.

    Population sd, not sample sd: this is the spread of a run that happened, not
    an estimate of some wider population's.
    """
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    mean = sum(vals) / len(vals)
    var = sum((v - mean) ** 2 for v in vals) / len(vals)
    return {"mean": mean, "sd": math.sqrt(var), "n": len(vals),
            "min": min(vals), "max": max(vals)}


def _pct(first, second):
    """Percentage change from first to second, or None if it cannot be had."""
    if first is None or second is None or not first:
        return None
    return (second / first - 1.0) * 100.0


def _mmss(seconds):
    m, s = divmod(int(round(seconds)), 60)
    return "%d:%02d" % (m, s)


# --------------------------------------------------------------------------- #
# cadence, counted correctly
# --------------------------------------------------------------------------- #
def looks_halved(cadences):
    """Is this stream counting one foot rather than two?

    Single-leg cadence reads as a running median around 80-90, which is not a
    cadence any human sustains at running speed -- it is a brisk walk. So a
    median inside the plausible band but below HALVED_MAX_SPM can only be one
    foot, and doubling recovers the real figure.
    """
    med = _median(cadences)
    return med is not None and CADENCE_RANGE[0] <= med < HALVED_MAX_SPM


def normalise_cadence(cadences):
    """Steps per minute over both feet. -> (values, doubled).

    Cadence is taken as given unless the whole stream looks single-leg. The
    judgement is made once, on the median, and applied to everything: deciding
    per sample would turn one noisy low reading into a doubled outlier.
    """
    vals = list(cadences)
    if not looks_halved(vals):
        return vals, False
    return [None if c is None else c * 2.0 for c in vals], True


def vertical_ratio(vert_osc_cm, stride_m):
    """Bounce as a percentage of stride length. Lower is more economical.

    Raw oscillation flatters a short strider: 8 cm of bounce is cheap if the step
    covers 1.4 m and expensive if it covers 0.9 m, which is why coaches quote the
    ratio rather than the height. Centimetres over metres is already a percentage
    (a cm is a hundredth of a metre), so there is no scaling to do.
    """
    v = _num(vert_osc_cm)
    s = _num(stride_m)
    if v is None or s is None or s <= 0:
        return None
    return v / s


# --------------------------------------------------------------------------- #
# one run
# --------------------------------------------------------------------------- #
def summarise(samples, min_speed=RUN_SPEED):
    """Form averages and spread over the running portion of one run. -> dict/None.

    Warm-up shuffling, traffic lights and the walk back to the door all sit below
    `min_speed` and are dropped. They are not form, and a five-minute stop with
    the cadence field pinned at walking pace would otherwise pull the average of
    the whole run down by ten steps a minute -- which reads as a form problem
    that never happened.

    None when there was no running at all, or when not one of the four dynamics
    channels carried a usable value: a summary of four Nones tells the caller
    nothing the missing fields had not already.
    """
    series = _series(samples)
    rows = _running(series, min_speed)
    if not rows:
        return None

    cadence, doubled = normalise_cadence([r[3] for r in rows])
    cad = _stats(cadence)
    stride = _stats([r[4] for r in rows])
    gct = _stats([r[5] for r in rows])
    vosc = _stats([r[6] for r in rows])
    if not (cad or stride or gct or vosc):
        return None

    secs, dist = _running_totals(series, min_speed)
    # Ratio of the means rather than the mean of the per-sample ratios: over a
    # whole run the two barely differ, and this one survives samples that carry
    # oscillation but not stride, or the other way round.
    ratio = (vertical_ratio(vosc["mean"], stride["mean"]) if vosc and stride
             else None)

    return {
        "n": len(rows),
        "seconds": secs,
        "distance_m": dist,
        "speed": (dist / secs) if secs > 0 else None,
        "pace_s_per_km": (1000.0 * secs / dist) if dist > 0 else None,
        "cadence": cad,
        "stride_m": stride,
        "gct_ms": gct,
        "vert_osc_cm": vosc,
        "vertical_ratio": ratio,
        "cadence_doubled": doubled,
    }


def cadence_by_pace(samples, buckets=PACE_BUCKETS, min_speed=RUN_SPEED):
    """How turnover changes as the pace does. -> [dict], fastest bucket first.

    A settled gait raises cadence only modestly from easy to hard -- a handful of
    steps a minute, with stride length doing most of the work. A big swing means
    the easy running is done with a long reaching stride and a slow turnover,
    which is overstriding dressed up as relaxation.

    Every bucket comes back with its own sample count, because a bucket holding
    four samples from a pace transition deserves to be ignored.
    """
    rows = _running(_series(samples), min_speed)
    cadence, _doubled = normalise_cadence([r[3] for r in rows])
    edges = tuple(sorted(float(b) for b in (buckets or ())))

    binned = {}
    for row, cad in zip(rows, cadence):
        if cad is None or row[2] <= 0:
            continue
        pace = 1000.0 / row[2]
        i = 0
        while i < len(edges) and pace >= edges[i]:
            i += 1
        binned.setdefault(i, []).append((pace, cad))

    out = []
    for i in sorted(binned):
        pairs = binned[i]
        lo = edges[i - 1] if i > 0 else None
        hi = edges[i] if i < len(edges) else None
        out.append({
            "label": _bucket_label(lo, hi),
            "pace_lo": lo,
            "pace_hi": hi,
            "mean_pace": sum(p for p, _ in pairs) / len(pairs),
            "cadence": sum(c for _, c in pairs) / len(pairs),
            "n": len(pairs),
        })
    return out


def _bucket_label(lo, hi):
    if lo is None and hi is None:
        return "all paces"
    if lo is None:
        return "faster than %s /km" % _mmss(hi)
    if hi is None:
        return "slower than %s /km" % _mmss(lo)
    return "%s-%s /km" % (_mmss(lo), _mmss(hi))


def fatigue_drift(samples, min_speed=RUN_SPEED):
    """First half of the running against the second. -> dict or None.

    Cadence falling while ground contact rises is the classic picture of a runner
    coming apart late on: turnover slows, the foot sits on the ground longer, and
    the stride starts reaching to make up the difference.

    The pace of each half comes back too, because slowing down lowers cadence all
    by itself. Drift at a held pace is a finding; drift while fading is just the
    fade, and the caller needs to be able to tell them apart.
    """
    rows = _running(_series(samples), min_speed)
    if len(rows) < MIN_DRIFT_SAMPLES:
        return None
    cadence, _doubled = normalise_cadence([r[3] for r in rows])

    # Halves are counted in samples rather than in metres or seconds. Garmin
    # records at a steady rate, so on any normal file the two coincide.
    # ponytail: index halves. Split on elapsed running time if smart-recording
    # files, which sample irregularly, ever turn up here.
    mid = len(rows) // 2

    def half(lo, hi):
        chunk = rows[lo:hi]
        return (_mean(cadence[lo:hi]),
                _mean([r[5] for r in chunk]),
                _mean([r[2] for r in chunk]))

    cad1, gct1, spd1 = half(0, mid)
    cad2, gct2, spd2 = half(mid, len(rows))
    if cad1 is None and cad2 is None and gct1 is None and gct2 is None:
        return None

    cad_pct = _pct(cad1, cad2)
    gct_pct = _pct(gct1, gct2)
    falling = cad_pct is not None and cad_pct <= -DRIFT_PCT
    rising = gct_pct is not None and gct_pct >= DRIFT_PCT

    return {
        "n": len(rows),
        "cadence_first": cad1, "cadence_second": cad2,
        "cadence_delta": (cad2 - cad1) if (cad1 and cad2) else None,
        "cadence_pct": cad_pct,
        "gct_first": gct1, "gct_second": gct2,
        "gct_delta": (gct2 - gct1) if (gct1 and gct2) else None,
        "gct_pct": gct_pct,
        "pace_first": (1000.0 / spd1) if spd1 else None,
        "pace_second": (1000.0 / spd2) if spd2 else None,
        # Positive means the second half was slower, in the direction a runner
        # reads it: seconds per kilometre going up is going backwards.
        "pace_pct": _pct(spd2, spd1),
        "breaking_down": falling and rising,
    }


# --------------------------------------------------------------------------- #
# what the numbers mean
# --------------------------------------------------------------------------- #
def assess(summary, drift=None, by_pace=None):
    """Turn a summary into plain-English findings. -> [{metric, severity, text}].

    Severity is 'good' (nothing to do), 'watch' (worth a session's attention) or
    'note' (context, or a number only interesting next to another one).

    The reference points are population guidance -- roughly 170-180 spm, under
    about 250 ms on the ground, a vertical ratio under about 10% -- and they are
    quoted as such in the text. Cadence in particular rises with pace and falls
    with height, so the honest reading of a low figure is "look at this", never
    "fix this". Where a range is genuinely fuzzy the sentence says so rather than
    hiding it behind a decimal place.
    """
    if not summary:
        return []
    out = []

    def add(metric, severity, text):
        out.append({"metric": metric, "severity": severity, "text": text})

    cad = summary.get("cadence")
    if cad:
        spm = cad["mean"]
        if spm < CADENCE_LOW:
            add("cadence", "watch",
                "Cadence averaged %.0f spm. Most runners sit around %.0f-%.0f, and "
                "this far under usually means the foot is landing out in front of "
                "you. That band is guidance rather than a rule -- cadence falls "
                "with height and with how easy the run was."
                % (spm, CADENCE_TYPICAL[0], CADENCE_TYPICAL[1]))
        elif spm < CADENCE_TYPICAL[0]:
            add("cadence", "note",
                "Cadence averaged %.0f spm, a little under the %.0f-%.0f most "
                "runners settle at. Unremarkable on an easy run; worth a look if "
                "this one was hard." % (spm, CADENCE_TYPICAL[0], CADENCE_TYPICAL[1]))
        elif spm <= CADENCE_HIGH:
            add("cadence", "good",
                "Cadence averaged %.0f spm, inside the %.0f-%.0f range most runners "
                "settle at." % (spm, CADENCE_TYPICAL[0], CADENCE_TYPICAL[1]))
        else:
            add("cadence", "note",
                "Cadence averaged %.0f spm, quicker than most. Nothing wrong with "
                "that as long as the stride does not feel cramped." % spm)

    gct = summary.get("gct_ms")
    if gct:
        ms = gct["mean"]
        if ms <= GCT_GOOD_MS:
            add("gct_ms", "good",
                "Ground contact averaged %.0f ms, the quick side of the ~%.0f ms "
                "usually quoted." % (ms, GCT_GOOD_MS))
        elif ms <= GCT_LONG_MS:
            add("gct_ms", "note",
                "Ground contact averaged %.0f ms, a shade over the ~%.0f ms usually "
                "quoted. It shortens as you speed up, so an easy run reading like "
                "this means little." % (ms, GCT_GOOD_MS))
        else:
            add("gct_ms", "watch",
                "Ground contact averaged %.0f ms -- a long time on the ground. It "
                "usually travels with a slow cadence, so raise the turnover first "
                "and expect this to follow." % ms)

    ratio = summary.get("vertical_ratio")
    if ratio is not None:
        if ratio < VERTICAL_RATIO_GOOD:
            add("vertical_ratio", "good",
                "Vertical ratio %.1f%%, under the ~%.0f%% usually called economical: "
                "the bounce is paying for itself in stride."
                % (ratio, VERTICAL_RATIO_GOOD))
        elif ratio < VERTICAL_RATIO_HIGH:
            add("vertical_ratio", "note",
                "Vertical ratio %.1f%%, right around the ~%.0f%% mark the usual "
                "guidance sits at -- close enough that your own past runs are a "
                "better yardstick than any published figure."
                % (ratio, VERTICAL_RATIO_GOOD))
        else:
            add("vertical_ratio", "watch",
                "Vertical ratio %.1f%%: a lot of the work is going up rather than "
                "along. More often a short stride than a high bounce, so check "
                "stride length before trying to run flatter." % ratio)

    if drift:
        if drift.get("breaking_down"):
            text = ("Cadence fell %.1f%% and ground contact rose %.1f%% between the "
                    "first and second half -- the usual signature of form going late "
                    "in a run." % (abs(drift["cadence_pct"]), drift["gct_pct"]))
            if (drift.get("pace_pct") or 0) > 2.0:
                text += (" You also slowed %.1f%%, which accounts for some of it."
                         % drift["pace_pct"])
            add("drift", "watch", text)
        elif drift.get("cadence_pct") is not None or drift.get("gct_pct") is not None:
            add("drift", "good",
                "Cadence and ground contact held between the halves of the run: the "
                "form you finished with was the form you started with.")

    solid = [b for b in (by_pace or []) if b["n"] >= MIN_BUCKET_SAMPLES]
    if len(solid) >= 2:
        cadences = [b["cadence"] for b in solid]
        swing = max(cadences) - min(cadences)
        where = "%s to %s" % (solid[-1]["label"], solid[0]["label"])
        if swing >= CADENCE_SWING_SPM:
            add("cadence_swing", "watch",
                "Cadence swings %.0f spm across your paces (%s). A swing that big "
                "normally means the slow running is done with a long reaching "
                "stride rather than a quicker one -- though where a big swing "
                "starts is a rule of thumb, not a measurement." % (swing, where))
        else:
            add("cadence_swing", "good",
                "Cadence moves only %.0f spm from your slowest pace to your fastest, "
                "so the gears are coming from stride length. That is what a settled "
                "gait looks like." % swing)

    if summary.get("cadence_doubled"):
        add("cadence", "note",
            "This file reported single-leg cadence; it has been doubled to steps per "
            "minute over both feet so it can be compared with everything else.")

    if (summary.get("seconds") or 0) < THIN_RUN_S:
        add("data", "note",
            "Only %.0f minutes of actual running here -- thin enough that the "
            "averages are indicative rather than solid."
            % ((summary.get("seconds") or 0) / 60.0))

    return out
