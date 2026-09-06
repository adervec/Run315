"""Run315 -- Garmin cardio analysis with projected race times.

Single-file Flask app: Google sign-in, Garmin sync, the fitness model in
fitness.py, and an AI review from coach.py.

    python app.py            run it
    python app.py --demo     seed a demo account with synthetic data and run
"""
import base64
import csv
import hashlib
import io
import json
import logging
import math
import os
import re
import sqlite3
import sys
import threading
import time
from datetime import date, datetime, timedelta

from authlib.integrations.flask_client import OAuth
from cryptography.fernet import Fernet, InvalidToken
from dotenv import load_dotenv
from flask import (Flask, Response, abort, flash, g, redirect, render_template,
                   request, session, url_for)
from markupsafe import Markup, escape

import adherence as AD
import coach
import durability as DU
import fitness as F
import fuelling as FU
import landmarks as LM
import form as FM
import garmin
import intervals as IV
import plan as PL
import pois as POI
import racecraft as RC
import recap as RE
import recovery as RV
import secondopinion as SO
import repeats as RP
import stops as ST
import terrain as TE
import territory
import trails as TR
import vitals as VI
import weather as WX
import zones as Z

load_dotenv()
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("run315")

DB_PATH = os.environ.get("DATABASE_PATH", "run315.db")
SYNC_INTERVAL_HOURS = float(os.environ.get("SYNC_INTERVAL_HOURS", "6"))
HISTORY_DAYS = 400          # how far back the first sync reaches
DETAIL_HISTORY_DAYS = 180   # best efforts only matter while they are recent
DETAIL_BATCH = int(os.environ.get("DETAIL_BATCH", "40"))  # per backfill pass
# What a pair of road shoes is usually good for, when Garmin has no figure.
DEFAULT_SHOE_LIFE_M = 800000.0
SHOE_WARN_SHARE = 0.8
DEMO = "--demo" in sys.argv

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY") or ("dev-only-key" if DEMO else "")
if not app.secret_key:
    raise SystemExit("SECRET_KEY is not set. Copy .env.example to .env and fill it in.")
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    # ponytail: SameSite=Lax is the browser's own CSRF defence and blocks the
    # cross-site POSTs this app cares about -- no token plumbing needed.
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("HTTPS", "").lower() in ("1", "true", "yes"),
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
)

# Garmin session tokens are real credentials, so they are encrypted at rest with
# a key derived from SECRET_KEY (cryptography ships with Authlib -- no new dep).
_FERNET = Fernet(base64.urlsafe_b64encode(hashlib.sha256(app.secret_key.encode()).digest()))

oauth = OAuth(app)
GOOGLE_ID = os.environ.get("GOOGLE_CLIENT_ID")
GOOGLE_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET")
GOOGLE_CONFIGURED = bool(GOOGLE_ID and GOOGLE_SECRET)
if GOOGLE_CONFIGURED:
    oauth.register(
        name="google",
        client_id=GOOGLE_ID,
        client_secret=GOOGLE_SECRET,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )


