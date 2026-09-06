"""AI analysis of the athlete's training, via the Claude API."""
import logging
import os

import anthropic

import fitness as F

log = logging.getLogger(__name__)

MODEL = "claude-opus-5"

SYSTEM = """You are an experienced endurance running coach reviewing one athlete's
training data. You are given a computed summary -- training load (CTL/ATL/TSB, a
TSS-style model), recent best efforts, weekly volume, and model-projected race times.

Write a short, direct review in Markdown with exactly these sections:

## Where your fitness is
## What the projections mean
## What to change in the next 4 weeks

Rules:
- Be specific and quantitative. Reference the actual numbers you were given.
- The projections come from a power-law fit over recent efforts. Say plainly when
  the confidence is low or the data is thin, and what the athlete should run to
  improve it (e.g. a hard 5K time trial).
- Use the workload ratio and the projected race-day form to say something concrete
  about taper and injury risk when either is out of the ordinary.
- Give at most 4 concrete actions, each one line, each with a number in it.
- No preamble, no filler, no disclaimers about not being a doctor. Under 400 words.
- If there is too little data to say anything useful, say exactly that and stop."""


def _brief(summary, races, today, prs=(), cal=None):
    """Compact the computed model output into the prompt payload."""
    lines = []
    lines.append("TRAINING LOAD (TSS-style, exponential averages)")
    lines.append("  Fitness (CTL, 42d): %.0f   6 weeks ago: %.0f" % (summary["ctl"], summary["ctl_6w_ago"]))
    lines.append("  Fatigue (ATL, 7d):  %.0f" % summary["atl"])
    lines.append("  Form (TSB=CTL-ATL): %+.0f" % summary["tsb"])
    if summary.get("threshold_hr"):
        lines.append("  Estimated threshold HR: %.0f bpm" % summary["threshold_hr"])

    lines.append("\nWEEKLY VOLUME (last 12 weeks, oldest first)")
    for wk, km, hrs, load in summary["weekly"]:
        lines.append("  %s  %5.1f km  %4.1f h  load %5.0f" % (wk.isoformat(), km, hrs, load))

    fit = summary.get("fit")
    lines.append("\nBEST EFFORTS DRIVING THE MODEL")
    if fit:
        for d, t, age in fit[2]:
            lines.append("  %5.2f km in %s (%s, %d days ago)"
                         % (d / 1000.0, F.fmt_time(t), F.fmt_pace(t, d), age))
        lines.append("  Fitted fatigue exponent: %.3f (textbook is %.2f; higher = fades more over distance)"
                     % (fit[1], F.RIEGEL))
    else:
        lines.append("  none -- no usable running efforts in the last 180 days")

    spike = summary.get("spike")
    lines.append("\nLATEST RUN AGAINST THE LAST 30 DAYS")
    if spike:
        ratio, distance_m, longest_m, verdict = spike
        lines.append("  %.1f km against a 30-day longest of %.1f km (%+.0f%%) -- %s"
                     % (distance_m / 1000, longest_m / 1000, (ratio - 1) * 100, verdict))
    else:
        lines.append("  not enough history")

    if summary.get("paces"):
        lines.append("\nTRAINING PACES IMPLIED BY CURRENT FITNESS")
        for name, _purpose, fast, slow in summary["paces"]:
            lines.append("  %-11s %s - %s" % (name, F.fmt_time(fast), F.fmt_pace(slow, 1000)))

    if prs:
        lines.append("\nBEST EFFORTS MEASURED INSIDE RUNS (last 180 days)")
        for dist, secs, when in prs:
            lines.append("  %6.2f km  %9s  %s  (%s)"
                         % (dist / 1000.0, F.fmt_time(secs), F.fmt_pace(secs, dist), when))

    if cal:
        lines.append("\nCALIBRATION FROM PAST RACES")
        lines.append("  %d result(s): athlete has run %s, mean error %.1f%%. Projections below "
                     "are already adjusted by %+.1f%%."
                     % (cal["n"], cal["direction"], cal["mean_abs_error"] * 100,
                        (cal["factor"] - 1) * 100))
    for r in races:
        if r.get("actual_s") and r["date"] < today:
            lines.append("  Past race %s (%s): ran %s%s"
                         % (r["name"], r["date"], F.fmt_time(r["actual_s"]),
                            (", projected %s" % F.fmt_time(r["predicted_s"]))
                            if r.get("predicted_s") else ""))

    lines.append("\nSCHEDULED RACES AND PROJECTIONS")
    upcoming = [r for r in races if r["date"] >= today]
    if upcoming:
        for r in upcoming:
            p = F.apply_calibration(
                F.project_race(summary, r["distance_m"], r["date"], today), cal)
            if not p:
                lines.append("  %s (%s): no projection possible" % (r["name"], r["date"]))
                continue
            goal = ("  goal %s" % F.fmt_time(r["goal_s"])) if r.get("goal_s") else ""
            lines.append("  %s -- %s, %.2f km, in %d days"
                         % (r["name"], r["date"], r["distance_m"] / 1000.0, p["days_to_race"]))
            lines.append("     projected %s (%s), confidence: %s, fitness-trend adjustment %+.1f%%%s"
                         % (F.fmt_time(p["seconds"]), F.fmt_pace(p["seconds"], r["distance_m"]),
                            p["confidence"], (p["trend_factor"] - 1) * 100, goal))
            form = F.project_form(summary.get("daily") or {}, today, r["date"])
            if form:
                lines.append("     projected form on race day: %+.0f holding current load, "
                             "%+.0f with a %d-day taper (fitness %.0f)"
                             % (form["tsb_no_taper"], form["tsb_with_taper"],
                                form["taper_days"], form["ctl_race_day"]))
    else:
        lines.append("  none scheduled")

    lines.append("\nREFERENCE PROJECTIONS AT STANDARD DISTANCES (today's form)")
    for label, dist in F.STANDARD_RACES:
        p = F.project_race(summary, dist)
        if p:
            lines.append("  %-14s %s (%s, confidence %s)"
                         % (label, F.fmt_time(p["seconds"]), F.fmt_pace(p["seconds"], dist), p["confidence"]))
    return "\n".join(lines)


