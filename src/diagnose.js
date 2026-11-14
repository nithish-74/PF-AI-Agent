// Core of the agent: turn whatever the user sent (text, voice-note transcript,
// screenshot) into a diagnosis + fix plan.
//
// Safety rule: the AI only CLASSIFIES and TRANSLATES. Fix steps always come
// from the playbook, so the AI can never invent an EPFO rule.
const { reasons, byId, ladder, matchRules } = require('./playbook');
const { maskIds } = require('./privacy');
const gemini = require('./gemini');

const LANGS = { en: 'English', hi: 'Hindi', ta: 'Tamil', te: 'Telugu', kn: 'Kannada', ml: 'Malayalam', mr: 'Marathi', bn: 'Bengali' };

const SYSTEM = `You help Indian employees whose EPF (provident fund) claim was rejected or is stuck.
Read the user's message and/or screenshot (it may be in any Indian language or mixed, e.g. Hinglish or Tanglish).
Pick which of these known problems apply. Use ONLY these ids:
${reasons.map((r) => `- ${r.id}: ${r.title}`).join('\n')}

Reply with JSON only:
{
  "reason_ids": [ids from the list, most likely first, max 3],
  "confidence": "high" | "medium" | "low",
  "remark": "the official EPFO rejection wording, copied exactly, ONLY if the user pasted it or it is visible in the screenshot (it is usually English, e.g. 'Member name mismatch with Aadhaar'); never the user's own description; else empty",
  "claim_id": "claim/reference id if visible, else empty",
  "claim_type": "final_settlement" | "partial_withdrawal" | "pension" | "transfer" | "unknown",
  "filed_date": "YYYY-MM-DD if known, else empty",
  "summary": "one sentence describing the user's situation",
  "follow_up_question": "ONE short question to ask if confidence is low, else empty"
}
Never give advice yourself. Never invent ids. If nothing fits, return an empty reason_ids list.`;

// EPFO remarks are formal English ("Member name mismatch with Aadhaar").
// Reject non-Latin script and everyday Hinglish/Tanglish words.
const CHAT_WORDS = /\b(hai|hain|nahi|nahin|ki|ka|ke|ko|ho|gaya|gayi|mera|meri|aur|bhi|kya|kar|raha|rahi|saaf|illa|illai|aachu|enna|romba|naan|ennoda)\b/i;
function looksOfficial(remark) {
  if (typeof remark !== 'string' || !remark.trim()) return false;
  if (/[^\x00-\x7F₹–—’“”]/.test(remark)) return false;
  if (CHAT_WORDS.test(remark)) return false;
  return matchRules(remark).length > 0;
}

async function classify({ text, image }) {
  const ruleIds = matchRules(text);
  const base = { reason_ids: ruleIds, confidence: ruleIds.length ? 'medium' : 'low', remark: '', claim_id: '', claim_type: 'unknown', filed_date: '', summary: '', follow_up_question: '', source: 'rules' };

  if (!gemini.enabled()) return base;

  try {
    const ai = await gemini.generateJson({
      system: SYSTEM,
      text: maskIds(text || '(no text, see screenshot)'),
      image,
    });
    // Keep only ids that really exist in our playbook
    const ids = (ai.reason_ids || []).filter((id) => byId[id]);
    // The remark goes into formal letters, so keep it only if it reads like real
    // EPFO wording (matches a known phrase), not the user's own Hinglish.
    const remark = looksOfficial(ai.remark) ? ai.remark.trim().slice(0, 300) : '';
    // If AI found nothing but rules did, trust rules
    return { ...base, ...ai, remark, reason_ids: ids.length ? ids : ruleIds, source: 'gemini' };
  } catch (err) {
    console.error('Gemini failed, using rules only:', err.message);
    return { ...base, source: 'rules-fallback' };
  }
}

// None of our languages use Arabic script, but the model sometimes slips an
// Urdu word into Hindi ("اگر अगर"). Strip any such runs.
const FOREIGN_SCRIPT = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]+/g;
function cleanScript(s) {
  return typeof s === 'string' ? s.replace(FOREIGN_SCRIPT, '').replace(/\s{2,}/g, ' ').trim() : s;
}

// Take only the translated words; keep the structure, ids and numbers of the
// original. If the translation dropped or added items, fall back to English.
function mergeTranslation(orig, tr) {
  if (Array.isArray(orig)) {
    if (!Array.isArray(tr) || tr.length !== orig.length) throw new Error('translation changed a list');
    return orig.map((o, i) => mergeTranslation(o, tr[i]));
  }
  if (orig && typeof orig === 'object') {
    if (!tr || typeof tr !== 'object') throw new Error('translation changed the structure');
    const out = {};
    for (const [k, v] of Object.entries(orig)) {
      out[k] = ['id', 'step', 'after_days', 'typical_days', 'needs_check', 'where'].includes(k) ? v : mergeTranslation(v, tr[k]);
    }
    return out;
  }
  if (typeof orig === 'string') {
    const t = cleanScript(tr);
    return typeof t === 'string' && t ? t : orig;
  }
  return orig;
}

// Translate the fix plan into the user's language (playbook stays the source of truth).
async function translatePlan(plan, lang) {
  if (lang === 'en' || !LANGS[lang] || !gemini.enabled()) return plan;
  try {
    const tr = await gemini.generateJson({
      system: `Translate every string value in this JSON into simple, friendly ${LANGS[lang]} that an elderly person can understand. Write only in ${LANGS[lang]} script (no Urdu or other scripts). Keep website names, form names (Form 19, Form 31, Form 15G), UAN, EPFO, KYC and numbers in English. Keep the exact same JSON structure, keys and number of items. Reply with JSON only.`,
      text: JSON.stringify(plan),
    });
    return mergeTranslation(plan, tr);
  } catch (err) {
    console.error('Translation failed, sending English:', err.message);
    return plan;
  }
}

function buildPlan(c) {
  const problems = c.reason_ids.map((id) => {
    const r = byId[id];
    return { id: r.id, title: r.title, explanation: r.plain, who_fixes: r.who_fixes, steps: r.steps, documents: r.documents, typical_days: r.typical_days, needs_check: Boolean(r.verify) };
  });
  const needsEscalation = c.reason_ids.some((id) => byId[id].escalate);
  return {
    summary: c.summary,
    problems,
    escalation: needsEscalation ? ladder.map((s) => ({ step: s.step, name: s.name, after_days: s.after_days, action: s.action, where: s.where })) : [],
    follow_up_question: c.follow_up_question,
  };
}

async function diagnose({ text, image, lang = 'en' }) {
  const c = await classify({ text, image });
  const needsHuman = c.reason_ids.length === 0 || c.confidence === 'low';
  const plan = await translatePlan(buildPlan(c), lang);
  return {
    needs_human: needsHuman,
    confidence: c.confidence,
    source: c.source,
    extracted: { remark: c.remark, claim_id: c.claim_id, claim_type: c.claim_type, filed_date: c.filed_date },
    reason_ids: c.reason_ids,
    plan,
  };
}

module.exports = { diagnose, classify, buildPlan, translatePlan, cleanScript, LANGS };
