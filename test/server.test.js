// End-to-end: the website's API, case tracker and reminders, with no API key.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-test-'));
process.env.ADMIN_KEY = 'test-admin-key';
const gemini = require('../src/gemini');
gemini.enabled = () => false;

const { createServer } = require('../src/server');
const cases = require('../src/cases');

let base;
const server = createServer();
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
test.after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

async function call(p, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : await res.text() };
}

test('home page and assets are served with a strict CSP', async () => {
  const r = await call('/');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.includes('<main id="app"'));
  assert.ok(r.headers.get('content-security-policy').includes("script-src 'self'"));
  assert.strictEqual((await call('/app.js')).status, 200);
  assert.strictEqual((await call('/c/abc123')).status, 200, 'case links load the app');
});

test('path traversal is blocked', async () => {
  assert.strictEqual((await call('/../package.json')).status, 404);
  assert.strictEqual((await call('/%2e%2e/package.json')).status, 404);
});

test('diagnose: needs text or photo, and rejects odd file types', async () => {
  assert.strictEqual((await call('/api/diagnose', { method: 'POST', body: {} })).status, 400);
  assert.strictEqual((await call('/api/diagnose', { method: 'POST', body: { image: { mimeType: 'text/html', base64: 'x' } } })).status, 400);
  const r = await call('/api/diagnose', { method: 'POST', body: { text: 'Rejected: cheque image not clear', lang: 'xx' } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.reason_ids, ['cheque_image']);
});

test('full journey: diagnose → case → send grievance → CPGRAMS due → money received', async () => {
  const d = (await call('/api/diagnose', { method: 'POST', body: { text: 'status sent to field office' } })).body;
  const created = await call('/api/cases', { method: 'POST', body: {
    for_whom: 'family', helper_name: 'Priya', lang: 'en', problem_text: 'Appa UAN 100123456789 stuck', reason_ids: d.reason_ids,
    extracted: d.extracted, details: { name: 'Ravi Kumar', uan: '1001 2345 6789', mobile: '9000000000', filed_date: '2026-09-01', aadhaar: '123412341234' },
  } });
  assert.strictEqual(created.status, 201);
  const { id, token } = created.body;
  assert.ok(created.body.url.endsWith(`#${token}`), 'token travels in the URL fragment');

  // Privacy: wrong token = not found; Aadhaar never stored; free text masked
  assert.strictEqual((await call(`/api/cases/${id}`, { headers: { 'X-Case-Token': 'nope' } })).status, 404);
  const raw = fs.readFileSync(path.join(process.env.DATA_DIR, 'cases.json'), 'utf8');
  assert.ok(!raw.includes('123412341234'));
  assert.ok(!raw.includes('100123456789 stuck'));

  const H = { 'X-Case-Token': token };
  let v = (await call(`/api/cases/${id}`, { headers: H })).body;
  assert.strictEqual(v.token, undefined, 'token never sent back');
  assert.strictEqual(v.details.uan, '100123456789');
  assert.ok(v.reminders.due.some((r) => r.type === 'send_epfigms'));
  assert.deepStrictEqual(v.letters.map((l) => l.key), ['epfigms', 'cpgrams', 'rti']);

  // Step checklist persists
  v = (await call(`/api/cases/${id}`, { method: 'PATCH', headers: H, body: { step: { key: 'stuck_no_reason:0', done: true } } })).body;
  assert.strictEqual(v.steps_done['stuck_no_reason:0'], true);

  // Grievance sent recently → CPGRAMS waits for the 15-day reply window
  const recent = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  v = (await call(`/api/cases/${id}`, { method: 'PATCH', headers: H, body: { event: { type: 'epfigms_sent', date: recent, grievance_no: 'EPFIGMS/123' } } })).body;
  assert.strictEqual(v.details.grievance_no, 'EPFIGMS/123');
  assert.ok(!v.reminders.due.some((r) => r.type.startsWith('send_')));
  assert.strictEqual(v.reminders.upcoming.type, 'send_cpgrams');
  assert.ok(v.letters.find((l) => l.key === 'epfigms').sent);
  assert.ok(v.letters.find((l) => l.key === 'cpgrams').text.includes('EPFIGMS/123'));

  // Bad event rejected
  assert.strictEqual((await call(`/api/cases/${id}`, { method: 'PATCH', headers: H, body: { event: { type: 'hack' } } })).status, 400);
  // Users can't re-classify their own case
  v = (await call(`/api/cases/${id}`, { method: 'PATCH', headers: H, body: { reason_ids: ['form_15g'] } })).body;
  assert.deepStrictEqual(v.reason_ids, ['stuck_no_reason']);

  v = (await call(`/api/cases/${id}`, { method: 'PATCH', headers: H, body: { event: { type: 'money_received', amount: '184500' } } })).body;
  assert.strictEqual(v.status, 'resolved');
  assert.deepStrictEqual(v.reminders.due, []);
});

test('reminders: CPGRAMS due 15 days after grievance, RTI after CPGRAMS', () => {
  const c = { status: 'open', needs_human: false, reason_ids: ['stuck_no_reason'], extracted: {}, details: { filed_date: '2026-08-01' }, events: [] };
  const due = (today) => cases.reminders(c, today).due.map((r) => r.type);
  assert.deepStrictEqual(due('2026-08-15'), []);
  assert.strictEqual(cases.reminders(c, '2026-08-15').upcoming.date, '21-08-2026');
  assert.deepStrictEqual(due('2026-08-21'), ['send_epfigms']);
  c.events.push({ type: 'epfigms_sent', date: '2026-08-25' });
  assert.deepStrictEqual(due('2026-09-08'), []);
  assert.deepStrictEqual(due('2026-09-09'), ['send_cpgrams']);
  c.events.push({ type: 'cpgrams_sent', date: '2026-09-10' });
  assert.deepStrictEqual(due('2026-10-09'), []);
  assert.deepStrictEqual(due('2026-10-10'), ['send_rti']);
  c.events.push({ type: 'rti_sent', date: '2026-10-10' });
  assert.strictEqual(cases.reminders(c, '2026-10-20').upcoming.type, 'rti_reply');
  assert.deepStrictEqual(due('2026-11-10'), ['rti_overdue']);
});

test('reminders: employer fix → email HR → chase → re-file → escalate if stuck again', () => {
  const c = { status: 'open', needs_human: false, reason_ids: ['exit_date'], extracted: {}, details: { filed_date: '2026-10-01' }, events: [] };
  const due = (today) => cases.reminders(c, today).due.map((r) => r.type);
  assert.deepStrictEqual(due('2026-10-05'), ['send_employer_email', 'fix_and_refile']);
  c.events.push({ type: 'employer_email_sent', date: '2026-10-05' });
  assert.deepStrictEqual(due('2026-10-08'), ['fix_and_refile']);
  assert.deepStrictEqual(due('2026-10-12'), ['chase_employer', 'fix_and_refile']);
  c.events.push({ type: 'refiled', date: '2026-10-15' });
  c.details.filed_date = '2026-10-15';
  assert.deepStrictEqual(due('2026-10-20'), []);
  assert.deepStrictEqual(due('2026-11-04'), ['send_epfigms'], 'stuck 20 days after re-filing');
});

test('reminders: unsure AI → team call; no date → ask for it', () => {
  const c = { status: 'open', needs_human: true, reason_ids: [], extracted: {}, details: {}, events: [] };
  const r = cases.reminders(c, '2026-11-14').due;
  assert.deepStrictEqual(r.map((x) => [x.who, x.type]), [['team', 'call_user'], ['user', 'need_filed_date']]);
});

test('admin: queue needs the key; team can re-classify and steps are rebuilt', async () => {
  assert.strictEqual((await call('/api/admin/cases')).status, 401);
  assert.strictEqual((await call('/api/admin/cases', { headers: { 'X-Admin-Key': 'wrong-admin-key' } })).status, 401);
  const created = (await call('/api/cases', { method: 'POST', body: { problem_text: 'pf not coming', reason_ids: [], details: { name: 'Lakshmi', mobile: '9111111111' } } })).body;
  const A = { 'X-Admin-Key': 'test-admin-key' };
  const q = (await call('/api/admin/cases', { headers: A })).body.cases;
  const item = q.find((c) => c.id === created.id);
  assert.ok(item.needs_human);
  assert.strictEqual(q[0].reminders.due.length >= q[q.length - 1].reminders.due.length, true, 'most urgent first');

  const v = (await call(`/api/cases/${created.id}`, { method: 'PATCH', headers: A, body: { reason_ids: ['bank_details'], event: { type: 'human_reviewed' } } })).body;
  assert.deepStrictEqual(v.reason_ids, ['bank_details']);
  assert.strictEqual(v.needs_human, false);
  assert.strictEqual(v.plan.problems[0].id, 'bank_details');
});

test('letters endpoint ignores unknown reason ids', async () => {
  const r = await call('/api/letters', { method: 'POST', body: { reason_ids: ['exit_date', 'evil'], details: {} } });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.letters.map((l) => l.key), ['employer_email']);
});
