# Run315

GymTracker for cardio. Every Garmin and Strava number you have — per-second streams,
laps, weather, gear, sleep stages, HRV, body battery, Garmin's own estimates — in one
place, analysed properly, and handed to an AI agent for as deep a dig as you care to ask
for. Coaching, routing, trail completion and territory: the parts of Strava premium you
actually miss, plus the parts it never had.

**[Open it](https://adervec.github.io/Run315/)** — press *Load demo athlete* to look around
with a synthetic year of training.

It is a static web app: no server, no account. Your data lives in your browser, syncs
between phone and desktop through Google Drive's private app folder, and arrives from
Garmin and Strava through a **cowork folder** on the desktop — the same protocol as
[GymTracker](https://adervec.github.io/GymTracker/) and every other app in
[CoworkSyncHub](https://github.com/adervec/CoworkSyncHub).

## How data gets in, and out

```
 Garmin Connect ─┐  tools/garmin-export.py             ┌─ app-export.json, data/streams/*.json
                 ├▶ tools/strava-export.py ─▶ inbox ─▶ Run315 (desktop) ─▶ brief.json, BRIEF.md
 Strava ─────────┘  (run by the agent / the hub)        └─ context.json per channel: what is missing
                                                               │
                                                Google Drive appDataFolder
                                                               │
                                                         Run315 (phone)
```

**Read-only by design.** Run315 takes from Garmin and Strava to analyse and never writes
back: `strava-export.py` asks Strava only for read scopes and refuses any request but a read,
`garmin-export.py` wraps the Garmin client so only `get_*` calls get through, and every
channel's instructions forbid the agent from changing anything on either service, even when
a connector offers the tools.

Duplicates are folded away on every import, whichever service arrived first: a Strava
activity is matched to its Garmin twin by the Garmin id Strava keeps (`external_id`), else
by start time (10 min) and distance (15%); a second Strava upload of a linked session is
dropped.

The cowork folder has four channels, each an `INSTRUCTIONS.md` + `context.json`, replies
into `<channel>/inbox/`:

| Channel | What the agent does |
|---|---|
| `garmin` | runs `tools/garmin-export.py`, which backfills exactly what `context.json` says is missing: new activities, every per-sample channel the watch recorded, laps, weather, gear, the daily sweep, overnight HRV / resting HR / sleep, Garmin's own estimates |
| `strava` | runs `tools/strava-export.py` (all sports, streams). The app links each Strava activity to the Garmin activity it duplicates and inserts the rest |
| `analysis` | answers the questions you queue on **Ask** — with the whole export and every stream on disk, so "go deep" is a real option |
| `coach` | writes the weekly review |

Each request carries a `requestHash` the reply echoes; an agent that cannot finish writes
`error-<date>.json` with a reason, which shows in the run log. The exporters ship inside
the folder (`tools/`), so it is self-contained. With **CoworkSyncHub**:
`python coworkhub.py add run315 manifest "<folder>"` and the hub sweeps it like any other
app. With **Claude Desktop / Cowork**: point it at the folder and ask it to do the Run315
channels.

No folder? Put your own Anthropic key in *Sync & cowork* and **Ask** answers straight from
the browser (Claude Opus 5.5 through the official SDK; the key never leaves the device
except to api.anthropic.com).

Each activity's stream is analysed **once**, on the desktop that imported it, and what the
analysis finds — best efforts, reps, stops, map tiles, zones, durability, climbing, a
thinned track — syncs. So the phone shows every number without downloading a stream; the
activity page fetches the stream from Drive only when you open it.

### First run

1. Desktop (Chrome or Edge): *Sync & cowork* → **Choose folder**, then **Connect Google Drive**.
2. Once, in a terminal: `pip install garminconnect`, and
   `python <folder>/tools/strava-export.py --auth` (a Strava API application with callback
   domain `localhost`). Garmin logs in on the first export and keeps only session tokens,
   shared with garmin_mcp's `~/.garminconnect`.
3. Let the hub or Claude run the channels. The first year arrives over a few sweeps (40
   activity details per run, newest first); the app keeps asking for the rest.
4. Phone: open the same URL, **Connect Google Drive**, install it from the share menu.

This is the merge of three separate projects, and a rebuild of the first as a browser app:

| Was | Is now |
|---|---|
| **Run315** — Garmin analytics, race projections, AI coach | Today, Races, Activities, Ask |
| **RouteMaster** — standalone GPX route maker | Route maker, saved routes synced |
| **TrailTracker** — offline trail-completion PWA | Trails |
| *(new)* **intvl** — the territory game | Territory |
| *(new)* **track & interval analysis** | Track & intervals |
| *(new)* **stop & slow-down analysis** | every activity page |
| *(new)* **race strategy, postmortem, plan adherence, fuelling** | a race's page |
| *(new)* **shoe mileage & weather correction** | Gear |
| *(new)* **zones, running form, readiness, heat** | Today, activity pages |
| *(new)* **durability, climbing, second opinion, career, vitals, route repeats** | their own pages |


## What it does

**Asking, and acting on the answers**
- **Ask & coach**: questions for the agent, answered with the whole export and every stream, **with charts** (agents reply with ```` ```chart ```` specs the app draws); **standing questions** re-asked on a schedule with their history; weekly coach reviews
- **Experiments**: declare a change, and the app compares before and during (Welch intervals, confounders, never causation)
- **Plan of the day**: the agent writes today's options from readiness, the week, the block and the **forecast** (Open-Meteo, best window to run, heat-adjusted targets), and learns from what you actually did
- **Journal**: effort, feel, notes and tags per run, tags per day; Vitals tests them against HRV, resting HR, sleep, body battery and stress, and asks what predicts a good run
- **Data review**: GPS jumps, heart-rate dropouts, cadence lock, mislabelled sports, elevation spikes and Garmin/Strava near-misses flagged, fixes proposed by the agent, applied only when you approve (to Run315's copy, never the services)
- **Sources & coverage**: Garmin against Strava for every linked session, and a day-by-day map of which channels exist
- **Stream explorer**: every channel on one shared axis, synced crosshair, zoom tied to the map, overlay any other run
- **Calendar & search**, **Achievements** and a "since you last looked" digest, a **Today you can rearrange**
- **Strava segments** (read-only, for the runs you choose) and **GymTracker strength** sessions read from the shared Drive folder and counted in fatigue and form

**Coaching**
- Garmin and Strava through the cowork folder; phone and desktop in step through Google Drive
- Best efforts read from *inside* every run — your fastest 1 km, 5 km, 10 km
- Fitness / Fatigue / Form (CTL, ATL, TSB) from a self-calibrating load model
- Race projections with confidence, split targets, and taper planning
- Results close the loop: enter a finish time and projections calibrate to you
- Training paces, HR zones, workload ratio, pace curve, PRs, 26-week log
- A coach review written by Claude against your actual numbers

**Routing** — `/routes`
- Click waypoints on a map; BRouter snaps them to real paths
- Five surface profiles, point-to-point / loop / out-and-back
- Auto-loop: give it a target distance, get a loop of about that length
- Live distance, climb and an elevation profile
- **17 map layers** in five groups — toilets (with **free / paid / unknown**),
  drinking water, showers, pharmacies, coffee, food, shops, **beaches**,
  **water parks**, pools and lidos, viewpoints, shelter, benches, playgrounds,
  bike repair, parking and transit — found along the route and updated as you
  edit it, with a **Free only** filter
- GPX import/export, saved route library

**Trail completion** — `/trails`
- Pull every path, track and footway in a map area from OpenStreetMap
- Each way is split into nodes 25 m apart; your runs mark the ones they pass
  within 25 m
- A trail is every way sharing a name; it is **finished at 90% of its nodes**
- Coverage map: grey is known trail, teal is ground you have covered

**Track and interval work** — `/sessions`
- Finds the reps inside a run **from the pace stream** — no lap button required
- Per rep: distance (snapped to 400 m / 800 m / the mile…), time, pace, HR, and
  the recovery that followed
- Session spread (how even the reps were) and fade (second half vs first)
- Detects whether it was run on a **400 m oval**, from how much distance fits in
  how small a box
- Progression: every session at the same rep distance, over time, against the
  interval pace your own curve prescribes today

**Racing a course, not a distance** — `/race/<id>`
- Attach the real course: upload the organiser's GPX, or point at a run where you
  covered the same ground
- Elevation profile, total climb, how much **harder than flat** the course is, and
  where it bites
- A **race plan** that spends *even effort* rather than even pace — each kilometre
  scaled by what its gradient actually costs, normalised to land on your target
- Afterwards, a **postmortem**: your splits against the plan kilometre by
  kilometre, where the time went, whether you faded, and whether the course or
  your pacing was to blame

**Vitals** — `/vitals`
- Every daily metric the watch records, correlated against training load at
  four lags, with the multiple-comparison correction applied and *shown*
- Sleep architecture, trend detection, and days your body was off across
  several signals at once
- Every per-sample channel the device reports is stored, named or not

**Fuelling** — on any upcoming race
- Carbohydrate, fluid and sodium ranges for your *projected* finish time
- A rough schedule, spaced evenly and stopping before the finish
- Published consensus ranges with the source named, not invented numbers

**Did you do the plan?** — on any race with a plan
- The plan, week by week, against what was actually run
- Reports *which way* you drifted, because under and over mean opposite things
- Long runs judged separately from volume: hitting the mileage with short runs
  is not the same plan

**Heat** — on the dashboard
- How heat-adapted you are, from the weather already stored against your runs
- Decays, because acclimatisation does

**Second opinion** — `/second-opinion`
- This app's threshold and race projections against Garmin's own, side by side
- Where two independent methods agree, the number is probably close; where they
  disagree, you know which question to ask
- Neither is presented as ground truth, because neither is

**Career** — `/career`
- Lifetime distance, hours and races, with the next milestone named
- This year against the *same point* last year, not against all of last year
- Streaks counted in weeks, deliberately

**Climbing** — `/climbing`
- How well you climb, measured *against* the energy model rather than through it
- Total ascent expressed as something you can picture: "one and a half Everests"
  beats 13,470 m
- Route difficulty on the ascent-per-km scale hiking guides use

**Durability** — `/durability`
- Does your engine hold up, or does it just start well? Measures the drift
  between heart rate and grade-adjusted pace across a long run
- Critical speed and the reserve above it, fitted to your own best efforts
- Gated: below 75 minutes there is no signal, so it reports nothing rather
  than a number

**This morning** — on the dashboard
- Readiness from HRV, resting heart rate, sleep and training load, each scored
  against **your own** baseline rather than a population number
- Degrades honestly: with only training load it still answers, and says so

**A training block** — on any upcoming race
- Generated from what you are running **now**, not from a template
- Volume rises across the block, backs off every fourth week, and the heaviest
  week lands just before the taper
- Every session is a pace band off your own curve, so it stays right as you
  get fitter

**Routes you repeat** — `/routes/repeats`
- Finds the routes you run again and again by comparing the map tiles a run
  covers, reusing the territory game's machinery
- Best, latest and trend on each, with pace normalised so an extra 500 m does
  not read as a bad day

**How hard you train** — on the dashboard
- Time in heart-rate zones, integrated across the gaps rather than counted by
  sample, collapsed to easy / moderate / hard
- Your block classified as **polarised**, **pyramidal**, **threshold-heavy** or
  **too-hard**, with a polarisation index and a sentence saying what that means

**Running form** — on every activity page
- Cadence, stride length, ground contact and **vertical ratio**, measured over the
  running portion only so a stop cannot drag the averages down
- Cadence against pace, and whether form held between the halves of the run —
  falling cadence with rising ground contact is what breaking down looks like

**Gear and conditions** — `/gear`
- Shoe mileage counted from your own runs, with a **replace** warning against
  Garmin's own replace-at figure (or 800 km where you have not set one)
- **Heat-corrected pace**: the same effort is simply slower in the heat, so a
  July slump stops reading as lost fitness

**Why you stopped** — on every activity page
- Every interruption classified: **crossing**, **rest**, **climb**, **exhaustion**,
  or just eased off — with the evidence for the call and how sure it is
- The discriminators are heart rate and what happened *afterwards*: a rest stop
  drops your heart rate and costs you nothing; a fatigue break does not drop it
  at all and the running afterwards is measurably worse
- Places you stop on run after run are recognised as **junctions** from your own
  history, so a familiar corner stops being mistaken for a decision

**intvl** — `/intvl`
- Every run claims the ~300 m map tiles it passes through; everything else stays fogged
- Scores: tiles claimed, **largest solid square**, largest connected cluster
- And the question the game actually asks: *which tiles do I run to make the
  square bigger* — answered, ranked by cheapest

## How it works

`fitness.js`, `territory.js` and `trails.js` are pure functions with no I/O, so
each is readable and testable on its own.

### Race projection

1. **Find real efforts** — whole runs from the last 180 days (filtered for
   plausible pace, and for genuinely hard runs where HR exists), plus the best
   efforts measured *inside* each run.
2. **One best per distance bucket**, dropping any bucket whose best implies a
   fatigue exponent outside 1.01–1.20 versus your strongest performance. A
   genuinely fading runner survives this; a Sunday plod does not.
3. **Fit** `log(time) = a + b·log(distance)` by weighted least squares, 90-day
   half-life. `b` is *your* fatigue exponent (textbook Riegel is 1.06).
4. **Adjust for trend** — capped at ±4%, never extrapolated past 12 weeks.
5. **Rate the confidence** from how many efforts fed the fit and how far the race
   is beyond your longest.
6. **Calibrate to you** — the recency-weighted geometric mean of actual/projected
   across your past races multiplies future projections, capped at ±6%.

### Trail matching

Ported from TrailTracker's `engine.js` and **differentially verified against it**
— a seeded fixture of 8 ways and 6 tracks matched to 1e-6 on every number.

Each OSM way is resampled to a node every 25 m; each activity to a point every
10 m (gaps over 150 m are breaks, so the drive between trailheads paints
nothing). A hash grid indexes the nodes; every track point marks every node
within 25 m. Coverage is the union of all activities' masks. It is point-to-point
proximity — no map-matching, no snapping — which is what makes it fast and
predictable.

The 25 m / 10 m / 150 m / 90% constants *are* the product. Changing `NODE_STEP_M`
changes every historical percentage.

### Finding reps

An interval session is bimodal — hard bits and jog bits — so the split between
them is *found*, not assumed. Speed is smoothed over 9 s (raw GPS speed is far
too noisy to threshold), then **Otsu's method** picks the cut that best separates
the two clusters. Contiguous stretches above the cut become reps; ones separated
by under 6 s are stitched back together, because a dropped fix mid-rep would
otherwise split it in two.

The catch is that Otsu always returns *a* threshold, including for a steady run
where there is nothing to separate. So a gate follows: the fast cluster must be
at least 15% faster **and** at least 25 s/km quicker than the slow one. Without
it, a hilly easy hour gets chopped into twenty imaginary reps — which is exactly
what happened the first time this ran against real data.

Rep distances are snapped to standard track and road distances when within 8%,
because a GPS lap of a 400 m oval routinely measures 385–415 m.

### Route layers

The catalogue in `pois.js` is the single source of truth: the Overpass selector
for each layer is *generated* from the same tag rules used to label the results,
so the query and the labelling cannot drift apart.

Everything ticked goes into **one** Overpass union — one request no matter how
many boxes are on — and toggles are debounced by 350 ms so ticking five boxes
asks one question rather than five. Answers are cached for a week, there is a
per-user in-flight lock, and it all goes through the server so it inherits the
mirror failover, retry and `User-Agent` the trail loader uses. Overpass is
donated infrastructure; this is the difference between being a user and being a
problem.

Beaches, pools, playgrounds and parking are picked up from 300 m out rather than
120 m, because they are worth a longer detour than a tap is.

"Free" reads `fee` and `access` together and is honest about not knowing:
`fee=no` is free, `fee=yes` or `access=private|customers` is not, and an untagged
toilet reports **fee unknown** rather than guessing.

### Pacing a course

Even pace on a hilly course is uneven effort, and uneven effort is how a race
gets away from you. So the plan works in effort.

The gradient model is **Minetti et al. (2002)** — the metabolic cost per metre of
running as a polynomial in gradient. Cost relative to flat gives the pace
multiplier, which is what every grade-adjusted pace is built on. Each kilometre's
share of the target is weighted by that cost, then the whole plan is normalised so
it lands exactly on the target time.

One deliberate deviation: the polynomial keeps getting cheaper down to about
−20%, which would have you running a steep descent twice as fast as the flat.
Nobody does — you brake, and your quads pay for it — so the downhill benefit is
floored at 20%. It is a flat floor, not a braking model, and it is marked as such.

The postmortem reads the same model backwards. Every split gets a
**grade-adjusted pace**, so a slow kilometre uphill can be a *better* effort than
a quick one on the flat, and the verdict can tell "you went out too hard" apart
from "the course did that to you".

### Taking everything the watch gives

The app used to capture ten stream channels chosen by hand. It now captures
**every channel the device reports** — named ones get a friendly key, unknown
ones are stored under their raw Garmin key. Watches differ, firmware adds
channels, and a metric dropped at fetch time cannot be analysed next year without
re-downloading a year of activities. The narrow ten-wide view the analysis
modules expect is derived from the wide capture, so nothing broke.

Off the run, a daily sweep pulls **23 metrics from a dozen endpoints** — stress,
body battery, blood oxygen, respiration, sleep stages, body mass and fat,
readiness, intensity minutes, floors, calories, fitness age. Each endpoint is
fetched independently: a watch without a pulse oximeter must still give up its
stress and its steps.

### Which of your numbers actually mean anything

Two dozen daily metrics displayed as two dozen dials pushes the only interesting
question onto the athlete: *does any of this have anything to do with my
running?* For a given person, about three of them do — and which three is
individual, which is exactly what population studies average away.

So every metric is correlated against training load at lags of 0, 1, 2 and 7
days. For the demo athlete that surfaces body battery (same day, r = −0.83),
stress (next day, r = +0.64) and Garmin's readiness (two days, r = +0.47).

**The statistics are the hard part, and getting them wrong would be worse than
not doing it.** Three guards, all visible on the page rather than buried:

- **Multiple comparisons.** 108 tests were run on the demo data. At the usual 5%
  threshold you would expect ~5 false positives, and in fact **36** of the demo's
  correlations clear the uncorrected bar. Everything is Bonferroni-corrected by
  the number of tests actually run — r > 0.44 rather than r > 0.23 — and both
  numbers are printed so the difference is visible.
- **Autocorrelation is named, not fixed.** Hard days cluster and bad nights
  cluster, so the days are not independent and the real evidence is weaker than
  the arithmetic suggests. The page says so. A seven-day lag additionally lands
  on nearly the same phase as no lag, because training is weekly, and any lag-7
  finding carries that warning.
- **Arithmetic is separated from insight.** Calories, steps and intensity minutes
  correlate with running at r > 0.9 because they *are* running. They are shown
  apart from the findings rather than at the top of them. The same filter keeps
  "days your body was off" from simply listing your long runs.

There is a test asserting that twenty metrics of pure noise produce **zero**
findings. That test is the reason to trust the rest.

### What to carry

The app will pace your marathon to the second and tell you how your engine holds
up over three hours, then say nothing about the thing that most often ends those
three hours badly. Running out of carbohydrate is not a pacing error.

The ranges are the published consensus — Jeukendrup, *A Step Towards Personalized
Sports Nutrition* (Sports Medicine 44, 2014), and the joint position stand of the
Academy of Nutrition and Dietetics, Dietitians of Canada and the ACSM (2016):

| Duration | Carbohydrate |
|---|---|
| under 45 min | none needed |
| 45–75 min | small amounts, or a mouth rinse (the effect is on the brain, not the gut) |
| 1–2.5 h | 30–60 g/h |
| beyond ~2.5 h | up to 90 g/h, **glucose and fructose together, roughly 2:1** |

That last row is the part people get wrong. Glucose transport saturates near
60 g/h, so a single-sugar gel taken faster than that mostly sits in your stomach.
The advice has to change in kind above the ceiling, not just scale up, and there
is a test asserting exactly that.

**Fluid is given as a range with a warning rather than a number.** Drinking to a
schedule regardless of thirst is how runners end up hyponatraemic, which is more
dangerous than mild dehydration and puts people in hospital at big-city marathons
every year. Thirst is the instrument.

### Closing the loop on the plan

A plan generator that never looks back is a horoscope. It prints a tidy table,
the athlete does something else, and nobody finds out until the race.

So the plan is checked against what was actually run. What it reports is not a
compliance percentage but *which way* you drifted, because the two directions
mean opposite things: consistently under means the race projections built on the
plan are optimistic; consistently over means the plan is not what is governing
your training, and the easy weeks are the ones being skipped.

Three deliberate choices:

- **No streak, no grade, nothing that rewards hitting a number on a week you
  should have rested.** The readiness read exists precisely to override the plan,
  and a score that punished you for listening to it would fight the rest of the
  app.
- **A week still in progress is not a week you failed**, so only finished weeks
  are judged.
- **The long run is judged separately from volume.** Hitting 50 km with five
  short runs is not the week the plan asked for.

The demo caught a real bug here: it reported "tracking the plan closely — within
a tenth on most weeks" while showing 4 of 16 weeks on target. The fallback
message claimed something the numbers did not support. It now says the weeks land
on both sides, which is what actually happened, and there is a regression test
holding it there.

### Heat, and whether you are ready for it

Ten to fourteen days of running in the heat produces real adaptation — plasma
volume expands, sweating starts earlier, heart rate at a given effort falls —
with most of it arriving in the first week (Périard, Racinais & Sawka, Scand J
Med Sci Sports 2015). It also fades within a few weeks of stopping.

The app already stores the temperature of every run, so this is bookkeeping on
exposure that was free to compute: hot sessions bank credit, longer ones bank
more, and the total decays with an eight-day half-life. The bands are calibrated
against the protocol rather than guessed — fourteen consecutive hot sessions bank
about 8.5 units after decay, not fourteen, so that is where the top band sits.

It is a model of your *exposure*, not of your blood plasma, and the page says so.

### Arguing with your watch

Garmin computes its own threshold, VO2max and race predictions by a different
method (Firstbeat's, from the heart-rate/speed relationship) on the same runs.
This app infers a threshold from the top of your hard running and projects races
from a fitted power law. Both are estimates of the same underlying thing.

Where two independent methods agree, the number is probably close. Where they
disagree, one is wrong and you now know which question to ask. That is worth more
than either figure alone in a confident font, so the page frames everything as
agreement or disagreement and never as "Garmin says you are wrong".

The caveats are on the page, not buried: Garmin's threshold detection moved from
a chest-strap protocol using HRV-derived respiration to automatic detection from
optical wrist heart rate in late 2024, independent validation of that version is
thin, and one study measured the Fenix 7 reading threshold pace nearly 12% slow.

**No VO2max is computed here, on purpose.** A heart-rate-derived VO2max is a
lossy compression of the heart-rate/pace relationship into one number using a
population economy curve. It adds a familiar unit and a false precision, not
information — and Garmin's own carries a mean error of 5–8% with a chest strap.
Garmin's is displayed for reference; this app declines to invent a rival.

One detail worth flagging in the demo: Garmin's seeded threshold pace is
deliberately *not* a copy of ours. Seeding it identical would make the comparison
agree by construction and demonstrate nothing, so it is offset by the direction
the validation literature reports.

### Testing the hill model instead of applying it

Grade-adjusted pace takes Minetti's energy-cost polynomial and uses it to flatten
your splits. That is useful, but it means GAP can never tell you anything about
hills: it *assumes* the model is right about you and corrects accordingly.

Turn it around and the same model answers a question nobody ships. Inside a
single run, take the athlete's speed on the flat sections as the reference, then
for each climbing section compare the speed they actually held against the speed
the model says that effort should have bought on that gradient. The average is a
personal climbing factor:

    factor < 1   hills cost you more than the model expects
    factor > 1   you climb better than the model expects

Because both halves come from the same run, fitness, weather, fuelling and how
hard you were trying all cancel out. Only the gradient is left. The demo athlete
comes out at **+13%**.

There is a calibration test for this: a synthetic runner who holds *exactly* the
model's predicted speed at every gradient must score 1.000, and one built to be
15% better must score 1.150. A second test runs the same runner at half the
overall speed and asserts the factor does not move.

Route difficulty uses Naismith's rule (5 km/h, plus an hour per 600 m of ascent —
Scottish Mountaineering Club Journal, 1892) with Langmuir's descent corrections,
because that is the standard the world's trail databases publish official course
times against.

### Durability, and why it is the one worth having

Everything else in this app describes a runner who is fresh. Race prediction
fits a curve to your *best* efforts; threshold pace is a steady-state number.
None of it says anything about hour three, which is where a marathon is decided.

The measurement is decoupling: internal load (heart rate as a fraction of your
maximum) over external load (grade-adjusted speed as a fraction of your critical
speed), compared between the early part of a long run and the late part. The
method is Smyth, Maunder, Meyler, Hunter and Muniz-Pumares, *Decoupling of
Internal and External Workload During a Marathon* (Sports Medicine 52(9), 2022)
— an analysis of **82,303 recreational runners** using exactly the fields a GPS
watch records. Their population mean was 1.16; this app's demo athlete sits at
1.08–1.16, which is a reassuring place to land.

Three deliberate restrictions, all from the literature rather than from taste:

- **A dose gate.** Critical power does not move after 40 or 80 minutes of heavy
  work and only falls after 120 (Clark et al. 2019). Below 75 minutes there is
  nothing to measure, so `analyse()` returns `None` rather than a number.
- **Grade adjustment before anything else.** A long run that finishes uphill
  looks like fatigue and is not. There is a test that holds metabolic cost
  constant across a climb and asserts the drift stays under 2%.
- **No cross-athlete comparison anywhere.** Fast runners race at ~96% of critical
  speed and have no room to drift, so their fade shows up as slowing rather than
  a climbing heart rate (Takayama and Aoyagi 2025). Men decouple more than women
  and earlier. The number is yours alone.

Critical speed is fitted separately, following Smyth and Muniz-Pumares (MSSE
52(12), 2020): `distance = CS · time + D'` across your best efforts of two to
fifteen minutes. It is deliberately **not** used for race projection — checked
against held-out distances it predicts a half marathon at 1:23 against an actual
1:40, because critical speed is only sustainable for half an hour or so. There is
a test asserting the two models stay separate.

### Building a plan

Three rules, and they are the ones people break. Volume rises slowly and comes
back down — three weeks up, one easy, a cap on the week-on-week ramp and on total
growth. The long run is a share of the week rather than a heroic number, and it
is capped by the race: nobody needs a 40 km run to race a 10K. Intensity is
always a band off the athlete's own fitted curve, never a number from a chart.

The progression is spread across the whole build so the heaviest week lands just
before the taper. Compounding a fixed percentage instead — the obvious
implementation — hits the ceiling at week 7 of 16 and then sits flat for six
weeks, which is a ramp followed by a plateau rather than a plan.

### Reading the night

Every overnight number is scored against the athlete's own baseline, because an
HRV of 45 ms means nothing in the abstract and everything against your usual 60.
The weights are HRV 0.35, sleep 0.25, resting HR 0.20, training load 0.20,
renormalised over whatever actually arrived. Training load is last on purpose: it
is the plan's opinion of your fatigue, not a measurement of you, and an athlete
mid-block is *meant* to be tired. It anchors the score when nothing else exists
and cannot outvote the body when something does.

### Ascent you can picture

Cumulative ascent is the least legible number in running. Nobody has an intuition
for 13,470 m, and putting it in a box next to a distance does nothing to build
one. Korea's Runday maps stair-climbing onto world landmarks; the same trick
works better on trail ascent, because the numbers get large enough to be
meaningless.

So the app says **"one and a half Everests"**, and lists what you have cleared on
the way. Heights are structural (to the architectural top, not the aerial tip),
which is the figure people actually picture.

### A gate on nonsense

Borrowed from Tranggle, the Korean tracker, which awards nothing to a "hike"
recorded at 30 km/h. Strava will take a mislabelled bike ride as a run and put it
in your personal bests, where it stays forever and quietly poisons every
projection built on them. Twenty lines, and the limits sit well clear of
world-record average pace, so it catches a wrong label rather than a good day.

### A career, rather than a rolling window

Every training app forgets. Fitness is a 42-day average, form a 7-day one, and
the dashboard resets each January. That is right for "am I ready for Saturday"
and wrong for "what have I actually done".

Taiwan's 馬拉松普查 — a civilian-run national marathon census started by one
veteran runner — keeps a lifetime ledger instead, with awards at 10/30/60/100
marathons and a published, argued-over standard for what counts. No Western app
offers anything like it.

Two decisions worth naming:

- **Streaks are counted in weeks, not days.** A daily streak rewards running on
  the days you should not. A week with a run in it is a habit; a run every single
  day is a compulsion with a badge attached.
- **This year is compared against the same point last year**, not against all of
  last year — eleven months against twelve is not a decline. And when the record
  does not reach far enough back, it says so instead of printing a percentage:
  the demo's own data would otherwise report "26,090% more running than the year
  before", which is true and useless.

### The metric that got deleted

This app used to show an **acute:chronic workload ratio** on the dashboard, as
most training apps do. It has been removed, because it does not survive contact
with the evidence:

- Impellizzeri et al., *Time to Dismiss ACWR and Its Underlying Theory* (Sports
  Medicine 51(3), 2021) recomputed published ACWR results with the chronic load
  replaced by **random numbers** and reproduced the effect. The ratio predicted
  injury barely better than chance (c-statistic 0.574 against 0.544 for acute
  load alone) — and that was *in-sample*.
- The acute week sits inside the chronic window, so numerator and denominator
  share variance and part of the correlation is definitional (Lolli et al., BJSM
  2019). The EWMA variant fixes the weighting and none of the above.

What replaced it is narrower and much better evidenced. Frandsen et al. (BJSM
2025) followed **5,205 Garmin-tracked runners over 588,071 sessions and 1,820
injuries**, and compared three ways of expressing a training spike. The
single-session one won: **distance relative to your longest run of the past 30
days**. Against a rise of 10% or less, a rise of 10–30% carried a hazard rate
ratio of 1.64 (95% CI 1.31–2.05).

Note that the next band up, 30–100%, carried a *lower* ratio of 1.52. That is not
a clean dose-response, and the wording in the app does not pretend otherwise.

### Correcting for the weather

Running slows in a roughly quadratic way once the air is above about 13 C, and
humidity matters through the heat index rather than on its own. The curve is
calibrated to the reference points the published heat-and-pace tables agree on —
about 1.5% at 20 C, 4% at 25 C, 10% at 30 C — and those numbers are pinned in a
test, so the correction cannot quietly drift into being someone's opinion.

Two deliberate choices. The heat index is built for standing still and amplifies
humidity hard, so only half that amplification is carried into the pace curve;
applying it whole double-counts and produced a 21% penalty at 29 C on the first
attempt. And the penalty is capped at 15% — a run you actually finished was not
a quarter slower.

Where the watch reports a dew point it wins over humidity, because above about
15 C dew point sweat stops evaporating usefully and that is the thing that
actually hurts.

### Telling stops apart

A GPS trace records a red light, a water fountain and running out of legs
identically. They are separated by evidence:

| | Standing? | Heart rate | Afterwards |
|---|---|---|---|
| **crossing** | yes, briefly | barely moves — no time to recover | unchanged |
| **rest** | yes, long enough | comes down properly | unchanged |
| **climb** | no, walking | — | explained by grade ≥ 4% |
| **exhaustion** | no, walking | *stays high anyway* | measurably slower |

That last row is the whole point: high heart rate at walking pace is decoupling,
and a pace penalty over the 250 m after versus the 250 m before is what separates
"I chose to stop" from "I had to".

Whether it was a full stop is judged on the span's **minimum** speed, not its
mean. Smoothing bleeds running speed into a stop's edges, so on a sparsely
sampled stream the mean of a red light can rise above walking pace — which had a
late traffic light being blamed on fatigue.

Junctions come from the athlete's own history rather than map data: stand still
at the same corner on three separate runs and it is a junction, not a decision.

### intvl

Standard Web Mercator slippy tiles at zoom 17 (~305 m at the equator, less with
latitude), verified against the OSM reference formula. Consecutive GPS points are
bridged so a sparsely sampled track leaves no holes; a jump over 64 tiles is a
glitch or a drive and is not filled in.

Max square is a largest-square DP over a sparse dict, so the empty ocean between
you and everywhere else costs nothing. Growth suggestions use a 2D prefix sum to
find every near-miss window in constant time per window.

### Load, paces and zones

`load = hours × intensity² × 100`, intensity from your HR over an estimated
threshold HR (95th percentile of activity-average HR), falling back to pace.
CTL/ATL are 42- and 7-day exponential averages; TSB is their difference.

Training paces are anchored on the pace your own curve says you could hold for
**one hour** — solved from the fit, not assumed to be some race distance. HR
zones are Friel bands on the same threshold. Workload ratio is 7-day load over
the 28-day weekly average; above ~1.5 is where overuse injuries cluster.

## Tests

```bash
npm test
```

Every analysis module's Python test suite was ported with it (`test/<module>.test.mjs`,
same cases, same numbers), plus the importers and the sync merge (`ingest.test.mjs`), the
whole demo path from Garmin reply to brief (`pipeline.test.mjs`), and a render of every
page against the demo athlete and against an empty device (`pages.test.mjs`). Nothing
beyond `node --test`; no network.

## Layout

| Path | What it is |
|---|---|
| `index.html`, `css/app.css` | the shell; light and dark from the same tokens |
| `js/main.js` | boot, router, nav |
| `js/pages/*.js` | one module per page: `render(params)` returns HTML, `mount(el)` wires it |
| `js/derive.js` | per-activity derivation, every aggregate the pages read, the brief |
| `js/lib/*.js` | the analysis — pure, no dependencies |
| `js/merge.js` | the synced state and the per-record merge (newest edit wins, tombstones) |
| `js/store.js` | IndexedDB: state, streams, re-fetchable cache |
| `js/drive.js` | Google Drive appDataFolder sync (GymTracker's OAuth client) |
| `js/cowork.js` | the cowork folder: manifest, requests, inbox, run log, schedule |
| `js/ingest.js` | Garmin and Strava replies into state, one activity per session |
| `js/ai.js` | the own-key Claude transport |
| `js/demo.js` | the synthetic athlete, as a Garmin reply |
| `tools/` | `garmin-export.py` (+ `garmin_fetch.py`), `strava-export.py` |

## Outside services

All called from the browser, none with an SLA: **Overpass** (trail geometry, route layers;
two mirrors, cached a week in IndexedDB), **BRouter** (route snapping), **OpenStreetMap
tiles**, **Google Drive**, and **Anthropic** only with your own key.


## Known limits

- Best efforts come from Garmin's charted stream (≤2000 samples), so on a very
  long activity short efforts are interpolated between samples.
- Only running feeds the race projection; cycling and swimming count toward load.
- The route planner dropped RouteMaster's map notes, personal heatmap and
  custom-profile emphasis toggles — the territory map covers the heatmap's job,
  and the rest need their own tables.
- Layer coverage is only as good as OpenStreetMap locally. A missing toilet means
  nobody has mapped it, and most toilets carry no `fee` tag at all, which is why
  "fee unknown" is shown rather than assumed to be free.
- Trail dates are UTC and date-only, from the file. A late-evening run files
  under the next day.
- Rep detection reads pace only, and standing still is deliberately excluded
  from the clustering (otherwise every red light reads as a recovery). The cost
  is that a session run with *standing* recoveries will not be detected; jog
  recoveries are the common case.
- Stop classification needs heart rate to be confident. Without a strap it still
  separates standing from walking, but a rest and a fatigue break look alike.
- Grade comes from the device's elevation channel, which is noisy on GPS-only
  watches; a barometric altimeter is used where the watch reports one. Course
  elevation is smoothed over 100 m before any gradient is taken, or a flat road
  reads as a series of ramps.
- A race is matched to the run you did that day only if the distance is within
  15%; otherwise you link it by hand. An easy jog on race morning is not the race.
- Course GPX is thinned to ~2000 points on save. Plenty for gradients at
  kilometre grain, and it keeps a marathon course from becoming a megabyte.
- The heat correction is one curve for everybody. An acclimatised athlete suffers
  far less than an unacclimatised one, and the same athlete responds differently
  in April and August. It is a lens, not a measurement.
- Shoe mileage only counts runs you tagged with that pair in Garmin. Untagged
  runs are invisible to it, which is usually why a total looks low.
- Running form needs a watch or strap that records dynamics. Without one the
  panel simply does not appear; each channel degrades on its own.
- The form reference points (cadence 170-180, ground contact under ~250 ms,
  vertical ratio under ~10%) are population guidance, and the findings say so.
  Cadence rises with pace and falls with height, so a low figure is worth a look,
  never an instruction.
- Durability needs a long run and an honest maximum heart rate. The maximum is
  taken from your training history, so a runner who has never truly emptied the
  tank gets a ceiling that is too low and every ratio reads high. Smyth lists the
  same limitation.
- Critical speed is a physiological marker, not a race predictor, and the app
  keeps the two apart on purpose.
- Some things were investigated and deliberately **not** built: DFA-a1 as a
  threshold proxy (needs beat-to-beat RR intervals; Garmin's API gives 1 Hz heart
  rate only), running economy from gait data (ground contact time has a pooled
  correlation of **-0.02** with economy across 40 studies — van Hooren et al.
  2024), asymmetry-based injury alerts (no association in 836 prospectively
  followed runners — Malisoux et al. 2024), and cumulative bone load from watch
  data (a 9.9% force error becomes a 104% damage error — Matijevich et al. 2020).
- The vitals correlations are exploratory, and the page says so. Days are not
  independent, correlation is not causation, and a signal that clears a corrected
  threshold is a dial worth watching rather than a fact about your physiology.
- Sleep staging from a wrist device disagrees with a sleep lab often enough that
  the architecture breakdown is a shape, not a measurement.
- Fuelling gives published population ranges, not personal advice. Gut tolerance
  is individual, 90 g/h is a trained capacity rather than a starting point, and
  race day is the wrong time to find that out.
- Heat acclimatisation here is bookkeeping on exposure, not a physiological
  measurement. It cannot see your plasma volume, how well you slept, or whether
  you were acclimatised before the record starts.
- The second opinion compares two estimates, neither of which is truth. Agreement
  means they are probably both close; it is not proof either is right.
- The climbing factor needs runs containing both flat and climbing, so it says
  nothing about someone who only runs mountains or only runs a towpath. It is
  also a comparison against a model fitted on ten subjects on a treadmill
  (Minetti 2002), which is the best available and not the same as truth.
- The training plan is a schedule, not a prescription. It has no idea whether you
  slept; the readiness read is what should override it.
- Readiness reads training signals, not health. Several flat mornings with no
  hard training behind them are worth raising with a person, not an app.
- Route matching is direction-blind: a loop run backwards is the same route. It
  also needs GPS, so treadmill runs never appear.
- The polarisation index is blunt: with percentage shares it clears 2.0 for
  almost any block containing real hard work. The three shares are the honest
  discriminator; the index is for trending one block against the next.

## Installing it

A PWA: install from the address bar on the desktop, or Share → Add to Home Screen on the
phone. The service worker serves the shell from cache (stale-while-revalidate), so it opens
instantly and offline; the data is in IndexedDB anyway.

## Publishing

`.github/workflows/pages.yml` runs `npm test` on every push and publishes `main` to GitHub
Pages only when it is green (Settings → Pages → Source: **GitHub Actions**).
