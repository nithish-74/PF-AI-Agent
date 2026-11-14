// Day 3: turn a diagnosis + the user's details into ready-to-send letters
// (EPFiGMS grievance, CPGRAMS, RTI, email to employer HR).
//
// Rules:
//  - Letters are filled from playbook/templates.json on OUR side. If the user
//    wants a translated copy, only the blank template (with {placeholders}) is
//    sent to Gemini, never their name, UAN or claim details.
//  - Anything we don't know stays as a visible blank like [Your mobile number]
//    and is listed in `missing`, so the app can ask for it.
//  - The letter only says KYC is verified if the user confirmed it.
const { byId, templates, ladder } = require('./playbook');
const { timeline, parseDate, formatDate } = require('./escalation');
const gemini = require('./gemini');
const { LANGS } = require('./diagnose');

const LABELS = {
  name: 'Your full name (as on Aadhaar)',
  uan: 'Your UAN',
  mobile: 'Your mobile number',
  address: 'Your postal address',
  claim_id: 'Claim ID',
  filed_date: 'Date the claim was filed',
  grievance_no: 'EPFiGMS grievance number',
  grievance_date: 'Date of EPFiGMS grievance',
  regional_office: 'EPFO regional office (city)',
  company: 'Company name',
  exit_date: 'Date you left the company',
  employee_id: 'Employee ID',
  remark: 'Rejection reason shown by EPFO',
  employer_action: 'What the employer must do',
};

const CLAIM_TYPES = {
  final_settlement: 'final PF settlement (Form 19)',
  partial_withdrawal: 'partial withdrawal (Form 31)',
  pension: 'pension withdrawal (Form 10C)',
  transfer: 'PF transfer (Form 13)',
};

const ESCALATION_KEYS = ['epfigms', 'cpgrams', 'rti'];

function placeholders(body) {
  return [...new Set([...body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))];
}

function fill(body, values) {
  const missing = [];
  const text = body.replace(/\{(\w+)\}/g, (_, key) => {
    const v = values[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
    if (v === '') return ''; // intentionally empty (e.g. kyc_sentence)
    if (!missing.includes(key)) missing.push(key);
    return `[${LABELS[key] || key}]`;
  });
  return { text: text.replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' '), missing };
}

function niceDate(s) {
  const d = parseDate(s);
  return d ? formatDate(d) : s || undefined;
}

// Build every value the templates can use.
function buildValues(diagnosis, details, today) {
  const ex = diagnosis.extracted || {};
  const reasonIds = diagnosis.reason_ids || [];
  const reasons = reasonIds.map((id) => byId[id]).filter(Boolean);
  const remark = details.remark || ex.remark || '';
  const filedDate = details.filed_date || ex.filed_date || '';
  const tl = timeline(filedDate, today);
  const days = tl ? tl.days_since_filed : null;

  let statusShort, statusSentence;
  if (remark) {
    statusShort = 'rejected';
    statusSentence = `It was rejected with the remark: "${remark}".`;
  } else if (days !== null) {
    statusShort = `pending for ${days} days`;
    statusSentence = days > 20
      ? `It has been pending for ${days} days, beyond the 20-day settlement period.`
      : `It has been pending for ${days} days.`;
  } else {
    statusShort = 'pending';
    statusSentence = 'It has not been settled yet.';
  }

  const fixable = reasons.filter((r) => !r.escalate);
  const parts = [];
  if (fixable.length) parts.push(`As per my understanding, the issue relates to: ${fixable.map((r) => r.title).join('; ')}.`);
  if (reasons.some((r) => r.escalate) || !reasons.length) parts.push('No specific deficiency has been communicated to me so far.');

  const employerActions = reasons.map((r) => r.employer_action).filter(Boolean);
  const claimType = details.claim_type || ex.claim_type;

  return {
    values: {
      name: details.name,
      uan: details.uan,
      mobile: details.mobile,
      address: details.address,
      company: details.company,
      employee_id: details.employee_id,
      regional_office: details.regional_office,
      grievance_no: details.grievance_no,
      claim_id: details.claim_id || ex.claim_id || undefined,
      claim_type: CLAIM_TYPES[claimType] || 'PF',
      filed_date: niceDate(filedDate),
      grievance_date: niceDate(details.grievance_date),
      exit_date: niceDate(details.exit_date),
      remark: remark || undefined,
      status_short: statusShort,
      status_sentence: statusSentence,
      problem_sentence: parts.join(' '),
      kyc_sentence: details.kyc_verified === true ? 'All my KYC details (Aadhaar, PAN and bank) are verified on the Member Portal. ' : '',
      employer_action: employerActions.length ? employerActions.join('; and ') : undefined,
      today: formatDate(parseDate(today)),
    },
    timeline: tl,
    reasons,
    employerActions,
  };
}

