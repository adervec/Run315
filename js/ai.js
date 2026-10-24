// The no-folder transport: ask Claude straight from the browser with the athlete's OWN
// key (device-local, never synced, sent only to api.anthropic.com). Same answers land in
// the same places the cowork folder's replies do, so there is one importer for each.
import { state, save } from './store.js';
import { buildBrief, briefMarkdown } from './derive.js';

const SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.132.1/+esm';
export const MODEL = 'claude-opus-5-5';

export const apiKey = () => String((state.local.ai || {}).key || '').trim();
export function setKey(k) { state.local.ai = { ...(state.local.ai || {}), key: String(k || '').trim() }; save('ai'); }

const COACH = `You are an experienced endurance coach reviewing one athlete's training. You are given the app's own computed brief: training load (CTL/ATL/TSB), best efforts, weekly volume, projections, zones, readiness, durability, stops.

Write a short, direct review in Markdown with exactly these sections:
## Where your fitness is
## What the projections mean
## What to change in the next 4 weeks

Be specific and quantitative, referencing the numbers given. Say plainly when confidence is low or data thin, and what to run to fix it. At most 4 actions, one line each, each with a number. No preamble, no medical advice. Under 400 words.`;

const ANALYST = `You are a meticulous endurance-sport analyst. Answer the athlete's question from the brief below, which holds the app's own computed numbers. Go as deep as the question deserves, cite dates and numbers, show your working where it matters, and say plainly when the data cannot answer it. No medical advice. Markdown.`;

async function complete(system, prompt) {
  const key = apiKey();
  if (!key) throw new Error('No Anthropic API key on this device (Sync & cowork → AI).');
  const { default: Anthropic } = await import(SDK);
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  // Server-side fallback: a declined request is re-run on a fallback model inside the same call.
  const stream = client.beta.messages.stream({
    model: MODEL, max_tokens: 64000, system,
    thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    messages: [{ role: 'user', content: prompt }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined this one' + (msg.stop_details?.explanation ? ': ' + msg.stop_details.explanation : '.'));
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!text) throw new Error('Empty reply (stop reason: ' + msg.stop_reason + ').');
  return text;
}

export const coachReview = () => complete(COACH, briefMarkdown(buildBrief(state)));
export const answer = (q, note) => complete(ANALYST, briefMarkdown(buildBrief(state)) + '\n\n---\nQUESTION: ' + q + (note ? '\nCONTEXT: ' + note : ''));
