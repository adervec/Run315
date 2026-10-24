#!/usr/bin/env python3
"""garmin-export.py - everything Garmin Connect holds for you, as one Run315 cowork reply.

A browser app cannot talk to Garmin (no public per-user API, no CORS, an SSO login), so
the data has to arrive as a file. This logs in locally and writes a `garmin-output`
envelope Run315 imports from its cowork inbox: activities with every per-sample channel
the watch recorded, laps, weather, gear, the daily sweep (steps, stress, body battery,
SpO2, sleep stages...), overnight HRV / resting HR / sleep, and Garmin's own estimates.

READ-ONLY: Run315 takes from Garmin to analyse and never gives back. Every call goes
through ReadOnly below, which refuses anything but get_* -- nothing is created, renamed,
uploaded or deleted on your Garmin account.

UNOFFICIAL: this uses the community `garminconnect` library against Garmin Connect's
private endpoints with your own login. Personal data only, at your own risk; Garmin may
change or block the endpoints at any time.

SETUP (once):   py -m pip install garminconnect
LOGIN:          tokens are read from ~/.garminconnect (the same store garmin_mcp uses, or
                $GARMINTOKENS). With no tokens it asks for email/password (or reads
                $GARMIN_EMAIL / $GARMIN_PASSWORD) and an MFA code if needed, then saves them.

RUN:
  py garmin-export.py --context garmin/context.json --out garmin/inbox/
      backfill exactly what Run315 says it is missing (the normal cowork call)
  py garmin-export.py --days 30 --out garmin-output.json
      everything from the last 30 days, no context needed

--out may be a directory: the file is then named output-<timestamp>.json, which is the
name the app's inbox poller expects. Details (per-sample channels, laps, weather, gear)
are fetched for at most --max-details activities per run, newest first; the next run's
context asks for the rest, so a first year-long backfill takes a few sweeps.
"""
import argparse
import datetime as dt
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import garmin_fetch as G  # noqa: E402

PROTOCOL, VERSION = "run315-cowork", 1


class ReadOnly:
    """The Garmin client with every write removed: only get_* calls (and the tokens) pass."""
    def __init__(self, api):
        self._api = api

    def __getattr__(self, name):
        if name.startswith("get_") or name == "client":
            return getattr(self._api, name)
        raise PermissionError("garmin-export is read-only; refused Garmin.%s" % name)


def login():
    from garminconnect import Garmin
    store = os.path.expanduser(os.environ.get("GARMINTOKENS") or "~/.garminconnect")
    try:
        api = Garmin()
        api.login(store)
        return ReadOnly(api)
    except Exception:
        pass
    email = os.environ.get("GARMIN_EMAIL") or input("Garmin email: ").strip()
    password = os.environ.get("GARMIN_PASSWORD")
    if not password:
        import getpass
        password = getpass.getpass("Garmin password: ")
    api = Garmin(email=email, password=password, return_on_mfa=True)
    state, payload = api.login()
    if state == "needs_mfa":
        api.resume_login(payload, input("Garmin MFA code: ").strip())
    try:
        api.client.dump(store)
    except Exception as e:
        print("warning: could not save tokens to %s (%s)" % (store, e), file=sys.stderr)
    return ReadOnly(api)


def day_range(first, last):
    d = first
    while d <= last:
        yield d
        d += dt.timedelta(days=1)


def parse_day(s):
    return dt.date.fromisoformat(s[:10]) if s else None