# --------------------------------------------------------------------------- #
# storage
# --------------------------------------------------------------------------- #
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  google_sub TEXT UNIQUE,
  email TEXT,
  name TEXT,
  picture TEXT,
  garmin_email TEXT,
  garmin_token BLOB,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garmin_id TEXT NOT NULL,
  name TEXT, type TEXT, start TEXT NOT NULL,
  distance_m REAL, moving_s REAL, elapsed_s REAL,
  avg_hr REAL, max_hr REAL, elev_gain_m REAL, calories REAL,
  UNIQUE(user_id, garmin_id)
);
CREATE INDEX IF NOT EXISTS ix_act_user_start ON activities(user_id, start DESC);
CREATE TABLE IF NOT EXISTS races (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, date TEXT NOT NULL,
  distance_m REAL NOT NULL, goal_s REAL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, markdown TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_log (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_sync TEXT, status TEXT, message TEXT
);
CREATE TABLE IF NOT EXISTS best_efforts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garmin_id TEXT NOT NULL,
  distance_m REAL NOT NULL,
  seconds REAL NOT NULL,
  start TEXT NOT NULL,
  UNIQUE(user_id, garmin_id, distance_m)
);
CREATE INDEX IF NOT EXISTS ix_effort_user ON best_efforts(user_id, distance_m, seconds);
CREATE TABLE IF NOT EXISTS stream_channels (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garmin_id TEXT NOT NULL,
  channels TEXT NOT NULL,        -- JSON {channel: [values]}, every one the watch gave
  PRIMARY KEY (user_id, garmin_id)
);
CREATE TABLE IF NOT EXISTS streams (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garmin_id TEXT NOT NULL,
  samples TEXT NOT NULL,          -- JSON [[t, d, hr, lat, lon, ele,
                                  --        cadence, stride, gct, vosc], ...]
  PRIMARY KEY (user_id, garmin_id)
);
-- intvl: one row per map tile the athlete has ever run through.
CREATE TABLE IF NOT EXISTS tiles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  zoom INTEGER NOT NULL,
  first_seen TEXT NOT NULL,       -- date of the run that claimed it
  visits INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, zoom, x, y)
);
CREATE INDEX IF NOT EXISTS ix_tiles_user ON tiles(user_id, zoom);
-- Trail completion, ported from TrailTracker. A segment is one OSM way,
-- resampled to a node every 25 m; a "trail" is every segment sharing a name.
CREATE TABLE IF NOT EXISTS trail_segments (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  osm_id TEXT NOT NULL,
  name TEXT,
  kind TEXT,
  motor INTEGER NOT NULL DEFAULT 0,
  coords TEXT NOT NULL,           -- JSON [[lat, lon], ...] at 25 m spacing
  len_m REAL NOT NULL,
  min_lat REAL, min_lon REAL, max_lat REAL, max_lon REAL,
  area_id INTEGER,
  PRIMARY KEY (user_id, osm_id)   -- one claimant per OSM way, or coverage inflates
);
CREATE INDEX IF NOT EXISTS ix_seg_user_name ON trail_segments(user_id, name);
CREATE TABLE IF NOT EXISTS trail_hits (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garmin_id TEXT NOT NULL,
  osm_id TEXT NOT NULL,
  mask TEXT NOT NULL,             -- one '0'/'1' per node, same length as coords
  PRIMARY KEY (user_id, garmin_id, osm_id)
);
CREATE INDEX IF NOT EXISTS ix_hits_user_seg ON trail_hits(user_id, osm_id);
-- A run that touched no trail still counts as matched, or every pass redoes it.
CREATE TABLE IF NOT EXISTS trail_matched (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garmin_id TEXT NOT NULL,
  matched_at TEXT NOT NULL,
  PRIMARY KEY (user_id, garmin_id)
);
CREATE TABLE IF NOT EXISTS trail_areas (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  bbox TEXT NOT NULL,             -- JSON [south, west, north, east]
  loaded_at TEXT NOT NULL,
  seg_count INTEGER NOT NULL DEFAULT 0
);
-- Interval and track sessions, detected from the pace stream rather than from
-- lap buttons nobody presses on the recovery.
CREATE TABLE IF NOT EXISTS track_sessions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garmin_id TEXT NOT NULL,
  start TEXT NOT NULL,
  name TEXT NOT NULL,
  reps INTEGER NOT NULL,
  snapped_m INTEGER,              -- set only when every rep is the same distance
  work_m REAL, work_s REAL, avg_pace REAL,
  fastest REAL, slowest REAL,
  consistency REAL, fade REAL, avg_recovery_s REAL,
  on_track INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL,           -- JSON list of reps
  PRIMARY KEY (user_id, garmin_id)
);
CREATE INDEX IF NOT EXISTS ix_sess_user ON track_sessions(user_id, start DESC);
-- Why each run got interrupted: crossings, rest stops, climbs, fatigue.
CREATE TABLE IF NOT EXISTS run_stops (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garmin_id TEXT NOT NULL,
  start TEXT NOT NULL,
  count INTEGER NOT NULL,
  lost_s REAL, stopped_s REAL,
  crossings INTEGER NOT NULL DEFAULT 0,
  rests INTEGER NOT NULL DEFAULT 0,
  climbs INTEGER NOT NULL DEFAULT 0,
  exhaustion INTEGER NOT NULL DEFAULT 0,
  eased INTEGER NOT NULL DEFAULT 0,
  first_fatigue_m REAL,
  verdict TEXT,
  detail TEXT NOT NULL,           -- JSON list of classified interruptions
  PRIMARY KEY (user_id, garmin_id)
);
CREATE INDEX IF NOT EXISTS ix_stops_user ON run_stops(user_id, start DESC);
-- Overpass answers for a route corridor. Toilets do not move much, and this is
-- donated infrastructure -- asking twice for the same corridor is rude.
CREATE TABLE IF NOT EXISTS poi_cache (
  key TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
-- The actual course for a race, so pacing can account for the ground.
CREATE TABLE IF NOT EXISTS race_courses (
  race_id INTEGER PRIMARY KEY REFERENCES races(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL,           -- 'gpx' or 'activity'
  points TEXT NOT NULL,           -- JSON [[lat, lon, ele], ...]
  length_m REAL, climb_m REAL, drop_m REAL,
  added_at TEXT NOT NULL
);
-- Shoes and other kit, mirrored from Garmin so mileage is in one place.
CREATE TABLE IF NOT EXISTS gear (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uuid TEXT NOT NULL,
  name TEXT NOT NULL,
  brand TEXT, model TEXT, type TEXT,
  retired INTEGER NOT NULL DEFAULT 0,
  limit_m REAL,                   -- the athlete's own replace-at figure
  PRIMARY KEY (user_id, uuid)
);
CREATE TABLE IF NOT EXISTS activity_gear (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garmin_id TEXT NOT NULL,
  uuid TEXT NOT NULL,
  PRIMARY KEY (user_id, garmin_id, uuid)
);
CREATE INDEX IF NOT EXISTS ix_actgear ON activity_gear(user_id, uuid);
-- Conditions per run, so a summer pace can be compared with a winter one.
CREATE TABLE IF NOT EXISTS activity_weather (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garmin_id TEXT NOT NULL,
  temp_c REAL, humidity REAL, dew_point_c REAL, wind_kph REAL,
  conditions TEXT,
  PRIMARY KEY (user_id, garmin_id)
);
-- Everything the watch records when you are not running. One row per day, wide,
-- because a column added later cannot be backfilled without re-downloading.
CREATE TABLE IF NOT EXISTS daily (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  steps REAL, floors REAL,
  stress_avg REAL, stress_max REAL,
  body_battery_high REAL, body_battery_low REAL,
  spo2_avg REAL, spo2_low REAL,
  respiration_avg REAL,
  intensity_minutes REAL, vigorous_minutes REAL,
  weight_kg REAL, body_fat_pct REAL,
  training_readiness REAL,
  calories_total REAL, calories_active REAL,
  fitness_age REAL,
  deep_s REAL, light_s REAL, rem_s REAL, awake_s REAL,
  restless_count REAL, avg_stress REAL,
  PRIMARY KEY (user_id, day)
);
-- The athlete's own lap structure: what they pressed the button for.
CREATE TABLE IF NOT EXISTS laps (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  garmin_id TEXT NOT NULL,
  lap_index INTEGER NOT NULL,
  distance_m REAL, duration_s REAL, avg_hr REAL, max_hr REAL,
  avg_speed REAL, elev_gain_m REAL, avg_cadence REAL, avg_power REAL,
  PRIMARY KEY (user_id, garmin_id, lap_index)
);
-- Garmin's own estimates, kept so they can be argued with rather than trusted.
CREATE TABLE IF NOT EXISTS garmin_metrics (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  threshold_hr REAL, threshold_speed_m_s REAL, vo2max REAL,
  endurance_score REAL, hill_score REAL, races TEXT,
  PRIMARY KEY (user_id, day)
);
-- What the night says: the overnight numbers behind the readiness read.
CREATE TABLE IF NOT EXISTS wellness (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  hrv_ms REAL, rhr REAL, sleep_hours REAL, sleep_score REAL,
  PRIMARY KEY (user_id, day)
);
-- Saved routes, ported from RouteMaster's localStorage.
CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  profile TEXT NOT NULL,
  rtype TEXT NOT NULL,
  pts TEXT NOT NULL,              -- JSON [{"lat":..,"lon":..}, ...] control points only
  created_at TEXT NOT NULL,
  UNIQUE(user_id, name)
);
"""

# Columns added after the first release. SQLite has no "ADD COLUMN IF NOT EXISTS".
MIGRATIONS = (
    ("activities", "details_synced", "INTEGER NOT NULL DEFAULT 0"),
    ("races", "actual_s", "REAL"),            # finish time once the race is run
    ("races", "predicted_s", "REAL"),         # what we projected the day before
    ("races", "garmin_id", "TEXT"),           # the run that was this race
)


def migrate(conn):
    for table, column, spec in MIGRATIONS:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(%s)" % table)}
        if column not in cols:
            conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, spec))
            log.info("migrated: %s.%s added", table, column)
    conn.commit()


def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def _close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    conn.commit()
    migrate(conn)
    conn.close()


def load_activities(conn, user_id):
    """Activity rows as the dicts fitness.py expects."""
    rows = conn.execute(
        "SELECT * FROM activities WHERE user_id=? ORDER BY start DESC", (user_id,)
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["start"] = datetime.fromisoformat(r["start"])
        out.append(d)
    return out


def load_segment_efforts(conn, user_id, now):
    """Best efforts measured inside activities, as (distance, seconds, age_days)."""
    rows = conn.execute(
        "SELECT distance_m, seconds, start FROM best_efforts WHERE user_id=?", (user_id,)
    ).fetchall()
    out = []
    for r in rows:
        age = (now.date() - datetime.fromisoformat(r["start"]).date()).days
        out.append((r["distance_m"], r["seconds"], age))
    return out


def load_pr_rows(conn, user_id):
    """(distance_m, seconds, date) for every stored best effort."""
    rows = conn.execute(
        "SELECT distance_m, seconds, start FROM best_efforts WHERE user_id=?", (user_id,)
    ).fetchall()
    return [(r["distance_m"], r["seconds"], r["start"][:10]) for r in rows]


def load_results(conn, user_id):
    """(predicted_s, actual_s, date) for races that have been run and recorded."""
    rows = conn.execute(
        "SELECT predicted_s, actual_s, date FROM races"
        " WHERE user_id=? AND actual_s IS NOT NULL AND predicted_s IS NOT NULL",
        (user_id,)).fetchall()
    return [(r["predicted_s"], r["actual_s"], datetime.fromisoformat(r["date"]).date())
            for r in rows]


def load_stream(conn, user_id, garmin_id):
    row = conn.execute("SELECT samples FROM streams WHERE user_id=? AND garmin_id=?",
                       (user_id, garmin_id)).fetchone()
    return json.loads(row["samples"]) if row else []


def load_tiles(conn, user_id, zoom=territory.DEFAULT_ZOOM):
    """Every tile this athlete has claimed. -> set of (x, y)."""
    return {(r["x"], r["y"]) for r in conn.execute(
        "SELECT x, y FROM tiles WHERE user_id=? AND zoom=?", (user_id, zoom))}


def load_tile_visits(conn, user_id, zoom=territory.DEFAULT_ZOOM):
    """{(x, y): times_run} -- used to work out where home is."""
    return {(r["x"], r["y"]): r["visits"] for r in conn.execute(
        "SELECT x, y, visits FROM tiles WHERE user_id=? AND zoom=?", (user_id, zoom))}


def claim_tiles(conn, user_id, garmin_id, start_iso, samples,
                zoom=territory.DEFAULT_ZOOM):
    """Claim every tile a track passes through. -> (claimed, newly_claimed)."""
    points = [(r[3], r[4]) for r in samples
              if len(r) > 4 and r[3] is not None and r[4] is not None]
    if not points:
        return (set(), set())
    claimed = territory.tiles_for_track(points, zoom)
    if not claimed:
        return (set(), set())
    before = load_tiles(conn, user_id, zoom)
    day = start_iso[:10]
    conn.executemany(
        """INSERT INTO tiles (user_id, x, y, zoom, first_seen, visits) VALUES (?,?,?,?,?,1)
           ON CONFLICT(user_id, zoom, x, y) DO UPDATE SET
             visits = visits + 1,
             first_seen = MIN(first_seen, excluded.first_seen)""",
        [(user_id, x, y, zoom, day) for (x, y) in claimed])
    return (claimed, claimed - before)


def load_segments(conn, user_id):
    """Stored OSM ways as trails.Segment objects."""
    out = []
    for r in conn.execute(
            "SELECT osm_id, name, kind, motor, coords, len_m FROM trail_segments"
            " WHERE user_id=?", (user_id,)):
        coords = [tuple(c) for c in json.loads(r["coords"])]
        out.append(TR.Segment(id=r["osm_id"], coords=coords, len_m=r["len_m"],
                              name=r["name"], kind=r["kind"], motor=bool(r["motor"])))
    return out


def save_segments(conn, user_id, segs, area_id):
    """Store new ways. First area to claim a way keeps it -- see the schema note."""
    added = 0
    for sg in segs:
        bb = sg.bbox or TR.bbox_of(sg.coords)
        cur = conn.execute(
            """INSERT INTO trail_segments (user_id, osm_id, name, kind, motor, coords,
                                           len_m, min_lat, min_lon, max_lat, max_lon, area_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(user_id, osm_id) DO NOTHING""",
            (user_id, sg.id, sg.name, sg.kind, 1 if sg.motor else 0,
             json.dumps([[round(a, 6), round(b, 6)] for a, b in sg.coords]),
             sg.len_m, bb[0], bb[1], bb[2], bb[3], area_id))
        added += cur.rowcount or 0
    conn.commit()
    return added


def stored_coverage(conn, user_id):
    """OR every stored hit mask together. -> {way_id: bytearray}."""
    cover = {}
    for r in conn.execute("SELECT osm_id, mask FROM trail_hits WHERE user_id=?",
                          (user_id,)):
        mask = r["mask"]
        have = cover.get(r["osm_id"])
        if have is None:
            cover[r["osm_id"]] = bytearray(1 if c == "1" else 0 for c in mask)
        else:
            for i, c in enumerate(mask):
                if c == "1" and i < len(have):
                    have[i] = 1
    return cover


def match_activities(conn, user_id, tol_m=TR.DEFAULT_TOL_M, limit=None):
    """Match un-matched GPS activities against the loaded trail network.

    -> (activities_matched, ways_touched). Cheap to re-run: activities already
    matched are skipped unless their rows were cleared.
    """
    segs = load_segments(conn, user_id)
    if not segs:
        return (0, 0)
    index = TR.build_index(segs, tol_m)

    done = {r["garmin_id"] for r in conn.execute(
        "SELECT garmin_id FROM trail_matched WHERE user_id=?", (user_id,))}
    rows = conn.execute(
        "SELECT garmin_id, samples FROM streams WHERE user_id=?", (user_id,)).fetchall()

    matched = touched = 0
    for r in rows:
        if r["garmin_id"] in done:
            continue
        pts = [(s[3], s[4]) for s in json.loads(r["samples"])
               if len(s) > 4 and s[3] is not None and s[4] is not None]
        if len(pts) < 2:
            continue
        coords, _len = TR.resample(pts, TR.TRACK_STEP_M, TR.TRACK_GAP_M)
        hits = TR.mark_hits(index, coords, tol_m)
        for way_id, mask in hits.items():
            conn.execute(
                """INSERT INTO trail_hits (user_id, garmin_id, osm_id, mask)
                   VALUES (?,?,?,?)
                   ON CONFLICT(user_id, garmin_id, osm_id) DO UPDATE SET mask=excluded.mask""",
                (user_id, r["garmin_id"], way_id,
                 "".join("1" if b else "0" for b in mask)))
            touched += 1
        conn.execute(
            """INSERT INTO trail_matched (user_id, garmin_id, matched_at) VALUES (?,?,?)
               ON CONFLICT(user_id, garmin_id) DO NOTHING""",
            (user_id, r["garmin_id"], datetime.now().isoformat(timespec="seconds")))
        matched += 1
        if matched % 25 == 0:
            conn.commit()
        if limit and matched >= limit:
            break
    conn.commit()
    log.info("trails: matched %d activities for user %s, %d way hits",
             matched, user_id, touched)
    return (matched, touched)


def build_trails(conn, user_id, complete_at=TR.DEFAULT_COMPLETE_AT, named_only=False):
    """Group segments into named trails and score their coverage.

    -> (sorted trail list, totals dict). A trail is complete when the share of
    its 25 m nodes you have been within 25 m of crosses `complete_at`.
    """
    segs = load_segments(conn, user_id)
    if not segs:
        return ([], None)
    cover = stored_coverage(conn, user_id)

    grouped = {}
    for sg in segs:
        if named_only and not sg.name:
            continue
        key = TR.trail_key(sg)
        t = grouped.setdefault(key, {
            "key": key, "name": sg.name or "Unnamed way %s" % sg.id,
            "named": bool(sg.name), "nodes": 0, "hit": 0, "len_m": 0.0,
            "kinds": set(), "segs": []})
        nodes = len(sg.coords)
        mask = cover.get(sg.id)
        t["nodes"] += nodes
        t["hit"] += TR.count_bits(mask) if mask else 0
        t["len_m"] += sg.len_m
        t["kinds"].add(sg.kind)
        t["segs"].append(sg)

    out = []
    for t in grouped.values():
        t["pct"] = (t["hit"] / t["nodes"]) if t["nodes"] else 0.0
        t["done_m"] = t["len_m"] * t["pct"]
        t["complete"] = t["pct"] >= complete_at
        t["kinds"] = sorted(t["kinds"])
        out.append(t)
    out.sort(key=lambda t: (-t["pct"], -t["len_m"], t["name"]))

    totals = {
        "trails": len(out),
        "complete": sum(1 for t in out if t["complete"]),
        "started": sum(1 for t in out if 0 < t["pct"] < complete_at),
        "len_km": sum(t["len_m"] for t in out) / 1000.0,
        "done_km": sum(t["done_m"] for t in out) / 1000.0,
        "complete_at": complete_at,
        "segments": len(segs),
    }
    totals["pct"] = (totals["done_km"] / totals["len_km"]) if totals["len_km"] else 0.0
    return (out, totals)


def store_session(conn, user_id, garmin_id, start_iso, samples):
    """Detect and store the rep structure of one activity, if it has any.

    -> the analysis dict, or None. Called whenever a stream is written, so the
    sessions list never has to re-scan hundreds of streams to render.
    """
    td = [(x[0], x[1], x[2] if len(x) > 2 else None) for x in samples]
    pts = [(x[3], x[4]) for x in samples
           if len(x) > 4 and x[3] is not None and x[4] is not None]
    a = IV.analyse(td, pts)
    if not a:
        conn.execute("DELETE FROM track_sessions WHERE user_id=? AND garmin_id=?",
                     (user_id, garmin_id))
        return None
    conn.execute(
        """INSERT INTO track_sessions
             (user_id, garmin_id, start, name, reps, snapped_m, work_m, work_s,
              avg_pace, fastest, slowest, consistency, fade, avg_recovery_s,
              on_track, detail)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(user_id, garmin_id) DO UPDATE SET
             name=excluded.name, reps=excluded.reps, snapped_m=excluded.snapped_m,
             work_m=excluded.work_m, work_s=excluded.work_s,
             avg_pace=excluded.avg_pace, fastest=excluded.fastest,
             slowest=excluded.slowest, consistency=excluded.consistency,
             fade=excluded.fade, avg_recovery_s=excluded.avg_recovery_s,
             on_track=excluded.on_track, detail=excluded.detail""",
        (user_id, garmin_id, start_iso, a["name"], a["count"],
         a["reps"][0]["snapped_m"] if a["uniform"] else None,
         a["work_m"], a["work_s"], a["avg_pace"], a["fastest"], a["slowest"],
         a["consistency"], a["fade"], a["avg_recovery_s"],
         1 if a["on_track"] else 0, json.dumps(a["reps"])))
    return a


def rescan_sessions(conn, user_id):
    """Re-detect sessions across every stored stream. -> how many were found."""
    rows = conn.execute(
        """SELECT s.garmin_id, s.samples, a.start FROM streams s
             JOIN activities a ON a.user_id=s.user_id AND a.garmin_id=s.garmin_id
            WHERE s.user_id=? AND a.type IN (%s)""" % ",".join("?" * len(F.RUN_TYPES)),
        (user_id,) + tuple(F.RUN_TYPES)).fetchall()
    found = 0
    for r in rows:
        if store_session(conn, user_id, r["garmin_id"], r["start"],
                         json.loads(r["samples"])):
            found += 1
    conn.commit()
    log.info("sessions: %d detected for user %s across %d streams",
             found, user_id, len(rows))
    return found


def load_sessions(conn, user_id, limit=200):
    rows = conn.execute(
        "SELECT * FROM track_sessions WHERE user_id=? ORDER BY start DESC LIMIT ?",
        (user_id, limit)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["reps"] = json.loads(d.pop("detail"))
        out.append(d)
    return out


def session_progression(sessions):
    """Group uniform sessions by rep distance so progress is visible.

    -> [(distance_m, [session, ...] oldest first)], most-run distance first.
    """
    by_dist = {}
    for s in sessions:
        if s.get("snapped_m"):
            by_dist.setdefault(int(s["snapped_m"]), []).append(s)
    out = []
    for dist, group in by_dist.items():
        group = sorted(group, key=lambda s: s["start"])
        best = min(group, key=lambda s: s["avg_pace"] or 1e9)
        out.append({
            "distance_m": dist,
            "sessions": group,
            "count": len(group),
            "best_pace": best["avg_pace"],
            "best_on": best["start"][:10],
            "latest_pace": group[-1]["avg_pace"],
            "trend": (group[-1]["avg_pace"] - group[0]["avg_pace"])
                     if len(group) > 1 and group[0]["avg_pace"] else None,
        })
    out.sort(key=lambda g: (-g["count"], g["distance_m"]))
    return out


def known_junctions(conn, user_id, min_runs=3):
    """Places this athlete stops on run after run -- i.e. road crossings.

    Derived from their own history rather than from map data: if you stand still
    at the same corner on three separate runs, it is a junction.
    """
    runs = {}
    for r in conn.execute("SELECT garmin_id, detail FROM run_stops WHERE user_id=?",
                          (user_id,)):
        runs[r["garmin_id"]] = json.loads(r["detail"])
    return ST.junction_tiles(list(runs.values()), min_runs=min_runs)


def store_stops(conn, user_id, garmin_id, start_iso, samples, junctions=None):
    """Classify and store why one run got interrupted. -> analysis dict or None."""
    a = ST.analyse(samples, junctions or set())
    if not a:
        conn.execute("DELETE FROM run_stops WHERE user_id=? AND garmin_id=?",
                     (user_id, garmin_id))
        return None
    c = a["counts"]
    conn.execute(
        """INSERT INTO run_stops (user_id, garmin_id, start, count, lost_s, stopped_s,
                                  crossings, rests, climbs, exhaustion, eased,
                                  first_fatigue_m, verdict, detail)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(user_id, garmin_id) DO UPDATE SET
             count=excluded.count, lost_s=excluded.lost_s, stopped_s=excluded.stopped_s,
             crossings=excluded.crossings, rests=excluded.rests, climbs=excluded.climbs,
             exhaustion=excluded.exhaustion, eased=excluded.eased,
             first_fatigue_m=excluded.first_fatigue_m, verdict=excluded.verdict,
             detail=excluded.detail""",
        (user_id, garmin_id, start_iso, a["count"], a["lost_s"], a["stopped_s"],
         c.get("crossing", 0), c.get("rest", 0), c.get("climb", 0),
         c.get("exhaustion", 0), c.get("eased", 0),
         a["first_fatigue_m"], a["verdict"], json.dumps(a["interruptions"])))
    return a


def rescan_stops(conn, user_id):
    """Re-read every stream in two passes. -> (runs_with_interruptions, junctions).

    The first pass has to finish before the second can start: whether a stop is a
    crossing depends on how often the athlete stops in that spot, which is only
    knowable once every run has been read.
    """
    rows = conn.execute(
        """SELECT s.garmin_id, s.samples, a.start FROM streams s
             JOIN activities a ON a.user_id=s.user_id AND a.garmin_id=s.garmin_id
            WHERE s.user_id=? AND a.type IN (%s)""" % ",".join("?" * len(F.RUN_TYPES)),
        (user_id,) + tuple(F.RUN_TYPES)).fetchall()

    parsed = [(r["garmin_id"], r["start"], json.loads(r["samples"])) for r in rows]
    junctions = ST.junction_tiles(
        [ST.find_interruptions(sm) for _g, _s, sm in parsed], min_runs=3)

    found = 0
    for gid, start_iso, sm in parsed:
        if store_stops(conn, user_id, gid, start_iso, sm, junctions):
            found += 1
    conn.commit()
    log.info("stops: %d runs with interruptions for user %s, %d junctions",
             found, user_id, len(junctions))
    return (found, junctions)


def stop_totals(conn, user_id, days=90):
    """Rolled-up interruption counts over a recent window."""
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    r = conn.execute(
        """SELECT COUNT(*) runs, SUM(crossings) crossings, SUM(rests) rests,
                  SUM(climbs) climbs, SUM(exhaustion) exhaustion, SUM(eased) eased,
                  SUM(lost_s) lost_s, SUM(stopped_s) stopped_s
             FROM run_stops WHERE user_id=? AND start >= ?""",
        (user_id, cutoff)).fetchone()
    if not r or not r["runs"]:
        return None
    out = dict(r)
    out["days"] = days
    out["fatigue_runs"] = conn.execute(
        "SELECT COUNT(*) c FROM run_stops WHERE user_id=? AND start >= ? AND exhaustion > 0",
        (user_id, cutoff)).fetchone()["c"]
    return out


def parse_gpx(raw):
    """Points out of a GPX file. -> [[lat, lon, ele_or_None], ...].

    Accepts a track or a route, whichever the organiser published.
    """
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        raise ValueError("That file is not valid GPX (%s)." % e)

    def tag(el):
        return el.tag.rsplit("}", 1)[-1]

    out = []
    for el in root.iter():
        if tag(el) not in ("trkpt", "rtept"):
            continue
        try:
            lat, lon = float(el.get("lat")), float(el.get("lon"))
        except (TypeError, ValueError):
            continue
        ele = None
        for child in el:
            if tag(child) == "ele":
                try:
                    ele = float((child.text or "").strip())
                except ValueError:
                    ele = None
                break
        out.append([lat, lon, ele])
    if len(out) < 2:
        raise ValueError("No track points found in that GPX.")
    return out


def load_course(conn, race_id):
    row = conn.execute("SELECT * FROM race_courses WHERE race_id=?", (race_id,)).fetchone()
    if not row:
        return None
    out = dict(row)
    out["points"] = json.loads(out["points"])
    return out


def save_course(conn, user_id, race_id, points, source):
    """Store a course and its headline numbers. -> stats dict."""
    stats = RC.course_stats(points)
    if not stats:
        raise ValueError("That course has too few usable points.")
    # ponytail: thinned to ~2000 points. Plenty for gradients at 1 km grain, and
    # it keeps a marathon GPX from becoming a megabyte of JSON per race.
    step = max(len(points) // 2000, 1)
    thinned = [[round(p[0], 6), round(p[1], 6),
                round(p[2], 1) if len(p) > 2 and p[2] is not None else None]
               for p in points[::step]]
    conn.execute(
        """INSERT INTO race_courses (race_id, user_id, source, points, length_m,
                                     climb_m, drop_m, added_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(race_id) DO UPDATE SET
             source=excluded.source, points=excluded.points, length_m=excluded.length_m,
             climb_m=excluded.climb_m, drop_m=excluded.drop_m, added_at=excluded.added_at""",
        (race_id, user_id, source, json.dumps(thinned), stats["length_m"],
         stats["climb_m"], stats["drop_m"],
         datetime.now().isoformat(timespec="seconds")))
    conn.commit()
    return stats


def match_race_to_activity(conn, user_id, race):
    """The run that was probably this race: same day, roughly the right distance."""
    day = race["date"].isoformat()
    rows = conn.execute(
        """SELECT garmin_id, distance_m, moving_s FROM activities
            WHERE user_id=? AND type IN (%s) AND start LIKE ?
            ORDER BY ABS(distance_m - ?) LIMIT 1"""
        % ",".join("?" * len(F.RUN_TYPES)),
        (user_id,) + tuple(F.RUN_TYPES) + (day + "%", race["distance_m"])).fetchone()
    if not rows or not rows["distance_m"]:
        return None
    # Within 15% of the race distance, or it was a different run that day.
    if abs(rows["distance_m"] - race["distance_m"]) / race["distance_m"] > 0.15:
        return None
    return rows["garmin_id"]


def load_weather(conn, user_id, garmin_id=None):
    """Conditions for one run, or a {garmin_id: row} map for all of them."""
    if garmin_id:
        row = conn.execute(
            "SELECT * FROM activity_weather WHERE user_id=? AND garmin_id=?",
            (user_id, garmin_id)).fetchone()
        return dict(row) if row else None
    return {r["garmin_id"]: dict(r) for r in conn.execute(
        "SELECT * FROM activity_weather WHERE user_id=?", (user_id,))}


def store_weather(conn, user_id, garmin_id, raw):
    """Normalise and keep Garmin's weather blob. -> the stored row or None."""
    wx = WX.normalise(raw)
    if not wx:
        return None
    conn.execute(
        """INSERT INTO activity_weather (user_id, garmin_id, temp_c, humidity,
                                         dew_point_c, wind_kph, conditions)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(user_id, garmin_id) DO UPDATE SET
             temp_c=excluded.temp_c, humidity=excluded.humidity,
             dew_point_c=excluded.dew_point_c, wind_kph=excluded.wind_kph,
             conditions=excluded.conditions""",
        (user_id, garmin_id, wx["temp_c"], wx["humidity"], wx["dew_point_c"],
         wx["wind_kph"], wx["conditions"]))
    return wx


def gear_table(conn, user_id):
    """Every piece of kit with the mileage actually run in it.

    Distance comes from this app's own activity records rather than Garmin's
    running total, so it always agrees with everything else on the page.
    """
    rows = conn.execute(
        """SELECT g.uuid, g.name, g.brand, g.model, g.type, g.retired, g.limit_m,
                  COUNT(a.garmin_id) AS runs,
                  COALESCE(SUM(a.distance_m), 0) AS distance_m,
                  MIN(a.start) AS first_used,
                  MAX(a.start) AS last_used
             FROM gear g
             LEFT JOIN activity_gear ag
               ON ag.user_id = g.user_id AND ag.uuid = g.uuid
             LEFT JOIN activities a
               ON a.user_id = g.user_id AND a.garmin_id = ag.garmin_id
            WHERE g.user_id = ?
            GROUP BY g.uuid
            ORDER BY g.retired, distance_m DESC""", (user_id,)).fetchall()

    out = []
    for r in rows:
        item = dict(r)
        limit = item["limit_m"] or DEFAULT_SHOE_LIFE_M
        item["limit_m"] = limit
        item["share"] = min(item["distance_m"] / limit, 1.5) if limit else 0.0
        item["remaining_m"] = max(limit - item["distance_m"], 0.0)
        item["worn_out"] = item["distance_m"] >= limit
        item["getting_on"] = (not item["worn_out"]
                              and item["distance_m"] >= limit * SHOE_WARN_SHARE)
        out.append(item)
    return out


def weather_seasons(conn, user_id, days=400):
    """Mean pace by temperature band, raw and heat-corrected."""
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    rows = conn.execute(
        """SELECT w.temp_c, w.humidity, w.dew_point_c, a.distance_m, a.moving_s
             FROM activity_weather w
             JOIN activities a ON a.user_id = w.user_id AND a.garmin_id = w.garmin_id
            WHERE w.user_id=? AND a.start >= ? AND a.type IN (%s)
              AND a.distance_m > 1500 AND a.moving_s > 0"""
        % ",".join("?" * len(F.RUN_TYPES)),
        (user_id, cutoff) + tuple(F.RUN_TYPES)).fetchall()
    pace_rows = [(r["temp_c"], r["moving_s"] / (r["distance_m"] / 1000.0),
                  r["humidity"], r["dew_point_c"]) for r in rows]
    return WX.season_summary(pace_rows)


def zone_summary(conn, user_id, thr_hr, weeks=12):
    """Time in heart-rate zones and how polarised the training is.

    Reads the streams already stored, so this costs nothing extra to compute.
    """
    if not thr_hr:
        return None
    cutoff = (datetime.now() - timedelta(weeks=weeks + 1)).isoformat()
    rows = conn.execute(
        """SELECT a.start, s.samples FROM streams s
             JOIN activities a ON a.user_id=s.user_id AND a.garmin_id=s.garmin_id
            WHERE s.user_id=? AND a.start >= ?""", (user_id, cutoff)).fetchall()
    if not rows:
        return None

    acts = [{"start": datetime.fromisoformat(r["start"]),
             "samples": json.loads(r["samples"])} for r in rows]
    weekly = Z.weekly_zones(acts, thr_hr, weeks=weeks)
    total = {}
    for _week, buckets in weekly:
        for zone, secs in buckets.items():
            total[zone] = total.get(zone, 0.0) + (secs or 0.0)
    if not sum(total.values()):
        return None
    shape = Z.polarisation(total)
    shape["weekly"] = weekly
    shape["total"] = total
    shape["index"] = Z.polarisation_index(total)
    shape["zones"] = Z.ZONES
    return shape


def repeated_routes(conn, user_id, days=365, min_repeats=3):
    """The routes this athlete runs over and over, and how they are going on them.

    Uses the tiles already claimed for the territory game rather than re-deriving
    geometry, so a route is "the same" when its tile set overlaps heavily.
    """
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    rows = conn.execute(
        """SELECT s.garmin_id, s.samples, a.start, a.distance_m, a.moving_s, a.name
             FROM streams s
             JOIN activities a ON a.user_id=s.user_id AND a.garmin_id=s.garmin_id
            WHERE s.user_id=? AND a.start >= ? AND a.type IN (%s)
              AND a.distance_m > 1000
            ORDER BY a.start""" % ",".join("?" * len(F.RUN_TYPES)),
        (user_id, cutoff) + tuple(F.RUN_TYPES)).fetchall()

    runs = []
    for r in rows:
        points = [(x[3], x[4]) for x in json.loads(r["samples"])
                  if len(x) > 4 and x[3] is not None and x[4] is not None]
        if len(points) < 10:
            continue
        runs.append({
            "garmin_id": r["garmin_id"],
            "name": r["name"],
            "start": datetime.fromisoformat(r["start"]),
            "distance_m": r["distance_m"],
            "moving_s": r["moving_s"],
            "tiles": RP.signature(points),
        })
    return RP.summarise(runs, min_repeats=min_repeats)


WELLNESS_DAYS = 70      # enough history for a 60-day baseline plus a margin


def sync_wellness(conn, user_id, api, days=WELLNESS_DAYS):
    """Pull the nights we do not already have. -> how many were stored.

    Only the gaps are fetched: this is one request per metric per night, and
    re-reading three months on every sync would be rude and slow.
    """
    have = {r["day"] for r in conn.execute(
        "SELECT day FROM wellness WHERE user_id=?", (user_id,))}
    today = datetime.now().date()
    stored = 0
    for back in range(1, days + 1):
        day = today - timedelta(days=back)
        iso = day.isoformat()
        if iso in have:
            continue
        night = garmin.fetch_wellness(api, day)
        if not night:
            continue
        conn.execute(
            """INSERT INTO wellness (user_id, day, hrv_ms, rhr, sleep_hours, sleep_score)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(user_id, day) DO UPDATE SET
                 hrv_ms=excluded.hrv_ms, rhr=excluded.rhr,
                 sleep_hours=excluded.sleep_hours, sleep_score=excluded.sleep_score""",
            (user_id, iso, night["hrv_ms"], night["rhr"],
             night["sleep_hours"], night["sleep_score"]))
        stored += 1
    conn.commit()
    if stored:
        log.info("wellness: stored %d nights for user %s", stored, user_id)
    return stored


def store_derived(conn, user_id, derived, day=None):
    """Keep one row per day of Garmin's own numbers. -> bool stored."""
    if not derived:
        return False
    iso = (day or datetime.now().date()).isoformat()
    conn.execute(
        """INSERT INTO garmin_metrics (user_id, day, threshold_hr,
               threshold_speed_m_s, vo2max, endurance_score, hill_score, races)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(user_id, day) DO UPDATE SET
             threshold_hr=excluded.threshold_hr,
             threshold_speed_m_s=excluded.threshold_speed_m_s,
             vo2max=excluded.vo2max,
             endurance_score=excluded.endurance_score,
             hill_score=excluded.hill_score, races=excluded.races""",
        (user_id, iso, derived.get("threshold_hr"),
         derived.get("threshold_speed_m_s"), derived.get("vo2max"),
         derived.get("endurance_score"), derived.get("hill_score"),
         json.dumps({str(k): v for k, v in (derived.get("races") or {}).items()})))
    conn.commit()
    return True


def latest_derived(conn, user_id):
    """Garmin's most recent numbers. -> dict|None."""
    row = conn.execute(
        """SELECT * FROM garmin_metrics WHERE user_id=?
            ORDER BY day DESC LIMIT 1""", (user_id,)).fetchone()
    if not row:
        return None
    out = dict(row)
    out["races"] = {int(k): v for k, v in json.loads(row["races"] or "{}").items()}
    return out


def second_opinion(conn, user_id, summary):
    """Our estimates against Garmin's. -> dict|None when there is no comparison."""
    theirs = latest_derived(conn, user_id)
    if not theirs or not summary:
        return None

    ours_races = {}
    for distance in sorted(theirs.get("races") or {}):
        projected = F.project_race(summary, distance)
        if projected:
            ours_races[distance] = projected["seconds"]

    their_pace = None
    if theirs.get("threshold_speed_m_s"):
        their_pace = 1000.0 / theirs["threshold_speed_m_s"]

    result = SO.review(
        {"threshold_hr": summary.get("threshold_hr"),
         "threshold_pace": summary.get("threshold_pace"),
         "races": ours_races},
        {"threshold_hr": theirs.get("threshold_hr"),
         "threshold_pace": their_pace,
         "races": theirs.get("races")})
    if not result["comparisons"]:
        return None
    result["garmin"] = theirs
    return result


DAILY_COLUMNS = ("steps", "floors", "stress_avg", "stress_max",
                 "body_battery_high", "body_battery_low", "spo2_avg", "spo2_low",
                 "respiration_avg", "intensity_minutes", "vigorous_minutes",
                 "weight_kg", "body_fat_pct", "training_readiness",
                 "calories_total", "calories_active", "fitness_age",
                 "deep_s", "light_s", "rem_s", "awake_s",
                 "restless_count", "avg_stress")


def store_daily(conn, user_id, row):
    """One day of off-run metrics. -> bool stored."""
    if not row or not row.get("day"):
        return False
    columns = ["user_id", "day"] + list(DAILY_COLUMNS)
    values = [user_id, row["day"]] + [row.get(c) for c in DAILY_COLUMNS]
    updates = ", ".join("%s=excluded.%s" % (c, c) for c in DAILY_COLUMNS)
    conn.execute(
        "INSERT INTO daily (%s) VALUES (%s) "
        "ON CONFLICT(user_id, day) DO UPDATE SET %s"
        % (", ".join(columns), ", ".join("?" * len(columns)), updates),
        values)
    return True


def sync_daily(conn, user_id, api, days=WELLNESS_DAYS):
    """Backfill the daily sweep for days we do not already have. -> count."""
    have = {r["day"] for r in conn.execute(
        "SELECT day FROM daily WHERE user_id=?", (user_id,))}
    today = datetime.now().date()
    stored = 0
    for back in range(1, days + 1):
        day = today - timedelta(days=back)
        if day.isoformat() in have:
            continue
        row = garmin.fetch_daily(api, day)
        if row and store_daily(conn, user_id, row):
            stored += 1
    conn.commit()
    if stored:
        log.info("daily: stored %d days for user %s", stored, user_id)
    return stored


def store_channels(conn, user_id, garmin_id, channels):
    """The full per-sample capture for one activity. -> bool stored."""
    if not channels or "seconds" not in channels:
        return False
    conn.execute(
        """INSERT INTO stream_channels (user_id, garmin_id, channels)
           VALUES (?,?,?)
           ON CONFLICT(user_id, garmin_id) DO UPDATE SET channels=excluded.channels""",
        (user_id, str(garmin_id), json.dumps(channels)))
    return True


def load_channels(conn, user_id, garmin_id):
    """-> dict of lists, or {} when this activity was never captured wide."""
    row = conn.execute(
        "SELECT channels FROM stream_channels WHERE user_id=? AND garmin_id=?",
        (user_id, str(garmin_id))).fetchone()
    return json.loads(row["channels"]) if row else {}


def store_laps(conn, user_id, garmin_id, laps):
    """The athlete's own lap structure. -> how many stored."""
    stored = 0
    for lap in laps or []:
        if lap.get("index") is None:
            continue
        conn.execute(
            """INSERT INTO laps (user_id, garmin_id, lap_index, distance_m,
                   duration_s, avg_hr, max_hr, avg_speed, elev_gain_m,
                   avg_cadence, avg_power)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(user_id, garmin_id, lap_index) DO UPDATE SET
                 distance_m=excluded.distance_m, duration_s=excluded.duration_s,
                 avg_hr=excluded.avg_hr, max_hr=excluded.max_hr,
                 avg_speed=excluded.avg_speed, elev_gain_m=excluded.elev_gain_m,
                 avg_cadence=excluded.avg_cadence, avg_power=excluded.avg_power""",
            (user_id, str(garmin_id), lap["index"], lap.get("distance_m"),
             lap.get("duration_s"), lap.get("avg_hr"), lap.get("max_hr"),
             lap.get("avg_speed"), lap.get("elev_gain_m"),
             lap.get("avg_cadence"), lap.get("avg_power")))
        stored += 1
    return stored


def channel_coverage(conn, user_id):
    """Which channels this athlete's watches actually record. -> [(name, activities)].

    Worth surfacing: it tells you what analysis is even possible, and it changes
    when someone buys a new watch or straps on a chest belt.
    """
    counts = {}
    for row in conn.execute(
            "SELECT channels FROM stream_channels WHERE user_id=?", (user_id,)):
        for name, values in json.loads(row["channels"]).items():
            if name in ("seconds", "metres"):
                continue
            if any(v is not None for v in values):
                counts[name] = counts.get(name, 0) + 1
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))


def daily_rows(conn, user_id, days=180):
    """The daily sweep, joined with the overnight numbers. -> [(date, dict)]."""
    cutoff = (datetime.now().date() - timedelta(days=days)).isoformat()
    merged = {}
    for row in conn.execute(
            "SELECT * FROM daily WHERE user_id=? AND day >= ? ORDER BY day",
            (user_id, cutoff)):
        merged[row["day"]] = {k: row[k] for k in row.keys()
                              if k not in ("user_id", "day") and row[k] is not None}
    for row in conn.execute(
            "SELECT * FROM wellness WHERE user_id=? AND day >= ? ORDER BY day",
            (user_id, cutoff)):
        target = merged.setdefault(row["day"], {})
        for k in ("hrv_ms", "rhr", "sleep_hours", "sleep_score"):
            if row[k] is not None:
                target[k] = row[k]
    return [(date.fromisoformat(day), values)
            for day, values in sorted(merged.items()) if values]


def training_load_by_day(conn, user_id, days=180):
    """Minutes of running per calendar day. -> {date: minutes}."""
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    out = {}
    for row in conn.execute(
            """SELECT start, moving_s FROM activities
                WHERE user_id=? AND start >= ? AND type IN (%s)"""
            % ",".join("?" * len(F.RUN_TYPES)),
            (user_id, cutoff) + tuple(F.RUN_TYPES)):
        day = datetime.fromisoformat(row["start"]).date()
        out[day] = out.get(day, 0.0) + (row["moving_s"] or 0) / 60.0
    return out


def vitals_report(conn, user_id):
    """Everything the off-run data says. -> dict|None."""
    daily = daily_rows(conn, user_id)
    if len(daily) < VI.MIN_POINTS:
        return None
    load = training_load_by_day(conn, user_id)
    tracked = sorted({k for _d, row in daily for k in row})
    trends = [t for t in (VI.trend(daily, name) for name in tracked) if t]
    trends.sort(key=lambda t: -abs(t["z"] or 0))
    return {
        "days": len(daily),
        "metrics": len(tracked),
        "correlations": VI.correlate(daily, load),
        "sleep": VI.sleep_architecture(daily),
        "trends": trends[:10],
        "odd_days": VI.odd_days(daily)[:6],
        "coverage": channel_coverage(conn, user_id),
    }


def readiness_today(conn, user_id, tsb=None):
    """Today's readiness read, or None when there is nothing to read it from."""
    rows = conn.execute(
        "SELECT * FROM wellness WHERE user_id=? ORDER BY day", (user_id,)).fetchall()
    if not rows:
        # TSB alone still answers, just with low confidence.
        return RV.readiness(tsb=tsb) if tsb is not None else None

    hrv = [(r["day"], r["hrv_ms"]) for r in rows if r["hrv_ms"]]
    rhr = [(r["day"], r["rhr"]) for r in rows if r["rhr"]]
    latest = rows[-1]
    baselines = {
        "hrv": RV.baseline([v for _d, v in hrv]) if hrv else None,
        "rhr": RV.baseline([v for _d, v in rhr]) if rhr else None,
    }
    result = RV.readiness(
        hrv=latest["hrv_ms"], rhr=latest["rhr"],
        sleep_hours=latest["sleep_hours"], sleep_score=latest["sleep_score"],
        tsb=tsb, baselines=baselines)
    if result:
        result["day"] = latest["day"]
        result["hrv_trend"] = RV.trend([v for _d, v in hrv[-14:]]) if len(hrv) > 3 else None
        result["rhr_trend"] = RV.trend([v for _d, v in rhr[-14:]]) if len(rhr) > 3 else None
        result["nights"] = len(rows)
        result["latest"] = dict(latest)
        result["advice"] = RV.advice(result)
    return result


def athlete_limits(conn, user_id):
    """The two ceilings every durability number is expressed against.

    -> (hr_max, critical_speed_m_s, d_prime_m). Any of them may be None.

    Maximum heart rate is the highest seen in training, which Smyth's own paper
    lists as a limitation: a runner who has never truly maxed out gets a ceiling
    that is too low, and every ratio measured against it reads high.
    """
    row = conn.execute(
        """SELECT MAX(max_hr) hr FROM activities
            WHERE user_id=? AND max_hr IS NOT NULL""", (user_id,)).fetchone()
    hr_max = row["hr"] if row else None

    prs = F.personal_records([
        (r["distance_m"], r["seconds"], r["start"]) for r in conn.execute(
            "SELECT distance_m, seconds, start FROM best_efforts WHERE user_id=?",
            (user_id,))])
    fit = DU.critical_speed([(d, s) for d, s, _at in prs])
    if not fit:
        return (hr_max, None, None)
    return (hr_max, fit[0], fit[1])


def durability_runs(conn, user_id, limit=40):
    """Decoupling on every long run we can measure. -> (list, limits).

    Recomputed on demand rather than stored: it depends on critical speed and
    maximum heart rate, both of which move as the athlete gets fitter, so a
    cached number would quietly go stale.
    """
    hr_max, cs, d_prime = athlete_limits(conn, user_id)
    limits = {"hr_max": hr_max, "cs": cs, "d_prime": d_prime}
    if not hr_max or not cs:
        return [], limits

    rows = conn.execute(
        """SELECT s.garmin_id, s.samples, a.start, a.name, a.distance_m,
                  w.temp_c
             FROM streams s
             JOIN activities a ON a.user_id=s.user_id AND a.garmin_id=s.garmin_id
             LEFT JOIN activity_weather w
                    ON w.user_id=s.user_id AND w.garmin_id=s.garmin_id
            WHERE s.user_id=? AND a.type IN (%s)
              AND a.distance_m >= ? AND a.moving_s >= ?
            ORDER BY a.start DESC LIMIT ?""" % ",".join("?" * len(F.RUN_TYPES)),
        (user_id,) + tuple(F.RUN_TYPES)
        + (DU.MIN_DISTANCE_M, DU.MIN_DURATION_S, limit)).fetchall()

    out = []
    for r in rows:
        samples = [tuple(x) for x in json.loads(r["samples"])]
        result = DU.analyse(samples, hr_max, cs, r["temp_c"])
        if not result:
            continue
        result["garmin_id"] = r["garmin_id"]
        result["name"] = r["name"]
        result["start"] = datetime.fromisoformat(r["start"])
        out.append(result)
    return out, limits


CLIMB_LOOKBACK_DAYS = 180


def climbing(conn, user_id, days=CLIMB_LOOKBACK_DAYS, limit=60):
    """How the athlete handles hills, and what their climbing adds up to.

    -> dict. Always answers something: the ascent total needs no streams, and
    the climbing factor quietly stays None when there are no hilly runs.
    """
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    total = conn.execute(
        """SELECT COALESCE(SUM(elev_gain_m), 0) gain, COUNT(*) n
             FROM activities
            WHERE user_id=? AND start >= ? AND type IN (%s)"""
        % ",".join("?" * len(F.RUN_TYPES)),
        (user_id, cutoff) + tuple(F.RUN_TYPES)).fetchone()
    ascent = total["gain"] or 0.0

    rows = conn.execute(
        """SELECT s.samples, a.start, a.name, a.garmin_id, a.distance_m,
                  a.moving_s, a.elev_gain_m
             FROM streams s
             JOIN activities a ON a.user_id=s.user_id AND a.garmin_id=s.garmin_id
            WHERE s.user_id=? AND a.start >= ? AND a.type IN (%s)
              AND a.elev_gain_m > 50
            ORDER BY a.elev_gain_m DESC LIMIT ?"""
        % ",".join("?" * len(F.RUN_TYPES)),
        (user_id, cutoff) + tuple(F.RUN_TYPES) + (limit,)).fetchall()

    costs, hilliest = [], []
    for r in rows:
        cost = TE.climb_cost([tuple(x) for x in json.loads(r["samples"])])
        if not cost:
            continue
        costs.append(cost)
        if len(hilliest) < 8:
            ratio = TE.terrain_ratio(r["moving_s"], r["distance_m"],
                                     r["elev_gain_m"])
            hilliest.append({
                "name": r["name"], "garmin_id": r["garmin_id"],
                "start": datetime.fromisoformat(r["start"]),
                "distance_m": r["distance_m"], "ascent_m": r["elev_gain_m"],
                "factor": cost["factor"], "terrain": ratio,
            })

    return {
        "ascent_m": ascent,
        "runs": total["n"],
        "days": days,
        "landmark": LM.compare(ascent),
        "next_up": LM.next_up(ascent),
        "ladder": [r for r in LM.ladder(ascent) if r["cleared"]][:5],
        "profile": TE.profile(costs),
        "hilliest": hilliest,
    }


def heat_state(conn, user_id, days=60):
    """How heat-adapted the athlete is, from the weather already stored."""
    cutoff = (datetime.now() - timedelta(days=days)).isoformat()
    rows = conn.execute(
        """SELECT a.start, w.temp_c, a.moving_s
             FROM activity_weather w
             JOIN activities a ON a.user_id=w.user_id AND a.garmin_id=w.garmin_id
            WHERE w.user_id=? AND a.start >= ? AND a.type IN (%s)
              AND w.temp_c IS NOT NULL""" % ",".join("?" * len(F.RUN_TYPES)),
        (user_id, cutoff) + tuple(F.RUN_TYPES)).fetchall()
    if not rows:
        return None
    return WX.heat_exposure(
        [(datetime.fromisoformat(r["start"]), r["temp_c"],
          (r["moving_s"] or 0) / 60.0) for r in rows],
        datetime.now().date())


def pending_detail_count(conn, user_id):
    """Runs still waiting to be analysed for best efforts."""
    cutoff = (datetime.now() - timedelta(days=DETAIL_HISTORY_DAYS)).isoformat()
    return conn.execute(
        "SELECT COUNT(*) c FROM activities WHERE user_id=? AND details_synced=0"
        " AND start >= ? AND type IN (%s)" % ",".join("?" * len(F.RUN_TYPES)),
        (user_id, cutoff) + tuple(F.RUN_TYPES),
    ).fetchone()["c"]


def load_races(conn, user_id):
    rows = conn.execute(
        "SELECT * FROM races WHERE user_id=? ORDER BY date", (user_id,)
    ).fetchall()
    races = []
    for r in rows:
        d = dict(r)
        d["date"] = datetime.fromisoformat(r["date"]).date()
        races.append(d)
    return races


OVERPASS_MIRRORS = ("https://overpass-api.de/api/interpreter",
                    "https://overpass.kumi.systems/api/interpreter")
OVERPASS_TIMEOUT = 90
OVERPASS_ATTEMPTS = 2           # per mirror -- 504s here are routine, not fatal
OVERPASS_BACKOFF = 2.5
MAX_AREA_SQ_DEG = 0.45          # bigger than this melts a free mirror
USER_AGENT = "Run315/1.0 (self-hosted training log; +https://github.com/)"


def overpass_trail_query(bbox, sidewalks=False):
    """OverpassQL for every walkable way in a bbox, plus the routes naming them.

    The relation half is what gives unnamed ways a name -- that is how members of
    a long-distance trail get identified at all.
    """
    not_side = "" if sidewalks else '["footway"!~"^(sidewalk|crossing)$"]'
    box = ",".join("%.6f" % v for v in bbox)
    return ("[out:json][timeout:180];"
            'way["highway"~"^(path|footway|track|bridleway|cycleway|steps)$"]'
            + not_side + '["access"!~"^(private|no)$"](' + box + ')->.w;'
            ".w out geom;"
            'rel(bw.w)["route"];'
            "out body;")


def overpass(query):
    """POST a query, trying each mirror in turn. -> parsed JSON.

    ponytail: sequential, not raced -- racing would triple the load on free
    volunteer servers. Add a real job queue if this ever serves more than a few
    people.
    """
    import urllib.error
    import urllib.parse
    import urllib.request

    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for mirror in OVERPASS_MIRRORS:
        # These servers are busy and shed load with 429s and 504s constantly. One
        # attempt each is not enough; a plain retry usually lands.
        for attempt in range(OVERPASS_ATTEMPTS):
            req = urllib.request.Request(
                mirror, data=body,
                headers={"User-Agent": USER_AGENT,
                         "Content-Type": "application/x-www-form-urlencoded"})
            try:
                with urllib.request.urlopen(req, timeout=OVERPASS_TIMEOUT) as r:
                    data = json.loads(r.read().decode("utf-8", "replace"))
                if data.get("elements"):
                    return data
                # A regional mirror answering 200 with nothing is suspect, not empty.
                last = "%s returned no elements" % mirror
            except urllib.error.HTTPError as e:
                last = "%s said HTTP %s" % (mirror, e.code)
            except Exception as e:
                last = "%s: %s" % (mirror, e)
            log.warning("overpass: %s (attempt %d)", last, attempt + 1)
            if attempt + 1 < OVERPASS_ATTEMPTS:
                time.sleep(OVERPASS_BACKOFF * (attempt + 1))
    raise RuntimeError("Overpass is busy right now (%s). Try again in a minute." % last)


# --------------------------------------------------------------------------- #
# auth
# --------------------------------------------------------------------------- #
def current_user():
    uid = session.get("uid")
    if not uid:
        return None
    return db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()


@app.before_request
def _load_user():
    g.user = current_user()


def login_required(view):
    def wrapped(*a, **kw):
        if not g.get("user"):
            return redirect(url_for("index"))
        return view(*a, **kw)
    wrapped.__name__ = view.__name__
    return wrapped


@app.route("/login/google")
def login_google():
    if not GOOGLE_CONFIGURED:
        flash("Google sign-in is not configured. Set GOOGLE_CLIENT_ID and "
              "GOOGLE_CLIENT_SECRET in .env.", "error")
        return redirect(url_for("index"))
    return oauth.google.authorize_redirect(url_for("auth_callback", _external=True))


@app.route("/auth/callback")
def auth_callback():
    try:
        token = oauth.google.authorize_access_token()
    except Exception as e:                       # Authlib raises many shapes here
        log.warning("google oauth failed: %s", e)
        flash("Google sign-in failed or was cancelled.", "error")
        return redirect(url_for("index"))

    info = token.get("userinfo") or {}
    sub = info.get("sub")
    if not sub:
        flash("Google did not return an account id.", "error")
        return redirect(url_for("index"))

    conn = db()
    conn.execute(
        """INSERT INTO users (google_sub, email, name, picture, created_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(google_sub) DO UPDATE SET
             email=excluded.email, name=excluded.name, picture=excluded.picture""",
        (sub, info.get("email"), info.get("name"), info.get("picture"),
         datetime.now().isoformat(timespec="seconds")),
    )
    conn.commit()
    row = conn.execute("SELECT id FROM users WHERE google_sub=?", (sub,)).fetchone()
    session.permanent = True
    session["uid"] = row["id"]
    return redirect(url_for("index"))


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("index"))


