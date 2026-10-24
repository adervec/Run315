#!/usr/bin/env python3
"""strava-export.py - your Strava activities and their streams, as one Run315 cowork reply.

Strava's API needs a client secret for the token exchange and is not CORS-enabled, so a
browser app cannot call it; this runs locally with your own API application (Strava's
terms allow that for your own data). Standard library only.

READ-ONLY: Run315 takes from Strava to analyse and never gives back. It asks Strava only
for read scopes (read, activity:read_all, profile:read_all), so even a bug here could not
change, upload or delete anything; the only POST is the OAuth token exchange.

ONE-TIME SETUP
  1. https://www.strava.com/settings/api -> create an application,
     "Authorization Callback Domain" = localhost. Note the Client ID and Secret.
  2. py strava-export.py --auth     (opens the browser; stores a refresh token in
     ~/.run315/strava-token.json, or $STRAVA_TOKEN_FILE - treat it like a password)

RUN
  py strava-export.py --context strava/context.json --out strava/inbox/
  py strava-export.py --days 30 --out strava-output.json

--out may be a directory (file named output-<timestamp>.json). Streams cost one request
each and Strava allows ~100 requests / 15 min, so at most --max-streams activities get
streams per run (newest first); the next run's context asks for the rest.
"""
import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

API = "https://www.strava.com/api/v3"
TOKEN_URL = "https://www.strava.com/oauth/token"
PORT = 8723
TOKEN_FILE = os.path.expanduser(os.environ.get("STRAVA_TOKEN_FILE") or "~/.run315/strava-token.json")
STREAM_KEYS = "time,distance,heartrate,latlng,altitude,cadence,watts,velocity_smooth,grade_smooth,temp,moving"
PROTOCOL, VERSION = "run315-cowork", 1


