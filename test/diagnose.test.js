const test = require('node:test');
const assert = require('node:assert');
const gemini = require('../src/gemini');
const { diagnose } = require('../src/diagnose');
const { maskIds } = require('../src/privacy');

// Swap Gemini for a fake per test
function fakeGemini(handler) {
  gemini.enabled = () => Boolean(handler);
  gemini.generateJson = handler || (async () => { throw new Error('should not be called'); });
}

test('rules only (no API key): real Reddit remark gets both fixes', async () => {
  fakeGemini(null);
  const r = await diagnose({ text: 'Rejected: wages exceeds rs15000 but eps service and contribution received and form 15 g assessment year wrongly submitted' });
  assert.deepStrictEqual(r.reason_ids.sort(), ['eps_wage_ceiling', 'form_15g']);
  assert.strictEqual(r.source, 'rules');
  assert.ok(r.plan.problems[0].steps.length > 0, 'steps come from playbook');
});

test('rules only: vague message asks a human to look', async () => {
  fakeGemini(null);
  const r = await diagnose({ text: 'my pf is not coming please help' });
  assert.strictEqual(r.needs_human, true);
});

test('gemini: invented ids are dropped, real ones kept', async () => {
  fakeGemini(async () => ({ reason_ids: ['made_up_rule', 'name_mismatch'], confidence: 'high', summary: 'Name differs from Aadhaar' }));
  const r = await diagnose({ text: 'mera naam aadhaar se match nahi ho raha, claim reject ho gaya' });
  assert.deepStrictEqual(r.reason_ids, ['name_mismatch']);
  assert.strictEqual(r.needs_human, false);
  assert.strictEqual(r.source, 'gemini');
});

test('gemini: fix steps always come from playbook, never from AI', async () => {
  fakeGemini(async () => ({ reason_ids: ['cheque_image'], confidence: 'high', steps: ['pay an agent 5000'] }));
  const r = await diagnose({ text: 'cheque photo problem' });
  const allSteps = r.plan.problems.flatMap((p) => p.steps).join(' ');
  assert.ok(!allSteps.includes('agent'), 'AI-written steps must not leak into the plan');
});

test('remark: real EPFO wording kept, user paraphrase dropped', async () => {
  fakeGemini(async () => ({ reason_ids: ['name_mismatch'], confidence: 'high', remark: 'Member name mismatch with Aadhaar' }));
  let r = await diagnose({ text: 'Rejected: Member name mismatch with Aadhaar' });
  assert.strictEqual(r.extracted.remark, 'Member name mismatch with Aadhaar');
  fakeGemini(async () => ({ reason_ids: ['cheque_image'], confidence: 'high', remark: 'cheque ki photo saaf nahi hai' }));
  r = await diagnose({ text: 'cheque ki photo saaf nahi hai' });
  assert.strictEqual(r.extracted.remark, '');
});

test('gemini down: falls back to rules', async () => {
  fakeGemini(async () => { throw new Error('quota exceeded'); });
  const r = await diagnose({ text: 'Date of exit not available' });
  assert.deepStrictEqual(r.reason_ids, ['exit_date']);
  assert.strictEqual(r.source, 'rules-fallback');
});

test('stuck claim includes the escalation ladder', async () => {
  fakeGemini(null);
  const r = await diagnose({ text: 'status says Sent to field office for 40 days' });
  assert.ok(r.plan.escalation.length >= 4);
  assert.strictEqual(r.plan.escalation[1].where, 'epfigms.gov.in');
});

test('Aadhaar / UAN numbers are masked before reaching Gemini', async () => {
  let sent = '';
  fakeGemini(async ({ text }) => { sent = text; return { reason_ids: [], confidence: 'low' }; });
  await diagnose({ text: 'My UAN 100123456789 and aadhaar 1234 5678 9012 rejected on 12-03-2026 for 50000' });
  assert.ok(!sent.includes('100123456789'));
  assert.ok(!sent.includes('1234 5678 9012'));
  assert.ok(sent.includes('6789') && sent.includes('9012'), 'last 4 digits kept');
  assert.ok(sent.includes('12-03-2026') && sent.includes('50000'), 'dates and amounts untouched');
});

// Fake translator: prefixes every string, keeps structure (optionally breaks it)
function fakeTranslate(prefix, mutate) {
  const walk = (v) => (Array.isArray(v) ? v.map(walk) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : typeof v === 'string' ? `${prefix}${v}` : v);
  return async ({ system, text }) => {
    if (system.includes('Translate')) { const out = walk(JSON.parse(text)); return mutate ? mutate(out) : out; }
    return { reason_ids: ['bank_details'], confidence: 'high', summary: 'Bank account closed' };
  };
}

test('plan is translated when user picks Tamil; ids and numbers stay', async () => {
  fakeGemini(fakeTranslate('த '));
  const r = await diagnose({ text: 'bank account closed', lang: 'ta' });
  assert.strictEqual(r.plan.summary, 'த Bank account closed');
  assert.ok(r.plan.problems[0].steps[0].startsWith('த '));
  assert.strictEqual(r.plan.problems[0].id, 'bank_details', 'ids never translated');
  assert.strictEqual(typeof r.plan.problems[0].typical_days, 'number');
});

test('stray Urdu words are stripped from Hindi', async () => {
  fakeGemini(fakeTranslate('اگر अगर '));
  const r = await diagnose({ text: 'bank account closed', lang: 'hi' });
  const all = JSON.stringify(r.plan);
  assert.ok(!/[؀-ۿ]/.test(all), 'no Arabic-script text left');
  assert.ok(r.plan.problems[0].steps[0].startsWith('अगर '));
});

test('translation that drops a step falls back to English', async () => {
  fakeGemini(fakeTranslate('हि ', (out) => { out.problems[0].steps.pop(); return out; }));
  const r = await diagnose({ text: 'bank account closed', lang: 'hi' });
  assert.ok(!r.plan.problems[0].steps[0].startsWith('हि '), 'English kept');
  const { byId } = require('../src/playbook');
  assert.strictEqual(r.plan.problems[0].steps.length, byId.bank_details.steps.length);
});

test('maskIds leaves short numbers alone', () => {
  assert.strictEqual(maskIds('Rs 15000 on 2026-03-12'), 'Rs 15000 on 2026-03-12');
});