# --------------------------------------------------------------------------- #
# garmin
# --------------------------------------------------------------------------- #
def store_token(conn, user_id, token_string, garmin_email=None):
    blob = _FERNET.encrypt(token_string.encode())
    if garmin_email:
        conn.execute("UPDATE users SET garmin_token=?, garmin_email=? WHERE id=?",
                     (blob, garmin_email, user_id))
    else:
        conn.execute("UPDATE users SET garmin_token=? WHERE id=?", (blob, user_id))
    conn.commit()


def read_token(row):
    if not row["garmin_token"]:
        return None
    try:
        return _FERNET.decrypt(row["garmin_token"]).decode()
    except InvalidToken:
        # SECRET_KEY changed -- the stored token can no longer be read.
        return None


@app.route("/garmin/connect", methods=["POST"])
@login_required
def garmin_connect():
    email = (request.form.get("garmin_email") or "").strip()
    password = request.form.get("garmin_password") or ""
    if not email or not password:
        flash("Garmin email and password are both required.", "error")
        return redirect(url_for("index"))
    try:
        state, value = garmin.start_login(email, password)
    except Exception as e:
        log.warning("garmin login failed: %s", e)
        flash("Garmin rejected that login: %s" % e, "error")
        return redirect(url_for("index"))

    if state == "mfa":
        session["garmin_mfa"] = value
        session["garmin_email"] = email
        flash("Garmin sent a verification code -- enter it below.", "info")
        return redirect(url_for("index"))

    store_token(db(), g.user["id"], value, email)
    return first_sync("Garmin connected.")


