// The chat agent. It talks with the user one message at a time, asks
// questions, answers follow-ups, and decides when to show fix steps,
// letters or a "save my case" card.
//
// Safety rules (same as the rest of the app):
//  - The agent may only use facts from the playbook below. Fix steps shown
//    as cards always come from the playbook, never from the model.
//  - ID numbers are masked before anything is sent to Gemini.
//  - Personal details for letters are collected by a form on our side, not
//    through the model.
const { reasons, byId, ladder } = require('./playbook');
const { buildPlan, translatePlan, cleanScript, classify, LANGS } = require('./diagnose');
const { maskIds } = require('./privacy');
const gemini = require('./gemini');

const KNOWLEDGE = reasons.map((r) => [
  `### ${r.id}: ${r.title}`,
  `Meaning: ${r.plain}`,
  `Who fixes it: ${r.who_fixes}`,
  `Steps:\n${r.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`,
  `Documents: ${r.documents.length ? r.documents.join(', ') : 'none'}`,
  `Usually takes: about ${r.typical_days} days`,
  r.employer_action ? `What to ask the employer: ${r.employer_action}` : '',
  r.verify ? 'Note: EPFO rules here changed recently; tell the user to confirm on the EPFO portal.' : '',
].filter(Boolean).join('\n')).join('\n\n');

const LADDER = ladder.map((s) => `- From day ${s.after_days}: ${s.name}. ${s.action} (${s.where})`).join('\n');

const { basics } = require('../playbook/basics.json');
const BASICS = basics.map((b) => `- ${b.q}: ${b.a}`).join('\n');

const SHOW = ['none', 'fix', 'letters', 'save_case', 'human'];

function systemPrompt({ lang, forWhom, known }) {
  return `You are PF Rescue, a kind, patient helper on a website for people in India whose EPF (PF) claim was rejected or is stuck. Many users are elderly, or are helping a parent. Talk like a friendly person at a help desk, not like a robot.

HOW TO TALK
- Reply ONLY in ${LANGS[lang] || 'English'}, in very simple words. Keep EPFO, UAN, KYC, PF and form names (Form 19, Form 31, Form 10C, Form 15G) in English.
- Be short: at most 4 short sentences. One idea at a time.
- If you need information, ask exactly ONE question (for example: what does the SMS or portal say? when was the claim filed? did they leave the job? is the UAN linked to Aadhaar?).
- ${forWhom === 'family' ? 'The user is helping a family member (often a parent). Say "your father/mother" or "the PF member", not "you", when talking about the PF account.' : 'If the PF belongs to someone else (e.g. a parent), adapt and talk about "the PF member".'}
- Never ask for, and never repeat, an Aadhaar number, password or OTP. If the user shares one, gently tell them never to share it.

WHAT YOU MAY SAY
- Use ONLY facts from KNOWLEDGE, PORTAL BASICS and ESCALATION below. Never invent EPFO rules, deadlines, fees, phone numbers or website names.
- If a question is outside this knowledge, say honestly you are not sure and offer a real person (set show to "human").
- Do not list all fix steps yourself. When you know the problem, explain in 1–2 sentences what went wrong and who has to fix it, then set show to "fix" — the website shows the exact steps as a checklist under your message.
- When a letter is needed (the employer must act, or the claim is stuck 20+ days with no reply), say so and set show to "letters" — the website collects details safely and writes the letters.
- After the user has a plan, offer to save the case for reminders (show "save_case").

KNOWN SO FAR
${known}

KNOWLEDGE (problem id: details)
${KNOWLEDGE}

PORTAL BASICS (everyday how-to answers)
${BASICS}

ESCALATION (if EPFO does not settle a claim)
${LADDER}

Reply with JSON only:
{
  "reply": "your message to the user",
  "reason_ids": ["problem ids from KNOWLEDGE that apply, most likely first, max 3; [] if not known yet"],
  "show": "none" | "fix" | "letters" | "save_case" | "human",
  "quick_replies": ["up to 3 very short answers the user might tap next, in ${LANGS[lang] || 'English'}"],
  "extracted": { "remark": "official EPFO rejection wording if the user pasted it or it is in a photo, else empty", "claim_type": "final_settlement|partial_withdrawal|pension|transfer|unknown", "filed_date": "YYYY-MM-DD if the user said it, else empty" }
}`;
}

function describeKnown(state) {
  const lines = [];
  if (state.reason_ids.length) lines.push(`Problems already identified: ${state.reason_ids.join(', ')} (fix steps already shown: ${state.shown_fix.join(', ') || 'none'})`);
  if (state.extracted.filed_date) lines.push(`Claim filed on: ${state.extracted.filed_date}`);
  if (state.extracted.remark) lines.push(`EPFO remark: ${state.extracted.remark}`);
  if (state.has_details) lines.push('The user has already filled in their details for letters.');
  if (state.case_saved) lines.push('The case is already saved for reminders.');
  return lines.join('\n') || 'Nothing yet — this is the start of the conversation.';
}

function cleanState(s = {}) {
  const ids = (v) => (Array.isArray(v) ? [...new Set(v.filter((id) => typeof id === 'string' && byId[id]))].slice(0, 3) : []);
  const ex = s.extracted || {};
  return {
    reason_ids: ids(s.reason_ids),
    shown_fix: ids(s.shown_fix),
    extracted: {
      remark: typeof ex.remark === 'string' ? ex.remark.slice(0, 300) : '',
      claim_type: typeof ex.claim_type === 'string' ? ex.claim_type : 'unknown',
      filed_date: typeof ex.filed_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ex.filed_date) ? ex.filed_date : '',
    },
    has_details: Boolean(s.has_details),
    case_saved: Boolean(s.case_saved),
  };
}