def analyse(summary, races, today, prs=(), cal=None):
    """-> markdown review. Raises RuntimeError with a readable message on failure."""
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        raise RuntimeError("No Anthropic credentials found. Set ANTHROPIC_API_KEY in .env "
                           "(or run `ant auth login`) to enable the AI review.")

    payload = _brief(summary, races, today, prs, cal)
    log.info("coach: sending %d chars to %s", len(payload), MODEL)
    client = anthropic.Anthropic()
    try:
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            system=SYSTEM,
            thinking={"type": "adaptive"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{"role": "user", "content": payload}],
        )
    except anthropic.AuthenticationError:
        raise RuntimeError("Anthropic rejected the API key.")
    except anthropic.RateLimitError:
        raise RuntimeError("Anthropic rate limit hit -- try again in a minute.")
    except anthropic.APIStatusError as e:
        raise RuntimeError("Anthropic API error %s: %s" % (e.status_code, e.message))
    except anthropic.APIConnectionError:
        raise RuntimeError("Could not reach the Anthropic API -- check your connection.")

    if resp.stop_reason == "refusal":
        raise RuntimeError("The model declined to answer this one. Try syncing more data first.")
    text = "\n".join(b.text for b in resp.content if b.type == "text").strip()
    return text or "The model returned nothing usable. Try again."


if __name__ == "__main__":
    # Prints the prompt payload for a synthetic athlete -- no API call, no key needed.
    from datetime import datetime, timedelta
    now = datetime.now()
    acts = ([{"type": "running", "start": now - timedelta(days=d), "distance_m": 12000,
              "moving_s": 3600, "elapsed_s": 3600, "avg_hr": 148} for d in range(1, 90, 3)]
            + [{"type": "running", "start": now - timedelta(days=6), "distance_m": 5000,
                "moving_s": 1200, "elapsed_s": 1200, "avg_hr": 178}])
    s = F.summarise(acts, now)
    print(_brief(s, [{"name": "Test Half", "date": now.date() + timedelta(days=60),
                      "distance_m": 21097, "goal_s": 5400}], now.date()))