@app.route("/garmin/mfa", methods=["POST"])
@login_required
def garmin_mfa():
    handle = session.pop("garmin_mfa", None)
    email = session.pop("garmin_email", None)
    code = (request.form.get("code") or "").strip()
    if not handle:
        flash("That verification session expired -- please connect again.", "error")
        return redirect(url_for("index"))
    try:
        token_string = garmin.finish_login(handle, code)
    except Exception as e:
        log.warning("garmin mfa failed: %s", e)
        flash("Verification failed: %s" % e, "error")
        return redirect(url_for("index"))
    store_token(db(), g.user["id"], token_string, email)
    return first_sync("Garmin connected.")


@app.route("/garmin/disconnect", methods=["POST"])
@login_required
def garmin_disconnect():
    conn = db()
    conn.execute("UPDATE users SET garmin_token=NULL, garmin_email=NULL WHERE id=?",
                 (g.user["id"],))
    conn.commit()
    flash("Garmin disconnected. Your synced activities are kept.", "info")
    return redirect(url_for("index"))


def sync_user(conn, user_row):
    """Pull new activities for one user. -> (added, message). Raises on auth failure."""
    token = read_token(user_row)
    if not token:
        raise RuntimeError("Garmin is not connected.")

    uid = user_row["id"]
    last = conn.execute("SELECT MAX(start) AS m FROM activities WHERE user_id=?",
                        (uid,)).fetchone()["m"]
    if last:
        # Re-fetch a short overlap so an activity edited after import is corrected.
        start_date = (datetime.fromisoformat(last) - timedelta(days=3)).date()
    else:
        start_date = (datetime.now() - timedelta(days=HISTORY_DAYS)).date()

    acts, fresh_token = garmin.fetch_activities(token, start_date)
    store_token(conn, uid, fresh_token)
    try:
        api, _ = garmin.connect(fresh_token)
        sync_wellness(conn, uid, api)
        sync_daily(conn, uid, api)
        store_derived(conn, uid, garmin.fetch_derived(api))
    except Exception as e:
        # Both are a bonus; never let them break an activity sync.
        log.warning("wellness/metrics sync failed for user %s: %s", uid, e)

    added = 0
    for a in acts:
        cur = conn.execute(
            """INSERT INTO activities
                 (user_id, garmin_id, name, type, start, distance_m, moving_s,
                  elapsed_s, avg_hr, max_hr, elev_gain_m, calories)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(user_id, garmin_id) DO UPDATE SET
                 name=excluded.name, type=excluded.type, start=excluded.start,
                 distance_m=excluded.distance_m, moving_s=excluded.moving_s,
                 elapsed_s=excluded.elapsed_s, avg_hr=excluded.avg_hr,
                 max_hr=excluded.max_hr, elev_gain_m=excluded.elev_gain_m,
                 calories=excluded.calories""",
            (uid, a["garmin_id"], a["name"], a["type"], a["start"].isoformat(),
             a["distance_m"], a["moving_s"], a["elapsed_s"], a["avg_hr"],
             a["max_hr"], a["elev_gain_m"], a["calories"]),
        )
        added += 1 if cur.rowcount else 0
    msg = "Synced %d activities since %s." % (len(acts), start_date)
    conn.execute(
        """INSERT INTO sync_log (user_id, last_sync, status, message) VALUES (?,?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET
             last_sync=excluded.last_sync, status=excluded.status, message=excluded.message""",
        (uid, datetime.now().isoformat(timespec="seconds"), "ok", msg),
    )
    conn.commit()
    start_backfill(uid)
    return added, msg


# ponytail: one in-process lock per user stops a double-click starting two
# backfills. Move to a real job queue if this ever runs multi-worker.
_backfill_locks = {}
_backfill_guard = threading.Lock()


def analyse_details(conn, user_row, limit=DETAIL_BATCH):
    """Pull streams for un-analysed runs and store their best efforts.

    -> (activities_analysed, efforts_found). Newest runs first, since those
    matter most to the projection.
    """
    token = read_token(user_row)
    if not token:
        return 0, 0
    uid = user_row["id"]
    cutoff = (datetime.now() - timedelta(days=DETAIL_HISTORY_DAYS)).isoformat()
    rows = conn.execute(
        "SELECT garmin_id, start, distance_m FROM activities"
        " WHERE user_id=? AND details_synced=0 AND start >= ? AND type IN (%s)"
        " ORDER BY start DESC LIMIT ?" % ",".join("?" * len(F.RUN_TYPES)),
        (uid, cutoff) + tuple(F.RUN_TYPES) + (limit,),
    ).fetchall()
    if not rows:
        return 0, 0

    api, fresh_token = garmin.connect(token)
    store_token(conn, uid, fresh_token)

    done = found = 0
    for r in rows:
        try:
            # Capture every channel the watch recorded, then derive the narrow
            # view the analysis modules expect. Fetching wide costs nothing extra
            # -- it is the same request -- and a channel not stored today cannot
            # be analysed next year without re-downloading everything.
            channels = garmin.fetch_channels(api, r["garmin_id"], r["distance_m"])
            store_channels(conn, uid, r["garmin_id"], channels)
            store_laps(conn, uid, r["garmin_id"],
                       garmin.fetch_activity_extras(api, r["garmin_id"])["laps"])
            samples = garmin.streams_from_channels(channels)
            curve = F.best_effort_curve([(r[0], r[1]) for r in samples])
            if samples:
                conn.execute(
                    """INSERT INTO streams (user_id, garmin_id, samples) VALUES (?,?,?)
                       ON CONFLICT(user_id, garmin_id) DO UPDATE SET samples=excluded.samples""",
                    (uid, r["garmin_id"], json.dumps(
                        [[round(x[0], 1), round(x[1], 1), x[2],
                          round(x[3], 6) if x[3] is not None else None,
                          round(x[4], 6) if x[4] is not None else None,
                          round(x[5], 1) if len(x) > 5 and x[5] is not None else None]
                         for x in samples])))
                claim_tiles(conn, uid, r["garmin_id"], r["start"], samples)
                store_session(conn, uid, r["garmin_id"], r["start"], samples)
                store_weather(conn, uid, r["garmin_id"],
                              garmin.fetch_weather(api, r["garmin_id"]))
                for uuid in garmin.fetch_activity_gear(api, r["garmin_id"]):
                    conn.execute(
                        """INSERT INTO activity_gear (user_id, garmin_id, uuid)
                           VALUES (?,?,?) ON CONFLICT DO NOTHING""",
                        (uid, r["garmin_id"], uuid))
                store_stops(conn, uid, r["garmin_id"], r["start"], samples,
                            known_junctions(conn, uid))
        except Exception as e:
            # One unreadable activity must not stall the whole backfill; mark it
            # done so we do not retry it forever.
            log.warning("details failed for activity %s: %s", r["garmin_id"], e)
            curve = {}
        for dist, secs in curve.items():
            conn.execute(
                """INSERT INTO best_efforts (user_id, garmin_id, distance_m, seconds, start)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(user_id, garmin_id, distance_m)
                   DO UPDATE SET seconds=excluded.seconds""",
                (uid, r["garmin_id"], float(dist), secs, r["start"]))
            found += 1
        conn.execute("UPDATE activities SET details_synced=1 WHERE user_id=? AND garmin_id=?",
                     (uid, r["garmin_id"]))
        done += 1
        conn.commit()
    log.info("details: analysed %d activities for user %s, %d efforts", done, uid, found)
    return done, found


def start_backfill(user_id):
    """Analyse this user's runs in the background so the request can return."""
    with _backfill_guard:
        lock = _backfill_locks.setdefault(user_id, threading.Lock())
    if lock.locked():
        return False

    def work():
        with lock:
            try:
                with app.app_context():
                    conn = db()
                    user = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
                    if user:
                        analyse_details(conn, user)
            except Exception as e:
                log.exception("backfill failed for user %s: %s", user_id, e)

    threading.Thread(target=work, daemon=True).start()
    return True


