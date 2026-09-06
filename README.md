# Run315

One self-hosted app for coaching, routing, trail completion and territory — the
parts of Strava premium you actually miss, plus the parts it never had.

**[Live demo](https://adervec.github.io/Run315/)** — a synthetic athlete's year, frozen to static files. Every page is the real app doing real analysis; only the buttons that write are switched off.

This is the merge of three separate projects:

| Was | Is now |
|---|---|
| **Run315** — Garmin analytics, race projections, AI coach | the dashboard, `/race/<id>`, `/activity/<id>` |
| **RouteMaster** — standalone GPX route maker | `/routes`, server-persisted per user |
| **TrailTracker** — offline trail-completion PWA | `/trails`, matching engine in `trails.py` |
| *(new)* **intvl** — the territory game | `/intvl` |
| *(new)* **track & interval analysis** | `/sessions` |
| *(new)* **stop & slow-down analysis** | on every activity page |
| *(new)* **race strategy & postmortem** | `/race/<id>` |
| *(new)* **shoe mileage & weather correction** | `/gear` |
| *(new)* **zone distribution & running form** | dashboard, activity pages |
| *(new)* **readiness, training plans, route repeats** | dashboard, `/race/<id>`, `/routes/repeats` |
| *(new)* **durability / decoupling** | `/durability` |
| *(new)* **climbing: how hills cost you** | `/climbing` |
| *(new)* **second opinion vs Garmin** | `/second-opinion` |
| *(new)* **career ledger and year in review** | `/career` |
| *(new)* **plan adherence, heat acclimatisation** | `/race/<id>`, dashboard |
| *(new)* **race fuelling** | `/race/<id>` |
| *(new)* **vitals: what responds to training** | `/vitals` |

## What it does

**Coaching**
- Google sign-in, Garmin Connect sync (incl. MFA), background refresh
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

## Run it

Python 3.12 or newer (`garminconnect` 0.3.x needs it).

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt   # macOS/Linux: .venv/bin/python
.venv/Scripts/python app.py
```

`.env` already has a generated `SECRET_KEY`. Fill in the rest as you need it:

| Variable | Needed for | Where to get it |
|---|---|---|
| `SECRET_KEY` | sessions + Garmin token encryption | already generated |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | sign-in | Google Cloud Console → Credentials → OAuth client ID → **Web application**. Redirect URI `http://127.0.0.1:5000/auth/callback` |
| `ANTHROPIC_API_KEY` | the coach review | console.anthropic.com |

Everything else works without those two. Optional: `SYNC_INTERVAL_HOURS` (6),
`DETAIL_BATCH` (40), `DATABASE_PATH`, `PORT`, `HTTPS`.

### See it without any credentials

```bash
.venv/Scripts/python app.py --demo
```

A synthetic athlete with a year of training, five races, ~1,750 best efforts and
GPS tracks around Zurich — enough to light up every page. The demo builds each
run's pace profile and GPS track and puts them through the *real* extractors, so
what you see is the production code path.

### Connecting Garmin

Garmin has no consumer OAuth, so you sign in once with your Garmin credentials.
Only the resulting **session token** is kept, encrypted with a key derived from
`SECRET_KEY`; the password is never written anywhere. MFA is handled. Rotating
`SECRET_KEY` invalidates stored tokens — you just reconnect.

After each sync, Run315 fetches detail streams for runs it has not analysed
(newest first, `DETAIL_BATCH` at a time) in a background thread. Those streams
carry time, distance, heart rate, **GPS, elevation and running dynamics**
(cadence, stride length, ground contact, vertical oscillation) — which is what
feeds best efforts, the activity map, trail matching, intvl, the stop analysis
and the form work. Weather and gear are pulled per activity in the same pass.

## How it works

`fitness.py`, `territory.py` and `trails.py` are pure functions with no I/O, so
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

The catalogue in `pois.py` is the single source of truth: the Overpass selector
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
.venv/Scripts/python test_fitness.py     # the coaching model: 32 checks
.venv/Scripts/python test_territory.py   # tiles, squares, clusters: 16 checks
.venv/Scripts/python test_trails.py      # matching and coverage: 21 checks
.venv/Scripts/python test_intervals.py   # rep detection, track sensing: 14 checks
.venv/Scripts/python test_stops.py       # stop classification: 15 checks
.venv/Scripts/python test_pois.py        # layer catalogue and parsing: 10 checks
.venv/Scripts/python test_racecraft.py   # pacing and postmortem: 19 checks
.venv/Scripts/python test_weather.py     # heat correction: 9 checks
.venv/Scripts/python test_zones.py       # zones and polarisation: 23 checks
.venv/Scripts/python test_form.py        # running dynamics: 28 checks
.venv/Scripts/python test_plan.py        # plan generation: 13 checks
.venv/Scripts/python test_recovery.py    # readiness: 26 checks
.venv/Scripts/python test_repeats.py     # route matching: 21 checks
.venv/Scripts/python test_durability.py  # decoupling, critical speed: 16 checks
.venv/Scripts/python test_terrain.py     # climbing cost, book time: 13 checks
.venv/Scripts/python test_landmarks.py   # ascent, in things you can picture: 7 checks
.venv/Scripts/python test_secondopinion.py  # us against Garmin: 9 checks
.venv/Scripts/python test_recap.py       # career ledger, year on year: 10 checks
.venv/Scripts/python test_adherence.py   # plan vs actual: 12 checks
.venv/Scripts/python test_fuelling.py    # carbs, fluid, sodium: 9 checks
.venv/Scripts/python test_vitals.py      # correlation, correction, outliers: 15 checks
.venv/Scripts/python test_app.py         # parsing, routes, integration: 40 checks
```

380 checks. No framework, no fixtures — run the files. `test_app.py` never touches
the network; Overpass is a free volunteer service and a test suite has no
business hammering it.

## Layout

| File | What it is |
|---|---|
| `app.py` | Flask: auth, sync, backfill, races, activities, trails, intvl, APIs, demo seed |
| `fitness.py` | The coaching model. Pure, no dependencies |
| `territory.py` | The intvl game. Pure, no dependencies |
| `intervals.py` | Rep detection and track analysis. Pure, no dependencies |
| `stops.py` | Why a run got interrupted. Pure, no dependencies |
| `pois.py` | The map-layer catalogue and Overpass queries. Pure, no dependencies |
| `racecraft.py` | Course pacing and race postmortem. Pure, no dependencies |
| `weather.py` | Heat correction for pace. Pure, no dependencies |
| `zones.py` | HR zone time and training polarisation. Pure, no dependencies |
| `form.py` | Running dynamics. Pure, no dependencies |
| `plan.py` | Training block generation. Pure, no dependencies |
| `recovery.py` | Readiness from overnight data. Pure, no dependencies |
| `repeats.py` | Repeated-route detection. Pure, builds on `territory.py` |
| `durability.py` | Decoupling and critical speed. Pure, builds on `racecraft.py` |
| `terrain.py` | Climbing cost and book time. Pure, builds on `racecraft.py` |
| `landmarks.py` | Ascent, in things you can picture. Pure, no dependencies |
| `secondopinion.py` | Our estimates against Garmin's. Pure, no dependencies |
| `recap.py` | Career ledger and year on year. Pure, no dependencies |
| `adherence.py` | Plan against reality. Pure, no dependencies |
| `fuelling.py` | Carbohydrate, fluid and sodium. Pure, no dependencies |
| `vitals.py` | Correlating daily metrics against load. Pure, stdlib only |
| `trails.py` | Trail matching and coverage. Pure, no dependencies |
| `garmin.py` | Garmin login (incl. MFA), activities, detail streams |
| `coach.py` | Builds the prompt and calls Claude |
| `static/routes.js` | The route planner |
| `templates/` | dashboard, race, activity, trails, intvl, routes, login |

## APIs

| Endpoint | Returns |
|---|---|
| `GET /api/summary` | fitness, calibration, races, projections, paces, zones, PRs, weekly, territory |
| `GET /api/tiles` | claimed tiles, max square, growth targets |
| `GET /api/trails` | trail geometry with covered sections |
| `GET /api/poi-layers`, `POST /api/pois` | the layer catalogue, and what is along a route |
| `GET /api/routes`, `POST`, `DELETE /api/routes/<id>` | saved routes |
| `GET /export.csv` | every activity |

## Outside services

All free, all unauthenticated, none with an SLA:

- **Overpass** (`overpass-api.de`, `overpass.kumi.systems`) — trail geometry and
  route layers. Server-side, two attempts per mirror with backoff, sequential not
  raced, area capped at 0.45 square degrees, corridor capped at 80 points, a
  week-long cache, a per-user in-flight lock, and a descriptive `User-Agent`.
- **BRouter** (`brouter.de`) — route snapping. Called from the browser.
- **OpenStreetMap tiles** — basemaps.

## Known limits

- Sync, backfill and matching run in threads in the web process — fine for one
  person, not for a multi-worker deployment.
- Half-finished MFA logins are held in memory and do not survive a restart.
- Best efforts come from Garmin's charted stream (≤2000 samples), so on a very
  long activity short efforts are interpolated between samples.
- Only running feeds the race projection; cycling and swimming count toward load.
- `/api/trails` caps at 3000 segments; paginate by bbox if you outgrow it.
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

Run315 is a PWA: install it from the browser's address bar on desktop, or
Share -> Add to Home Screen on iOS, and it opens standalone with its own icon.

`templates/manifest.webmanifest` and `templates/sw.js` are Jinja templates
rather than static files, so `url_for` decides the paths and the same code
serves a real install at `/` and the frozen demo under `/Run315/`. The service
worker has to live at the mount root -- one served from `/static/` could only
ever control `/static/`.

Pages are network-first: this app shows *your* data, and a stale dashboard is
worse than a spinner, so the cache only comes out when the network is gone.
Anything that writes -- a sync, a new race, signing out -- drops the cached
pages, which is also what stops the offline copy outliving your session.
Icons come from `icons.py`: a 5x7 bitmap font and a hand-rolled PNG writer,
which is less than a build dependency for two files that never change.

## Publishing the demo

GitHub Pages serves files, not Flask, so `freeze.py` seeds the synthetic
athlete, signs in as them with a test client, crawls every internal link and
writes what comes back:

```bash
BASE_PATH=/Run315 python freeze.py     # -> docs/, ~130 pages
python -m http.server -d docs          # check it locally first
git add docs && git commit -m "refresh demo" && git push
```

Pages is served from `main` on `/docs`, so a push is the deploy. `BASE_PATH`
is the project-page prefix; leave it empty for a user page or a custom domain.

Frozen pages carry a banner saying so, and every POST form is disabled rather
than left to 405 when someone presses it. The route builder still routes --
BRouter is a public API -- it just cannot save.
