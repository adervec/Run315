// Ask & coach: the deep-analysis page. A question asked here is queued for the cowork
// agent, which answers on its next sweep with every per-second stream and the full
// export in front of it -- or, with an Anthropic key on this device, answered now from
// the app's own brief. Coach reviews land here too, from either route.
//
// A question can also be *standing*: asked again every N days, its answers kept, so a
// verdict ("is my decoupling improving?") can be watched move rather than asked once.
import { state, save } from '../store.js';
import { put, remove } from '../merge.js';
import * as cowork from '../cowork.js';
import * as ai from '../ai.js';
import { html, pageHead, md, ago, day, toast, useCss } from '../ui.js';

export const title = 'Ask & coach';

const CSS = `
.ask-form textarea { width: 100%; min-height: 84px; resize: vertical; box-sizing: border-box;
  font-family: var(--body); font-size: 15px; padding: 10px 12px; border: 1.5px solid var(--line);
  border-radius: 2px; background: var(--surface); color: var(--ink); }
.ask-form textarea:focus { border-color: var(--projected); outline: none; }
.ask-form input[type=text] { width: 100%; box-sizing: border-box; margin-top: 8px; }
.ask-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; align-items: center; }
.ask-status { font-size: 14px; color: var(--muted); margin: 0 0 18px; }
.ask-status b { color: var(--ink); font-weight: 600; }
.ask-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.ask-chip { font-family: var(--body); font-size: 13px; text-align: left; line-height: 1.35; cursor: pointer;
  padding: 7px 12px; border-radius: 16px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
.ask-chip:hover { border-color: var(--projected); background: var(--projected-soft); }
.ask-chip:focus-visible { outline: 3px solid var(--projected); outline-offset: 2px; }
.q-item { border-top: 1px solid var(--line); padding: 14px 0; }
.q-item:first-child { border-top: none; padding-top: 0; }
.q-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.q-text { font-weight: 600; font-size: 15px; flex: 1 1 260px; }
.q-meta { font-family: var(--mono); font-size: 11px; color: var(--faint); }
.q-meta.open { color: var(--projected); }
.q-note { font-size: 13px; color: var(--muted); margin: 4px 0 0; }
.q-answer { margin-top: 10px; padding-left: 14px; border-left: 3px solid var(--measured); }
.q-item details summary, .review-old summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.review-old { border-top: 1px solid var(--line); padding: 10px 0; }
.ask-standing-opt { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; font-size: 14px; }
.ask-standing-opt label { display: inline-flex; gap: 6px; align-items: center; min-height: 32px; }
.ask-form .ask-standing-opt input[type=number], .sq-cadence input[type=number] { width: 64px; margin: 0; }
.sq-changed { margin: 10px 0 0; padding: 8px 12px; background: var(--projected-soft); border-left: 3px solid var(--projected); font-size: 14px; }
.sq-changed .eyebrow { margin: 0 0 2px; }
.sq-changed .md p { margin: 0; }
.sq-cadence { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; font-size: 13px; color: var(--muted); }
.sq-cadence label { display: inline-flex; gap: 6px; align-items: center; }
.sq-history { margin-top: 10px; }
.sq-history details { border-top: 1px solid var(--line); padding: 6px 0; }
.sq-history summary { cursor: pointer; font-size: 13px; color: var(--muted); }
.sq-history summary b { font-family: var(--mono); font-size: 11px; font-weight: 400; color: var(--faint); margin-right: 6px; }
`;

// Deep dives worth a whole stream archive: each needs per-second data or a join across
// sources that the dashboard's own numbers do not make.
const SUGGESTED = [
  'Is my aerobic decoupling improving on long runs, controlling for temperature?',
  'Which variables predict my best-feeling runs: sleep, HRV, load, weather?',
  'Where do I lose time on hills, and is it uphill or downhill?',
  'How does my cadence and ground contact change as I fatigue?',
  'Am I running my easy days easy enough?',
  'What does my Strava-only activity add to the training-load picture?',
  'How has my pace at a fixed heart rate moved over the last six months?',
  'Which weeks in the last three months carried the most injury risk, and why?',
  'Given my longest runs and how my pace holds late in them, is my race projection realistic?',
  // These three ask for charts outright: the answer is a trend, and a trend is better seen.
  'Chart my resting HR and HRV over the last 90 days against weekly running minutes: what moves together?',
  'Draw my easy-run pace at a fixed heart rate month by month as a line chart, and tell me what it shows.',
  'Plot long-run decoupling against temperature as a scatter chart: how much of my drift is heat?',
];

// Answers in flight from this page (ids), and whether a review is being written.
const busy = new Set();
let reviewing = false;

const requests = () => Object.values(state.analysisRequests).filter(r => r && r.id)
  .sort((a, b) => String(b.created).localeCompare(String(a.created)));