@app.route("/efforts/analyse", methods=["POST"])
@login_required
def analyse_efforts():
    if not g.user["garmin_token"]:
        flash("Connect Garmin first.", "error")
    elif start_backfill(g.user["id"]):
        flash("Analysing your runs for best efforts. Refresh in a moment.", "info")
    else:
        flash("Already analysing -- give it a minute.", "info")
    return redirect(url_for("index"))


def first_sync(message):
    """Pull history right after connecting, then land back on the dashboard."""
    try:
        added, msg = sync_user(db(), current_user())
        flash("%s %s %d new." % (message, msg, added), "success")
    except Exception as e:
        log.warning("first sync failed for user %s: %s", g.user["id"], e)
        flash("%s Syncing failed though: %s" % (message, e), "error")
    return redirect(url_for("index"))


@app.route("/sync", methods=["POST"])
@login_required
def sync():
    conn = db()
    try:
        added, msg = sync_user(conn, g.user)
        flash("%s %d new." % (msg, added), "success")
    except Exception as e:
        log.warning("sync failed for user %s: %s", g.user["id"], e)
        conn.execute(
            """INSERT INTO sync_log (user_id, last_sync, status, message) VALUES (?,?,?,?)
               ON CONFLICT(user_id) DO UPDATE SET
                 last_sync=excluded.last_sync, status=excluded.status,
                 message=excluded.message""",
            (g.user["id"], datetime.now().isoformat(timespec="seconds"), "error", str(e)),
        )
        conn.commit()
        flash("Sync failed: %s" % e, "error")
    return redirect(url_for("index"))


def background_sync_loop():
    """Refresh every connected account on a fixed interval."""
    while True:
        time.sleep(SYNC_INTERVAL_HOURS * 3600)
        try:
            with app.app_context():
                conn = db()
                users = conn.execute(
                    "SELECT * FROM users WHERE garmin_token IS NOT NULL").fetchall()
                for u in users:
                    try:
                        added, _ = sync_user(conn, u)
                        analysed, efforts = analyse_details(conn, u)
                        log.info("background sync user %s: %d new, %d analysed, %d efforts",
                                 u["id"], added, analysed, efforts)
                    except Exception as e:
                        log.warning("background sync user %s failed: %s", u["id"], e)
        except Exception as e:
            log.exception("background sync loop error: %s", e)


# --------------------------------------------------------------------------- #
# races + review
# --------------------------------------------------------------------------- #
def parse_goal(text):
    """'1:29:30' or '89:30' or '5400' -> seconds, or None."""
    text = (text or "").strip()
    if not text:
        return None
    if re.fullmatch(r"\d+(\.\d+)?", text):
        return float(text)
    parts = text.split(":")
    if not all(re.fullmatch(r"\d+(\.\d+)?", p) for p in parts) or len(parts) > 3:
        return None
    total = 0.0
    for p in parts:
        total = total * 60 + float(p)
    return total


@app.route("/races", methods=["POST"])
@login_required
def add_race():
    name = (request.form.get("name") or "").strip()
    date_s = (request.form.get("date") or "").strip()
    dist_s = (request.form.get("distance") or "").strip()
    try:
        race_date = datetime.strptime(date_s, "%Y-%m-%d").date()
        distance_m = float(dist_s)
        if not (300 <= distance_m <= 500000):
            raise ValueError("distance out of range")
    except ValueError:
        flash("Give the race a valid date and a distance in metres.", "error")
        return redirect(url_for("index"))
    if not name:
        name = "Race"

    conn = db()
    conn.execute(
        "INSERT INTO races (user_id, name, date, distance_m, goal_s, created_at) VALUES (?,?,?,?,?,?)",
        (g.user["id"], name[:120], race_date.isoformat(), distance_m,
         parse_goal(request.form.get("goal")),
         datetime.now().isoformat(timespec="seconds")),
    )
    conn.commit()
    return redirect(url_for("index"))


@app.route("/races/<int:race_id>/delete", methods=["POST"])
@login_required
def delete_race(race_id):
    conn = db()
    cur = conn.execute("DELETE FROM races WHERE id=? AND user_id=?", (race_id, g.user["id"]))
    conn.commit()
    if not cur.rowcount:
        abort(404)
    return redirect(url_for("index"))


@app.route("/review", methods=["POST"])
@login_required
def review():
    conn = db()
    now = datetime.now()
    summary, acts = build_summary(conn, g.user["id"], now)
    if not summary:
        flash("Sync some activities first.", "error")
        return redirect(url_for("index"))
    try:
        md = coach.analyse(summary, load_races(conn, g.user["id"]), now.date(),
                           F.personal_records(load_pr_rows(conn, g.user["id"])),
                           F.calibration(load_results(conn, g.user["id"]), now.date()))
    except RuntimeError as e:
        flash(str(e), "error")
        return redirect(url_for("index"))
    except Exception as e:
        log.exception("review failed")
        flash("The AI review failed: %s" % e, "error")
        return redirect(url_for("index"))
    conn.execute("INSERT INTO reviews (user_id, created_at, markdown) VALUES (?,?,?)",
                 (g.user["id"], now.isoformat(timespec="seconds"), md))
    conn.commit()
    flash("New review ready.", "success")
    return redirect(url_for("index"))


# --------------------------------------------------------------------------- #
# rendering
# --------------------------------------------------------------------------- #
@app.template_filter("signed")
def signed(value):
    """Whole number with an explicit sign. Rounds -0.4 to +0, never "-0"."""
    return "%+d" % int(round(value or 0))


def render_markdown(text):
    """Minimal, escape-first renderer for the constrained coach output.

    ponytail: the model only emits headings, bullets and bold. Swap in a real
    markdown library the day the prompt allows tables or links.
    """
    html, in_list = [], False
    for raw in escape(text).split("\n"):
        line = raw.strip()
        bullet = line.startswith("- ") or line.startswith("* ")
        if bullet and not in_list:
            html.append("<ul>")
            in_list = True
        elif not bullet and in_list:
            html.append("</ul>")
            in_list = False
        if not line:
            continue
        line = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", line)
        line = re.sub(r"`(.+?)`", r"<code>\1</code>", line)
        if line.startswith("### "):
            html.append("<h4>%s</h4>" % line[4:])
        elif line.startswith("## "):
            html.append("<h3>%s</h3>" % line[3:])
        elif line.startswith("# "):
            html.append("<h3>%s</h3>" % line[2:])
        elif bullet:
            html.append("<li>%s</li>" % line[2:])
        else:
            html.append("<p>%s</p>" % line)
    if in_list:
        html.append("</ul>")
    return Markup("".join(html))


def sparkline(curve, index, top, width=680, height=140):
    """SVG polyline points for one series of the load curve.

    `top` is shared across series so fitness and fatigue stay comparable.
    """
    if not curve:
        return ""
    vals = [c[index] for c in curve]
    n = len(vals)
    step = width / max(n - 1, 1)
    return " ".join("%.1f,%.1f" % (i * step, height - (v / top) * (height - 8))
                    for i, v in enumerate(vals))


def pace_curve_points(prs, width=680, height=150):
    """SVG points for pace against distance, log-scaled on x. -> (points, labels)."""
    usable = [(d, s) for d, s, _ in prs if d and s]
    if len(usable) < 2:
        return "", []
    usable.sort()
    paces = [s / (d / 1000.0) for d, s in usable]
    lo_p, hi_p = min(paces), max(paces)
    span_p = max(hi_p - lo_p, 1.0)
    lo_x, hi_x = math.log(usable[0][0]), math.log(usable[-1][0])
    span_x = max(hi_x - lo_x, 1e-9)

    pts, labels = [], []
    for (d, s), pace in zip(usable, paces):
        x = (math.log(d) - lo_x) / span_x * width
        y = (pace - lo_p) / span_p * (height - 20) + 10
        pts.append("%.1f,%.1f" % (x, y))
        labels.append((x, y, d, s, pace))
    return " ".join(pts), labels


def training_calendar(daily, today, weeks=26):
    """[(week_start, [(date, load) x7])] for the heatmap, oldest week first."""
    monday = today - timedelta(days=today.weekday())
    out = []
    for w in range(weeks - 1, -1, -1):
        start = monday - timedelta(weeks=w)
        out.append((start, [(start + timedelta(days=i),
                             daily.get(start + timedelta(days=i), 0.0)) for i in range(7)]))
    return out


def build_summary(conn, uid, now):
    """Everything the model needs for one user, or (None, []) with no activities."""
    acts = load_activities(conn, uid)
    if not acts:
        return None, []
    segments = load_segment_efforts(conn, uid, now)
    return F.summarise(acts, now, segment_efforts=segments), acts


@app.route("/")
def index():
    if not g.get("user"):
        return render_template("login.html", demo=DEMO,
                               google_configured=GOOGLE_CONFIGURED)

    conn = db()
    uid = g.user["id"]
    now = datetime.now()
    summary, acts = build_summary(conn, uid, now)
    races = load_races(conn, uid)

    cal = F.calibration(load_results(conn, uid), now.date())
    projections, past_races = [], []
    for r in races:
        if r["date"] < now.date():
            past_races.append(r)
            continue
        p = F.project_race(summary, r["distance_m"], r["date"], now.date()) if summary else None
        projections.append((r, F.apply_calibration(p, cal)))
    past_races.reverse()                                   # most recent first

    standards = []
    if summary:
        for label, dist in F.STANDARD_RACES:
            p = F.project_race(summary, dist)
            if p:
                standards.append((label, dist, p))

    prs = F.personal_records(load_pr_rows(conn, uid))
    curve_points, curve_labels = pace_curve_points(prs)
    curve_fast = min((l[4] for l in curve_labels), default=None)
    curve_slow = max((l[4] for l in curve_labels), default=None)
    chart_top = max([c[2] for c in summary["curve"]] + [c[3] for c in summary["curve"]] + [1.0]) \
        if summary else 1.0
    calendar = training_calendar(summary["daily"], now.date()) if summary else []
    calendar_top = max([l for _, days in calendar for _, l in days] + [1.0]) if calendar else 1.0

    latest_review = conn.execute(
        "SELECT * FROM reviews WHERE user_id=? ORDER BY id DESC LIMIT 1", (uid,)).fetchone()
    return render_template(
        "dashboard.html",
        user=g.user, now=now, summary=summary, activities=acts[:15],
        activity_count=len(acts), projections=projections, standards=standards,
        sync=conn.execute("SELECT * FROM sync_log WHERE user_id=?", (uid,)).fetchone(),
        awaiting_mfa=bool(session.get("garmin_mfa")),
        review=latest_review,
        review_html=render_markdown(latest_review["markdown"]) if latest_review else None,
        ctl_points=sparkline(summary["curve"], 2, chart_top) if summary else "",
        atl_points=sparkline(summary["curve"], 3, chart_top) if summary else "",
        chart_top=chart_top,
        prs=prs, curve_points=curve_points, curve_labels=curve_labels,
        curve_fast=curve_fast, curve_slow=curve_slow,
        calibration=cal, past_races=past_races,
        territory=tile_summary(conn, uid, now),
        zoneshape=zone_summary(conn, uid, summary["threshold_hr"]) if summary else None,
        ready=readiness_today(conn, uid, summary["tsb"] if summary else None),
        heat=heat_state(conn, uid),
        digest=F.week_digest(acts, now, summary["threshold_hr"], F.thresholds(acts)[1]) if summary else None,
        calendar=calendar, calendar_top=calendar_top,
        pending_details=pending_detail_count(conn, uid),
        fmt_time=F.fmt_time, fmt_pace=F.fmt_pace, fmt_effort=F.fmt_effort,
    )


@app.route("/race/<int:race_id>")
@login_required
def race_detail(race_id):
    conn = db()
    uid = g.user["id"]
    now = datetime.now()
    row = conn.execute("SELECT * FROM races WHERE id=? AND user_id=?", (race_id, uid)).fetchone()
    if not row:
        abort(404)
    race = dict(row)
    race["date"] = datetime.fromisoformat(row["date"]).date()

    summary, _ = build_summary(conn, uid, now)
    projection = (F.project_race(summary, race["distance_m"], race["date"], now.date())
                  if summary else None)
    cal = F.calibration(load_results(conn, uid), now.date())
    projection = F.apply_calibration(projection, cal)
    form = F.project_form(summary["daily"], now.date(), race["date"]) if summary else None
    # Freeze the projection while the race is still ahead, so a result entered
    # afterwards is scored against what we actually said beforehand.
    if projection and race["date"] >= now.date():
        conn.execute("UPDATE races SET predicted_s=? WHERE id=?", (projection["seconds"], race_id))
        conn.commit()

    splits = F.split_targets(race["distance_m"], projection["seconds"]) if projection else []
    goal_splits = F.split_targets(race["distance_m"], race["goal_s"]) if race["goal_s"] else []

    # --- the course, if one has been attached ---
    course = load_course(conn, race_id)
    course_stats = plan = hard = course_mismatch = None
    target_for_plan = race["goal_s"] or (projection["seconds"] if projection else None)
    if course:
        course_stats = RC.course_stats(course["points"])
        if course_stats and race["distance_m"]:
            # A GPX for the wrong event would silently spread the goal time over
            # the wrong distance, so say so rather than quietly pacing a fiction.
            off = (course_stats["length_m"] - race["distance_m"]) / race["distance_m"]
            if abs(off) > 0.05:
                course_mismatch = off
        if course_stats and target_for_plan:
            plan = RC.pace_plan(course_stats["segments"], target_for_plan)
            hard = RC.hard_sections(course_stats["segments"])

    # --- the postmortem, once the race has been run ---
    # A plan only makes sense for a race still ahead, and only off a real base.
    training_plan = plan_notes = plan_stats = None
    weeks_out = (race["date"] - now.date()).days // 7
    if summary and weeks_out >= 2:
        # Running volume only. summary["weekly"] counts every cardio activity, and
        # building a running plan off a total that includes bike rides asks for
        # twice the mileage the athlete has ever run.
        since = (now - timedelta(weeks=6)).isoformat()
        run_m = conn.execute(
            """SELECT COALESCE(SUM(distance_m), 0) d FROM activities
                WHERE user_id=? AND start >= ? AND type IN (%s)"""
            % ",".join("?" * len(F.RUN_TYPES)),
            (uid, since) + tuple(F.RUN_TYPES)).fetchone()["d"]
        current_week_m = run_m / 6.0
        if current_week_m > 5000:
            training_plan = PL.build(current_week_m, race["distance_m"],
                                     min(weeks_out, 24), summary["paces"])
            plan_stats = PL.summarise(training_plan, race["distance_m"])
            plan_notes = PL.sanity(training_plan, current_week_m)

    # Did the athlete actually do the plan? A plan nobody checks is a horoscope.
    plan_review = None
    if training_plan:
        plan_start = (now - timedelta(weeks=len(training_plan))).date()
        plan_review = AD.review(
            training_plan,
            [a for a in load_activities(conn, uid) if a.get("type") in F.RUN_TYPES],
            plan_start, now.date())

    # Fuelling hangs off the projected finish time, so it needs no new inputs.
    # ponytail: no race-day forecast source, so conditions are left unknown and
    # the fluid range stays at its temperate default. Pass a forecast temperature
    # here if one ever gets wired up.
    fuel = (FU.plan(projection["seconds"])
            if projection and projection.get("seconds") else None)

    review = None
    ran = race.get("garmin_id") or match_race_to_activity(conn, uid, race)
    if race["date"] <= now.date() and ran:
        stream = load_stream(conn, uid, ran)
        if stream:
            actual = RC.actual_segments(stream)
            review = RC.postmortem(plan or [], actual, race["goal_s"])
            review["garmin_id"] = ran
            review["auto"] = not race.get("garmin_id")
    past_runs = []
    if race["date"] <= now.date():
        past_runs = conn.execute(
            """SELECT garmin_id, name, start, distance_m FROM activities
                WHERE user_id=? AND type IN (%s)
                  AND start >= ? AND start <= ?
                ORDER BY start DESC LIMIT 12""" % ",".join("?" * len(F.RUN_TYPES)),
            (uid,) + tuple(F.RUN_TYPES)
            + ((race["date"] - timedelta(days=1)).isoformat(),
               (race["date"] + timedelta(days=2)).isoformat())).fetchall()
    return render_template(
        "race.html", user=g.user, now=now, race=race, projection=projection,
        form=form, splits=splits, goal_splits=goal_splits, summary=summary,
        calibration=cal, course=course, course_stats=course_stats, plan=plan,
        training_plan=training_plan, plan_stats=plan_stats, plan_notes=plan_notes,
        fuel=fuel,
        plan_review=plan_review,
        course_mismatch=course_mismatch,
        hard=hard, review=review, past_runs=past_runs,
        profile_points=elevation_profile(course_stats) if course_stats else "",
        fmt_time=F.fmt_time, fmt_pace=F.fmt_pace,
    )


def elevation_profile(stats, width=680, height=110):
    """SVG polygon points for a course profile."""
    segments = (stats or {}).get("segments") or []
    if not segments or not stats.get("has_elevation"):
        return ""
    # Rebuild a running elevation from the per-segment climb and drop.
    ele, marks = 0.0, [(0.0, 0.0)]
    for seg in segments:
        ele += seg["climb_m"] - seg["drop_m"]
        marks.append((seg["to_m"], ele))
    lo = min(e for _d, e in marks)
    hi = max(e for _d, e in marks)
    span = max(hi - lo, 1.0)
    total = marks[-1][0] or 1.0
    return " ".join("%.1f,%.1f" % (d / total * width,
                                   height - (e - lo) / span * (height - 12) - 6)
                    for d, e in marks)


