// The athlete's own words and numbers: effort (RPE), feel, notes and tags per activity,
// tags per day (illness, travel, alcohol, stress...). state.journal; see merge.js.
// CONTRACT (pages depend on these):
//   journalWidget(activityId) -> html for the activity page;  mountJournal(el, activityId)
//   dayTagsWidget(day)        -> html for Today / a day;       mountDayTags(el, day)
//   journalDaily(st)          -> {'YYYY-MM-DD': {rpe, feel, tag_<name>: 1, ...}} for correlations
// STUB: filled in by the journal work.
export function journalWidget(id) { return ''; }
export function mountJournal(el, id) {}
export function dayTagsWidget(day) { return ''; }
export function mountDayTags(el, day) {}
export function journalDaily(st) { return {}; }
