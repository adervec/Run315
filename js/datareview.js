// Data review: findings the app flags in imported data, and the agent's proposals for them.
// CONTRACT (cowork.js depends on these two):
//   reviewContext(st) -> plain object written as datareview/context.json's payload ({findings: [...]})
//   importReview(st, payload) -> {handled: true, note} after storing proposals in state.dataReview
// STUB: filled in by the data review work.
import { put } from './merge.js';
export function reviewContext() { return { findings: [] }; }
export function importReview(st, p) {
  const props = (p && Array.isArray(p.proposals)) ? p.proposals : null;
  if (!props) return { handled: false, note: 'no proposals array' };
  for (const x of props) if (x && x.id) put(st, 'dataReview', String(x.id), { ...(st.dataReview[x.id] || {}), id: String(x.id), proposal: x });
  return { handled: true, note: props.length + ' proposals' };
}