const everyDays = r => Math.max(1, +r.everyDays || 7);
const reviews = () => Object.values(state.reviews).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

function statusLine() {
  const cw = state.local.cowork?.enabled, key = !!ai.apiKey(), cloud = state.local.cloud?.enabled;
  if (!cw && !key) return html`<p class="ask-status">Nothing on this device answers questions yet.
    ${cloud ? 'Questions you ask here still travel through Drive to a desktop that runs the cowork folder. ' : ''}
    <a class="quiet-link" href="#/sync">Set up the cowork folder or add an API key →</a></p>`;
  return html`<p class="ask-status">
    ${cw ? html`<b>Cowork folder on</b> (${state.local.cowork.folderName || 'folder'}): queued questions are answered on the agent's next sweep, from every stream and the full export.` : ''}
    ${cw && key ? ' ' : ''}
    ${key ? html`<b>API key on this device</b>: “Answer now” asks Claude directly, from the app's own brief.` : ''}
  </p>`;
}

function askPanel() {
  const key = !!ai.apiKey();
  const asked = new Set(requests().map(r => r.q));
  const chips = SUGGESTED.filter(q => !asked.has(q));
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Ask a question</p>
      <p class="panel-note">anything the data could answer</p></div>
    ${statusLine()}
    <form class="ask-form" id="ask-form">
      <label class="eyebrow" for="ask-q" style="display:block;margin-bottom:6px">Question</label>
      <textarea id="ask-q" name="q" required placeholder="e.g. Did my threshold runs get faster at the same heart rate this spring?"></textarea>
      <input type="text" id="ask-note" name="note" placeholder="Context (optional): a niggle, a goal race, what you suspect">
      <div class="ask-standing-opt">
        <label><input type="checkbox" name="standing"> Keep asking this</label>
        <label>every <input type="number" name="every" min="1" max="90" value="7" aria-label="Days between answers"> days</label>
        <span class="dim">— each answer starts with what changed since the last</span>
      </div>
      <div class="ask-actions">
        <button class="btn" type="submit" data-mode="queue">Queue for the cowork agent</button>
        ${key ? html`<button class="btn btn-ghost" type="submit" data-mode="now">Answer now</button>` : ''}
      </div>
    </form>
    ${chips.length ? html`<p class="eyebrow" style="margin:22px 0 10px">Deep dives to try</p>
      <div class="ask-chips">${chips.map(q => html`<button type="button" class="ask-chip" data-suggest="${q}">${q}</button>`)}</div>
      <p class="stat-hint" style="margin-top:10px">One click queues it for the cowork agent${key ? '; “Answer now” on the question asks Claude straight away' : ''}.</p>` : ''}
  </section>`;
}