@app.route("/race/<int:race_id>/course", methods=["POST"])
@login_required
def race_course(race_id):
    conn = db()
    uid = g.user["id"]
    row = conn.execute("SELECT * FROM races WHERE id=? AND user_id=?",
                       (race_id, uid)).fetchone()
    if not row:
        abort(404)

    source = request.form.get("source")
    try:
        if source == "activity":
            gid = request.form.get("garmin_id") or ""
            stream = load_stream(conn, uid, gid)
            if not stream:
                raise ValueError("That activity has no GPS track stored yet.")
            points = [[x[3], x[4], x[5] if len(x) > 5 else None] for x in stream
                      if len(x) > 4 and x[3] is not None and x[4] is not None]
            if len(points) < 2:
                raise ValueError("That activity has no GPS track stored yet.")
        else:
            upload = request.files.get("gpx")
            if not upload or not upload.filename:
                raise ValueError("Choose a GPX file first.")
            raw = upload.read(8 * 1024 * 1024)      # a course GPX is never bigger
            points = parse_gpx(raw)
        stats = save_course(conn, uid, race_id, points, source or "gpx")
    except ValueError as e:
        flash(str(e), "error")
        return redirect(url_for("race_detail", race_id=race_id))

    flash("Course attached: %.2f km, %d m of climbing."
          % (stats["length_m"] / 1000.0, round(stats["climb_m"])), "success")
    return redirect(url_for("race_detail", race_id=race_id))


@app.route("/race/<int:race_id>/course/delete", methods=["POST"])
@login_required
def race_course_delete(race_id):
    conn = db()
    conn.execute("DELETE FROM race_courses WHERE race_id=? AND user_id=?",
                 (race_id, g.user["id"]))
    conn.commit()
    flash("Course removed.", "info")
    return redirect(url_for("race_detail", race_id=race_id))


@app.route("/race/<int:race_id>/ran", methods=["POST"])
@login_required
def race_ran(race_id):
    """Say which activity was this race, for the postmortem."""
    conn = db()
    uid = g.user["id"]
    gid = (request.form.get("garmin_id") or "").strip()
    if not conn.execute("SELECT 1 FROM races WHERE id=? AND user_id=?",
                        (race_id, uid)).fetchone():
        abort(404)
    if gid and not conn.execute(
            "SELECT 1 FROM activities WHERE user_id=? AND garmin_id=?",
            (uid, gid)).fetchone():
        flash("That activity is not one of yours.", "error")
        return redirect(url_for("race_detail", race_id=race_id))
    conn.execute("UPDATE races SET garmin_id=? WHERE id=?", (gid or None, race_id))
    conn.commit()
    flash("Linked. The postmortem below now reads that run." if gid
          else "Unlinked.", "success")
    return redirect(url_for("race_detail", race_id=race_id))


@app.route("/races/<int:race_id>/result", methods=["POST"])
@login_required
def race_result(race_id):
    conn = db()
    row = conn.execute("SELECT * FROM races WHERE id=? AND user_id=?",
                       (race_id, g.user["id"])).fetchone()
    if not row:
        abort(404)
    actual = parse_goal(request.form.get("actual"))
    if actual is None:
        flash("Enter the finish time as h:mm:ss or m:ss.", "error")
        return redirect(url_for("race_detail", race_id=race_id))
    conn.execute("UPDATE races SET actual_s=? WHERE id=?", (actual, race_id))
    conn.commit()
    if row["predicted_s"]:
        gap = actual - row["predicted_s"]
        flash("Result saved: %s, %s %s than projected. Future projections will learn from it."
              % (F.fmt_time(actual), F.fmt_time(abs(gap)), "slower" if gap > 0 else "faster"),
              "success")
    else:
        flash("Result saved: %s." % F.fmt_time(actual), "success")
    return redirect(url_for("race_detail", race_id=race_id))


@app.route("/activity/<garmin_id>")
@login_required
def activity_detail(garmin_id):
    conn = db()
    uid = g.user["id"]
    row = conn.execute("SELECT * FROM activities WHERE user_id=? AND garmin_id=?",
                       (uid, garmin_id)).fetchone()
    if not row:
        abort(404)
    act = dict(row)
    act["start"] = datetime.fromisoformat(row["start"])

    now = datetime.now()
    summary, acts = build_summary(conn, uid, now)
    thr_hr = summary["threshold_hr"] if summary else None
    thr_pace = summary["threshold_pace"] if summary else None

    stream = load_stream(conn, uid, garmin_id)
    td = [(s[0], s[1]) for s in stream]
    splits = F.km_splits(td) if td else []
    curve = F.best_effort_curve(td) if td else {}
    drift = F.hr_drift([(s[0], s[1], s[2]) for s in stream]) if stream else None
    track = [[s[3], s[4]] for s in stream if len(s) > 4 and s[3] is not None]
    load = F.activity_load(act, thr_hr, F.thresholds(acts)[1]) if summary else None

    # Where does this run sit against the athlete's records at each distance?
    prs = {d: s for d, s, _ in F.personal_records(load_pr_rows(conn, uid))}
    efforts = [(d, s, prs.get(d), (s <= prs[d] + 0.5) if d in prs else False)
               for d, s in sorted(curve.items())]

    shape = FM.summarise(stream) if stream else None
    form_drift = FM.fatigue_drift(stream) if stream else None
    form_by_pace = FM.cadence_by_pace(stream) if stream else None
    form_findings = FM.assess(shape, form_drift, form_by_pace) if shape else []

    wx = load_weather(conn, uid, garmin_id)
    wx_line = adjusted_pace = None
    if wx and wx["temp_c"] is not None:
        wx_line = WX.describe(wx["temp_c"], wx["humidity"], wx["dew_point_c"])
        if act.get("distance_m") and act.get("moving_s"):
            raw_pace = act["moving_s"] / (act["distance_m"] / 1000.0)
            corrected = WX.adjust(raw_pace, wx["temp_c"], wx["humidity"], wx["dew_point_c"])
            if corrected and abs(corrected - raw_pace) >= 1.0:
                adjusted_pace = corrected

    row_st = conn.execute(
        "SELECT * FROM run_stops WHERE user_id=? AND garmin_id=?",
        (uid, garmin_id)).fetchone()
    breaks = dict(row_st) if row_st else None
    if breaks:
        breaks["interruptions"] = json.loads(breaks.pop("detail"))

    row_s = conn.execute(
        "SELECT * FROM track_sessions WHERE user_id=? AND garmin_id=?",
        (uid, garmin_id)).fetchone()
    sess = dict(row_s) if row_s else None
    if sess:
        sess["reps"] = json.loads(sess["detail"])
    prescribed = band = None
    if summary:
        for name, _purpose, fast, slow in summary["paces"]:
            if name == "Interval":
                prescribed = (fast, slow)
    if prescribed and sess:
        lo, hi = prescribed
        paces = [r["pace"] for r in sess["reps"]]
        band = {
            "quicker": sum(1 for p in paces if p < lo),
            "inside": sum(1 for p in paces if lo <= p <= hi),
            "slower": sum(1 for p in paces if p > hi),
            "total": len(paces),
        }

    split_max = max((p for _, _, p in splits), default=0.0)
    split_min = min((p for _, _, p in splits), default=0.0)
    return render_template(
        "activity.html", user=g.user, act=act, splits=splits, efforts=efforts,
        drift=drift, load=load, evenness=F.split_evenness(splits),
        kind=F.classify_run(act, thr_hr, thr_pace) if act["type"] in F.RUN_TYPES else act["type"],
        split_min=split_min, split_max=split_max, has_stream=bool(stream),
        track=track, session=sess, prescribed=prescribed, band=band, breaks=breaks,
        wx=wx, wx_line=wx_line, adjusted_pace=adjusted_pace,
        shape=shape, form_drift=form_drift, form_findings=form_findings,
        fmt_time=F.fmt_time, fmt_pace=F.fmt_pace, fmt_effort=F.fmt_effort,
    )


def tile_summary(conn, uid, now, zoom=territory.DEFAULT_ZOOM):
    """Everything the intvl page needs. -> dict, or None if no ground is claimed."""
    rows = conn.execute(
        "SELECT x, y, first_seen, visits FROM tiles WHERE user_id=? AND zoom=?",
        (uid, zoom)).fetchall()
    if not rows:
        return None
    tiles = {(r["x"], r["y"]) for r in rows}
    visits = {(r["x"], r["y"]): r["visits"] for r in rows}
    today = now.date()
    week_ago = (today - timedelta(days=7)).isoformat()
    month_ago = (today - timedelta(days=30)).isoformat()

    st = territory.stats(tiles, zoom=zoom)
    st["this_week"] = sum(1 for r in rows if r["first_seen"] >= week_ago)
    st["this_month"] = sum(1 for r in rows if r["first_seen"] >= month_ago)
    st["home"] = territory.home_tile(visits)
    st["coverage"] = territory.area_coverage(tiles, st["home"])
    st["targets"] = territory.square_growth_targets(tiles)
    st["tiles"] = len(tiles)
    st["tile_set"] = tiles
    st["visits"] = visits
    return st


@app.route("/intvl")
@login_required
def intvl():
    conn = db()
    now = datetime.now()
    summary = tile_summary(conn, g.user["id"], now)
    first = conn.execute(
        "SELECT MIN(first_seen) m FROM tiles WHERE user_id=?", (g.user["id"],)).fetchone()["m"]
    return render_template("intvl.html", user=g.user, now=now, t=summary, since=first)


@app.route("/api/tiles")
@login_required
def api_tiles():
    """Claimed ground for the map. Compact on purpose -- this can be thousands."""
    conn = db()
    zoom = territory.DEFAULT_ZOOM
    summary = tile_summary(conn, g.user["id"], datetime.now(), zoom)
    if not summary:
        return {"zoom": zoom, "tiles": [], "square": None, "targets": []}
    size, corner = summary["max_square"], summary["square_corner"]
    return {
        "zoom": zoom,
        "tiles": sorted([x, y] for (x, y) in summary["tile_set"]),
        "square": {"size": size, "corner": list(corner)} if corner else None,
        "cluster": sorted([x, y] for (x, y) in summary["cluster"]),
        "targets": [[t[0], t[1]] for t, _size, _cost in summary["targets"]],
        "home": list(summary["home"]) if summary["home"] else None,
    }


# Ported from RouteMaster. These are the only values BRouter and the UI accept;
# anything else is a client bug or someone poking at the API.
ROUTE_PROFILES = {"trekking", "fastbike", "mtb", "hiking-mountain", "shortest"}
ROUTE_TYPES = {"p2p", "loop", "outback"}
MAX_WAYPOINTS = 50


def clean_waypoints(raw):
    """Validate client-supplied waypoints. -> list, or None if they are junk."""
    if not isinstance(raw, list) or not raw or len(raw) > MAX_WAYPOINTS:
        return None
    out = []
    for p in raw:
        if not isinstance(p, dict):
            return None
        try:
            lat, lon = float(p["lat"]), float(p["lon"])
        except (KeyError, TypeError, ValueError):
            return None
        if not (-90.0 <= lat <= 90.0) or not (-180.0 <= lon <= 180.0):
            return None
        out.append({"lat": round(lat, 6), "lon": round(lon, 6)})
    return out


@app.route("/routes")
@login_required
def routes_page():
    return render_template("routes.html", user=g.user, now=datetime.now())


@app.route("/api/routes")
@login_required
def api_routes_list():
    rows = db().execute(
        "SELECT id, name, profile, rtype, pts FROM routes WHERE user_id=? ORDER BY name",
        (g.user["id"],)).fetchall()
    return {"routes": [{"id": r["id"], "name": r["name"], "profile": r["profile"],
                        "rtype": r["rtype"], "pts": json.loads(r["pts"])} for r in rows]}


@app.route("/api/routes", methods=["POST"])
@login_required
def api_routes_save():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()[:120]
    profile = body.get("profile")
    rtype = body.get("rtype")
    pts = clean_waypoints(body.get("pts"))
    if not name:
        return {"error": "Give the route a name."}, 400
    if profile not in ROUTE_PROFILES or rtype not in ROUTE_TYPES:
        return {"error": "Unknown routing profile or route type."}, 400
    if pts is None:
        return {"error": "That route has no usable waypoints."}, 400

    conn = db()
    conn.execute(
        """INSERT INTO routes (user_id, name, profile, rtype, pts, created_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT(user_id, name) DO UPDATE SET
             profile=excluded.profile, rtype=excluded.rtype, pts=excluded.pts""",
        (g.user["id"], name, profile, rtype, json.dumps(pts),
         datetime.now().isoformat(timespec="seconds")))
    conn.commit()
    row = conn.execute("SELECT id FROM routes WHERE user_id=? AND name=?",
                       (g.user["id"], name)).fetchone()
    return {"id": row["id"]}


@app.route("/api/routes/<int:route_id>", methods=["DELETE"])
@login_required
def api_routes_delete(route_id):
    conn = db()
    cur = conn.execute("DELETE FROM routes WHERE id=? AND user_id=?",
                       (route_id, g.user["id"]))
    conn.commit()
    if not cur.rowcount:
        abort(404)
    return {"ok": True}


@app.route("/trails")
@login_required
def trails_page():
    conn = db()
    uid = g.user["id"]
    named_only = request.args.get("all") != "1"
    hide_done = request.args.get("hide_done") == "1"

    all_trails, stats = build_trails(conn, uid, named_only=named_only)
    shown = [t for t in all_trails if not (hide_done and t["complete"])]

    areas = conn.execute(
        "SELECT * FROM trail_areas WHERE user_id=? ORDER BY loaded_at DESC",
        (uid,)).fetchall()
    unmatched = conn.execute(
        """SELECT COUNT(*) c FROM streams s WHERE s.user_id=? AND NOT EXISTS
             (SELECT 1 FROM trail_matched m WHERE m.user_id=s.user_id
                AND m.garmin_id=s.garmin_id)""", (uid,)).fetchone()["c"]
    return render_template(
        "trails.html", user=g.user, now=datetime.now(), areas=areas,
        trails=shown[:400], total_shown=len(shown), stats=stats,
        unmatched=unmatched, named_only=named_only, hide_done=hide_done,
        fmt_time=F.fmt_time)


@app.route("/trails/load", methods=["POST"])
@login_required
def trails_load():
    """Pull every walkable way in a bounding box from Overpass."""
    try:
        bbox = [float(request.form[k]) for k in ("south", "west", "north", "east")]
    except (KeyError, ValueError):
        flash("That map area did not come through. Move the map and try again.", "error")
        return redirect(url_for("trails_page"))
    if not (-90 <= bbox[0] < bbox[2] <= 90 and -180 <= bbox[1] < bbox[3] <= 180):
        flash("That is not a valid map area.", "error")
        return redirect(url_for("trails_page"))
    area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
    if area > MAX_AREA_SQ_DEG:
        flash("That area is too big to ask a free Overpass server for. "
              "Zoom in and load it in pieces.", "error")
        return redirect(url_for("trails_page"))

    name = (request.form.get("name") or "").strip()[:80] or ("Area %.3f,%.3f" % (bbox[0], bbox[1]))
    conn = db()
    try:
        data = overpass(overpass_trail_query(bbox))
    except RuntimeError as e:
        flash(str(e), "error")
        return redirect(url_for("trails_page"))

    segs = TR.segments_from_overpass(data)
    if not segs:
        flash("No trails found in that area.", "info")
        return redirect(url_for("trails_page"))

    cur = conn.execute(
        "INSERT INTO trail_areas (user_id, name, bbox, loaded_at, seg_count) VALUES (?,?,?,?,?)",
        (g.user["id"], name, json.dumps(bbox),
         datetime.now().isoformat(timespec="seconds"), len(segs)))
    area_id = cur.lastrowid
    added = save_segments(conn, g.user["id"], segs, area_id)
    if added:
        # New trails mean every run has to be checked against them again.
        conn.execute("DELETE FROM trail_matched WHERE user_id=?", (g.user["id"],))
    conn.execute("UPDATE trail_areas SET seg_count=? WHERE id=?", (added, area_id))
    conn.commit()

    matched, _ = match_activities(conn, g.user["id"])
    flash("Loaded %d trails from %s (%d already known). Matched %d of your runs against them."
          % (added, name, len(segs) - added, matched), "success")
    return redirect(url_for("trails_page"))


@app.route("/trails/match", methods=["POST"])
@login_required
def trails_match():
    conn = db()
    if request.form.get("again") == "1":
        conn.execute("DELETE FROM trail_hits WHERE user_id=?", (g.user["id"],))
        conn.execute("DELETE FROM trail_matched WHERE user_id=?", (g.user["id"],))
        conn.commit()
    matched, touched = match_activities(conn, g.user["id"])
    if matched:
        flash("Matched %d runs, touching %d trail sections." % (matched, touched), "success")
    else:
        flash("Nothing new to match. Load a map area first, or sync more runs.", "info")
    return redirect(url_for("trails_page"))


@app.route("/trails/area/<int:area_id>/delete", methods=["POST"])
@login_required
def trails_delete_area(area_id):
    conn = db()
    conn.execute("DELETE FROM trail_segments WHERE user_id=? AND area_id=?",
                 (g.user["id"], area_id))
    cur = conn.execute("DELETE FROM trail_areas WHERE id=? AND user_id=?",
                       (area_id, g.user["id"]))
    conn.commit()
    if not cur.rowcount:
        abort(404)
    flash("Area removed.", "info")
    return redirect(url_for("trails_page"))


@app.route("/api/trails")
@login_required
def api_trails():
    """Trail geometry plus which parts are covered, for the map."""
    conn = db()
    uid = g.user["id"]
    segs = load_segments(conn, uid)
    cover = stored_coverage(conn, uid)
    out = []
    for sg in segs[:3000]:          # ponytail: hard cap; paginate by bbox if it bites
        mask = cover.get(sg.id)
        runs = TR.covered_runs(mask) if mask else []
        out.append({
            "id": sg.id, "name": sg.name, "kind": sg.kind,
            "coords": [[round(a, 5), round(b, 5)] for a, b in sg.coords],
            "covered": [[a, b] for a, b in runs],
        })
    return {"segments": out, "truncated": len(segs) > 3000}


