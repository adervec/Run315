// Plan of the Day: the pod cowork channel's request and import, and what the page reads.
// CONTRACT (cowork.js depends on these two):
//   podContext(st, now) -> plain object written as pod/context.json's payload
//   importPod(st, payload) -> {handled: true, note} after storing state.pod[date]
// STUB: filled in by the Plan of the Day work.
import { put } from './merge.js';
export function podContext(st, now = new Date()) { return { date: now.toISOString().slice(0, 10), options: (st.profile && st.profile.podOptions) || {} }; }
export function importPod(st, p) {
  if (!p || !p.date || !Array.isArray(p.plans)) return { handled: false, note: 'no date/plans' };
  put(st, 'pod', p.date, { ...(st.pod[p.date] || {}), date: p.date, rationale: p.rationale || '', plans: p.plans });
  return { handled: true, note: p.plans.length + ' plans for ' + p.date };
}

// Today's panel (Today page hook). STUB until the Plan of the Day work lands.
export function podPanel() { return ''; }
export function mountPodPanel(el) {}
