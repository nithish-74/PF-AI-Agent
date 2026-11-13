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

test('plan is translated when user picks Tamil', async () => {
  let calls = 0;
  fakeGemini(async ({ system }) => {
    calls++;
    if (system.includes('Translate')) return { summary: 'தமிழ்', problems: [], escalation: [], follow_up_question: '' };
    return { reason_ids: ['bank_details'], confidence: 'high' };
  });
  const r = await diagnose({ text: 'bank account closed', lang: 'ta' });
  assert.strictEqual(calls, 2);
  assert.strictEqual(r.plan.summary, 'தமிழ்');
});

test('maskIds leaves short numbers alone', () => {
  assert.strictEqual(maskIds('Rs 15000 on 2026-03-12'), 'Rs 15000 on 2026-03-12');
});