@app.route("/sessions")
@login_required
def sessions_page():
    conn = db()
    uid = g.user["id"]
    sessions = load_sessions(conn, uid)
    summary, _acts = build_summary(conn, uid, datetime.now())
    prescribed = None
    if summary:
        for name, _purpose, fast, slow in summary["paces"]:
            if name == "Interval":
                prescribed = (fast, slow)
    return render_template(
        "sessions.html", user=g.user, now=datetime.now(), sessions=sessions,
        progression=session_progression(sessions), prescribed=prescribed,
        fmt_time=F.fmt_time, fmt_pace=F.fmt_pace)


@app.route("/stops/rescan", methods=["POST"])
@login_required
def stops_rescan():
    found, junctions = rescan_stops(db(), g.user["id"])
    flash("Re-read every run: %d had interruptions, %d recurring stop point%s "
          "recognised as junctions."
          % (found, len(junctions), "" if len(junctions) == 1 else "s"), "success")
    return redirect(request.referrer or url_for("index"))


@app.route("/sessions/rescan", methods=["POST"])
@login_required
def sessions_rescan():
    found = rescan_sessions(db(), g.user["id"])
    flash("Re-read every run: %d interval session%s found."
          % (found, "" if found == 1 else "s"), "success")
    return redirect(url_for("sessions_page"))


POI_CACHE_DAYS = 7

# ponytail: one in-process lock per user. Stops a burst of layer toggles turning
# into a burst of concurrent Overpass queries, which is how you get temporarily
# blocked. A shared queue if this ever runs multi-worker.
_poi_locks = {}
_poi_guard = threading.Lock()


def poi_lock(user_id):
    with _poi_guard:
        return _poi_locks.setdefault(user_id, threading.Lock())


@app.route("/api/poi-layers")
@login_required
def api_poi_layers():
    """The layer catalogue, so the UI never hard-codes it."""
    return {"groups": [
        {"name": name,
         "layers": [{"id": l.id, "label": l.label, "icon": l.icon,
                     "fee_matters": l.fee_matters} for l in layers]}
        for name, layers in POI.groups()]}


@app.route("/api/pois", methods=["POST"])
@login_required
def api_pois():
    """Find the requested layers along a drawn route.

    Server-side rather than from the browser: this way the Overpass call gets
    the mirror failover, the retry and the descriptive User-Agent that the trail
    loader already uses, plus a cache so toggling a layer off and on is free.
    """
    body = request.get_json(silent=True) or {}
    points = POI.thin(body.get("points") or [])
    layers = [x for x in (body.get("layers") or []) if x in POI.BY_ID]
    free_only = bool(body.get("free_only"))
    if len(points) < 2:
        return {"error": "Draw a route first."}, 400
    if not layers:
        return {"pois": [], "cached": False}

    query = POI.build_query(points, layers)
    if not query:
        return {"error": "Nothing to look for."}, 400

    conn = db()
    key = hashlib.sha256(query.encode()).hexdigest()
    fresh = (datetime.now() - timedelta(days=POI_CACHE_DAYS)).isoformat()
    hit = conn.execute(
        "SELECT payload FROM poi_cache WHERE key=? AND fetched_at >= ?",
        (key, fresh)).fetchone()
    if hit:
        data = json.loads(hit["payload"])
        return {"pois": POI.parse(data, layers, free_only), "cached": True}

    lock = poi_lock(g.user["id"])
    if not lock.acquire(timeout=45):
        return {"error": "Still fetching the last set of layers."}, 429
    try:
        # Another request may have filled the cache while we waited for the lock.
        hit = conn.execute(
            "SELECT payload FROM poi_cache WHERE key=? AND fetched_at >= ?",
            (key, fresh)).fetchone()
        if hit:
            data = json.loads(hit["payload"])
            return {"pois": POI.parse(data, layers, free_only), "cached": True}
        data = overpass(query)
    except RuntimeError as e:
        return {"error": str(e)}, 502
    finally:
        lock.release()

    conn.execute(
        """INSERT INTO poi_cache (key, fetched_at, payload) VALUES (?,?,?)
           ON CONFLICT(key) DO UPDATE SET
             fetched_at=excluded.fetched_at, payload=excluded.payload""",
        (key, datetime.now().isoformat(timespec="seconds"), json.dumps(data)))
    conn.commit()
    return {"pois": POI.parse(data, layers, free_only), "cached": False}


@app.route("/routes/repeats")
@login_required
def repeats_page():
    conn = db()
    return render_template("repeats.html", user=g.user, now=datetime.now(),
                           routes=repeated_routes(conn, g.user["id"]),
                           fmt_pace=F.fmt_pace, fmt_time=F.fmt_time)


@app.route("/durability")
@login_required
def durability_page():
    conn = db()
    runs, limits = durability_runs(conn, g.user["id"])
    return render_template(
        "durability.html", user=g.user, now=datetime.now(),
        runs=runs, limits=limits,
        trend=DU.trend([(r["start"], r) for r in reversed(runs)]),
        fmt_pace=F.fmt_pace, fmt_time=F.fmt_time)


@app.route("/climbing")
@login_required
def climbing_page():
    conn = db()
    return render_template("climbing.html", user=g.user, now=datetime.now(),
                           climb=climbing(conn, g.user["id"]),
                           fmt_pace=F.fmt_pace, fmt_time=F.fmt_time)


@app.route("/second-opinion")
@login_required
def second_opinion_page():
    conn = db()
    acts = load_activities(conn, g.user["id"])
    summary = F.summarise(acts, datetime.now()) if acts else None
    return render_template("secondopinion.html", user=g.user, now=datetime.now(),
                           review=second_opinion(conn, g.user["id"], summary),
                           summary=summary,
                           fmt_pace=F.fmt_pace, fmt_time=F.fmt_time)


@app.route("/career")
@login_required
def career_page():
    conn = db()
    uid = g.user["id"]
    today = datetime.now()
    runs = [a for a in load_activities(conn, uid) if a.get("type") in F.RUN_TYPES]

    finished = conn.execute(
        """SELECT COUNT(*) n FROM races
            WHERE user_id=? AND (actual_s IS NOT NULL OR garmin_id IS NOT NULL)""",
        (uid,)).fetchone()["n"]

    years = RE.by_year(runs)
    return render_template(
        "career.html", user=g.user, now=today,
        career=RE.career(runs, finished, today.date()),
        years=years,
        this_year=RE.partial_year_compare(runs, today.year, today.date()),
        busiest=RE.busiest_month(runs, today.year),
        landmark=LM.compare(sum(a.get("elev_gain_m") or 0.0 for a in runs)),
        fmt_pace=F.fmt_pace, fmt_time=F.fmt_time)


@app.route("/vitals")
@login_required
def vitals_page():
    conn = db()
    return render_template("vitals.html", user=g.user, now=datetime.now(),
                           report=vitals_report(conn, g.user["id"]),
                           fmt_pace=F.fmt_pace, fmt_time=F.fmt_time)


@app.route("/gear")
@login_required
def gear_page():
    conn = db()
    return render_template("gear.html", user=g.user, now=datetime.now(),
                           gear=gear_table(conn, g.user["id"]),
                           seasons=weather_seasons(conn, g.user["id"]),
                           default_life_km=DEFAULT_SHOE_LIFE_M / 1000.0,
                           fmt_pace=F.fmt_pace, fmt_time=F.fmt_time)


@app.route("/api/summary")
@login_required
def api_summary():
    """Everything the dashboard knows, as JSON -- for scripts and spreadsheets."""
    conn = db()
    uid = g.user["id"]
    now = datetime.now()
    summary, acts = build_summary(conn, uid, now)
    if not summary:
        return {"activities": 0}
    cal = F.calibration(load_results(conn, uid), now.date())
    races = []
    for r in load_races(conn, uid):
        p = F.apply_calibration(
            F.project_race(summary, r["distance_m"], r["date"], now.date()), cal)
        races.append({
            "name": r["name"], "date": r["date"].isoformat(),
            "distance_m": r["distance_m"], "goal_s": r["goal_s"], "actual_s": r["actual_s"],
            "projected_s": p["seconds"] if p else None,
            "confidence": p["confidence"] if p else None,
        })
    spike = summary["spike"]
    return {
        "generated_at": now.isoformat(timespec="seconds"),
        "activities": len(acts),
        "fitness": {"ctl": summary["ctl"], "atl": summary["atl"], "tsb": summary["tsb"],
                    "ctl_6w_ago": summary["ctl_6w_ago"], "threshold_hr": summary["threshold_hr"],
                    "threshold_pace_s_per_km": summary["threshold_pace"],
                    "session_spike": spike[0] if spike else None,
                    "session_spike_verdict": spike[3] if spike else None},
        "fatigue_exponent": summary["fit"][1] if summary["fit"] else None,
        "calibration": cal,
        "races": races,
        "standard_projections": {
            label: F.apply_calibration(F.project_race(summary, d), cal)["seconds"]
            for label, d in F.STANDARD_RACES if F.project_race(summary, d)},
        "training_paces": [{"name": n, "fast_s_per_km": f, "slow_s_per_km": sl}
                           for n, _, f, sl in summary["paces"]],
        "hr_zones": [{"name": n, "low": lo, "high": hi} for n, lo, hi in summary["zones"]],
        "personal_records": [{"distance_m": d, "seconds": s, "date": w}
                             for d, s, w in F.personal_records(load_pr_rows(conn, uid))],
        "weekly": [{"week": w.isoformat(), "km": km, "hours": h, "load": l}
                   for w, km, h, l in summary["weekly"]],
        "territory": {k: v for k, v in (tile_summary(conn, uid, now) or {}).items()
                      if k not in ("tile_set", "cluster", "visits", "targets")},
    }


