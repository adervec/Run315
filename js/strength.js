// GymTracker's strength sessions, read (never written) from the shared Drive appDataFolder,
// so leg day counts in fatigue, form and readiness.
// CONTRACT:
//   strengthActivities()  -> pseudo-activities merged into derive.activities() when enabled:
//                            {id: 'gt…', source: 'gymtracker', type: 'strength_training', start: ISO, moving_s, avg_hr, ...}
//   strengthPanel()       -> html for Today;  strengthDetail(id) -> html for the activity page (ids 'gt…')
// STUB: filled in by the GymTracker work.
export function strengthActivities() { return []; }
export function strengthPanel() { return ''; }
export function strengthDetail(id) { return ''; }
