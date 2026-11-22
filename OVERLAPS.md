# Overlaps

Places where this app and another app, or the hub, hold the same data, do the same job, or could
feed each other (house standard 27). Written down, not acted on: building one is the maker's call,
after a plan. The hub's register is `../CoworkSyncHub/OVERLAPS.md`.

Reviewed: 2026-11-21

## Seen from the hub's register

- [idea] GymTracker + Run315 + CelebrityCrusher + BlackMirrorBikeRide: each takes in the same Garmin and Strava activities its own way -> fetch once, one `shared-activities.json` in the shared Drive folder (from the hub register; standard 27 now names the AI runner, not Run315, as its owner)
- [idea] GymTracker + Run315: a run can be logged as cardio in both -> GymTracker's cardio reads Run315's runs instead of storing its own (from the hub register)
- [idea] MacroTrackro + GymTracker + Run315: daily calorie targets ignore the day's training -> MacroTrackro reads the day's sessions (the hub ledger, or shared-activities) to adjust the target (from the hub register)
- [idea] BlackMirrorBikeRide + Run315: both import and build GPX routes; rides never reach Run315's fitness and fatigue model -> share routes; BMBR rides join shared-activities (from the hub register)
- [planned] GymTracker + Run315 + CelebrityCrusher + BlackMirrorBikeRide + BodybuildingProgressCoach + hub: the hub compiles one de-duplicated activity list and gives credit by what each activity was (from the hub register)

## Seen from Run315

- [idea] Run315 + AI runner: `shared-activities.json` and `shared-body.json` now exist (owned by the runner) while Run315 still fetches Garmin and Strava through its own garmin and strava cowork channels -> Run315 reads the shared feed for the activity list and keeps its own channels only for what the feed leaves out (per-second streams, laps, weather, Garmin's daily sweep and nights)
- [idea] Run315 + hub ledger: Run315 logs each imported Garmin or Strava run with `appFont.logSession` (js/pages/today.js reportToPortal), but standard 25 now says an app that only analyses those runs should not -> stop logging once the `ledger` check exempts analysis-only apps
- [idea] Run315 + GymTracker: Run315 reads GymTracker's own Drive file `gymtracker-state.json` for strength sessions (js/strength.js), which standard 27 says not to do -> GymTracker publishes `shared-strength.json` (or its sessions join shared-activities as `strength`) and Run315 reads that instead
- [idea] Run315 + MacroTrackro: Run315 works out race-week carb loading and per-hour fuelling (js/lib/fuelling.js) -> MacroTrackro reads the race calendar and loading plan from a `shared-races.json` Run315 owns, to set race-week targets
- [idea] Run315 + BlackMirrorBikeRide + hub: Run315 fetches Open-Meteo weather for every run and race-day forecast (js/collect.js, js/forecast.js) -> one shared weather helper in font.js if another app forecasts too
- [idea] Run315 + every app (languages): Run315's `english()` keeps stored data and everything an AI agent reads in English while the screen is translated (js/i18n.js) -> a shared `appFont.english()` in font.js, since every app with cowork channels has the same need
- [idea] Run315 + any app with a calendar of events: the races cowork channel keeps a calendar current from emails and websites (js/racemail.js) -> the same email-and-web channel pattern could serve other dated events (gigs, exams), as a recipe in COWORK-PROTOCOL.md rather than shared code