// The first line of an answer, as plain text, for the compact history.
export function firstLine(text) {
  const line = String(text || '').split('\n').map(l => l.trim()).find(l => l && !l.startsWith('```')) || '';
  const plain = line.replace(/^#+\s*|^[-*]\s+|\*\*|`/g, '').trim();
  return plain.length > 140 ? plain.slice(0, 137) + '…' : plain;
}
// A standing answer leads with what changed (the analysis channel asks for that, in a line):
// lift that line out so it reads first. Only when there is an earlier answer to change from,
// and only when the first line is prose -- a chart, a table or a heading is not a "what changed".
function splitChanged(answer, hasPrevious) {
  const lines = String(answer || '').split('\n'), i = lines.findIndex(l => l.trim());
  if (!hasPrevious || i < 0 || /^(```|\||#)/.test(lines[i].trim())) return [null, answer];
  return [lines[i].trim(), lines.slice(i + 1).join('\n')];
}
function nextDue(r) {
  if (!r.answeredAt) return 'waiting for its first answer';
  const days = Math.ceil((Date.parse(r.answeredAt) + everyDays(r) * 864e5 - Date.now()) / 864e5);
  return days <= 0 ? 'due now' : 'next in ' + days + ' day' + (days === 1 ? '' : 's');
}
// Past answers, newest first, without the one already shown in full above them.
function pastAnswers(r) {
  const h = (r.history || []).filter(x => x && x.answer);
  const last = h[h.length - 1];
  return (last && last.answer === r.answer ? h.slice(0, -1) : h).reverse();
}
function historyList(past) {
  if (!past.length) return '';
  return html`<div class="sq-history"><p class="eyebrow" style="margin:0 0 4px">Earlier answers (${past.length})</p>
    ${past.map(x => html`<details><summary><b>${x.at ? day(x.at) : '--'}</b>${firstLine(x.answer) || 'an answer'}</summary>
      <div class="q-answer review">${md(x.answer)}</div></details>`)}</div>`;
}

function standingItem(r, key) {
  const past = pastAnswers(r), [changed, rest] = splitChanged(r.answer, past.length > 0);
  return html`<div class="q-item">
    <div class="q-head">
      <span class="q-text">${r.q}</span>
      ${busy.has(r.id) ? html`<span class="q-meta open">Claude is answering…</span>`
        : html`<span class="q-meta ${r.answeredAt ? '' : 'open'}">every ${everyDays(r)} days${r.answeredAt ? html` · last ${day(r.answeredAt)}${r.via === 'api' ? ' · API' : ' · cowork'}` : ''} · ${nextDue(r)}</span>`}
      ${key && !busy.has(r.id) ? html`<button class="btn-quiet" data-answer="${r.id}">Answer now</button>` : ''}
      <button class="btn-quiet" data-stop="${r.id}">Stop asking</button>
      <button class="btn-quiet" data-del="${r.id}" aria-label="Delete this question">Delete</button>
    </div>
    ${r.note ? html`<p class="q-note">${r.note}</p>` : ''}
    ${changed ? html`<div class="sq-changed"><p class="eyebrow">What changed</p>${md(changed)}</div>` : ''}
    ${r.answer ? html`<div class="q-answer review">${md(rest)}</div>` : ''}
    <form class="sq-cadence" data-cadence="${r.id}">
      <label>Ask every <input type="number" name="every" min="1" max="90" value="${everyDays(r)}" aria-label="Days between answers"> days</label>
      <button class="btn-quiet" type="submit">Save</button>
    </form>
    ${historyList(past)}
  </div>`;
}

function standingPanel() {
  const rs = requests().filter(r => r.standing), key = !!ai.apiKey();
  if (!rs.length) return '';
  const due = rs.filter(r => nextDue(r) === 'due now' || !r.answeredAt).length;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Standing questions</p>
      <p class="panel-note">${rs.length} asked again on a schedule · ${due} due</p></div>
    ${rs.map(r => standingItem(r, key))}
  </section>`;
}

function questionItem(r, key) {
  const answered = r.status === 'answered' && r.answer;
  const stopped = r.status === 'answered' && !r.answer;   // a standing question stopped before its first answer
  return html`<div class="q-item">
    <div class="q-head">
      <span class="q-text">${r.q}</span>
      ${answered
        ? html`<span class="q-meta">answered ${r.answeredAt ? day(r.answeredAt) : ''}${r.via === 'api' ? ' · API' : ' · cowork'}</span>`
        : busy.has(r.id) ? html`<span class="q-meta open">Claude is answering…</span>`
        : stopped ? html`<span class="q-meta">stopped before an answer</span>`
        : html`<span class="q-meta open">asked ${ago(r.created)} · waiting for the cowork agent</span>`}
      ${!answered && !stopped && key && !busy.has(r.id) ? html`<button class="btn-quiet" data-answer="${r.id}">Answer now</button>` : ''}
      <button class="btn-quiet" data-del="${r.id}" aria-label="Delete this question">Delete</button>
    </div>
    ${r.note ? html`<p class="q-note">${r.note}</p>` : ''}
    ${answered ? html`<div class="q-answer review">${md(r.answer)}</div>` : ''}
    ${historyList(pastAnswers(r))}
  </div>`;
}

function questionsPanel() {
  const rs = requests().filter(r => !r.standing), key = !!ai.apiKey();
  if (!rs.length) return '';
  const open = rs.filter(r => r.status !== 'answered').length;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Your questions</p>
      <p class="panel-note">${rs.length} asked · ${open} waiting</p></div>
    ${rs.map(r => questionItem(r, key))}
  </section>`;
}

function reviewsPanel() {
  const rv = reviews(), key = !!ai.apiKey(), latest = rv[0];
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Coach reviews</p>
      ${latest ? html`<p class="panel-note">latest ${day(latest.created_at)} · ${latest.source === 'api' ? 'API' : 'cowork'}</p>` : ''}</div>
    ${latest ? html`<div class="review">${md(latest.markdown)}</div>` : html`<div class="empty"><p>No review yet. A review reads your
      training load, best efforts, projections, zones and readiness, and ends with at most four changes for the next four weeks.</p></div>`}
    ${rv.slice(1).map(r => html`<details class="review-old"><summary>${day(r.created_at)} · ${r.source === 'api' ? 'API' : 'cowork'}</summary>
      <div class="review">${md(r.markdown)}</div></details>`)}
    <div class="ask-actions">
      ${key ? html`<button class="btn ${latest ? 'btn-ghost' : ''}" data-act="review" ${reviewing ? 'disabled' : ''}>${reviewing ? 'Writing the review…' : 'New review'}</button>`
        : html`<p class="stat-hint" style="margin:0">The cowork agent writes a review each week through the folder's
          <code>coach</code> channel, and it lands here (and on your phone, through Drive).
          For one on demand, add an Anthropic API key on <a class="quiet-link" href="#/sync">Sync &amp; cowork</a>.</p>`}
    </div>
  </section>`;
}

export function render() {
  useCss('ask', CSS);
  return html`<div id="ask-page">
    ${pageHead('Ask & coach', 'Deep analysis of every run, from the per-second streams up')}
    ${askPanel()}
    ${standingPanel()}
    ${questionsPanel()}
    ${reviewsPanel()}
  </div>`;
}

// Re-render only while this page is still the one showing, keeping a half-typed question.
function redraw(el, keepDraft = true) {
  if (!el.querySelector('#ask-page')) return;
  const f = el.querySelector('#ask-form'), draft = keepDraft && f ? [f.q.value, f.note.value, f.standing.checked, f.every.value] : null;
  el.innerHTML = String(render()); mount(el);
  const g = el.querySelector('#ask-form');
  if (draft && g) { g.q.value = draft[0]; g.note.value = draft[1]; g.standing.checked = draft[2]; g.every.value = draft[3]; }
}

async function answerNow(el, id) {
  const rq = state.analysisRequests[id];
  if (!rq || busy.has(id)) return;
  busy.add(id); redraw(el);
  try {
    const answer = await ai.answer(rq.q, rq.note);
    // applyAnswer keeps a standing question's history (and leaves it standing); false when
    // the question was deleted meanwhile.
    if (cowork.applyAnswer(id, answer, 'api')) {
      save('edit');
      toast('Answered.');
    }
  } catch (e) {
    toast((e.message || String(e)) + ' It stays queued for the cowork agent.', 6000);
  } finally { busy.delete(id); redraw(el); }
}

export function mount(el) {
  const form = el.querySelector('#ask-form');
  if (form) form.onsubmit = ev => {
    ev.preventDefault();
    const q = form.q.value.trim(), note = form.note.value.trim();
    if (!q) { toast('Write a question first.'); return; }
    const standing = form.standing.checked, every = Math.round(+form.every.value);
    if (standing && !(every >= 1 && every <= 90)) { toast('Ask again every 1 to 90 days.'); return; }
    const id = cowork.ask(q, note, standing ? { standing: true, everyDays: every } : {});
    const now = ev.submitter?.dataset.mode === 'now';
    if (!now) toast(state.local.cowork?.enabled ? 'Queued: the cowork agent answers on its next sweep.' : 'Queued for the cowork agent.');
    redraw(el, false);
    if (now) answerNow(el, id);
  };
  el.querySelectorAll('[data-suggest]').forEach(b => b.onclick = () => {
    cowork.ask(b.dataset.suggest, '');
    toast('Queued for the cowork agent.');
    redraw(el);
  });
  el.querySelectorAll('[data-answer]').forEach(b => b.onclick = () => answerNow(el, b.dataset.answer));
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const rq = state.analysisRequests[b.dataset.del];
    if (!rq || !confirm('Delete this question' + (rq.answer ? ' and its answer' : '') + '?')) return;
    remove(state, 'analysisRequests', rq.id);
    save('edit');
    redraw(el);
  });
  // Stop: it becomes an ordinary answered question, history and all, and is no longer due.
  el.querySelectorAll('[data-stop]').forEach(b => b.onclick = () => {
    const rq = state.analysisRequests[b.dataset.stop];
    if (!rq) return;
    put(state, 'analysisRequests', rq.id, { ...rq, standing: false, status: 'answered' });
    save('edit');
    toast('Stopped. Its answers stay below.');
    redraw(el);
  });
  el.querySelectorAll('form[data-cadence]').forEach(f => f.onsubmit = ev => {
    ev.preventDefault();
    const rq = state.analysisRequests[f.dataset.cadence], every = Math.round(+f.every.value);
    if (!rq) return;
    if (!(every >= 1 && every <= 90)) { toast('Ask again every 1 to 90 days.'); return; }
    put(state, 'analysisRequests', rq.id, { ...rq, everyDays: every });
    save('edit');
    toast(`Asked every ${every} day${every === 1 ? '' : 's'} from now on.`);
    redraw(el);
  });
  const rev = el.querySelector('[data-act="review"]');
  if (rev) rev.onclick = async () => {
    if (reviewing) return;
    reviewing = true; redraw(el);
    try {
      const markdown = await ai.coachReview();
      const id = 'r' + Date.now().toString(36);
      put(state, 'reviews', id, { id, created_at: new Date().toISOString(), markdown, source: 'api' });
      save('edit');
      toast('New review in.');
    } catch (e) { toast(e.message || String(e), 6000); }
    finally { reviewing = false; redraw(el); }
  };
}