@app.route("/export.csv")
@login_required
def export_csv():
    rows = db().execute(
        "SELECT start, name, type, distance_m, moving_s, elapsed_s, avg_hr, max_hr,"
        " elev_gain_m, calories FROM activities WHERE user_id=? ORDER BY start DESC",
        (g.user["id"],)).fetchall()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["start", "name", "type", "distance_m", "moving_s", "elapsed_s",
                     "avg_hr", "max_hr", "elev_gain_m", "calories"])
    writer.writerows([tuple(r) for r in rows])
    return Response(
        buf.getvalue(), mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=run315-activities.csv"})


# --------------------------------------------------------------------------- #
# installable app
# --------------------------------------------------------------------------- #
# Both files are templates so that url_for decides the paths: the same code
# serves a real install at / and the frozen demo under /Run315/.
@app.route("/manifest.webmanifest")
def manifest():
    return Response(render_template("manifest.webmanifest"),
                    mimetype="application/manifest+json")


@app.route("/sw.js")
def service_worker():
    # A worker can only control the directory it is served from, so this has
    # to stay at the mount root -- not under /static/.
    return Response(render_template("sw.js"), mimetype="text/javascript",
                    headers={"Cache-Control": "no-cache"})


@app.route("/healthz")
def healthz():
    return {"ok": True, "activities": db().execute(
        "SELECT COUNT(*) c FROM activities").fetchone()["c"]}


# --------------------------------------------------------------------------- #
# demo seed
# --------------------------------------------------------------------------- #
DEMO_HOME = (47.3769, 8.5417)      # Zurich, so the demo map lands somewhere real


def demo_route(bearing_deg, total_m, home=DEMO_HOME, steps=40):
    """An out-and-back of `total_m` on a gently curving bearing.

    -> [(cumulative_m, lat, lon)]. Curving rather than dead straight means the
    claimed tiles look like a route someone ran, not a ruler line.
    """
    import math as _m
    half = total_m / 2.0
    step = half / steps
    lat, lon, cum = home[0], home[1], 0.0
    out = [(0.0, lat, lon)]
    for i in range(steps):
        brg = bearing_deg + 35.0 * _m.sin(_m.pi * i / steps) + (i % 3) * 4.0
        r = _m.radians(brg)
        lat += step * _m.cos(r) / 111320.0
        lon += step * _m.sin(r) / (111320.0 * _m.cos(_m.radians(lat)))
        cum += step
        out.append((cum, lat, lon))
    # Retrace the same way home, so distance keeps increasing.
    return out + [(total_m - c, la, lo) for c, la, lo in reversed(out[:-1])]


def demo_point(route, d):
    """Position at cumulative distance `d` along a demo_route()."""
    if d <= route[0][0]:
        return route[0][1], route[0][2]
    for i in range(1, len(route)):
        c0, la0, lo0 = route[i - 1]
        c1, la1, lo1 = route[i]
        if d <= c1:
            f = (d - c0) / (c1 - c0) if c1 > c0 else 0.0
            return la0 + (la1 - la0) * f, lo0 + (lo1 - lo0) * f
    return route[-1][1], route[-1][2]


def seed_demo():
    """A synthetic athlete so the app can be run without Garmin credentials."""
    import math
    import random
    rng = random.Random(315)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    conn.execute(
        """INSERT INTO users (google_sub, email, name, created_at) VALUES (?,?,?,?)
           ON CONFLICT(google_sub) DO NOTHING""",
        ("demo", "demo@run315.local", "Demo Athlete",
         datetime.now().isoformat(timespec="seconds")))
    uid = conn.execute("SELECT id FROM users WHERE google_sub='demo'").fetchone()["id"]
    conn.execute("DELETE FROM activities WHERE user_id=?", (uid,))
    conn.execute("DELETE FROM races WHERE user_id=?", (uid,))
    conn.execute("DELETE FROM best_efforts WHERE user_id=?", (uid,))

    today = datetime.now().replace(hour=7, minute=30, second=0, microsecond=0)
    rows, runs, conditions, n = [], [], [], 0
    for days_ago in range(365, -1, -1):
        day = today - timedelta(days=days_ago)
        dow = day.weekday()
        if dow in (0, 4):                                    # rest days
            continue
        # Fitness improves over the year: volume ramps and pace follows.
        progress = 1 - days_ago / 365.0
        form = 1.0 - 0.06 * progress
        ramp = 0.70 + 0.30 * progress

        # Zurich weather over the year, and the slowdown that comes with it.
        # Deliberately a different shape from the correction model, so the demo
        # is a demonstration rather than a tautology.
        doy = day.timetuple().tm_yday
        temp_c = 12.0 + 12.0 * math.sin(2 * math.pi * (doy - 100) / 365.0)
        humidity = 62.0 + 18.0 * math.sin(2 * math.pi * (doy - 40) / 365.0)
        heat_drag = 1.0 + 0.004 * max(0.0, temp_c - 14.0)
        parkrun = dow == 5 and days_ago % 28 < 7
        if dow == 6:                                         # long run
            dist, pace, hr = rng.uniform(18000, 26000), 300 * form, 148
        elif dow == 2:                                       # intervals
            dist, pace, hr = rng.uniform(9000, 12000), 258 * form, 172
        elif parkrun:                                        # a real 5K, flat out
            dist, pace, hr = 5000.0, 243 * form, 181
        elif dow == 5:                                       # tempo
            dist, pace, hr = rng.uniform(10000, 14000), 276 * form, 165
        else:
            dist, pace, hr = rng.uniform(8000, 12000), 312 * form, 142
        if not parkrun:                                      # a 5K is always 5 km
            dist *= ramp
        secs = dist / 1000.0 * pace * heat_drag * rng.uniform(0.99, 1.01)
        n += 1
        rows.append((uid, "demo-%d" % n, "Run", "running", day.isoformat(),
                     round(dist, 1), round(secs, 1), round(secs * 1.01, 1),
                     hr + rng.randint(-3, 3), hr + 12, rng.uniform(20, 180),
                     round(secs / 60 * 11)))
        runs.append(("demo-%d" % n, day.isoformat(), dist, secs, dow, days_ago))
        conditions.append(("demo-%d" % n, round(temp_c, 1), round(humidity, 0),
                           round(temp_c - (100 - humidity) / 5.0, 1)))
        if dow == 3:                                         # easy spin
            n += 1
            ride_m = rng.uniform(30000, 55000)
            ride_s = ride_m / 1000.0 / rng.uniform(26.0, 30.0) * 3600.0
            rows.append((uid, "demo-%d" % n, "Bike", "cycling",
                         (day + timedelta(hours=9)).isoformat(),
                         round(ride_m, 1), round(ride_s, 1), round(ride_s * 1.04, 1),
                         128 + rng.randint(-5, 5), 155, rng.uniform(100, 600),
                         round(ride_s / 60 * 9)))
    conn.executemany(
        """INSERT INTO activities (user_id, garmin_id, name, type, start, distance_m,
             moving_s, elapsed_s, avg_hr, max_hr, elev_gain_m, calories)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""", rows)

    # Synthesise a within-run pace profile and put it through the real
    # best-effort extractor, so the demo exercises the same code path a Garmin
    # stream does rather than inventing tidy numbers.
    def profile(dow, days_ago, step, count):
        """Per-step pace multiplier: session shape decides where the fast bit is."""
        for i in range(count):
            frac = i / max(count - 1, 1)
            if dow == 2:                                   # intervals: 3 min hard / 2 min float
                yield 0.86 if (i * step) % 1600 < 900 else 1.14
            elif dow == 5 and days_ago % 28 < 7:           # parkrun: flat out
                yield 0.99
            elif dow == 5:                                 # tempo block in the middle
                yield 0.90 if 0.3 < frac < 0.7 else 1.08
            elif dow == 6:                                 # long run, quick last quarter
                yield 0.93 if frac > 0.75 else 1.03
            else:
                yield 1.0

    effort_rows, stream_rows, tile_rows = [], [], []
    for gid, start_iso, dist, secs, dow, days_ago in runs:  # noqa: PLR1702
        step = 25.0
        count = max(int(dist / step), 2)
        weights = list(profile(dow, days_ago, step, count))
        base = secs / sum(weights)                        # keep the total time honest
        samples, t, d = [(0.0, 0.0)], 0.0, 0.0
        for w in weights:
            t += base * w
            d += step
            samples.append((t, d))
        for edist, esecs in F.best_effort_curve(samples).items():
            effort_rows.append((uid, gid, float(edist), esecs, start_iso))
        # Thin the stream to ~200 samples and add a plausible HR trace with drift.
        keep = max(len(samples) // 200, 1)
        base_hr = {2: 172, 6: 148}.get(dow, 181 if (dow == 5 and days_ago % 28 < 7) else 142)
        if dow == 6:
            bearing = (days_ago * 13) % 360          # long runs explore
        elif dow == 2:
            bearing = (n % 4) * 90                   # intervals: four usual ways out
        else:
            bearing = (n % 6) * 60                   # easy runs: the same few loops
        gps = demo_route(bearing, dist)

        # Where this run gets interrupted. The same two corners come up on every
        # easy run, which is what makes them read as junctions rather than
        # decisions. Long runs add a water stop, and a walk break once they are
        # long enough to hurt.
        standing = []                       # (distance_m, seconds stood still)
        walking = []                        # (distance_m, metres walked)
        if dow not in (2, 5):
            standing += [(1200.0, 22.0), (dist * 0.62, 18.0)]
        if dow == 6:
            standing.append((dist * 0.45, 150.0))
            if dist > 16000:
                walking.append((dist * 0.80, 280.0))

        thin = []
        prev_t = prev_d = clock = 0.0
        tired = 1.0                         # pace penalty carried after a walk
        hill = rng.uniform(0.0, 6.283)
        for (t, d), w in zip(samples[::keep], ([1.0] + weights)[::keep]):
            step_d = max(d - prev_d, 0.0)
            step_t = max(t - prev_t, 0.0) * tired
            prev_t, prev_d = t, d

            on_foot = any(a <= d <= a + m for a, m in walking)
            if on_foot and step_d > 0:
                step_t = step_d / 1.35      # walking, not running
            clock += step_t

            la, lo = demo_point(gps, d)
            ele = 400.0 + 18.0 * math.sin(hill + 4.0 * math.pi * d / dist)
            hr = base_hr * (0.94 + 0.10 * (d / dist)) * (0.90 if w > 1.05 else 1.0)

            # Faster running means quicker feet and less time on the ground, and
            # everything drifts the wrong way once you have been out a while.
            speed_now = 1.35 if on_foot else (dist / secs) / max(w, 0.01)
            tiredness = max(0.0, d / dist - 0.6) * (1.0 if dist > 16000 else 0.3)
            cadence = 158.0 + 7.0 * speed_now - 6.0 * tiredness
            gct = 300.0 - 18.0 * speed_now + 22.0 * tiredness
            vosc = 9.6 - 0.35 * speed_now
            stride = speed_now / (cadence / 60.0)
            thin.append([round(clock, 1), round(d, 1), round(hr),
                         round(la, 6), round(lo, 6), round(ele, 1),
                         round(cadence, 1), round(stride, 3),
                         round(gct, 1), round(vosc, 2)])

            # Once the walk is done the legs are gone: everything after is slower.
            if on_foot:
                tired = 1.09

            for at_m, held_s in standing:
                if at_m <= d < at_m + step_d and step_d > 0:
                    held = 0.0
                    while held < held_s:
                        held += 4.0
                        clock += 4.0
                        # Standing: distance frozen, heart rate falling away.
                        thin.append([round(clock, 1), round(d, 1),
                                     round(hr - min(held * 0.24, 45)),
                                     round(la, 6), round(lo, 6), round(ele, 1),
                                     None, None, None, None])
        stream_rows.append((uid, gid, json.dumps(thin)))
        tile_rows.append((gid, start_iso, thin))
    conn.executemany(
        """INSERT INTO best_efforts (user_id, garmin_id, distance_m, seconds, start)
           VALUES (?,?,?,?,?)""", effort_rows)
    conn.execute("DELETE FROM streams WHERE user_id=?", (uid,))
    conn.executemany("INSERT INTO streams (user_id, garmin_id, samples) VALUES (?,?,?)",
                     stream_rows)
    # Overnight numbers: HRV drifts with the training load, dips after the hard
    # days, and carries the night-to-night noise that makes a baseline mean
    # anything at all.
    # The off-run day: stress, body battery, sleep stages, weight, oxygen. All of
    # it correlates with training load, because in a real athlete it does.
    conn.execute("DELETE FROM daily WHERE user_id=?", (uid,))
    load_by_day = {}
    for _gid, start_iso, _dist, secs, _dow, _ago in runs:
        day = start_iso[:10]
        load_by_day[day] = load_by_day.get(day, 0.0) + (secs or 0) / 60.0
    weight = 70.5
    for back in range(1, 75):
        day = today.date() - timedelta(days=back)
        iso = day.isoformat()
        minutes = load_by_day.get(iso, 0.0)
        hard = minutes > 55
        # Stress rises with yesterday's load; body battery falls.
        yesterday = load_by_day.get((day - timedelta(days=1)).isoformat(), 0.0)
        stress = 26.0 + yesterday * 0.18 + rng.gauss(0, 5)
        battery_high = 88.0 - yesterday * 0.10 + rng.gauss(0, 4)
        deep = 4800.0 + rng.gauss(0, 700) + (400 if hard else 0)
        rem = 5100.0 + rng.gauss(0, 800)
        light = 13800.0 + rng.gauss(0, 1500)
        weight += rng.gauss(0, 0.12) - 0.004      # a slow drift down over the block
        store_daily(conn, uid, {
            "day": iso,
            "steps": round(7200 + minutes * 95 + rng.gauss(0, 1200)),
            "floors": round(max(0, 8 + rng.gauss(0, 5))),
            "stress_avg": round(max(8.0, stress), 1),
            "stress_max": round(min(99.0, max(40.0, stress * 2.4 + rng.gauss(0, 8))), 1),
            "body_battery_high": round(min(100.0, max(40.0, battery_high))),
            "body_battery_low": round(max(5.0, battery_high - 30 - minutes * 0.22)),
            "spo2_avg": round(min(99.0, 95.5 + rng.gauss(0, 1.0)), 1),
            "spo2_low": round(min(97.0, 90.0 + rng.gauss(0, 2.0)), 1),
            "respiration_avg": round(13.2 + rng.gauss(0, 0.8), 1),
            "intensity_minutes": round(max(0.0, minutes * 0.8 + rng.gauss(0, 8))),
            "vigorous_minutes": round(max(0.0, minutes * 0.35 + rng.gauss(0, 6))),
            "weight_kg": round(weight, 2),
            "body_fat_pct": round(12.4 + rng.gauss(0, 0.35), 1),
            "training_readiness": round(min(99.0, max(20.0, 72.0 - yesterday * 0.16
                                                      + rng.gauss(0, 9)))),
            "calories_total": round(2450 + minutes * 11 + rng.gauss(0, 120)),
            "calories_active": round(380 + minutes * 10.5 + rng.gauss(0, 90)),
            "fitness_age": round(31.0 + rng.gauss(0, 0.4), 1),
            "deep_s": round(max(1800.0, deep)),
            "light_s": round(max(6000.0, light)),
            "rem_s": round(max(1800.0, rem)),
            "awake_s": round(max(120.0, 900.0 + rng.gauss(0, 400))),
            "restless_count": round(max(0.0, 12 + rng.gauss(0, 6))),
            "avg_stress": round(max(5.0, 17.0 + yesterday * 0.05 + rng.gauss(0, 4)), 1),
        })

    conn.execute("DELETE FROM wellness WHERE user_id=?", (uid,))
    hard_days = {gid_start[:10] for gid_start in
                 [r[1] for r in runs if r[4] in (2, 5, 6)]}
    nights = []
    for back in range(1, 75):
        night = today.date() - timedelta(days=back)
        iso = night.isoformat()
        after_hard = (night - timedelta(days=1)).isoformat() in hard_days
        hrv = 60.0 + rng.gauss(0, 5.5) - (5.0 if after_hard else 0.0)
        rhr = 47.0 + rng.gauss(0, 1.8) + (1.5 if after_hard else 0.0)
        hours = 7.4 + rng.gauss(0, 0.7) - (0.3 if after_hard else 0.0)
        nights.append((uid, iso, round(hrv, 1), round(rhr, 1),
                       round(max(hours, 4.0), 2),
                       round(max(40.0, min(95.0, 78.0 + rng.gauss(0, 9))), 0)))
    conn.executemany(
        """INSERT INTO wellness (user_id, day, hrv_ms, rhr, sleep_hours, sleep_score)
           VALUES (?,?,?,?,?,?)""", nights)

    # Garmin's own estimates. Generated by perturbing our numbers rather than
    # inventing free-standing ones, so the comparison page shows the realistic
    # case: two methods that mostly agree and disagree in one specific place.
    conn.execute("DELETE FROM garmin_metrics WHERE user_id=?", (uid,))
    demo_summary = F.summarise(load_activities(conn, uid), today)
    if demo_summary and demo_summary.get("fit"):
        their_races = {}
        for distance in (5000, 10000, 21097, 42195):
            projected = F.project_race(demo_summary, distance)
            if not projected:
                continue
            # Garmin leans optimistic at longer distances, which is the bias the
            # validation literature reports and the thing worth showing.
            optimism = 1.0 - 0.012 * (distance / 21097.0)
            their_races[distance] = projected["seconds"] * optimism
        store_derived(conn, uid, {
            "threshold_hr": (demo_summary["threshold_hr"] or 170) - 4,
            # Not simply our own number handed back: seeding it identical would
            # make the comparison agree by construction and prove nothing. The
            # validation literature has Garmin's wrist-based threshold reading
            # slow, so the demo shows it a few per cent slow.
            "threshold_speed_m_s": (1000.0 / (demo_summary["threshold_pace"] * 1.04)
                                    if demo_summary.get("threshold_pace") else None),
            "vo2max": 52.0,
            "endurance_score": 7100.0,
            "hill_score": 68.0,
            "races": their_races,
        }, day=today.date())

    conn.execute("DELETE FROM activity_weather WHERE user_id=?", (uid,))
    conn.executemany(
        """INSERT INTO activity_weather (user_id, garmin_id, temp_c, humidity,
                                         dew_point_c, conditions)
           VALUES (?,?,?,?,?,?)""",
        [(uid, gid, t, h, d, "Partly cloudy") for gid, t, h, d in conditions])

    # Three pairs on rotation: one worn out, one getting on, one barely used.
    conn.execute("DELETE FROM gear WHERE user_id=?", (uid,))
    conn.execute("DELETE FROM activity_gear WHERE user_id=?", (uid,))
    shoes = [("demo-shoe-1", "Pegasus 40", "Nike", "Pegasus 40", 800000.0),
             ("demo-shoe-2", "Endorphin Speed", "Saucony", "Endorphin Speed 3", 700000.0),
             ("demo-shoe-3", "Novablast 4", "Asics", "Novablast 4", 800000.0)]
    conn.executemany(
        """INSERT INTO gear (user_id, uuid, name, brand, model, type, retired, limit_m)
           VALUES (?,?,?,?,?,'shoes',0,?)""",
        [(uid, u, n_, b, m, lim) for u, n_, b, m, lim in shoes])
    pairs = []
    for gid, start_iso, _dist, _secs, dow, days_ago in runs:
        if days_ago < 45:
            uuid = "demo-shoe-3"          # the new pair, only recently in rotation
        elif dow in (2, 5):
            uuid = "demo-shoe-2"          # the quick pair for fast days
        else:
            uuid = "demo-shoe-1"          # the daily trainer, doing the miles
        pairs.append((uid, gid, uuid))
    conn.executemany(
        "INSERT INTO activity_gear (user_id, garmin_id, uuid) VALUES (?,?,?)", pairs)

    conn.execute("DELETE FROM tiles WHERE user_id=?", (uid,))
    conn.execute("DELETE FROM track_sessions WHERE user_id=?", (uid,))
    claimed_total, sessions_found, stop_inputs = set(), 0, []
    for gid, start_iso, thin in tile_rows:
        samples = [(r[0], r[1], r[2], r[3], r[4]) for r in thin]
        got, _new = claim_tiles(conn, uid, gid, start_iso, samples)
        claimed_total |= got
        if store_session(conn, uid, gid, start_iso, samples):
            sessions_found += 1
        stop_inputs.append((gid, start_iso, samples))
    conn.execute("UPDATE activities SET details_synced=1 WHERE user_id=?", (uid,))
    for name, weeks, dist, goal in (("Autumn Half", 7, 21097.0, 5400.0),
                                    ("City Marathon", 16, 42195.0, 11700.0),
                                    ("Club 10K", 3, 10000.0, 2340.0)):
        conn.execute(
            "INSERT INTO races (user_id, name, date, distance_m, goal_s, created_at) VALUES (?,?,?,?,?,?)",
            (uid, name, (today.date() + timedelta(weeks=weeks)).isoformat(), dist, goal,
             datetime.now().isoformat(timespec="seconds")))
    for name, weeks_ago, dist, predicted, actual in (
            ("Spring 10K", 14, 10000.0, 2520.0, 2551.0),
            ("Riverside Half", 8, 21097.0, 5760.0, 5842.0)):
        conn.execute(
            """INSERT INTO races (user_id, name, date, distance_m, goal_s, predicted_s,
                                  actual_s, created_at) VALUES (?,?,?,?,?,?,?,?)""",
            (uid, name, (today.date() - timedelta(weeks=weeks_ago)).isoformat(), dist,
             None, predicted, actual, datetime.now().isoformat(timespec="seconds")))
    conn.execute(
        """INSERT INTO sync_log (user_id, last_sync, status, message) VALUES (?,?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET last_sync=excluded.last_sync,
             status=excluded.status, message=excluded.message""",
        (uid, datetime.now().isoformat(timespec="seconds"), "ok",
         "Demo data -- %d synthetic activities, %d best efforts."
         % (len(rows), len(effort_rows))))
    # Junctions can only be worked out once every run has been read, so stops
    # are classified in a second pass -- before the connection closes.
    conn.execute("DELETE FROM run_stops WHERE user_id=?", (uid,))
    junctions = ST.junction_tiles(
        [ST.find_interruptions(sm) for _g, _s, sm in stop_inputs], min_runs=3)
    stopped_runs = 0
    for gid, start_iso, sm in stop_inputs:
        if store_stops(conn, uid, gid, start_iso, sm, junctions):
            stopped_runs += 1

    # A race that actually happened, so the postmortem has something to read: the
    # most recent flat-out 5 km becomes a race, with its own track as the course.
    parkrun = conn.execute(
        """SELECT garmin_id, start, distance_m, moving_s FROM activities
            WHERE user_id=? AND type='running' AND distance_m BETWEEN 4900 AND 5100
            ORDER BY start DESC LIMIT 1""", (uid,)).fetchone()
    if parkrun:
        conn.execute(
            """INSERT INTO races (user_id, name, date, distance_m, goal_s, predicted_s,
                                  actual_s, garmin_id, created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (uid, "Club parkrun", parkrun["start"][:10], 5000.0,
             round(parkrun["moving_s"] - 12), round(parkrun["moving_s"] + 8),
             round(parkrun["moving_s"]), parkrun["garmin_id"],
             datetime.now().isoformat(timespec="seconds")))
        race_id = conn.execute(
            "SELECT id FROM races WHERE user_id=? AND name='Club parkrun'", (uid,)
        ).fetchone()["id"]
        track = [[x[3], x[4], x[5] if len(x) > 5 else None]
                 for x in json.loads(conn.execute(
                     "SELECT samples FROM streams WHERE user_id=? AND garmin_id=?",
                     (uid, parkrun["garmin_id"])).fetchone()["samples"])
                 if len(x) > 4 and x[3] is not None]
        if len(track) > 2:
            try:
                save_course(conn, uid, race_id, track, "activity")
            except ValueError:
                pass

    # And a course on an upcoming race, so the plan has ground to work with.
    upcoming = conn.execute(
        "SELECT id FROM races WHERE user_id=? AND name='Autumn Half'", (uid,)).fetchone()
    long_run = conn.execute(
        """SELECT garmin_id FROM activities WHERE user_id=? AND type='running'
            AND distance_m > 15000 ORDER BY ABS(distance_m - 21097) LIMIT 1""",
        (uid,)).fetchone()
    if upcoming and long_run:
        row = conn.execute("SELECT samples FROM streams WHERE user_id=? AND garmin_id=?",
                           (uid, long_run["garmin_id"])).fetchone()
        if row:
            track = [[x[3], x[4], x[5] if len(x) > 5 else None]
                     for x in json.loads(row["samples"])
                     if len(x) > 4 and x[3] is not None]
            if len(track) > 2:
                try:
                    save_course(conn, uid, upcoming["id"], track, "activity")
                except ValueError:
                    pass

    conn.commit()
    conn.close()
    log.info("seeded demo user %s: %d activities, %d best efforts, %d tiles, "
             "%d interval sessions, %d runs with interruptions, %d junctions",
             uid, len(rows), len(effort_rows), len(claimed_total), sessions_found,
             stopped_runs, len(junctions))
    return uid


@app.route("/demo-login", methods=["POST"])
def demo_login():
    if not DEMO:
        abort(404)
    row = db().execute("SELECT id FROM users WHERE google_sub='demo'").fetchone()
    if not row:
        abort(404)
    session.permanent = True
    session["uid"] = row["id"]
    return redirect(url_for("index"))


if __name__ == "__main__":
    init_db()
    if DEMO:
        seed_demo()
        print("\n  Demo mode: open http://127.0.0.1:5000 and click 'Enter demo'.\n")
    else:
        threading.Thread(target=background_sync_loop, daemon=True).start()
    app.run(host=os.environ.get("HOST", "127.0.0.1"),
            port=int(os.environ.get("PORT", "5000")),
            debug=os.environ.get("FLASK_DEBUG", "").lower() in ("1", "true", "yes"))