// Keep the last few turns, text only, with ID numbers masked.
function cleanHistory(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-14)
    .filter((m) => m && (m.role === 'user' || m.role === 'agent') && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ role: m.role, text: maskIds(m.text.slice(0, 2000)) }));
}

function transcript(history) {
  return history.map((m) => `${m.role === 'user' ? 'USER' : 'PF RESCUE'}: ${m.text}`).join('\n');
}

const str = (v, max) => (typeof v === 'string' ? cleanScript(v).slice(0, max) : '');

// Build the cards the website shows under the agent's message.
async function buildCards({ show, newIds, allIds, lang, state }) {
  const cards = [];
  const fixIds = show === 'fix' ? allIds.filter((id) => !state.shown_fix.includes(id)) : newIds;
  if (fixIds.length) {
    const plan = await translatePlan(buildPlan({ reason_ids: fixIds, summary: '', follow_up_question: '' }), lang);
    cards.push({ type: 'fix', reason_ids: fixIds, problems: plan.problems, escalation: plan.escalation });
  }
  if (show === 'letters') cards.push({ type: 'letters' });
  if (show === 'save_case' && !state.case_saved) cards.push({ type: 'save_case' });
  if (show === 'human') cards.push({ type: 'human' });
  return cards;
}

// Without a key (or when Gemini is down) we still answer, using keyword rules.
async function fallback({ history, lang, state }) {
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const c = await classify({ text: lastUser ? lastUser.text : '' });
  const newIds = c.reason_ids.filter((id) => !state.reason_ids.includes(id));
  const allIds = [...new Set([...state.reason_ids, ...c.reason_ids])].slice(0, 3);
  const cards = await buildCards({ show: 'none', newIds, allIds, lang, state });
  if (newIds.length && newIds.some((id) => byId[id].escalate || byId[id].employer_action)) cards.push({ type: 'letters' });
  if (!newIds.length) cards.push({ type: 'human' });
  return {
    reply: null,
    reply_key: newIds.length ? 'fb_found' : 'fb_unknown',
    quick_replies: [],
    reason_ids: allIds,
    extracted: state.extracted,
    cards,
    source: 'rules',
  };
}

/**
 * @param {object} opts
 * @param {Array<{role:'user'|'agent', text:string}>} opts.messages  conversation so far (last is the user's)
 * @param {{mimeType:string, base64:string}} [opts.image]  photo attached to the last message
 * @param {string} [opts.lang]
 * @param {'self'|'family'} [opts.forWhom]
 * @param {object} [opts.state]  what the client already knows (reason_ids, shown_fix, extracted, ...)
 */
async function chat({ messages, image, lang = 'en', forWhom = 'self', state: rawState } = {}) {
  lang = LANGS[lang] ? lang : 'en';
  const state = cleanState(rawState);
  const history = cleanHistory(messages);
  if (!history.length || history[history.length - 1].role !== 'user') {
    if (!image) throw Object.assign(new Error('Send a message first.'), { status: 400 });
    history.push({ role: 'user', text: '(sent a photo)' });
  }

  if (!gemini.enabled()) return fallback({ history, lang, state });

  let ai;
  try {
    ai = await gemini.generateJson({
      system: systemPrompt({ lang, forWhom, known: describeKnown(state) }),
      text: `${transcript(history)}\n\nWrite PF RESCUE's next message.`,
      image,
    });
  } catch (err) {
    console.error('Agent: Gemini failed, using rules:', err.message);
    return fallback({ history, lang, state });
  }

  const found = (Array.isArray(ai.reason_ids) ? ai.reason_ids : []).filter((id) => typeof id === 'string' && byId[id]);
  const allIds = [...new Set([...state.reason_ids, ...found])].slice(0, 3);
  const newIds = allIds.filter((id) => !state.reason_ids.includes(id));
  const show = SHOW.includes(ai.show) ? ai.show : 'none';
  const ex = ai.extracted || {};
  const remark = str(ex.remark, 300);
  const extracted = {
    // Only keep a remark that reads like official EPFO English (see diagnose.js)
    remark: remark && /^[\x00-\x7F₹–—’“”]+$/.test(remark) && !/\b(hai|nahi|ki|ka|gaya|mera|aur|illa|aachu)\b/i.test(remark) ? remark : state.extracted.remark,
    claim_type: ['final_settlement', 'partial_withdrawal', 'pension', 'transfer'].includes(ex.claim_type) ? ex.claim_type : state.extracted.claim_type,
    filed_date: typeof ex.filed_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ex.filed_date) ? ex.filed_date : state.extracted.filed_date,
  };

  const reply = str(ai.reply, 1500) || null;
  return {
    reply,
    reply_key: reply ? null : 'fb_error',
    quick_replies: (Array.isArray(ai.quick_replies) ? ai.quick_replies : []).map((q) => str(q, 60)).filter(Boolean).slice(0, 3),
    reason_ids: allIds,
    extracted,
    cards: await buildCards({ show, newIds: show === 'fix' ? [] : newIds, allIds, lang, state }),
    source: 'gemini',
  };
}

module.exports = { chat, systemPrompt, cleanHistory };
