const test = require('node:test');
const assert = require('node:assert');
const gemini = require('../src/gemini');
const { diagnose } = require('../src/diagnose');
const { generateLetters } = require('../src/letters');
const { timeline } = require('../src/escalation');

function fakeGemini(handler) {
  gemini.enabled = () => Boolean(handler);
  gemini.generateJson = handler || (async () => { throw new Error('should not be called'); });
}

const details = {
  name: 'Ravi Kumar', uan: '100000000001', mobile: '9000000000', address: '12 Sample Street, Chennai',
  company: 'Example Tech', employee_id: 'EX1', exit_date: '2026-06-30', claim_id: 'CLM1',
  claim_type: 'final_settlement', filed_date: '2026-09-01', regional_office: 'Chennai', kyc_verified: true,
};
const TODAY = '2026-11-14';

test('timeline: 74 days after filing, RTI is due and regional office is next', () => {
  const t = timeline('2026-09-01', TODAY);
  assert.strictEqual(t.days_since_filed, 74);
  assert.strictEqual(t.current_step.name, 'RTI application');
  assert.strictEqual(t.next_step.step, 5);
  assert.strictEqual(t.steps[1].due_on, '21-09-2026');
});

test('timeline: unknown or bad date gives null', () => {
  assert.strictEqual(timeline('', TODAY), null);
  assert.strictEqual(timeline('31-02-2026', TODAY), null);
  assert.strictEqual(timeline('01/09/2026', TODAY).days_since_filed, 74, 'DD/MM/YYYY accepted');
});

test('stuck claim: grievance, CPGRAMS and RTI letters fully filled', async () => {
  fakeGemini(null);
  const diagnosis = await diagnose({ text: 'status says sent to field office' });
  const out = await generateLetters({ diagnosis, details: { ...details, grievance_no: 'EPFIGMS/1', grievance_date: '2026-09-25' }, today: TODAY });
  assert.deepStrictEqual(out.letters.map((l) => l.key), ['epfigms', 'cpgrams', 'rti']);
  for (const l of out.letters) {
    assert.ok(!/\{\w+\}/.test(l.text), `${l.key} has no raw placeholders`);
    assert.ok(!l.text.includes('['), `${l.key} has no blanks`);
    assert.strictEqual(l.status, 'ready');
  }
  const g = out.letters[0].text;
  assert.ok(g.includes('Ravi Kumar (UAN 100000000001)'));
  assert.ok(g.includes('final PF settlement (Form 19)'));
  assert.ok(g.includes('pending for 74 days, beyond the 20-day'));
  assert.ok(g.includes('verified on the Member Portal. I request'));
  assert.ok(out.letters[2].text.includes('Date: 14-11-2026'));
  assert.deepStrictEqual(out.missing, []);
});

test('too early: CPGRAMS and RTI say wait, with the date', async () => {
  fakeGemini(null);
  const diagnosis = await diagnose({ text: 'claim under process' });
  const out = await generateLetters({ diagnosis, details: { ...details, filed_date: '2026-10-20' }, today: TODAY });
  const byKey = Object.fromEntries(out.letters.map((l) => [l.key, l]));
  assert.strictEqual(byKey.epfigms.status, 'ready');
  assert.strictEqual(byKey.cpgrams.status, 'wait');
  assert.strictEqual(byKey.cpgrams.send_on, '24-11-2026');
});

test('missing details become visible blanks and are listed', async () => {
  fakeGemini(null);
  const diagnosis = await diagnose({ text: 'sent to field office' });
  const out = await generateLetters({ diagnosis, details: { name: 'Ravi' }, today: TODAY });
  const g = out.letters.find((l) => l.key === 'epfigms');
  assert.ok(g.text.includes('[Your UAN]'));
  assert.ok(out.missing.some((m) => m.key === 'mobile'));
  assert.ok(!g.text.includes('verified on the Member Portal'), 'no KYC claim unless confirmed');
  assert.ok(out.checks[0].includes('KYC'));
});

test('employer problem: HR email with the right action, no grievance yet', async () => {
  fakeGemini(null);
  const diagnosis = await diagnose({ text: 'Rejected: Date of exit not available' });
  const out = await generateLetters({ diagnosis, details, today: TODAY });
  assert.deepStrictEqual(out.letters.map((l) => l.key), ['employer_email']);
  const t = out.letters[0].text;
  assert.ok(t.includes('mark my date of exit'));
  assert.ok(t.includes('until 30-06-2026'));
  // Rules mode can't pull the exact remark out of free text, so the app asks for it
  assert.ok(out.missing.some((m) => m.key === 'remark'));
  const again = await generateLetters({ diagnosis, details: { ...details, remark: 'Date of exit not available' }, today: TODAY });
  assert.ok(again.letters[0].text.includes('"Date of exit not available"'), 'quotes the EPFO remark');
  assert.deepStrictEqual(again.missing, []);
});

test('member-only fix (blurry cheque): no letters, just re-file', async () => {
  fakeGemini(null);
  const diagnosis = await diagnose({ text: 'cheque image not clear' });
  const out = await generateLetters({ diagnosis, details, today: TODAY });
  assert.deepStrictEqual(out.letters, []);
});

test('translation: only the blank template goes to Gemini, never personal data', async () => {
  const sent = [];
  fakeGemini(async ({ system, text }) => {
    sent.push(text);
    if (system.includes('letter template')) return { body: text.replace('Respected Sir/Madam', 'மதிப்பிற்குரிய ஐயா') };
    return { reason_ids: ['stuck_no_reason'], confidence: 'high' };
  });
  const diagnosis = await diagnose({ text: 'pending' });
  const out = await generateLetters({ diagnosis, details, today: TODAY, lang: 'ta', only: ['epfigms'] });
  const letterPrompts = sent.slice(1).join(' ');
  assert.ok(!letterPrompts.includes('Ravi') && !letterPrompts.includes('100000000001'));
  assert.ok(out.letters[0].text_translated.includes('மதிப்பிற்குரிய'));
  assert.ok(out.letters[0].text_translated.includes('Ravi Kumar'), 'filled locally after translation');
  assert.ok(out.letters[0].text.startsWith('Subject:'), 'English copy kept for submission');
});

test('translation that breaks placeholders is discarded', async () => {
  fakeGemini(async ({ system }) => {
    if (system.includes('letter template')) return { body: 'broken, no placeholders' };
    return { reason_ids: ['stuck_no_reason'], confidence: 'high' };
  });
  const diagnosis = await diagnose({ text: 'pending' });
  const out = await generateLetters({ diagnosis, details, today: TODAY, lang: 'hi', only: ['rti'] });
  assert.strictEqual(out.letters[0].text_translated, undefined);
});
