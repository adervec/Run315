"""Self-check for the app's parsing, rendering and routes. Run: python test_app.py

Uses a throwaway SQLite file and the demo seed, so it needs no Garmin or
Anthropic credentials.
"""
import json
import os
import tempfile

os.environ.setdefault("SECRET_KEY", "test-key-not-a-secret")
os.environ["DATABASE_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("ANTHROPIC_AUTH_TOKEN", None)

import app as A  # noqa: E402


def test_parse_goal():
    assert A.parse_goal("1:29:30") == 5370
    assert A.parse_goal("89:30") == 5370
    assert A.parse_goal("5400") == 5400
    assert A.parse_goal("") is None
    assert A.parse_goal(None) is None
    assert A.parse_goal("not a time") is None
    assert A.parse_goal("1:2:3:4") is None


def test_render_markdown_escapes_and_structures():
    md = ("## Where your fitness is\nCTL is **59**, up 4.\n\n"
          "## What to change\n- Run a `5K` time trial\n- Add 8 km on Sunday\nBack to prose.")
    html = str(A.render_markdown(md))
    assert "<h3>Where your fitness is</h3>" in html
    assert "<strong>59</strong>" in html
    assert html.count("<ul>") == 1 and html.count("</ul>") == 1
    assert html.count("<li>") == 2
    assert "<code>5K</code>" in html
    assert html.endswith("<p>Back to prose.</p>")     # list closed before the prose


def test_render_markdown_blocks_injection():
    """Model output is untrusted text -- it must never become live markup."""
    html = str(A.render_markdown("## Hi\n<script>alert(1)</script>\n- <img src=x onerror=y>"))
    assert "<script>" not in html
    assert "&lt;script&gt;" in html
    assert "onerror=y>" not in html


def test_sparkline_shares_scale():
    curve = [(None, 0, 10.0, 5.0, 5.0), (None, 0, 20.0, 10.0, 10.0)]
    top = 20.0
    ctl = A.sparkline(curve, 2, top, width=100, height=100)
    atl = A.sparkline(curve, 3, top, width=100, height=100)
    # Same value must land on the same y in both series.
    assert ctl.split()[0].split(",")[1] == atl.split()[1].split(",")[1]
    assert ctl.split()[-1] == "100.0,8.0"              # the max sits at the top
    assert A.sparkline([], 2, 1.0) == ""


def test_routes_and_review_without_a_key():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()

    assert client.get("/").status_code == 200                  # signed out -> login
    assert client.get("/healthz").status_code == 200
    assert client.post("/demo-login").status_code == 302

    page = client.get("/")
    assert page.status_code == 200
    body = page.get_data(as_text=True)
    assert "Start list" in body and "Fitness and freshness" in body

    # Adding a race projects it; a bad race is rejected without a crash.
    assert client.post("/races", data={"name": "Test 10K", "date": "2027-01-01",
                                       "distance": "10000", "goal": "40:00"}).status_code == 302
    assert "Test 10K" in client.get("/").get_data(as_text=True)
    assert client.post("/races", data={"name": "Bad", "date": "nope",
                                       "distance": "10000"}).status_code == 302
    assert client.post("/races", data={"name": "Bad", "date": "2027-01-01",
                                       "distance": "-5"}).status_code == 302

    # No API key must surface as a readable message, not a 500.
    assert client.post("/review").status_code == 302
    assert "Anthropic" in client.get("/").get_data(as_text=True)

    # A race belonging to nobody must not be deletable.
    assert client.post("/races/99999/delete").status_code == 404


def test_pace_curve_points():
    prs = [(1000, 200, "2026-08-01"), (5000, 1150, "2026-08-02"), (10000, 2450, "2026-08-03")]
    points, labels = A.pace_curve_points(prs, width=100, height=100)
    assert len(labels) == 3
    xs = [round(l[0], 3) for l in labels]
    assert xs == sorted(xs) and xs[0] == 0.0 and xs[-1] == 100.0   # log-scaled, spans width
    assert labels[0][4] < labels[-1][4]                            # pace worsens with distance
    assert len(points.split()) == 3
    assert A.pace_curve_points([]) == ("", [])
    assert A.pace_curve_points([(5000, 1150, "x")]) == ("", [])    # one point is not a curve


def test_training_calendar():
    from datetime import date
    today = date(2026, 8, 18)                                       # a Tuesday
    daily = {date(2026, 8, 17): 90.0}
    cal = A.training_calendar(daily, today, weeks=4)
    assert len(cal) == 4
    assert all(len(days) == 7 for _, days in cal)
    assert cal[-1][0] == date(2026, 8, 17)                          # last week starts Monday
    assert cal[-1][1][0] == (date(2026, 8, 17), 90.0)
    assert cal[0][0] < cal[-1][0]                                   # oldest week first


def test_migrate_is_idempotent():
    import sqlite3
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(A.SCHEMA)
    A.migrate(conn)
    A.migrate(conn)                                                 # must not raise
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(activities)")}
    assert "details_synced" in cols


def test_new_routes():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")

    body = client.get("/").get_data(as_text=True)
    assert "Your pace curve" in body
    assert "Personal records" in body
    assert "Your training paces" in body
    assert "Heart rate zones" in body
    assert "Training log" in body

    # Race detail page renders a plan for a seeded race.
    race_id = A.sqlite3.connect(A.DB_PATH).execute(
        "SELECT id FROM races WHERE actual_s IS NULL ORDER BY date LIMIT 1").fetchone()[0]
    page = client.get("/race/%d" % race_id)
    assert page.status_code == 200
    detail = page.get_data(as_text=True)
    assert "Split targets" in detail and "Race-day readiness" in detail

    assert client.get("/race/999999").status_code == 404             # not yours

    csv_resp = client.get("/export.csv")
    assert csv_resp.status_code == 200
    assert csv_resp.mimetype == "text/csv"
    lines = csv_resp.get_data(as_text=True).strip().splitlines()
    assert lines[0].startswith("start,name,type,distance_m")
    assert len(lines) > 300

    # Analysing without Garmin connected must explain itself, not crash.
    assert client.post("/efforts/analyse").status_code == 302
    assert "Connect Garmin first" in client.get("/").get_data(as_text=True)


def test_segment_efforts_reach_the_projection():
    """The seeded best efforts must actually be feeding the model."""
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row
    uid = conn.execute("SELECT id FROM users WHERE google_sub='demo'").fetchone()["id"]
    now = A.datetime.now()
    segments = A.load_segment_efforts(conn, uid, now)
    assert len(segments) > 100
    with A.app.app_context():
        summary, acts = A.build_summary(conn, uid, now)
    assert summary["fit"] is not None
    # The points the fit actually uses should be drawn from measured segments,
    # not from whole-activity averages.
    seg_set = {(round(d, 1), round(s, 1)) for d, s, _ in segments}
    used = [(round(d, 1), round(s, 1)) for d, s, _ in summary["fit"][2]]
    assert any(p in seg_set for p in used), used


def test_results_calibration_and_activity_pages():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row

    # Seeded past results calibrate the dashboard.
    body = client.get("/").get_data(as_text=True)
    assert "Calibrated on" in body and "past result" in body
    assert "This week" in body
    assert "/activity/demo-" in body

    # JSON API is coherent and includes the calibration.
    js = client.get("/api/summary").get_json()
    assert js["activities"] > 300
    assert js["calibration"]["n"] >= 2
    assert js["calibration"]["factor"] > 1.0                        # demo athlete ran slower
    assert len(js["races"]) >= 5
    assert "5K" in js["standard_projections"]
    assert len(js["training_paces"]) == 5 and len(js["hr_zones"]) == 5

    # Visiting an upcoming race freezes its projection...
    upcoming = conn.execute("SELECT id FROM races WHERE actual_s IS NULL ORDER BY date LIMIT 1").fetchone()["id"]
    client.get("/race/%d" % upcoming)
    frozen = conn.execute("SELECT predicted_s FROM races WHERE id=?", (upcoming,)).fetchone()["predicted_s"]
    assert frozen and frozen > 0

    # ...and a past race accepts a result and scores it.
    past = conn.execute("SELECT id FROM races WHERE actual_s IS NOT NULL LIMIT 1").fetchone()["id"]
    page = client.get("/race/%d" % past).get_data(as_text=True)
    assert "Result" in page and "than projected" in page
    assert client.post("/races/%d/result" % past, data={"actual": "45:00"}).status_code == 302
    assert conn.execute("SELECT actual_s FROM races WHERE id=?", (past,)).fetchone()["actual_s"] == 2700
    assert client.post("/races/%d/result" % past, data={"actual": "nope"}).status_code == 302
    assert conn.execute("SELECT actual_s FROM races WHERE id=?", (past,)).fetchone()["actual_s"] == 2700
    assert client.post("/races/999999/result", data={"actual": "45:00"}).status_code == 404

    # Activity page draws splits, drift and best efforts from the stored stream.
    gid = conn.execute("SELECT garmin_id FROM activities WHERE type='running' ORDER BY start DESC LIMIT 1").fetchone()["garmin_id"]
    page = client.get("/activity/%s" % gid)
    assert page.status_code == 200
    html = page.get_data(as_text=True)
    assert "Kilometre splits" in html and "Best efforts in this run" in html
    assert "Cardiac drift" in html
    assert client.get("/activity/does-not-exist").status_code == 404

    # A ride has no run classification and no splits panel, but still renders.
    ride = conn.execute("SELECT garmin_id FROM activities WHERE type='cycling' LIMIT 1").fetchone()["garmin_id"]
    assert client.get("/activity/%s" % ride).status_code == 200


def test_intvl_territory():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")

    page = client.get("/intvl")
    assert page.status_code == 200
    body = page.get_data(as_text=True)
    assert "Max square" in body and "Tiles claimed" in body

    d = client.get("/api/tiles").get_json()
    assert d["zoom"] == 17
    assert len(d["tiles"]) > 500, len(d["tiles"])
    assert d["square"]["size"] >= 2
    assert d["home"] and len(d["home"]) == 2
    # Suggested tiles must be ground you do NOT already own.
    owned = {tuple(t) for t in d["tiles"]}
    assert all(tuple(t) not in owned for t in d["targets"])
    # The reported square really is solid.
    c, n = d["square"]["corner"], d["square"]["size"]
    assert all((c[0] + dx, c[1] + dy) in owned for dx in range(n) for dy in range(n))

    # The dashboard teaser and the JSON API both surface it.
    assert "intvl" in client.get("/").get_data(as_text=True)
    assert client.get("/api/summary").get_json()["territory"]["max_square"] == n


def test_route_api_round_trip():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")

    assert client.get("/api/routes").get_json() == {"routes": []}

    good = {"name": "River loop", "profile": "trekking", "rtype": "loop",
            "pts": [{"lat": 47.37, "lon": 8.54}, {"lat": 47.38, "lon": 8.55}]}
    rid = client.post("/api/routes", json=good).get_json()["id"]
    listed = client.get("/api/routes").get_json()["routes"]
    assert len(listed) == 1 and listed[0]["name"] == "River loop"
    assert listed[0]["pts"][0]["lat"] == 47.37

    # Saving the same name again updates rather than duplicating.
    again = dict(good, rtype="p2p")
    assert client.post("/api/routes", json=again).get_json()["id"] == rid
    listed = client.get("/api/routes").get_json()["routes"]
    assert len(listed) == 1 and listed[0]["rtype"] == "p2p"

    # Junk is refused, not stored.
    for bad in ({"name": "", "profile": "trekking", "rtype": "loop", "pts": good["pts"]},
                {"name": "x", "profile": "evil", "rtype": "loop", "pts": good["pts"]},
                {"name": "x", "profile": "trekking", "rtype": "nope", "pts": good["pts"]},
                {"name": "x", "profile": "trekking", "rtype": "loop", "pts": []},
                {"name": "x", "profile": "trekking", "rtype": "loop",
                 "pts": [{"lat": 999, "lon": 8.5}]},
                {"name": "x", "profile": "trekking", "rtype": "loop", "pts": "nope"}):
        assert client.post("/api/routes", json=bad).status_code == 400, bad
    assert len(client.get("/api/routes").get_json()["routes"]) == 1

    assert client.delete("/api/routes/%d" % rid).get_json() == {"ok": True}
    assert client.get("/api/routes").get_json() == {"routes": []}
    assert client.delete("/api/routes/999999").status_code == 404


def test_gps_reaches_the_stream_and_the_tiles():
    """Streams must carry lat/lon now, and those coordinates must claim tiles."""
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row
    uid = conn.execute("SELECT id FROM users WHERE google_sub='demo'").fetchone()["id"]

    gid = conn.execute(
        "SELECT garmin_id FROM activities WHERE type='running' ORDER BY start DESC LIMIT 1"
    ).fetchone()["garmin_id"]
    stream = A.load_stream(conn, uid, gid)
    # t, d, hr, lat, lon, ele, cadence, stride, gct, vosc -- the tail is optional
    # per device, so assert the floor rather than an exact width.
    assert stream and len(stream[0]) >= 6, stream[0]
    lat, lon = stream[0][3], stream[0][4]
    assert lat is not None and 47.0 < lat < 48.0, lat
    assert lon is not None and 8.0 < lon < 9.0, lon

    tiles = A.load_tiles(conn, uid)
    assert len(tiles) > 500
    # Every point of that run sits in a tile the athlete owns.
    import territory as T
    for s in stream[::20]:
        if s[3] is not None:
            assert T.tile_for(s[3], s[4]) in tiles


def test_trail_matching_end_to_end():
    """Plant a trail under a demo run and it should come out covered.

    Deliberately offline: Overpass is a free volunteer service and a test suite
    has no business hammering it.
    """
    import trails as TR

    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")

    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row
    uid = conn.execute("SELECT id FROM users WHERE google_sub='demo'").fetchone()["id"]

    # Take a real demo run and lay a "trail" directly along part of it.
    gid = conn.execute(
        "SELECT garmin_id FROM activities WHERE type='running' ORDER BY start DESC LIMIT 1"
    ).fetchone()["garmin_id"]
    pts = [(s[3], s[4]) for s in A.load_stream(conn, uid, gid)
           if len(s) > 4 and s[3] is not None]
    assert len(pts) > 40, len(pts)
    on_route = pts[5:35]

    coords, length = TR.resample(on_route, TR.NODE_STEP_M)
    ran_on = TR.Segment(id="test-on", coords=coords, len_m=length, name="Ran This Way")
    # And one a long way off, which must stay untouched.
    away = [(la + 0.5, lo + 0.5) for la, lo in on_route]
    acoords, alength = TR.resample(away, TR.NODE_STEP_M)
    never = TR.Segment(id="test-off", coords=acoords, len_m=alength, name="Never Been")

    with A.app.app_context():
        A.save_segments(conn, uid, [ran_on, never], None)
        matched, touched = A.match_activities(conn, uid)
    assert matched > 0 and touched > 0

    with A.app.app_context():
        built, stats = A.build_trails(conn, uid)
    by_name = {t["name"]: t for t in built}
    assert by_name["Ran This Way"]["pct"] > 0.9, by_name["Ran This Way"]["pct"]
    assert by_name["Ran This Way"]["complete"] is True
    assert by_name["Never Been"]["pct"] == 0.0
    assert by_name["Never Been"]["complete"] is False
    assert stats["trails"] == 2 and stats["complete"] == 1
    assert stats["done_km"] > 0

    # The page and the map API agree with the model.
    page = client.get("/trails").get_data(as_text=True)
    assert "Ran This Way" in page and "Never Been" in page
    assert "Trails finished" in page

    api = client.get("/api/trails").get_json()
    ids = {s["id"]: s for s in api["segments"]}
    assert ids["test-on"]["covered"], "covered runs should be reported for the matched way"
    assert ids["test-off"]["covered"] == []

    # Hiding finished trails removes the completed one.
    hidden = client.get("/trails?hide_done=1").get_data(as_text=True)
    assert "Never Been" in hidden and "Ran This Way" not in hidden

    # Re-matching is idempotent: nothing new the second time.
    with A.app.app_context():
        again, _ = A.match_activities(conn, uid)
    assert again == 0

    # Removing the area removes its segments.
    conn.execute("UPDATE trail_segments SET area_id=99 WHERE user_id=?", (uid,))
    conn.execute(
        "INSERT INTO trail_areas (id, user_id, name, bbox, loaded_at, seg_count)"
        " VALUES (99,?,?,?,?,2)", (uid, "tmp", "[]", "2026-01-01"))
    conn.commit()
    assert client.post("/trails/area/99/delete").status_code == 302
    assert conn.execute("SELECT COUNT(*) c FROM trail_segments WHERE user_id=?",
                        (uid,)).fetchone()["c"] == 0
    assert client.post("/trails/area/99/delete").status_code == 404


def test_trail_load_rejects_bad_areas():
    """Guard rails before we ever call Overpass."""
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")

    for bad in ({"south": "nope", "west": "8", "north": "48", "east": "9"},
                {"south": "48", "west": "8", "north": "47", "east": "9"},   # inverted
                {"south": "-100", "west": "8", "north": "48", "east": "9"},
                {"south": "40", "west": "0", "north": "50", "east": "20"},  # far too big
                {}):
        r = client.post("/trails/load", data=bad)
        assert r.status_code == 302, bad
    # Nothing was stored and no network call happened.
    conn = A.sqlite3.connect(A.DB_PATH)
    assert conn.execute("SELECT COUNT(*) c FROM trail_areas").fetchone()[0] == 0


def test_interval_sessions():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row
    uid = conn.execute("SELECT id FROM users WHERE google_sub='demo'").fetchone()["id"]

    stored = conn.execute("SELECT * FROM track_sessions WHERE user_id=?", (uid,)).fetchall()
    assert len(stored) > 10, len(stored)

    # Only the interval day should be detected -- an easy run is not a session.
    days = {A.datetime.fromisoformat(r["start"]).strftime("%a") for r in stored}
    assert days == {"Wed"}, days

    for r in stored:
        assert r["reps"] >= 2
        assert r["work_m"] > 0 and r["avg_pace"] > 0
        assert r["fastest"] <= r["avg_pace"] <= r["slowest"]
        reps = A.json.loads(r["detail"])
        assert len(reps) == r["reps"]
        assert [x["n"] for x in reps] == list(range(1, len(reps) + 1))
        assert reps[-1]["recovery_s"] is None          # nothing follows the last rep
        assert all(x["recovery_s"] for x in reps[:-1])

    page = client.get("/sessions")
    assert page.status_code == 200
    body = page.get_data(as_text=True)
    assert "Every session" in body and "x 800 m" in body
    assert "Progression" in body

    # The activity page shows the rep breakdown for a detected session.
    gid = stored[0]["garmin_id"]
    detail = client.get("/activity/%s" % gid).get_data(as_text=True)
    assert "Session &middot;" in detail or "Session ·" in detail
    assert "Reps were found from the pace stream" in detail

    # A non-session run has no rep panel.
    easy = conn.execute(
        """SELECT a.garmin_id FROM activities a WHERE a.user_id=? AND a.type='running'
             AND NOT EXISTS (SELECT 1 FROM track_sessions t
                               WHERE t.user_id=a.user_id AND t.garmin_id=a.garmin_id)
           LIMIT 1""", (uid,)).fetchone()["garmin_id"]
    assert "Reps were found from the pace stream" not in \
        client.get("/activity/%s" % easy).get_data(as_text=True)

    # Rescanning is stable: same detections, no duplicates.
    before = len(stored)
    assert client.post("/sessions/rescan").status_code == 302
    after = conn.execute("SELECT COUNT(*) c FROM track_sessions WHERE user_id=?",
                         (uid,)).fetchone()["c"]
    assert after == before, (before, after)


def test_session_progression_groups_by_distance():
    rows = [
        {"snapped_m": 400, "start": "2026-01-01T07:00", "avg_pace": 200.0, "name": "a"},
        {"snapped_m": 400, "start": "2026-03-01T07:00", "avg_pace": 190.0, "name": "b"},
        {"snapped_m": 400, "start": "2026-05-01T07:00", "avg_pace": 195.0, "name": "c"},
        {"snapped_m": 800, "start": "2026-02-01T07:00", "avg_pace": 210.0, "name": "d"},
        {"snapped_m": None, "start": "2026-04-01T07:00", "avg_pace": 205.0, "name": "e"},
    ]
    groups = A.session_progression(rows)
    assert [g["distance_m"] for g in groups] == [400, 800]   # most-run first
    four = groups[0]
    assert four["count"] == 3
    assert four["best_pace"] == 190.0 and four["best_on"] == "2026-03-01"
    assert [s["name"] for s in four["sessions"]] == ["a", "b", "c"]   # oldest first
    assert four["trend"] == -5.0                                     # 200 -> 195
    assert groups[1]["trend"] is None                                # only one session
    assert A.session_progression([]) == []


def test_stop_analysis():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row
    uid = conn.execute("SELECT id FROM users WHERE google_sub='demo'").fetchone()["id"]

    rows = conn.execute("SELECT * FROM run_stops WHERE user_id=?", (uid,)).fetchall()
    assert len(rows) > 50, len(rows)
    for r in rows:
        assert r["count"] >= 1 and r["verdict"]
        assert r["lost_s"] > 0
        parts = r["crossings"] + r["rests"] + r["climbs"] + r["exhaustion"] + r["eased"]
        assert parts == r["count"], (parts, r["count"])

    # The demo only puts walk breaks in long runs, so fatigue must not show up
    # on the short ones -- that was a real misfire before stops were judged on
    # minimum speed rather than the span mean.
    fatigue_days = {A.datetime.fromisoformat(r["start"]).strftime("%a")
                    for r in rows if r["exhaustion"]}
    assert fatigue_days == {"Sun"}, fatigue_days

    # Recurring corners get recognised as junctions from the athlete's own history.
    junctions = A.known_junctions(conn, uid)
    assert len(junctions) >= 1, junctions

    # A long run should show all three kinds, with the evidence that separates them.
    long_run = conn.execute(
        "SELECT * FROM run_stops WHERE user_id=? AND exhaustion > 0 ORDER BY start DESC LIMIT 1",
        (uid,)).fetchone()
    detail = A.json.loads(long_run["detail"])
    by_label = {}
    for it in detail:
        by_label.setdefault(it["label"], []).append(it)
    assert {"crossing", "rest", "exhaustion"} <= set(by_label)
    # A rest is a real recovery; a fatigue walk is not.
    assert by_label["rest"][0]["hr_drop"] > by_label["exhaustion"][0]["hr_drop"]
    # And fatigue is the one that costs you pace afterwards.
    assert by_label["exhaustion"][0]["penalty"] > 0.02
    assert by_label["crossing"][0]["seconds"] < by_label["rest"][0]["seconds"]

    page = client.get("/activity/%s" % long_run["garmin_id"]).get_data(as_text=True)
    assert "Why you stopped" in page
    assert "Exhaustion" in page and "Crossing" in page and "Rest" in page

    # A run with no interruptions has no panel.
    clean = conn.execute(
        """SELECT a.garmin_id FROM activities a WHERE a.user_id=? AND a.type='running'
             AND NOT EXISTS (SELECT 1 FROM run_stops s
                               WHERE s.user_id=a.user_id AND s.garmin_id=a.garmin_id)
           LIMIT 1""", (uid,)).fetchone()
    if clean:
        assert "Why you stopped" not in \
            client.get("/activity/%s" % clean["garmin_id"]).get_data(as_text=True)

    # Rescanning is stable.
    before = len(rows)
    assert client.post("/stops/rescan").status_code == 302
    after = conn.execute("SELECT COUNT(*) c FROM run_stops WHERE user_id=?",
                         (uid,)).fetchone()["c"]
    assert after == before, (before, after)

    totals = A.stop_totals(conn, uid, days=400)
    assert totals["runs"] == before
    assert totals["crossings"] > 0 and totals["exhaustion"] > 0


def test_streams_carry_elevation():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row
    uid = conn.execute("SELECT id FROM users WHERE google_sub='demo'").fetchone()["id"]
    gid = conn.execute(
        "SELECT garmin_id FROM activities WHERE type='running' ORDER BY start DESC LIMIT 1"
    ).fetchone()["garmin_id"]
    stream = A.load_stream(conn, uid, gid)
    assert stream and len(stream[0]) >= 6, stream[0]
    eles = [s[5] for s in stream if s[5] is not None]
    assert len(eles) > 10
    assert max(eles) > min(eles), "a rolling course should actually roll"


def test_poi_layers_and_lookup():
    """Offline: the cache is pre-seeded so no Overpass call can happen."""
    import pois as P

    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")

    cat = client.get("/api/poi-layers").get_json()
    names = [g["name"] for g in cat["groups"]]
    assert names == ["Body", "Fuel", "Water", "Along the way", "Getting there"]
    ids = {l["id"] for g in cat["groups"] for l in g["layers"]}
    assert {"toilets", "coffee", "beach", "waterpark", "pool", "water"} <= ids
    fee = {l["id"] for g in cat["groups"] for l in g["layers"] if l["fee_matters"]}
    assert fee == {"toilets", "shower", "pool"}

    corridor = [[47.366, 8.539], [47.356, 8.535], [47.346, 8.533], [47.336, 8.539]]
    layers = ["toilets", "beach"]

    # Seed the cache under the exact key the endpoint will compute.
    query = P.build_query(corridor, layers)
    key = A.hashlib.sha256(query.encode()).hexdigest()
    payload = {"elements": [
        {"type": "node", "id": 1, "lat": 47.36, "lon": 8.537,
         "tags": {"amenity": "toilets", "fee": "no", "name": "Seebad WC"}},
        {"type": "node", "id": 2, "lat": 47.35, "lon": 8.536,
         "tags": {"amenity": "toilets", "fee": "yes", "name": "Paid WC"}},
        {"type": "way", "id": 3, "center": {"lat": 47.34, "lon": 8.534},
         "tags": {"natural": "beach", "name": "Strandbad"}},
    ]}
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.execute("INSERT INTO poi_cache (key, fetched_at, payload) VALUES (?,?,?)",
                 (key, A.datetime.now().isoformat(timespec="seconds"),
                  A.json.dumps(payload)))
    conn.commit()

    got = client.post("/api/pois", json={"points": corridor, "layers": layers}).get_json()
    assert got["cached"] is True
    assert len(got["pois"]) == 3
    names = {p["name"]: p for p in got["pois"]}
    assert names["Seebad WC"]["free"] is True
    assert names["Paid WC"]["free"] is False
    assert names["Strandbad"]["layer"] == "beach"
    assert names["Strandbad"]["lat"] == 47.34            # way centre resolved

    # Free-only drops the paid toilet but keeps the beach.
    only = client.post("/api/pois", json={"points": corridor, "layers": layers,
                                          "free_only": True}).get_json()
    assert {p["name"] for p in only["pois"]} == {"Seebad WC", "Strandbad"}

    # Guard rails, none of which should reach the network.
    assert client.post("/api/pois", json={"points": [], "layers": layers}).status_code == 400
    assert client.post("/api/pois",
                       json={"points": [[47.0, 8.0]], "layers": layers}).status_code == 400
    empty = client.post("/api/pois", json={"points": corridor, "layers": []}).get_json()
    assert empty == {"pois": [], "cached": False}
    unknown = client.post("/api/pois", json={"points": corridor,
                                             "layers": ["definitely-not-a-layer"]}).get_json()
    assert unknown == {"pois": [], "cached": False}


GPX_SAMPLE = """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Course</name><trkseg>
    %s
  </trkseg></trk>
</gpx>"""


def _gpx_bytes(points):
    """points are (lat, lon) or (lat, lon, ele)."""
    rows = []
    for p in points:
        row = '<trkpt lat="%.6f" lon="%.6f">' % (p[0], p[1])
        if len(p) > 2:
            row += "<ele>%.1f</ele>" % p[2]
        rows.append(row + "</trkpt>")
    return (GPX_SAMPLE % "\n".join(rows)).encode()


def test_parse_gpx():
    pts = [(47.3769 + i * 0.0002, 8.5417, 400.0 + i) for i in range(60)]
    out = A.parse_gpx(_gpx_bytes(pts))
    assert len(out) == 60
    assert out[0][0] == 47.3769 and out[0][2] == 400.0
    # Routes work too, not just tracks.
    rte = ('<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1">'
           '<rte><rtept lat="47.0" lon="8.0"><ele>300</ele></rtept>'
           '<rtept lat="47.01" lon="8.0"/></rte></gpx>')
    got = A.parse_gpx(rte.encode())
    assert len(got) == 2 and got[1][2] is None      # missing ele is None, not zero

    for bad in (b"not xml at all", b"<gpx></gpx>",
                _gpx_bytes([(47.0, 8.0)])):          # a single point is not a course
        try:
            A.parse_gpx(bad)
            raise AssertionError("should have refused: %r" % bad[:20])
        except ValueError:
            pass


def test_race_course_and_postmortem():
    import racecraft as RC

    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row
    uid = conn.execute("SELECT id FROM users WHERE google_sub='demo'").fetchone()["id"]

    # The seed races a parkrun and attaches its own track as the course.
    raced = conn.execute(
        "SELECT * FROM races WHERE user_id=? AND garmin_id IS NOT NULL LIMIT 1",
        (uid,)).fetchone()
    assert raced, "demo should have raced something"
    course = A.load_course(conn, raced["id"])
    assert course and course["source"] == "activity"
    assert course["length_m"] > 4000

    page = client.get("/race/%d" % raced["id"]).get_data(as_text=True)
    assert "The course" in page
    assert "Postmortem" in page
    assert "Effort" in page                          # the grade-adjusted column

    # An upcoming race with a course gets a gradient-aware plan.
    upcoming = conn.execute(
        """SELECT r.* FROM races r JOIN race_courses c ON c.race_id = r.id
            WHERE r.user_id=? AND r.date > ? LIMIT 1""",
        (uid, A.datetime.now().date().isoformat())).fetchone()
    assert upcoming
    plan_page = client.get("/race/%d" % upcoming["id"]).get_data(as_text=True)
    assert "Race plan" in plan_page
    assert "Even effort, not even pace" in plan_page

    # Uploading a GPX replaces the course.
    pts = [(47.3769 + i * 0.0003, 8.5417, 400.0 + (i % 20)) for i in range(400)]
    up = client.post("/race/%d/course" % upcoming["id"],
                     data={"source": "gpx",
                           "gpx": (A.io.BytesIO(_gpx_bytes(pts)), "course.gpx")},
                     content_type="multipart/form-data")
    assert up.status_code == 302
    after = A.load_course(conn, upcoming["id"])
    assert after["source"] == "gpx"
    assert after["length_m"] > 9000

    # A course that is the wrong length for the race says so rather than
    # quietly pacing the goal time over the wrong distance.
    short = [(47.3769 + i * 0.00002, 8.5417, 400.0) for i in range(400)]
    client.post("/race/%d/course" % upcoming["id"],
                data={"source": "gpx", "gpx": (A.io.BytesIO(_gpx_bytes(short)), "s.gpx")},
                content_type="multipart/form-data")
    warned = client.get("/race/%d" % upcoming["id"]).get_data(as_text=True)
    assert "than the race distance" in warned
    # Put the sensible one back.
    client.post("/race/%d/course" % upcoming["id"],
                data={"source": "gpx", "gpx": (A.io.BytesIO(_gpx_bytes(pts)), "course.gpx")},
                content_type="multipart/form-data")

    # Junk upload is refused and leaves the good course alone.
    bad = client.post("/race/%d/course" % upcoming["id"],
                      data={"source": "gpx",
                            "gpx": (A.io.BytesIO(b"nope"), "bad.gpx")},
                      content_type="multipart/form-data")
    assert bad.status_code == 302
    assert A.load_course(conn, upcoming["id"])["source"] == "gpx"
    assert "not valid GPX" in client.get("/").get_data(as_text=True)

    # Removing the course leaves the race intact.
    assert client.post("/race/%d/course/delete" % upcoming["id"]).status_code == 302
    assert A.load_course(conn, upcoming["id"]) is None
    assert client.get("/race/%d" % upcoming["id"]).status_code == 200

    # Linking and unlinking the run that was the race.
    gid = raced["garmin_id"]
    assert client.post("/race/%d/ran" % raced["id"], data={"garmin_id": ""}).status_code == 302
    assert conn.execute("SELECT garmin_id FROM races WHERE id=?",
                        (raced["id"],)).fetchone()["garmin_id"] is None
    assert client.post("/race/%d/ran" % raced["id"],
                       data={"garmin_id": gid}).status_code == 302
    assert conn.execute("SELECT garmin_id FROM races WHERE id=?",
                        (raced["id"],)).fetchone()["garmin_id"] == gid
    # Somebody else's activity id is refused.
    assert client.post("/race/%d/ran" % raced["id"],
                       data={"garmin_id": "not-mine"}).status_code == 302
    assert "not one of yours" in client.get("/").get_data(as_text=True)

    # Races that are not yours stay that way.
    assert client.post("/race/999999/ran", data={"garmin_id": gid}).status_code == 404
    assert client.post("/race/999999/course", data={"source": "gpx"}).status_code == 404


def test_race_match_is_conservative():
    """An easy run on race day is not the race."""
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row
    uid = conn.execute("SELECT id FROM users WHERE google_sub='demo'").fetchone()["id"]
    run = conn.execute(
        """SELECT garmin_id, start, distance_m FROM activities
            WHERE user_id=? AND type='running' ORDER BY start DESC LIMIT 1""",
        (uid,)).fetchone()
    day = A.datetime.fromisoformat(run["start"]).date()

    same = {"date": day, "distance_m": run["distance_m"]}
    assert A.match_race_to_activity(conn, uid, same) == run["garmin_id"]

    # A marathon on a day you only ran 10 km is not a match.
    wrong = {"date": day, "distance_m": run["distance_m"] * 3}
    assert A.match_race_to_activity(conn, uid, wrong) is None
    # Nor is a day you did not run at all.
    assert A.match_race_to_activity(
        conn, uid, {"date": day + A.timedelta(days=900),
                    "distance_m": run["distance_m"]}) is None


def test_gear_mileage():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row

    gear = A.gear_table(conn, 1)
    assert len(gear) == 3, gear
    by_name = {g["name"]: g for g in gear}

    # Mileage is counted from this app's activities, not taken on trust.
    total_tagged = conn.execute(
        """SELECT COALESCE(SUM(a.distance_m), 0) d FROM activity_gear ag
             JOIN activities a ON a.user_id=ag.user_id AND a.garmin_id=ag.garmin_id
            WHERE ag.user_id=1""").fetchone()["d"]
    assert abs(sum(g["distance_m"] for g in gear) - total_tagged) < 1.0

    worn = by_name["Pegasus 40"]
    assert worn["distance_m"] > worn["limit_m"]
    assert worn["worn_out"] is True and worn["remaining_m"] == 0.0
    fresh = by_name["Novablast 4"]
    assert fresh["worn_out"] is False
    assert fresh["remaining_m"] > 0
    assert 0 < fresh["share"] < 1
    for g in gear:
        assert g["runs"] > 0 and g["first_used"] and g["last_used"]
        assert g["first_used"] <= g["last_used"]

    page = client.get("/gear").get_data(as_text=True)
    assert "Pegasus 40" in page and "replace" in page
    assert "Pace against the weather" in page


def test_weather_storage_and_seasons():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row

    stored = conn.execute("SELECT COUNT(*) c FROM activity_weather").fetchone()["c"]
    assert stored > 250, stored
    one = A.load_weather(conn, 1, conn.execute(
        "SELECT garmin_id FROM activity_weather LIMIT 1").fetchone()["garmin_id"])
    assert one["temp_c"] is not None and one["humidity"] is not None

    bands = A.weather_seasons(conn, 1)
    assert len(bands) >= 3
    labels = [b["label"] for b in bands]
    assert labels == sorted(labels, key=lambda l: [b["label"] for b in bands].index(l))
    hot = [b for b in bands if b["mean_temp"] > 19]
    assert hot, [b["mean_temp"] for b in bands]
    # Correcting a hot band can only make the pace look better, never worse.
    for b in bands:
        assert b["mean_adjusted"] <= b["mean_pace"] + 0.01
        assert b["runs"] > 0
    assert hot[0]["mean_adjusted"] < hot[0]["mean_pace"], "heat correction did nothing"

    # store_weather normalises rather than trusting the blob.
    assert A.store_weather(conn, 1, "demo-1", {"nothing": "useful"}) is None
    got = A.store_weather(conn, 1, "demo-1", {"temp": 86, "relativeHumidity": 50})
    assert 29.0 < got["temp_c"] < 31.0        # Fahrenheit detected
    # Commit and let go: an open write transaction here locks the next test out.
    conn.commit()
    conn.close()


def test_zone_polarisation():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row

    import fitness as F
    acts = A.load_activities(conn, 1)
    thr = F.summarise(acts, A.datetime.now())["threshold_hr"]
    shape = A.zone_summary(conn, 1, thr)
    assert shape is not None
    assert abs(shape["easy"] + shape["moderate"] + shape["hard"] - 1.0) < 1e-6
    assert shape["label"] in ("polarised", "pyramidal", "threshold-heavy", "too-hard")
    assert shape["verdict"]
    assert shape["index"] is None or shape["index"] > 0
    assert sum(shape["total"].values()) > 0
    # The demo runs mostly easy, so it must not read as too-hard.
    assert shape["easy"] > 0.6, shape["easy"]
    assert shape["label"] != "too-hard"

    assert A.zone_summary(conn, 1, None) is None      # no threshold, no answer
    assert "How hard you train" in client.get("/").get_data(as_text=True)


def test_training_plan_is_built_off_running_volume():
    """Regression: the plan was built off all cardio, so bike rides doubled it."""
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row
    import fitness as F

    since = (A.datetime.now() - A.timedelta(weeks=6)).isoformat()
    run_km = conn.execute(
        "SELECT COALESCE(SUM(distance_m),0) d FROM activities WHERE user_id=1"
        " AND start >= ? AND type IN (%s)" % ",".join("?" * len(F.RUN_TYPES)),
        (since,) + tuple(F.RUN_TYPES)).fetchone()["d"] / 6000.0
    all_km = conn.execute(
        "SELECT COALESCE(SUM(distance_m),0) d FROM activities WHERE user_id=1"
        " AND start >= ?", (since,)).fetchone()["d"] / 6000.0
    assert all_km > run_km * 1.3, "demo needs bike volume for this test to bite"

    page = client.get("/race/2").get_data(as_text=True)
    assert "Training block" in page
    # The first week must match running volume, not the cardio total.
    import re
    first = float(re.search(r'<td class="num actual">(\d+) km', page).group(1))
    assert abs(first - run_km) < 3, (first, run_km, all_km)
    assert first < all_km * 0.8


def test_readiness_reads_the_night():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row

    nights = conn.execute("SELECT COUNT(*) c FROM wellness WHERE user_id=1").fetchone()["c"]
    assert nights > 60, nights

    r = A.readiness_today(conn, 1, tsb=-5.0)
    assert r is not None
    assert 0 <= r["score"] <= 100
    assert r["band"] in ("primed", "ready", "steady", "tired", "depleted")
    assert r["verdict"] and r["advice"]
    assert r["used"], "should report which inputs it actually used"
    assert r["latest"]["hrv_ms"] and r["latest"]["rhr"]

    # With no data at all it still answers off TSB alone, at low confidence.
    conn.execute("DELETE FROM wellness WHERE user_id=1")
    conn.commit()
    bare = A.readiness_today(conn, 1, tsb=-5.0)
    assert bare is not None and bare["confidence"] == "low"
    assert A.readiness_today(conn, 1, tsb=None) is None
    conn.close()

    assert "This morning" in client.get("/").get_data(as_text=True)


def test_repeated_routes():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row

    routes = A.repeated_routes(conn, 1)
    assert len(routes) >= 3, len(routes)
    for r in routes:
        assert r["count"] >= 3
        assert r["distance_m"] > 0 and r["name"]
        assert len(r["garmin_ids"]) == r["count"]
        p = r["progression"]
        assert p["first"] <= p["last"]
        if p["best_pace"]:
            assert p["best_pace"] <= p["latest_pace"] + 1e-6
    # Most-run first.
    counts = [r["count"] for r in routes]
    assert counts == sorted(counts, reverse=True)

    # Routes run once or twice are not routes.
    assert all(r["count"] >= 3 for r in A.repeated_routes(conn, 1, min_repeats=3))
    assert len(A.repeated_routes(conn, 1, min_repeats=99)) == 0

    page = client.get("/routes/repeats").get_data(as_text=True)
    assert "Your routes" in page
    assert routes[0]["name"] in page


def test_durability_page_and_limits():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row
    import durability as DU

    hr_max, cs, d_prime = A.athlete_limits(conn, 1)
    assert hr_max and 150 < hr_max < 230, hr_max
    assert cs and 2.0 < cs < 7.0, cs
    assert d_prime and d_prime > 0

    runs, limits = A.durability_runs(conn, 1)
    assert runs, "demo long runs should be measurable"
    assert limits["cs"] == cs
    for r in runs:
        # The dose gate must hold for everything that comes back.
        assert r["duration_s"] >= DU.MIN_DURATION_S
        assert r["distance_m"] >= DU.MIN_DISTANCE_M
        assert r["decoupling"] > 0 and r["band"] in ("low", "moderate", "high")
        assert r["verdict"]

    # The demo athlete should land near the published population mean of 1.16.
    mean = sum(r["decoupling"] for r in runs) / len(runs)
    assert 0.95 < mean < 1.45, mean

    page = client.get("/durability").get_data(as_text=True)
    assert "Critical speed" in page
    assert "82,303" in page, "the caveat about comparability should be on the page"
    conn.close()


def test_critical_speed_is_not_used_as_a_race_predictor():
    """It over-predicts long races badly, so it must stay out of the projections."""
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row
    import durability as DU
    import fitness as F

    _hr, cs, d_prime = A.athlete_limits(conn, 1)
    half = 21097.0
    from_cs = (half - d_prime) / cs

    acts = A.load_activities(conn, 1)
    summary = F.summarise(acts, A.datetime.now())
    from_curve = F.base_prediction(summary["fit"], half)

    # The curve model must be the slower, more honest one at half-marathon
    # distance -- if these ever converge, something has been wired wrong.
    assert from_curve > from_cs, (from_curve, from_cs)
    conn.close()


def test_climbing_and_landmarks():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row

    climb = A.climbing(conn, 1)
    assert climb["ascent_m"] > 0 and climb["runs"] > 0
    assert climb["landmark"], "the demo athlete climbs enough to picture it"
    assert climb["landmark"]["repeats"] >= 1.0
    assert climb["landmark"]["phrase"]

    # Every cleared rung really is cleared.
    for rung in climb["ladder"]:
        assert rung["cleared"] and rung["height_m"] <= climb["ascent_m"]

    profile = climb["profile"]
    assert profile, "demo has hilly runs"
    # A climbing factor should sit near 1: a runner is not twice or half the
    # energy model. Anything outside this means the fit has gone wrong.
    assert 0.6 < profile["factor"] < 1.6, profile["factor"]
    assert profile["climb_segments"] > 0

    for h in climb["hilliest"]:
        assert h["ascent_m"] > 50
        assert h["terrain"]["difficulty"]

    page = client.get("/climbing").get_data(as_text=True)
    assert "Total ascent" in page
    # Proper nouns must survive: Jinja's capitalize filter would break these.
    assert "Mont blanc" not in page and "Mount fuji" not in page
    conn.close()


def test_implausible_activities_are_caught():
    import fitness as F
    # A run at bike speed is flagged.
    assert F.implausible({"type": "running", "distance_m": 20000.0,
                          "moving_s": 1800.0})
    # A genuinely fast run is not.
    assert F.implausible({"type": "running", "distance_m": 10000.0,
                          "moving_s": 1800.0}) is None
    # A bike ride at bike speed is fine.
    assert F.implausible({"type": "cycling", "distance_m": 40000.0,
                          "moving_s": 3600.0}) is None
    # Missing pieces produce no opinion rather than a crash.
    for bad in ({}, {"type": "running"}, {"type": "running", "distance_m": 0,
                                          "moving_s": 0}):
        assert F.implausible(bad) is None

    # Nothing in the demo data trips the gate.
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row
    flagged = [a for a in A.load_activities(conn, 1) if F.implausible(a)]
    assert not flagged, flagged[:2]
    conn.close()


def test_second_opinion():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row
    import fitness as F

    theirs = A.latest_derived(conn, 1)
    assert theirs and theirs["threshold_hr"] and theirs["races"]
    # Distances survive the JSON round trip as ints, not strings.
    assert all(isinstance(d, int) for d in theirs["races"])

    summary = F.summarise(A.load_activities(conn, 1), A.datetime.now())
    review = A.second_opinion(conn, 1, summary)
    assert review["comparisons"] >= 4
    assert review["races"] and review["race_summary"]

    # The demo must not seed Garmin's threshold pace as a copy of ours -- a
    # comparison that agrees by construction would prove nothing.
    pace = review["threshold_pace"]
    assert pace and abs(pace["relative"]) > 0.01, pace

    # Garmin's optimism should grow with distance, as the literature reports.
    by_distance = sorted(review["races"], key=lambda r: r["distance_m"])
    assert by_distance[-1]["relative"] > by_distance[0]["relative"]

    page = client.get("/second-opinion").get_data(as_text=True)
    assert "Threshold heart rate" in page
    assert "computes none on purpose" in page, "the no-VO2max stance should be stated"

    # With no Garmin data at all the page still renders its empty state.
    conn.execute("DELETE FROM garmin_metrics WHERE user_id=1")
    conn.commit()
    assert A.second_opinion(conn, 1, summary) is None
    assert "Nothing to compare yet" in client.get("/second-opinion").get_data(as_text=True)
    conn.close()


def test_career_page():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row
    import fitness as F
    import recap as RE

    runs = [a for a in A.load_activities(conn, 1) if a["type"] in F.RUN_TYPES]
    career = RE.career(runs, 3, A.datetime.now().date())
    assert career["km"] > 100
    assert career["totals"]["runs"] == len(runs)
    assert career["streak"]["current"] > 0
    assert career["streak"]["longest"] >= career["streak"]["current"]
    # The ladder must always point somewhere.
    assert career["distance_milestone"]["next"] > career["km"]

    years = RE.by_year(runs)
    assert len(years) >= 1
    assert years == sorted(years, key=lambda y: y["year"], reverse=True)
    # Per-year distance must add up to the career total.
    assert abs(sum(y["distance_m"] for y in years)
               - career["totals"]["distance_m"]) < 1.0

    page = client.get("/career").get_data(as_text=True)
    assert "The ledger" in page
    # The demo record starts mid-2025, so the year comparison has a thin
    # baseline and must say so rather than printing a four-figure percentage.
    partial = RE.partial_year_compare(runs, A.datetime.now().year,
                                      A.datetime.now().date())
    if partial and partial["thin_baseline"]:
        assert "first full year" in page
        assert "%" not in partial["note"]
    conn.close()


def test_plan_adherence_and_heat_on_the_pages():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row

    heat = A.heat_state(conn, 1)
    assert heat is not None
    assert heat["band"] in ("none", "starting", "partial", "most of the way")
    assert heat["sessions"] >= 0
    # A run cannot bank more heat credit than the days it happened on.
    assert heat["sessions"] <= heat["recent"] + 30

    page = client.get("/race/2").get_data(as_text=True)
    assert "Of the plan, actually run" in page
    # The verdict must not claim close tracking unless the weeks support it.
    if "4 of" in page and "16 finished weeks" in page:
        assert "tracking the plan closely" not in page
    conn.close()


def test_fuelling_on_the_race_page():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    import fuelling as FU

    # The marathon gets a full plan with the mixed-sugar warning.
    page = client.get("/race/2").get_data(as_text=True)
    assert "Fuelling" in page
    assert "glucose-and-fructose" in page
    # The hyponatraemia warning is a safety point and must be on the page.
    assert "Overdrinking" in page
    # And the guidance is attributed rather than asserted.
    assert "Jeukendrup" in page

    # A short race must not be told to carry gels.
    short = FU.plan(20 * 60)
    assert short["carbs"]["per_hour_high"] == 0
    assert short["schedule"] == []


def test_wide_capture_and_vitals():
    A.DEMO = True
    A.init_db()
    A.seed_demo()
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    client.post("/demo-login")
    conn = A.sqlite3.connect(A.DB_PATH)
    conn.row_factory = A.sqlite3.Row
    import vitals as VI

    rows = A.daily_rows(conn, 1)
    assert len(rows) > 60, len(rows)
    # The daily sweep should be genuinely wide, not three columns.
    widest = max(len(values) for _d, values in rows)
    assert widest >= 20, widest

    load = A.training_load_by_day(conn, 1)
    assert load and max(load.values()) > 0

    report = A.vitals_report(conn, 1)
    co = report["correlations"]
    assert co["tested"] > 50, co["tested"]
    # The correction must be strictly stricter than testing one hypothesis.
    assert co["critical_r"] > VI.critical_r(report["days"], tests=1)
    # The demo seeds stress and body battery to follow load, so they must be
    # found -- and the pure-noise metrics must not be.
    found = {f["metric"] for f in co["findings"]}
    assert "stress_avg" in found or "body_battery_low" in found, found
    assert "fitness_age" not in found, "that column is pure noise in the demo"
    # Arithmetic is kept out of the findings.
    assert not (found & VI.MECHANICAL), found

    page = client.get("/vitals").get_data(as_text=True)
    assert "What actually responds to your training" in page
    assert "correlations tested" in page
    assert "Hrv" not in page, "capitalize filter mangles acronyms"
    conn.close()


def test_channel_capture_keeps_unknown_metrics():
    """A channel this app has never heard of must still be stored."""
    import garmin

    class Api:
        def get_activity_details(self, aid, **kwargs):
            keys = ["sumDistance", "sumDuration", "directPower", "directBrandNewThing"]
            return {"metricDescriptors": [{"key": k, "metricsIndex": i}
                                          for i, k in enumerate(keys)],
                    "activityDetailMetrics": [
                        {"metrics": [i * 100.0, i * 30.0, 250.0, 7.0]}
                        for i in range(6)]}

    channels = garmin.fetch_channels(Api(), "1")
    assert "power_w" in channels                      # named
    assert "directBrandNewThing" in channels          # unknown, kept anyway
    # And the narrow legacy view still comes out the right shape.
    legacy = garmin.streams_from_channels(channels)
    assert legacy and len(legacy[0]) == 10


def test_the_app_is_installable():
    """Chrome will not offer to install without all of these at once."""
    A.DEMO = True
    A.init_db()
    A.app.config["TESTING"] = True
    client = A.app.test_client()

    res = client.get("/manifest.webmanifest")
    assert res.status_code == 200
    assert res.mimetype == "application/manifest+json"
    manifest = json.loads(res.get_data(as_text=True))
    assert manifest["name"] and manifest["display"] == "standalone"
    sizes = {i["sizes"] for i in manifest["icons"]}
    assert {"192x192", "512x512"} <= sizes, sizes
    assert any(i["purpose"] == "maskable" for i in manifest["icons"])
    # start_url has to sit inside scope or the install is rejected.
    assert manifest["start_url"].startswith(manifest["scope"])

    # The worker must be served from the mount root: one served from /static/
    # can only ever control /static/.
    sw = client.get("/sw.js")
    assert sw.status_code == 200 and "javascript" in sw.mimetype
    body = sw.get_data(as_text=True)
    assert "addEventListener('fetch'" in body     # no fetch handler, no install
    assert "caches.delete(PAGES)" in body         # writes must drop stale pages

    page = client.get("/").get_data(as_text=True)
    assert 'rel="manifest"' in page and "serviceWorker" in page


def test_the_icons_are_real_pngs_of_the_right_size():
    import struct
    for size in (192, 512):
        raw = open("static/icon-%d.png" % size, "rb").read()
        assert raw[:8] == bytes([137, 80, 78, 71, 13, 10, 26, 10]), "not a PNG"
        w, h = struct.unpack(">II", raw[16:24])
        assert (w, h) == (size, size), (w, h)


def test_a_mount_point_moves_every_pwa_path():
    """The frozen demo lives under /Run315/, so nothing may be hardcoded to /."""
    A.app.config["TESTING"] = True
    client = A.app.test_client()
    env = {"SCRIPT_NAME": "/Run315"}
    manifest = json.loads(
        client.get("/manifest.webmanifest", environ_overrides=env).get_data(as_text=True))
    assert manifest["start_url"] == "/Run315/"
    assert manifest["scope"] == "/Run315/"
    assert all(i["src"].startswith("/Run315/static/") for i in manifest["icons"])
    sw = client.get("/sw.js", environ_overrides=env).get_data(as_text=True)
    assert "'/Run315/'" in sw and "/Run315/static/style.css" in sw


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))