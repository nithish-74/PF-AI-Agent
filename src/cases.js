// Day 5: case tracker. A "case" is one stuck/rejected claim we are helping with,
// opened either by the member or by a family member on their behalf.
//
// Access is by a private link: /c/<id>#<token>. The token never appears in
// server logs because it travels in the URL fragment and an HTTP header.
const crypto = require('crypto');
const store = require('./store');
const { byId } = require('./playbook');
const { buildPlan, translatePlan, LANGS } = require('./diagnose');
const { generateLetters } = require('./letters');
const { timeline, parseDate, formatDate, addDays, daysBetween } = require('./escalation');
const { maskIds } = require('./privacy');

const DETAIL_KEYS = ['name', 'uan', 'mobile', 'address', 'company', 'employee_id', 'exit_date', 'claim_id', 'claim_type',
  'filed_date', 'regional_office', 'grievance_no', 'grievance_date', 'remark', 'helper_mobile'];
const CLAIM_TYPES = ['final_settlement', 'partial_withdrawal', 'pension', 'transfer', 'unknown'];
const EVENTS = ['employer_email_sent', 'epfigms_sent', 'cpgrams_sent', 'rti_sent', 'refiled', 'money_received', 'human_reviewed', 'closed'];
const ESCALATION = ['epfigms', 'cpgrams', 'rti'];
const RESPONSE_DAYS = { epfigms: 15, cpgrams: 30, rti: 30 };
const LADDER_DAYS = { epfigms: 20, cpgrams: 35, rti: 50 };

class CaseError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

function cleanDetails(input = {}) {
  const out = {};
  for (const k of DETAIL_KEYS) {
    const v = str(input[k], k === 'address' ? 300 : 200);
    if (v !== undefined) out[k] = v;
  }
  if (out.claim_type && !CLAIM_TYPES.includes(out.claim_type)) delete out.claim_type;
  if (out.uan !== undefined) out.uan = out.uan.replace(/\D/g, '').slice(0, 12);
  if (typeof input.kyc_verified === 'boolean') out.kyc_verified = input.kyc_verified;
  return out;
}

function cleanReasonIds(ids) {
  return Array.isArray(ids) ? [...new Set(ids.filter((id) => typeof id === 'string' && byId[id]))].slice(0, 3) : [];
}

function today() {
  return new Date();
}

async function create(input = {}) {
  const lang = LANGS[input.lang] ? input.lang : 'en';
  const reasonIds = cleanReasonIds(input.reason_ids);
  const ex = input.extracted || {};
  const extracted = {
    remark: str(ex.remark, 500) || '',
    claim_id: str(ex.claim_id, 60) || '',
    claim_type: CLAIM_TYPES.includes(ex.claim_type) ? ex.claim_type : 'unknown',
    filed_date: str(ex.filed_date, 20) || '',
  };
  const summary = str(input.summary, 300) || '';
  const plan = await translatePlan(buildPlan({ reason_ids: reasonIds, summary, follow_up_question: '' }), lang);
  const now = new Date().toISOString();
  const c = {
    id: crypto.randomBytes(6).toString('base64url'),
    token: crypto.randomBytes(18).toString('base64url'),
    created_at: now,
    updated_at: now,
    for_whom: input.for_whom === 'family' ? 'family' : 'self',
    helper_name: str(input.helper_name, 80) || '',
    lang,
    // Masked: we don't need full ID numbers from the free-text description
    problem_text: maskIds(str(input.problem_text, 2000) || ''),
    reason_ids: reasonIds,
    needs_human: Boolean(input.needs_human) || reasonIds.length === 0,
    confidence: ['high', 'medium', 'low'].includes(input.confidence) ? input.confidence : 'low',
    extracted,
    plan,
    details: cleanDetails(input.details),
    steps_done: {},
    events: [],
    status: 'open',
  };
  return store.put(c);
}

