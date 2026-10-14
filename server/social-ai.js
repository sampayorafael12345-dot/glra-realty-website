// =============================================================================
// GLRA SOCIAL — "Write with AI" and "Suggest a reply"
// =============================================================================
// Uses the website chatbot's AI set-up (server/chatbot.js): GEMINI_API_KEY
// and/or GROQ_API_KEY, PRIMARY_LLM to choose which goes first. With neither
// set, the buttons answer "AI writing is not set up" and nothing else changes.
//
// What the AI writes is ALWAYS returned as editable text for the composer or
// the reply box. Nothing here saves, submits, publishes or sends anything:
// a person edits it, and an approver still has to approve it.
//
// SOCIAL_LLM_BASE (localhost only) points the calls at the test kit's stub.
// =============================================================================
'use strict';
const { env, localOverride, scrub } = require('./meta-graph');

const TONES = {
  professional: 'Professional and clear. Plain English, confident, no hype, no exclamation marks overload.',
  warm_taglish: 'Warm and friendly Taglish (natural Filipino-English mix used by Metro Manila brokers), conversational, respectful ("po" where natural).',
  luxury: 'Refined luxury real-estate voice: calm, elegant, specific about finishes, views and address prestige. No cliches like "dream home".',
  short: 'Very short and punchy: at most 2 short sentences plus the call to action.'
};
const TONE_KEYS = Object.keys(TONES);

function configured() { return !!(localOverride('SOCIAL_LLM_BASE') || env('GEMINI_API_KEY') || env('GROQ_API_KEY')); }

async function callStub(system, prompt) {
  const r = await fetch(localOverride('SOCIAL_LLM_BASE') + '/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'stub', messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) { const e = new Error('AI service answered ' + r.status); e.status = r.status; throw e; }
  const j = await r.json();
  return { text: j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content };
}

async function llm(system, prompt) {
  if (!configured()) { const e = new Error('AI writing is not set up: add GEMINI_API_KEY or GROQ_API_KEY in Render (the same keys the website chat uses).'); e.code = 'no_ai'; throw e; }
  if (localOverride('SOCIAL_LLM_BASE')) return String((await callStub(system, prompt)).text || '').trim();
  const { callGemini, callGroq } = require('./chatbot');
  const hasG = !!env('GEMINI_API_KEY'), hasQ = !!env('GROQ_API_KEY');
  const order = env('PRIMARY_LLM') === 'groq' ? [hasQ && 'groq', hasG && 'gemini'] : [hasG && 'gemini', hasQ && 'groq'];
  let lastErr = null;
  for (const p of order.filter(Boolean)) {
    try {
      const r = p === 'gemini'
        ? await callGemini({ apiKey: env('GEMINI_API_KEY'), systemPrompt: system, history: [], message: prompt })
        : await callGroq({ apiKey: env('GROQ_API_KEY'), systemPrompt: system, history: [], message: prompt });
      if (r && r.text) return String(r.text).trim();
    } catch (e) { lastErr = e; }
  }
  const e = new Error('The AI service did not answer' + (lastErr ? ': ' + scrub(lastErr.message).slice(0, 160) : ''));
  e.code = 'ai_failed';
  throw e;
}

// Pulls the first {...} block out of a model answer (models like to add prose).
function parseJson(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}
const tidy = (s, max) => String(s == null ? '' : s).replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);

const SYSTEM = `You write social media posts for GLRA Realty, a licensed real estate brokerage in Metro Manila (broker: Catherine SB Sampayo).
Rules you never break:
- Use ONLY the facts given. Never invent a price, size, amenity, discount, deadline or availability.
- No promises of returns or appreciation, no "guaranteed", no pressure tactics.
- Do not include phone numbers or emails unless they are in the facts.
- Facebook text may be longer (up to ~120 words) and may include the link given.
- Instagram text: no clickable links (say "link in bio" instead), at most 2200 characters, and at most 12 relevant hashtags at the end.
Answer with JSON only: {"facebook":"...","instagram":"...","hashtags":["#..."]}`;

async function writeCaption({ brief, tone, facts, pageName }) {
  const t = TONE_KEYS.includes(tone) ? tone : 'professional';
  const prompt = `Tone: ${TONES[t]}
Posting as: ${pageName || 'GLRA Realty'}
What the post is about (from the team): ${tidy(brief, 1500) || '(no brief; use the facts)'}
Facts you may use:
${tidy(facts, 2500) || '(none)'}
Write one Facebook version and one Instagram version.`;
  const text = await llm(SYSTEM, prompt);
  const j = parseJson(text);
  if (j && (j.facebook || j.instagram)) {
    const tags = (Array.isArray(j.hashtags) ? j.hashtags : []).map(h => '#' + String(h).replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')).filter(h => h.length > 1).slice(0, 30);
    return { facebook: tidy(j.facebook || j.instagram, 5000), instagram: tidy(j.instagram || j.facebook, 2200), hashtags: tags, tone: t };
  }
  return { facebook: tidy(text, 5000), instagram: tidy(text, 2200), hashtags: [], tone: t };
}

const REPLY_SYSTEM = `You draft replies for GLRA Realty's Facebook Page / Instagram account inbox. A staff member will read and edit your draft before anyone approves and sends it.
Rules: answer only from the conversation and the office's saved answers given; never invent prices, availability or schedules (offer to check instead); be brief (1-3 sentences), polite and helpful; for a viewing, ask for a preferred day and time; never ask for sensitive data beyond a mobile number when needed; match the language the customer used (English, Filipino or Taglish).
Answer with the reply text only, no quotes.`;
async function suggestReply({ thread, savedReplies, tone, pageName }) {
  const t = TONE_KEYS.includes(tone) ? tone : 'warm_taglish';
  const convo = (thread || []).slice(-8).map(m => `${m.own ? 'Page' : 'Customer'}: ${tidy(m.text, 600)}`).join('\n');
  const saved = (savedReplies || []).slice(0, 12).map(r => `- ${tidy(r.name, 80)}: ${tidy(r.text, 400)}`).join('\n');
  const prompt = `Tone: ${TONES[t]}
Page: ${pageName || 'GLRA Realty'}
Office's saved answers:
${saved || '(none)'}
Conversation (latest last):
${convo || '(empty)'}
Draft the Page's next reply.`;
  return { text: tidy(await llm(REPLY_SYSTEM, prompt), 1900).replace(/^"|"$/g, ''), tone: t };
}

module.exports = { configured, writeCaption, suggestReply, TONE_KEYS, parseJson };
