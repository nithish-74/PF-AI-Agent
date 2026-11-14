// Team queue: every case, most urgent first. You (the founder) work from here:
// WhatsApp the user, fix the AI's guess, mark the case as reviewed.
(function () {
  const { h, api, waLink } = window.UI;
  const app = document.getElementById('app');
  let key = sessionStorage.getItem('adminKey') || '';
  let reasons = [];

  const headers = () => ({ 'X-Admin-Key': key });

  function login(msg) {
    const input = h('input', { type: 'password', autocomplete: 'current-password' });
    const form = h('form', {}, h('h1', {}, 'Team login'), msg ? h('p', { class: 'error' }, msg) : null,
      h('label', { class: 'field' }, 'Admin key (ADMIN_KEY in .env)', input), h('button', { class: 'btn', type: 'submit' }, 'Open queue'));
    form.addEventListener('submit', (e) => { e.preventDefault(); key = input.value; sessionStorage.setItem('adminKey', key); load(); });
    app.replaceChildren(form);
  }

  function message(c) {
    const first = c.reminders.due[0];
    const hello = c.name ? `Hi, this is PF Rescue about ${c.name}'s PF claim.` : 'Hi, this is PF Rescue about your PF claim.';
    return `${hello} ${first ? first.text : 'Just checking how it is going.'}`;
  }

  async function act(id, body) {
    await api(`/api/cases/${id}`, { method: 'PATCH', body, headers: headers() });
    load();
  }

  function card(c) {
    const select = h('select', { class: 'full' }, h('option', { value: '' }, 'Change problem…'),
      reasons.map((r) => h('option', { value: r.id, selected: c.reason_ids[0] === r.id }, r.title)));
    select.addEventListener('change', () => select.value && act(c.id, { reason_ids: [select.value], event: { type: 'human_reviewed', note: 'reclassified' } }));
    const urgent = c.reminders.due.length > 0;
    return h('div', { class: `card queue-item${urgent ? ' urgent' : ''}` },
      h('h3', {}, c.name || '(no name)', ' ', h('span', { class: 'pill' }, c.status), c.for_whom === 'family' ? h('span', { class: 'pill' }, 'family') : null, c.needs_human ? h('span', { class: 'pill warn' }, 'needs human') : null),
      h('p', { class: 'small muted' }, `#${c.id} · opened ${c.created_at.slice(0, 10)} · lang ${c.lang}${c.filed_date ? ` · filed ${c.filed_date}` : ''}${c.amount ? ` · ₹${c.amount} recovered` : ''}`),
      c.problem_text ? h('p', { class: 'small' }, '“', c.problem_text, '”') : null,
      h('p', { class: 'small' }, 'Problems: ', c.reason_ids.join(', ') || '—'),
      c.reminders.due.length ? h('ul', { class: 'small' }, c.reminders.due.map((r) => h('li', {}, `[${r.who}] ${r.text}`))) : null,
      c.reminders.upcoming ? h('p', { class: 'small muted' }, `Next: ${c.reminders.upcoming.text} on ${c.reminders.upcoming.date}`) : null,
      h('div', {},
        c.mobile ? h('a', { class: 'btn wa small', href: waLink(`91${c.mobile.replace(/\D/g, '').slice(-10)}`, message(c)), target: '_blank', rel: 'noopener' }, 'WhatsApp') : null,
        c.needs_human ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => act(c.id, { event: { type: 'human_reviewed' } }) }, 'Mark reviewed') : null),
      c.status === 'open' ? select : null);
  }

  async function load() {
    if (!key) return login();
    try {
      const [cfg, q] = await Promise.all([api('/api/config'), api('/api/admin/cases', { headers: headers() })]);
      reasons = cfg.reasons;
      const open = q.cases.filter((c) => c.status === 'open');
      const recovered = q.cases.reduce((s, c) => s + (c.amount || 0), 0);
      const resolved = q.cases.filter((c) => c.status === 'resolved').length;
      app.replaceChildren(
        h('h1', {}, 'Case queue'),
        h('div', { class: 'card brand' }, h('strong', {}, `${q.cases.length} cases · ${open.length} open · ${resolved} resolved · ₹${recovered.toLocaleString('en-IN')} recovered`),
          h('p', { class: 'small mb0' }, 'Your YC line: “₹', recovered.toLocaleString('en-IN'), ` recovered for ${resolved} people.”`)),
        h('button', { class: 'btn secondary small', type: 'button', onclick: load }, 'Refresh'),
        ...(q.cases.length ? q.cases.map(card) : [h('p', { class: 'muted' }, 'No cases yet.')]));
    } catch (e) {
      if (e.status === 401) { sessionStorage.removeItem('adminKey'); key = ''; return login('Wrong key'); }
      app.replaceChildren(h('p', { class: 'error' }, e.message));
    }
  }

  load();
})();