def details(api, a):
    """The heavy part of one activity: channels, laps, weather, gear. Never fatal."""
    out = {}
    try:
        out["channels"] = G.fetch_channels(api, a["garmin_id"], a.get("distance_m")) or None
    except Exception as e:
        out["channels"] = None
        out["detail_error"] = str(e)[:200]
    try:
        out["laps"] = G.fetch_activity_extras(api, a["garmin_id"])["laps"]
    except Exception:
        out["laps"] = []
    out["weather_raw"] = G.fetch_weather(api, a["garmin_id"])
    out["gear"] = G.fetch_activity_gear(api, a["garmin_id"])
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--context", help="the app's garmin/context.json")
    ap.add_argument("--days", type=int, default=None, help="look back this many days (default 14, or what context asks)")
    ap.add_argument("--max-details", type=int, default=40)
    ap.add_argument("--out", required=True, help="file, or directory for output-<timestamp>.json")
    args = ap.parse_args()

    ctx, request_hash = {}, None
    if args.context:
        with open(args.context, encoding="utf-8") as f:
            env = json.load(f)
        request_hash = env.get("requestHash")
        ctx = env.get("payload") or {}

    today = dt.date.today()
    history = ctx.get("historyDays") or 365
    if args.days:
        since = today - dt.timedelta(days=args.days)
    elif ctx.get("lastActivityStart"):
        # A short overlap so an activity edited after import is corrected.
        since = parse_day(ctx["lastActivityStart"]) - dt.timedelta(days=3)
    else:
        since = today - dt.timedelta(days=history if ctx else 14)

    api = login()
    t0 = time.time()
    acts = G.fetch_activities(api, since)
    for a in acts:
        a["start"] = a["start"].isoformat()

    # Details: the activities just fetched plus whatever the app says still lacks a stream.
    wanted = [a["garmin_id"] for a in sorted(acts, key=lambda a: a["start"], reverse=True)]
    wanted += [g for g in ctx.get("needDetail") or [] if g not in wanted]
    by_id = {a["garmin_id"]: a for a in acts}
    have = set(ctx.get("haveDetail") or [])
    done = 0
    for gid in wanted:
        if done >= args.max_details:
            break
        if gid in have:
            continue
        a = by_id.get(gid) or {"garmin_id": gid, "detail_only": True}
        a.update(details(api, a))
        by_id[gid] = a
        done += 1

    def gaps(last_key):
        last = parse_day(ctx.get(last_key))
        first = (last + dt.timedelta(days=1)) if last else (today - dt.timedelta(days=min(history, 120)))
        if args.days:
            first = today - dt.timedelta(days=args.days)
        return list(day_range(first, today))

    daily, wellness = [], []
    for d in gaps("lastDailyDay"):
        row = G.fetch_daily(api, d)
        if row:
            daily.append(row)
    for d in gaps("lastWellnessDay"):
        row = G.fetch_wellness(api, d)
        if row:
            wellness.append(row)

    metrics = G.fetch_derived(api)
    if metrics:
        metrics["day"] = today.isoformat()
        metrics["races"] = {str(k): v for k, v in (metrics.get("races") or {}).items()}

    gear = []
    try:
        profile = (api.get_device_last_used() or {}).get("userProfileNumber")
        if profile:
            gear = G.fetch_gear(api, profile)
    except Exception as e:
        print("warning: no gear (%s)" % e, file=sys.stderr)

    payload = {
        "activities": list(by_id.values()),
        "daily": daily, "wellness": wellness,
        "metrics": [metrics] if metrics else [],
        "gear": gear,
        "personalRecords": G.fetch_personal_records(api),
        "remainingDetail": max(0, len([g for g in wanted if g not in have]) - done),
    }
    env = {"protocol": PROTOCOL, "protocolVersion": VERSION, "kind": "garmin-output",
           "generatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
           "requestHash": request_hash, "payload": payload}

    out = args.out
    if os.path.isdir(out) or out.endswith(("/", "\\")):
        os.makedirs(out, exist_ok=True)
        out = os.path.join(out, "output-%s.json" % dt.datetime.now().strftime("%Y-%m-%dT%H-%M-%S"))
    tmp = out + ".part"   # the app polls the inbox; never let it read half a file
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(env, f, separators=(",", ":"))
    os.replace(tmp, out)
    print("Wrote %d activities (%d with details, %d still to fetch), %d days, %d nights -> %s (%.0fs)"
          % (len(acts), done, payload["remainingDetail"], len(daily), len(wellness),
             os.path.abspath(out), time.time() - t0))


if __name__ == "__main__":
    main()
