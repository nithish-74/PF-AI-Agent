const test = require('node:test');
const assert = require('node:assert');
const gemini = require('../src/gemini');
const { chat } = require('../src/agent');

function fakeGemini(handler) {
  gemini.enabled = () => Boolean(handler);
  gemini.generateJson = handler || (async () => { throw new Error('should not be called'); });
}

const user = (text) => [{ role: 'agent', text: 'Namaste! What happened?' }, { role: 'user', text }];

test('asks a question back and offers quick replies', async () => {
  fakeGemini(async () => ({ reply: 'When did your father leave the job?', reason_ids: [], show: 'none', quick_replies: ['2019', 'Not sure', 'a', 'b'] }));
  const r = await chat({ messages: user('papa ka claim reject ho gaya'), forWhom: 'family' });
  assert.strictEqual(r.reply, 'When did your father leave the job?');
  assert.deepStrictEqual(r.quick_replies, ['2019', 'Not sure', 'a'], 'max 3 quick replies');
  assert.deepStrictEqual(r.cards, []);
});

test('fix steps come from the playbook as a card, invented ids dropped', async () => {
  fakeGemini(async ({ system }) => {
    if (system.includes('Translate')) throw new Error('no translation for English');
    return { reply: 'His exit date is missing. The old company must mark it.', reason_ids: ['exit_date', 'made_up'], show: 'fix', steps: ['pay an agent'] };
  });
  const r = await chat({ messages: user('date of exit not available') });
  assert.deepStrictEqual(r.reason_ids, ['exit_date']);
  const fix = r.cards.find((c) => c.type === 'fix');
  assert.ok(fix && fix.problems[0].steps.length > 0);
  assert.ok(!JSON.stringify(fix).includes('pay an agent'));
});

test('fix card is not repeated once shown; letters and save cards pass through', async () => {
  fakeGemini(async () => ({ reply: 'Shall I write the email to HR?', reason_ids: ['exit_date'], show: 'letters' }));
  const r = await chat({ messages: user('yes please'), state: { reason_ids: ['exit_date'], shown_fix: ['exit_date'] } });
  assert.deepStrictEqual(r.cards.map((c) => c.type), ['letters']);
  fakeGemini(async () => ({ reply: 'Want reminders?', reason_ids: [], show: 'save_case' }));
  const r2 = await chat({ messages: user('ok'), state: { reason_ids: ['exit_date'], shown_fix: ['exit_date'], case_saved: true } });
  assert.deepStrictEqual(r2.cards, [], 'no save card when already saved');
});

test('ID numbers in the conversation are masked before reaching Gemini', async () => {
  let sent = '';
  fakeGemini(async ({ text }) => { sent = text; return { reply: 'ok', reason_ids: [], show: 'none' }; });
  await chat({ messages: user('my UAN is 100123456789 and aadhaar 1234 5678 9012') });
  assert.ok(!sent.includes('100123456789') && !sent.includes('1234 5678 9012'));
  assert.ok(sent.includes('6789'));
});

test('the prompt carries the playbook and the reply language', async () => {
  let sys = '';
  fakeGemini(async ({ system }) => { sys = system; return { reply: 'ठीक है', reason_ids: [], show: 'none' }; });
  await chat({ messages: user('hello'), lang: 'hi' });
  assert.ok(sys.includes('Reply ONLY in Hindi'));
  assert.ok(sys.includes('exit_date') && sys.includes('epfigms.gov.in'));
});

test('user Hinglish never becomes the official EPFO remark', async () => {
  fakeGemini(async () => ({ reply: 'ok', reason_ids: ['cheque_image'], show: 'none', extracted: { remark: 'cheque ki photo saaf nahi hai' } }));
  const r = await chat({ messages: user('cheque ki photo saaf nahi hai') });
  assert.strictEqual(r.extracted.remark, '');
});

test('no key: answers with rules and a fix card', async () => {
  fakeGemini(null);
  const r = await chat({ messages: user('Rejected: date of exit not available') });
  assert.strictEqual(r.source, 'rules');
  assert.strictEqual(r.reply_key, 'fb_found');
  assert.deepStrictEqual(r.cards.map((c) => c.type), ['fix', 'letters']);
});

test('Gemini down: still answers; vague message gets a human card', async () => {
  fakeGemini(async () => { throw new Error('503 UNAVAILABLE'); });
  const r = await chat({ messages: user('help me please') });
  assert.strictEqual(r.reply_key, 'fb_unknown');
  assert.deepStrictEqual(r.cards.map((c) => c.type), ['human']);
});

test('empty conversation is rejected', async () => {
  fakeGemini(null);
  await assert.rejects(chat({ messages: [] }), /Send a message/);
});