// Which letters make sense for this diagnosis.
// `stuck` forces the escalation letters, e.g. a claim that was fixed and
// re-filed but is again pending past 20 days.
function pickLetters(reasons, employerActions, tl, forceStuck) {
  const keys = [];
  if (employerActions.length) keys.push('employer_email');
  const stuck = forceStuck || reasons.some((r) => r.escalate) || (!reasons.length && tl && tl.days_since_filed >= 20);
  if (stuck) keys.push(...ESCALATION_KEYS);
  return keys;
}

const translationCache = new Map();

// Translate a blank template; placeholders must survive or we fall back.
async function translateTemplate(key, lang) {
  if (lang === 'en' || !LANGS[lang] || !gemini.enabled()) return null;
  const cacheKey = `${key}:${lang}`;
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);
  const body = templates[key].body;
  try {
    const out = await gemini.generateJson({
      system: `Translate this letter template into simple, polite ${LANGS[lang]}. Keep every {placeholder} exactly as written, in curly braces, untranslated. Keep EPFO, UAN, KYC, CPGRAMS, RTI, EPFiGMS, form names and section numbers in English. Reply with JSON only: {"body": "..."}`,
      text: body,
    });
    const ok = out && typeof out.body === 'string' && placeholders(body).every((p) => out.body.includes(`{${p}}`));
    const result = ok ? out.body : null;
    if (!ok) console.error(`Translation of ${key} dropped placeholders, keeping English only`);
    translationCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`Letter translation failed (${key}):`, err.message);
    return null;
  }
}

/**
 * @param {object} opts
 * @param {object} opts.diagnosis  result of diagnose()
 * @param {object} [opts.details]  name, uan, mobile, address, company, employee_id, exit_date,
 *                                 claim_id, claim_type, filed_date, regional_office,
 *                                 grievance_no, grievance_date, remark, kyc_verified
 * @param {Date|string} [opts.today]
 * @param {string} [opts.lang]     also return a translated copy for the family to read
 * @param {string[]} [opts.only]   force a specific set of letters
 */
async function generateLetters({ diagnosis, details: raw = {}, today = new Date(), lang = 'en', only, stuck = false } = {}) {
  const details = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
  const { values, timeline: tl, reasons, employerActions } = buildValues(diagnosis, details, today);
  const keys = (only || pickLetters(reasons, employerActions, tl, stuck)).filter((k) => templates[k]);
  const ladderByTemplate = Object.fromEntries(ladder.filter((s) => s.template).map((s) => [s.template, s]));

  const letters = [];
  for (const key of keys) {
    const t = templates[key];
    const { text, missing } = fill(t.body, values);
    const step = ladderByTemplate[key];
    const stepTl = step && tl ? tl.steps.find((s) => s.step === step.step) : null;
    const letter = {
      key,
      title: t.title,
      where: step ? step.where : 'Email to your employer\'s HR',
      reply_expected_in_days: step ? step.response_days || null : 7,
      // "wait" = too early to send; we tell the user the date it becomes useful
      status: stepTl && !stepTl.is_due ? 'wait' : 'ready',
      send_on: stepTl ? stepTl.due_on : null,
      missing: missing.map((k) => ({ key: k, label: LABELS[k] || k })),
      text,
    };
    if (key === 'cpgrams' || key === 'rti') letter.note = 'Send this only after your EPFiGMS grievance has had no reply for 15 days. Quote its number.';
    if (key === 'rti') letter.note += ' RTI fee is ₹10, paid online at rtionline.gov.in.';

    const translated = await translateTemplate(key, lang);
    if (translated) {
      letter.lang = lang;
      letter.text_translated = fill(translated, values).text;
    }
    letters.push(letter);
  }

  const checks = [];
  if (details.kyc_verified !== true && keys.includes('epfigms')) {
    checks.push('Before sending: open Member Portal → Manage → KYC and check Aadhaar, PAN and Bank all say "Verified". If yes, tell us and we will add that line to the letter.');
  }
  checks.push('Never write your full Aadhaar number in any letter.');

  const missingAll = [...new Map(letters.flatMap((l) => l.missing).map((m) => [m.key, m])).values()];
  return { letters, missing: missingAll, checks, timeline: tl };
}

module.exports = { generateLetters, fill, placeholders, LABELS };