function checkToken(c, token) {
  if (!c || typeof token !== 'string') return false;
  const a = Buffer.from(c.token);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function open(id, token) {
  const c = store.get(id);
  if (!checkToken(c, token)) throw new CaseError(404, 'Case not found');
  return c;
}

function lastEvent(c, type) {
  return [...c.events].reverse().find((e) => e.type === type) || null;
}

// After a re-file, the claim is "stuck" again once it passes 20 days.
function isStuck(c, tl) {
  if (c.reason_ids.some((id) => byId[id].escalate)) return true;
  if (lastEvent(c, 'refiled') && tl && tl.days_since_filed >= 20) return true;
  return !c.reason_ids.length && tl && tl.days_since_filed >= 20;
}

function needsRefile(c) {
  return c.reason_ids.some((id) => byId[id].refile) && !lastEvent(c, 'refiled');
}

function hasEmployerAction(c) {
  return c.reason_ids.some((id) => byId[id].employer_action);
}

// What should happen next. `who` = user (shown in the app) or team (you, the founder).
function reminders(c, now = today()) {
  const due = [];
  let upcoming = null;
  if (c.status !== 'open') return { due, upcoming };
  const nowD = parseDate(now);

  if (c.needs_human && !lastEvent(c, 'human_reviewed')) {
    due.push({ who: 'team', type: 'call_user', text: 'AI was not sure about this case. Call or WhatsApp the user and add the right problem.' });
  }

  const tl = timeline(c.details.filed_date || c.extracted.filed_date, now);
  if (!tl) due.push({ who: 'user', type: 'need_filed_date', text: 'Add the date the claim was filed so we can track the deadlines.' });

  if (hasEmployerAction(c) && needsRefile(c)) {
    const sent = lastEvent(c, 'employer_email_sent');
    if (!sent) due.push({ who: 'user', type: 'send_employer_email', text: 'Send the email to your employer\'s HR.' });
    else {
      const chaseOn = addDays(parseDate(sent.date), 7);
      if (nowD >= chaseOn) due.push({ who: 'user', type: 'chase_employer', text: 'HR was emailed 7+ days ago. Call them, or check the portal to see if it is fixed.' });
      else upcoming = { type: 'chase_employer', date: formatDate(chaseOn), text: 'Check with HR if not fixed' };
    }
  }
  if (needsRefile(c)) {
    due.push({ who: 'user', type: 'fix_and_refile', text: 'Finish the fix steps, then file the claim again and tell us the new date.' });
  }

  if (tl && isStuck(c, tl)) {
    const filed = parseDate(c.details.filed_date || c.extracted.filed_date);
    let prevSent = null;
    let prevKey = null;
    for (const key of ESCALATION) {
      const sent = lastEvent(c, `${key}_sent`);
      if (sent) { prevSent = sent; prevKey = key; continue; }
      let dueOn = addDays(filed, LADDER_DAYS[key]);
      if (prevSent) {
        const afterReply = addDays(parseDate(prevSent.date), RESPONSE_DAYS[prevKey]);
        if (afterReply > dueOn) dueOn = afterReply;
      } else if (key !== 'epfigms') {
        // Never skip a step: CPGRAMS/RTI need an EPFiGMS grievance first.
        break;
      }
      if (nowD >= dueOn) due.push({ who: 'user', type: `send_${key}`, text: `Send the ${key === 'epfigms' ? 'EPFiGMS grievance' : key === 'cpgrams' ? 'CPGRAMS complaint' : 'RTI application'} now.` });
      else upcoming = { type: `send_${key}`, date: formatDate(dueOn), text: `Send ${key.toUpperCase()} if there is no reply` };
      break;
    }
    if (!upcoming && !due.some((d) => d.type.startsWith('send_')) && lastEvent(c, 'rti_sent')) {
      const rti = lastEvent(c, 'rti_sent');
      const replyBy = addDays(parseDate(rti.date), 30);
      if (nowD >= replyBy) due.push({ who: 'team', type: 'rti_overdue', text: 'RTI reply is overdue. Help the user file a first appeal or visit the regional office.' });
      else upcoming = { type: 'rti_reply', date: formatDate(replyBy), text: 'RTI reply legally due' };
    }
  }
  return { due, upcoming };
}

async function view(c, now = today()) {
  const tl = timeline(c.details.filed_date || c.extracted.filed_date, now);
  const letters = await generateLetters({
    diagnosis: { reason_ids: c.reason_ids, extracted: c.extracted },
    details: c.details,
    today: now,
    lang: c.lang,
    stuck: Boolean(tl && isStuck(c, tl)),
  });
  const sentKeys = new Set(c.events.map((e) => e.type.replace(/_sent$/, '')));
  for (const l of letters.letters) l.sent = sentKeys.has(l.key);
  const { token, ...rest } = c;
  return {
    ...rest,
    days_open: daysBetween(parseDate(c.created_at.slice(0, 10)), parseDate(now)),
    timeline: tl,
    letters: letters.letters,
    missing: letters.missing,
    checks: letters.checks,
    reminders: reminders(c, now),
  };
}

function update(c, patch = {}, now = today()) {
  if (patch.details) Object.assign(c.details, cleanDetails(patch.details));
  if (typeof patch.helper_name === 'string') c.helper_name = str(patch.helper_name, 80);
  if (patch.step && typeof patch.step.key === 'string' && /^[a-z0-9_]+:\d{1,2}$/.test(patch.step.key)) {
    if (patch.step.done) c.steps_done[patch.step.key] = true;
    else delete c.steps_done[patch.step.key];
  }
  if (patch.reason_ids) {
    // Used by the team after a human review
    const ids = cleanReasonIds(patch.reason_ids);
    if (ids.length) { c.reason_ids = ids; c.needs_human = false; }
  }
  if (patch.event) {
    const e = patch.event;
    if (!EVENTS.includes(e.type)) throw new CaseError(400, 'Unknown event');
    const date = parseDate(e.date) || parseDate(now);
    const ev = { type: e.type, date: date.toISOString().slice(0, 10), at: new Date().toISOString() };
    const note = str(e.note, 500);
    if (note) ev.note = note;
    if (e.type === 'epfigms_sent') {
      const g = str(e.grievance_no, 60);
      if (g) { ev.grievance_no = g; c.details.grievance_no = g; }
      c.details.grievance_date = ev.date;
    }
    if (e.type === 'refiled') {
      c.details.filed_date = ev.date;
      const cid = str(e.claim_id, 60);
      if (cid) { ev.claim_id = cid; c.details.claim_id = cid; }
      delete c.details.remark; // old rejection no longer applies
    }
    if (e.type === 'money_received') {
      const amt = Number(e.amount);
      if (Number.isFinite(amt) && amt > 0) ev.amount = Math.round(amt);
      c.status = 'resolved';
    }
    if (e.type === 'closed') c.status = 'closed';
    if (e.type === 'human_reviewed') c.needs_human = false;
    c.events.push(ev);
  }
  c.updated_at = new Date().toISOString();
  return store.put(c);
}

// After the team re-classifies a case, rebuild its fix steps from the playbook.
async function rebuildPlan(c) {
  const plan = buildPlan({ reason_ids: c.reason_ids, summary: (c.plan && c.plan.summary) || '', follow_up_question: '' });
  c.plan = await translatePlan(plan, c.lang);
  c.steps_done = {};
  return store.put(c);
}

// Team view: every open case, most urgent first.
function queue(now = today()) {
  return store.all()
    .map((c) => ({ c, r: reminders(c, now) }))
    .map(({ c, r }) => ({
      id: c.id,
      created_at: c.created_at,
      status: c.status,
      for_whom: c.for_whom,
      name: c.details.name || '',
      mobile: c.details.helper_mobile || c.details.mobile || '',
      lang: c.lang,
      reason_ids: c.reason_ids,
      needs_human: c.needs_human,
      problem_text: c.problem_text,
      filed_date: c.details.filed_date || c.extracted.filed_date || '',
      amount: (lastEvent(c, 'money_received') || {}).amount || null,
      reminders: r,
    }))
    .sort((a, b) => (b.reminders.due.length - a.reminders.due.length) || b.created_at.localeCompare(a.created_at));
}

module.exports = { create, open, view, update, rebuildPlan, reminders, queue, CaseError, EVENTS };