def _req(url, token=None, data=None, method=None):
    # The one write-shaped request allowed is OAuth's own token endpoint.
    if (data or method not in (None, "GET")) and url != TOKEN_URL:
        raise PermissionError("strava-export is read-only; refused %s %s" % (method or "POST", url))
    headers = {"Authorization": "Bearer " + token} if token else {}
    body = urllib.parse.urlencode(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def load_cfg():
    try:
        with open(TOKEN_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_cfg(cfg):
    os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
    with open(TOKEN_FILE, "w") as f:
        json.dump(cfg, f, indent=2)


def authorize():
    cfg = load_cfg()
    cid = cfg.get("client_id") or input("Strava Client ID: ").strip()
    secret = cfg.get("client_secret") or input("Strava Client Secret: ").strip()
    got = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            got["code"] = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("code", [None])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h2>Run315: Strava authorised. You can close this tab.</h2>")

        def log_message(self, *a):
            pass

    url = "https://www.strava.com/oauth/authorize?" + urllib.parse.urlencode({
        "client_id": cid, "response_type": "code", "redirect_uri": "http://localhost:%d" % PORT,
        "approval_prompt": "auto", "scope": "read,activity:read_all,profile:read_all"})
    print("Opening the browser to authorise...\n" + url)
    webbrowser.open(url)
    HTTPServer(("localhost", PORT), Handler).handle_request()
    if not got.get("code"):
        sys.exit("No authorisation code received.")
    tok = _req(TOKEN_URL, data={"client_id": cid, "client_secret": secret,
                                "code": got["code"], "grant_type": "authorization_code"})
    cfg.update(client_id=cid, client_secret=secret, refresh_token=tok["refresh_token"])
    save_cfg(cfg)
    print("Authorised; token stored in", TOKEN_FILE)


def access_token():
    cfg = load_cfg()
    if not cfg.get("refresh_token"):
        sys.exit("Not authorised yet: run  py strava-export.py --auth")
    tok = _req(TOKEN_URL, data={"client_id": cfg["client_id"], "client_secret": cfg["client_secret"],
                                "refresh_token": cfg["refresh_token"], "grant_type": "refresh_token"})
    if tok.get("refresh_token") and tok["refresh_token"] != cfg["refresh_token"]:
        cfg["refresh_token"] = tok["refresh_token"]   # Strava rotates refresh tokens
        save_cfg(cfg)
    return tok["access_token"]


def streams(token, sid):
    """{key: [values]} for one activity, or None. A 429 stops the run, not the file."""
    try:
        raw = _req("%s/activities/%s/streams?keys=%s&key_by_type=true" % (API, sid, STREAM_KEYS), token)
    except urllib.error.HTTPError as e:
        if e.code == 429:
            raise
        return None
    return {k: v.get("data") for k, v in (raw or {}).items() if isinstance(v, dict)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--auth", action="store_true")
    ap.add_argument("--context")
    ap.add_argument("--days", type=int)
    ap.add_argument("--max-streams", type=int, default=40)
    ap.add_argument("--out")
    args = ap.parse_args()
    if args.auth:
        return authorize()
    if not args.out:
        sys.exit("--out is required")

    ctx, request_hash = {}, None
    if args.context:
        with open(args.context, encoding="utf-8") as f:
            env = json.load(f)
        request_hash, ctx = env.get("requestHash"), env.get("payload") or {}

    now = time.time()
    if args.days:
        after = now - args.days * 86400
    elif ctx.get("lastActivityStart"):
        after = dt.datetime.fromisoformat(ctx["lastActivityStart"][:19]).timestamp() - 3 * 86400
    else:
        after = now - (ctx.get("historyDays") or 30) * 86400

    token = access_token()
    acts, page = [], 1
    while True:
        batch = _req("%s/athlete/activities?after=%d&per_page=200&page=%d" % (API, int(after), page), token)
        acts.extend(batch or [])
        if not batch or len(batch) < 200:
            break
        page += 1

    keep = ("id", "name", "sport_type", "type", "start_date", "start_date_local", "timezone",
            "distance", "moving_time", "elapsed_time", "total_elevation_gain", "average_speed",
            "max_speed", "average_heartrate", "max_heartrate", "average_cadence", "average_watts",
            "kilojoules", "calories", "suffer_score", "gear_id", "trainer", "commute", "manual",
            "device_name", "external_id", "start_latlng", "kudos_count", "pr_count")
    out_acts = {str(a["id"]): {k: a.get(k) for k in keep} for a in acts}

    wanted = sorted(out_acts, key=lambda s: out_acts[s]["start_date"] or "", reverse=True)
    wanted += [str(s) for s in ctx.get("needStreams") or [] if str(s) not in out_acts]
    have, done, limited = set(map(str, ctx.get("haveStreams") or [])), 0, False
    for sid in wanted:
        if done >= args.max_streams or sid in have:
            continue
        try:
            st = streams(token, sid)
        except urllib.error.HTTPError:
            limited = True
            break
        rec = out_acts.setdefault(sid, {"id": sid, "streams_only": True})
        rec["streams"] = st
        done += 1

    # Segment efforts: one detail request per activity, so only for the ones the athlete asked for.
    for sid in [str(x) for x in ctx.get("wantSegments") or []][:args.max_streams]:
        try:
            det = _req("%s/activities/%s?include_all_efforts=true" % (API, sid), token)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                limited = True
                break
            continue
        rec = out_acts.setdefault(sid, {"id": sid, "streams_only": True})
        rec["segment_efforts"] = [{k: e.get(k) for k in ("id", "name", "elapsed_time", "moving_time", "distance",
                                   "start_date_local", "pr_rank", "average_heartrate", "average_watts")}
                                  | {"segment": {k: (e.get("segment") or {}).get(k) for k in
                                     ("id", "name", "distance", "average_grade", "climb_category", "city")}}
                                  for e in det.get("segment_efforts") or []]

    athlete = {}
    try:
        athlete = _req(API + "/athlete", token)
    except urllib.error.HTTPError:
        pass
    gear = [{"id": g.get("id"), "name": g.get("name"), "distance": g.get("distance"),
             "retired": g.get("retired"), "type": kind}
            for kind in ("shoes", "bikes") for g in athlete.get(kind) or []]

    payload = {"activities": list(out_acts.values()), "gear": gear,
               "athlete": {k: athlete.get(k) for k in ("id", "firstname", "lastname", "weight", "ftp")},
               "remainingStreams": max(0, len([s for s in wanted if s not in have]) - done),
               "rateLimited": limited}
    env = {"protocol": PROTOCOL, "protocolVersion": VERSION, "kind": "strava-output",
           "generatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
           "requestHash": request_hash, "payload": payload}
    out = args.out
    if os.path.isdir(out) or out.endswith(("/", "\\")):
        os.makedirs(out, exist_ok=True)
        out = os.path.join(out, "output-%s.json" % dt.datetime.now().strftime("%Y-%m-%dT%H-%M-%S"))
    with open(out + ".part", "w", encoding="utf-8") as f:
        json.dump(env, f, separators=(",", ":"))
    os.replace(out + ".part", out)
    print("Wrote %d activities (%d with streams, %d still to fetch%s) -> %s"
          % (len(out_acts), done, payload["remainingStreams"], ", rate-limited" if limited else "",
             os.path.abspath(out)))


if __name__ == "__main__":
    main()
