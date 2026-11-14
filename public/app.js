// PF Rescue website: landing → describe → diagnosis → details → case tracker.
(function () {
  const { t, h, api, copyButton, waLink, toIso, icsFile, download, ask } = window.UI;
  const icon = window.icon;
  const app = document.getElementById('app');
  const langSel = document.getElementById('lang');
  const SPEECH_LANG = { en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN', ml: 'ml-IN', mr: 'mr-IN', bn: 'bn-IN' };
  const NATIVE = { en: 'English', hi: 'हिन्दी', ta: 'தமிழ்', te: 'తెలుగు', kn: 'ಕನ್ನಡ', ml: 'മലയാളം', mr: 'मराठी', bn: 'বাংলা' };
  const SITES = { 'epfigms.gov.in': 'https://epfigms.gov.in', 'pgportal.gov.in': 'https://pgportal.gov.in', 'rtionline.gov.in': 'https://rtionline.gov.in', 'unifiedportal-mem.epfindia.gov.in': 'https://unifiedportal-mem.epfindia.gov.in' };

  // Common rejection messages on the landing page. `msg` is the EPFO wording,
  // kept in English because that's what the SMS / portal shows.
  const PROBLEMS = [
    { k: 'p_name', msg: 'Claim rejected: Member name mismatch with Aadhaar' },
    { k: 'p_bank', msg: 'Claim rejected: Cheque image not clear / bank details not verified' },
    { k: 'p_kyc', msg: 'Claim rejected: KYC details not verified' },
    { k: 'p_exit', msg: 'Claim rejected: Date of exit not available' },
    { k: 'p_stuck', msg: 'Status: Sent to field office (no update for 20+ days)' },
    { k: 'p_15g', msg: 'Claim rejected: Form 15G assessment year wrongly submitted' },
  ];

  const state = { config: null, view: 'home', forWhom: 'self', text: '', image: null, diagnosis: null, caseView: null };

  // ---------- shell ----------
  const clean = (nodes) => nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);

  function translateStatic() {
    document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  }

  // Flow screens: narrow column. Landing: full-width sections.
  function show(...nodes) {
    app.replaceChildren(h('div', { class: 'wrap' }, clean(nodes)));
    after();
  }
  function showWide(...nodes) {
    app.replaceChildren(...clean(nodes));
    after();
  }
  function after() {
    translateStatic();
    document.getElementById('topCta').hidden = state.view !== 'home';
    app.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }

  function rerender() {
    translateStatic();
    if (state.view === 'case') return renderCase();
    return window.PFChat.render();
  }

  function go(view) { state.view = view; rerender(); }

  function start(forWhom, text = '') {
    state.forWhom = forWhom;
    state.text = text;
    state.image = null;
    state.view = 'home';
    renderHome();
    goToAsk();
  }

  function setLang(code) {
    window.UI.setLang(code);
    langSel.value = code;
    rerender();
  }

  function setupLangPicker() {
    langSel.replaceChildren(...Object.keys(state.config.langs).map((code) =>
      h('option', { value: code, selected: code === window.UI.lang }, NATIVE[code] || state.config.langs[code])));
    langSel.addEventListener('change', () => setLang(langSel.value));
    document.getElementById('topCta').addEventListener('click', () => { state.view = 'chat'; history.pushState(null, '', '/'); route(); });
  }

  function waHelp(context, cls = 'btn wa') {
    const n = state.config.support_whatsapp;
    if (!n) return null;
    return h('a', { class: cls, href: waLink(n, context || 'Hi, I need help with a PF claim.'), target: '_blank', rel: 'noopener' }, icon('whatsapp'), t('whatsappUs'));
  }

  function errorBox(err) {
    return h('p', { class: 'error', role: 'alert' }, err.message || t('errorGeneric'));
  }

  function back(view) {
    return h('button', { class: 'back', type: 'button', onclick: () => go(view) }, icon('arrow', 18), t('back'));
  }

  function stepper(now) {
    const steps = ['stepTell', 'stepDiag', 'stepDetails', 'stepCase'];
    return h('ol', { class: 'stepper', 'aria-label': t('progressLabel') }, steps.map((k, i) =>
      h('li', { class: i < now ? 'done' : i === now ? 'now' : '', 'aria-current': i === now ? 'step' : undefined }, h('span', {}, t(k)))));
  }

  // ---------- 1. home: the question box IS the home page ----------
  // A hand-drawn arrow for the worked example (static SVG, no user data).
  function drawnArrow() {
    const s = document.createElement('span');
    s.className = 'ic';
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = '<svg width="54" height="46" viewBox="0 0 54 46" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4c-2 14 6 30 38 34"/><path d="M34 30l10 8-12 5"/></svg>';
    return s;
  }

  function submitDiagnosis(button, err, ta) {
    return async () => {
      if (!state.text.trim() && !state.image) { ta.focus(); return; }
      button.disabled = true;
      button.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), t('checking'));
      err.replaceChildren();
      try {
        state.diagnosis = await api('/api/diagnose', { method: 'POST', body: { text: state.text, image: state.image && { mimeType: state.image.mimeType, base64: state.image.base64 }, lang: window.UI.lang } });
        go('result');
      } catch (e) {
        err.replaceChildren(errorBox(e));
        button.disabled = false;
        button.replaceChildren(t('findProblem'), icon('arrow'));
      }
    };
  }

  function askBox() {
    const ta = h('textarea', { id: 'problem', placeholder: t('placeholder') });
    ta.value = state.text;
    ta.addEventListener('input', () => { state.text = ta.value; });
    const err = h('div');
    const submit = h('button', { class: 'btn', type: 'button' }, t('findProblem'), icon('arrow'));
    submit.addEventListener('click', submitDiagnosis(submit, err, ta));
    const radio = (value, label) => h('label', {},
      h('input', { type: 'radio', name: 'forWhom', value, checked: state.forWhom === value, onchange: () => { state.forWhom = value; } }), label);
    return h('div', { class: 'ask', id: 'ask' },
      h('label', { class: 'q', for: 'problem' }, t('askQ')),
      ta,
      h('div', { class: 'tools' }, micButton(ta), photoButton()),
      photoPreview(),
      h('fieldset', { class: 'seg' }, h('legend', {}, t('forLabel')), radio('self', t('forMe')), radio('family', t('forParent'))),
      submit,
      err,
      h('p', { class: 'fine' }, icon('lock', 16), h('span', {}, t('fineLine'))));
  }

  function goToAsk() {
    window.scrollTo(0, 0);
    const ta = document.getElementById('problem');
    if (ta) ta.focus({ preventScroll: true });
  }

  function renderHome() {
    const price = state.config.price_text || '₹999';
    showWide(
      h('section', { class: 'home-top' }, h('div', { class: 'wide' },
        h('div', {},
          h('h1', {}, t('h_title1'), ' ', h('mark', {}, t('h_title2'))),
          h('p', { class: 'lead' }, t('h_lead')),
          askBox()),
        h('div', { class: 'example' },
          h('p', { class: 'ex-label' }, t('exLabel')),
          h('div', { class: 'sms' }, h('b', {}, t('exFrom')), t('exSms')),
          h('div', { class: 'arrow-row' }, drawnArrow(), h('span', {}, t('exArrow'))),
          h('div', { class: 'note' },
            h('h3', {}, t('exTitle')),
            h('span', { class: 'who' }, icon('user', 16), t('exWho')),
            h('ol', {}, h('li', {}, t('exStep1')), h('li', {}, t('exStep2')), h('li', {}, t('exStep3'))),
            h('div', { class: 'letter-ready' }, icon('file', 18), t('exLetter')))))),

      h('section', { class: 'band' }, h('div', { class: 'wide' },
        h('h2', {}, t('msgsTitle')),
        h('p', { class: 'intro' }, t('msgsSub')),
        h('div', { class: 'msgs' }, PROBLEMS.map((p) => h('button', { class: 'msg', type: 'button', onclick: () => { state.text = p.msg; renderHome(); goToAsk(); } },
          h('code', {}, p.msg), h('span', {}, t(p.k), ' →')))))),

      h('section', { class: 'band alt' }, h('div', { class: 'wide' },
        h('h2', {}, t('nextTitle')),
        h('ol', { class: 'plain-steps' }, ['n1', 'n2', 'n3', 'n4'].map((k) => h('li', {}, h('strong', {}, t(`${k}t`)), t(k)))),
        h('h2', {}, t('escTitle')),
        h('p', { class: 'intro' }, t('escSub')),
        h('dl', { class: 'ruled' }, ['e1', 'e2', 'e3', 'e4'].map((k) => h('div', {}, h('dt', {}, t(`${k}d`)), h('dd', {}, t(k))))))),

      h('section', { class: 'band' }, h('div', { class: 'wide' },
        h('h2', {}, t('noteTitle')),
        h('div', { class: 'letter-note' }, h('p', {}, t('note1')), h('p', {}, t('note2', { price })), h('p', { class: 'sign' }, t('noteSign'))))),

      h('section', { class: 'band alt' }, h('div', { class: 'wide' },
        h('h2', {}, t('qaTitle')),
        h('dl', { class: 'qa' }, ['1', '2', '3', '4', '5'].map((n) => h('div', {}, h('dt', {}, t(`q${n}`)), h('dd', {}, t(`a${n}`, { price }))))))),

      h('section', { class: 'band' }, h('div', { class: 'wide help-strip' },
        h('p', {}, t('stuckLine')),
        h('div', { class: 'row' },
          h('button', { class: 'btn inline', type: 'button', onclick: goToAsk }, t('backTop')),
          waHelp(null, 'btn wa inline')))),
    );
  }

  function micButton(ta) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const b = h('button', { class: 'tool', type: 'button' }, icon('mic', 20), t('speak'));
    let rec = null;
    b.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = SPEECH_LANG[window.UI.lang] || 'en-IN';
      rec.continuous = true;
      rec.interimResults = false;
      const base = ta.value ? `${ta.value} ` : '';
      let heard = '';
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) heard += `${e.results[i][0].transcript} `;
        ta.value = base + heard;
        state.text = ta.value;
      };
      rec.onend = () => { rec = null; b.classList.remove('live'); b.replaceChildren(icon('mic', 20), t('speak')); };
      rec.onerror = () => rec && rec.stop();
      rec.start();
      b.classList.add('live');
      b.replaceChildren(icon('mic', 20), t('listening'));
    });
    return b;
  }

  function photoButton() {
    const input = h('input', { type: 'file', accept: 'image/*', class: 'sr', id: 'photo' });
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      state.image = await shrinkImage(f);
      rerender();
    });
    return h('label', { class: 'tool', for: 'photo', tabindex: '0', role: 'button',
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } }, icon('camera', 20), t('addPhoto'), input);
  }

  function photoPreview() {
    if (!state.image) return null;
    return h('div', { class: 'photo-preview' },
      h('img', { src: state.image.preview, alt: '' }),
      h('button', { class: 'btn secondary small', type: 'button', onclick: () => { state.image = null; rerender(); } }, icon('x', 18), t('removePhoto')));
  }

  // Resize big phone photos to ~1600px JPEG so uploads work on slow networks
  async function shrinkImage(file) {
    const raw = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(file); });
    try {
      const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = raw; });
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/jpeg', 0.85);
      return { mimeType: 'image/jpeg', base64: url.split(',')[1], preview: url };
    } catch {
      // e.g. HEIC the browser can't draw: send as-is
      return { mimeType: file.type || 'image/jpeg', base64: raw.split(',')[1], preview: raw };
    }
  }

  // ---------- 3. result ----------
  function problemCard(p, opts = {}) {
    const done = opts.stepsDone || {};
    return h('div', { class: 'card problem' },
      h('div', { class: 'problem-head' },
        h('h2', { class: 'mt0' }, p.title),
        h('span', { class: 'who' }, icon('user', 16), t('whoFixes'), ' ', p.who_fixes),
        h('p', {}, p.explanation),
        p.needs_check ? h('p', { class: 'card warn small' }, t('checkPortal')) : null),
      h('div', { class: 'problem-body' },
        h('h3', {}, t('steps')),
        h('ol', { class: 'steps' }, p.steps.map((s, i) => {
          const key = `${p.id}:${i}`;
          const box = h('input', { type: 'checkbox', checked: Boolean(done[key]) });
          if (opts.onStep) box.addEventListener('change', () => opts.onStep(key, box.checked));
          else box.addEventListener('change', () => box.closest('li').classList.toggle('done', box.checked));
          return h('li', { class: done[key] ? 'done' : '' }, h('label', { class: 'check' }, box, h('span', {}, s)));
        })),
        p.documents && p.documents.length ? [h('h3', {}, t('documents')), h('ul', { class: 'docs' }, p.documents.map((d) => h('li', {}, d)))] : null,
        p.typical_days ? h('p', { class: 'muted small' }, icon('clock', 16), ' ', t('typicalDays', { n: p.typical_days })) : null));
  }

  function renderResult() {
    const d = state.diagnosis;
    const plan = d.plan || {};
    const problems = plan.problems || [];
    const context = `Hi, I need help with a PF claim. ${state.text}`.slice(0, 500);
    show(
      back('home'),
      stepper(1),
      d.needs_human
        ? h('div', { class: 'verdict unsure' }, h('span', { class: 'v-ic' }, icon('users', 24)), h('div', {}, h('strong', {}, t('needsHumanTitle')), h('span', { class: 's' }, t('needsHumanBody'))))
        : h('div', { class: 'verdict' }, h('span', { class: 'v-ic' }, icon('check', 24)), h('div', {}, h('strong', {}, t('foundTitle', { n: problems.length })), h('span', { class: 's' }, plan.summary || t('foundSub')))),
      d.needs_human ? waHelp(context) : null,
      plan.follow_up_question ? h('div', { class: 'card soft' }, h('strong', {}, t('followUp')), h('p', { class: 'mb0' }, plan.follow_up_question)) : null,
      problems.map((p) => problemCard(p)),
      plan.escalation && plan.escalation.length ? h('div', { class: 'card' },
        h('h2', { class: 'mt0' }, t('escalationTitle')),
        h('ol', { class: 'ladder' }, plan.escalation.map((s) => h('li', {}, h('strong', {}, s.name), ' ', h('span', { class: 'pill' }, s.after_days ? t('afterDays', { n: s.after_days }) : t('now')), h('p', { class: 'small muted mb0' }, s.action))))) : null,
      h('button', { class: 'btn', type: 'button', onclick: () => go('details') }, icon('file'), t('nextLetters'), icon('arrow')),
      !d.needs_human ? waHelp(context, 'btn secondary') : null,
    );
  }

  // ---------- 4. details ----------
  const ALWAYS = ['name', 'uan', 'mobile', 'claim_type', 'filed_date'];
  const DATE_FIELDS = ['filed_date', 'exit_date', 'grievance_date'];
  // Grievance number/date are captured when the user presses "I sent it"
  const ASKED_LATER = ['employer_action', 'grievance_no', 'grievance_date'];

  // Only ask for what the letters that can be sent right now still need
  function missingNow(c) {
    const keys = new Map();
    for (const l of c.letters) {
      if (l.sent || l.status !== 'ready') continue;
      for (const m of l.missing) if (!ASKED_LATER.includes(m.key)) keys.set(m.key, m);
    }
    return [...keys.values()];
  }

  function field(key, value) {
    if (key === 'claim_type') {
      return h('label', { class: 'field' }, t('f_claim_type'),
        h('select', { class: 'full', name: key }, ['final_settlement', 'partial_withdrawal', 'pension', 'transfer', 'unknown'].map((v) =>
          h('option', { value: v, selected: v === (value || 'unknown') }, t(`ct_${v}`)))));
    }
    const type = DATE_FIELDS.includes(key) ? 'date' : key === 'mobile' || key === 'helper_mobile' ? 'tel' : 'text';
    return h('label', { class: 'field' }, t(`f_${key}`),
      h('input', { type, name: key, value: type === 'date' ? toIso(value) : value || '', inputmode: key === 'uan' ? 'numeric' : undefined, autocomplete: key === 'name' ? 'name' : key === 'mobile' ? 'tel' : 'off', maxlength: key === 'uan' ? '12' : undefined }));
  }

  function readForm(form) {
    const out = {};
    for (const el of form.querySelectorAll('input[name], select[name]')) {
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.value.trim()) out[el.name] = el.value.trim();
    }
    return out;
  }

  async function renderDetails() {
    const d = state.diagnosis;
    const ex = d.extracted || {};
    show(h('div', { class: 'loading' }, h('span', { class: 'spinner' })));
    let preview;
    try {
      preview = await api('/api/letters', { method: 'POST', body: { reason_ids: d.reason_ids, extracted: ex, details: {} } });
    } catch (e) {
      return show(errorBox(e));
    }
    const keys = [...new Set([...ALWAYS, ...preview.missing.map((m) => m.key)])].filter((k) => !ASKED_LATER.includes(k));
    const prefill = { claim_id: ex.claim_id, filed_date: ex.filed_date, remark: ex.remark, claim_type: ex.claim_type };
    const needsKyc = preview.letters.some((l) => l.key === 'epfigms');
    const err = h('div');
    const form = h('form', {},
      state.forWhom === 'family' ? h('div', { class: 'card soft' },
        h('h3', { class: 'mt0' }, icon('users', 20), ' ', t('aboutYou')),
        h('label', { class: 'field' }, t('helperName'), h('input', { type: 'text', name: 'helper_name', autocomplete: 'name' })),
        h('label', { class: 'field mb0' }, t('helperMobile'), h('input', { type: 'tel', name: 'helper_mobile', autocomplete: 'tel' }))) : null,
      h('div', { class: 'card' },
        h('h3', { class: 'mt0' }, icon('idcard', 20), ' ', state.forWhom === 'family' ? t('aboutMember') : t('aboutClaim')),
        keys.map((k) => field(k, prefill[k])),
        needsKyc ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'kyc_verified' }), h('span', {}, t('kycVerified'))) : null),
      h('p', { class: 'muted small' }, icon('lock', 16), ' ', t('noAadhaar')),
      h('button', { class: 'btn', type: 'submit' }, t('saveCase'), icon('arrow')),
      err);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = t('saving');
      const { helper_name: helperName, ...details } = readForm(form);
      try {
        const c = await api('/api/cases', { method: 'POST', body: {
          for_whom: state.forWhom, helper_name: helperName, lang: window.UI.lang,
          problem_text: state.text, reason_ids: d.reason_ids, extracted: ex, needs_human: d.needs_human,
          confidence: d.confidence, summary: d.plan && d.plan.summary, details,
        } });
        history.pushState(null, '', c.url);
        route();
      } catch (e2) {
        err.replaceChildren(errorBox(e2));
        btn.disabled = false;
        btn.replaceChildren(t('saveCase'), icon('arrow'));
      }
    });
    show(
      back('result'),
      stepper(2),
      h('h1', {}, t('detailsTitle')),
      h('p', { class: 'muted' }, t('detailsHelp')),
      form,
    );
  }

  // ---------- 5. case tracker ----------
  function caseIds() {
    const m = location.pathname.match(/^\/c\/([\w-]+)/);
    return m ? { id: m[1], token: location.hash.slice(1) } : null;
  }

  async function patchCase(body) {
    const { id, token } = caseIds();
    state.caseView = await api(`/api/cases/${id}`, { method: 'PATCH', body, headers: { 'X-Case-Token': token } });
    const y = window.scrollY;
    renderCase();
    window.scrollTo(0, y);
  }

  async function loadCase() {
    const { id, token } = caseIds();
    state.view = 'case';
    show(h('div', { class: 'loading' }, h('span', { class: 'spinner' })));
    try {
      state.caseView = await api(`/api/cases/${id}`, { headers: { 'X-Case-Token': token } });
      if (state.caseView.lang && !window.UI.store.get('lang')) window.UI.setLang(state.caseView.lang);
      langSel.value = window.UI.lang;
      renderCase();
    } catch (e) {
      show(h('h1', {}, t('notFound')), h('a', { class: 'btn', href: '/' }, t('appName')));
    }
  }

  // Where the case is: opened → fixing → following up → money received
  function caseStage(c) {
    if (c.status === 'resolved') return 4;
    if (c.events.some((e) => e.type.endsWith('_sent') || e.type === 'refiled')) return 2;
    return 1;
  }

  function renderCase() {
    state.view = 'case';
    const c = state.caseView;
    const name = c.details.name;
    const link = location.href;
    const userDue = c.reminders.due.filter((r) => r.who === 'user');
    const teamDue = c.reminders.due.some((r) => r.who === 'team');
    const up = c.reminders.upcoming;
    const stage = caseStage(c);
    const upText = up && (t(`u_${up.type}`) === `u_${up.type}` ? up.text : t(`u_${up.type}`));

    show(
      h('div', { class: 'case-head' },
        h('h1', {}, name ? t('caseTitle', { name }) : t('caseTitleNoName')),
        h('p', { class: 'sub' }, c.for_whom === 'family' && c.helper_name ? t('helpedBy', { name: c.helper_name }) : c.timeline ? t('filedOn', { date: c.timeline.filed_on, n: c.timeline.days_since_filed }) : t('caseCreated')),
        h('ol', { class: 'progress' }, ['pg_open', 'pg_fix', 'pg_chase', 'pg_money'].map((k, i) =>
          h('li', { class: i < stage ? 'done' : i === stage ? 'now' : '' }, t(k))))),

      c.status === 'resolved' ? h('div', { class: 'card ok' }, h('h2', { class: 'mt0' }, t('resolvedTitle')), h('p', { class: 'mb0' }, t('resolvedBody'))) : null,

      c.status === 'open' ? h('div', { class: 'card todo' },
        h('h2', { class: 'mt0' }, t('todo')),
        userDue.length ? userDue.map((r) => h('div', { class: 'todo-item' }, icon('bell', 20), h('span', {}, t(`r_${r.type}`) === `r_${r.type}` ? r.text : t(`r_${r.type}`))))
          : h('p', {}, t('nothingDue')),
        teamDue ? h('p', { class: 'small muted' }, t('teamWillCall')) : null,
        up ? [h('div', { class: 'next' }, icon('calendar', 22), h('span', {}, t('nextDate', { text: upText, date: up.date }))),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => download(icsFile({ title: `PF: ${upText}`, date: up.date, description: 'PF Rescue reminder', url: link }), 'pf-reminder.ics') }, icon('calendar'), t('addCalendar'))] : null,
        c.for_whom === 'family' && c.timeline ? h('p', { class: 'small muted mb0' }, t('filedOn', { date: c.timeline.filed_on, n: c.timeline.days_since_filed })) : null,
      ) : null,

      h('div', { class: 'card soft small' },
        h('p', { class: 'mt0' }, icon('lock', 16), ' ', t('saveLink')),
        h('a', { class: 'btn wa small', href: `https://wa.me/?text=${encodeURIComponent(`PF case: ${link}`)}`, target: '_blank', rel: 'noopener' }, icon('share', 18), t('shareWa')),
        copyButton(t('copyLink'), () => link)),

      c.plan.problems.length ? [h('h2', {}, t('stepsTitle')), c.plan.problems.map((p) => problemCard(p, { stepsDone: c.steps_done, onStep: (key, done) => patchCase({ step: { key, done } }) }))] : null,

      missingNow(c).length ? missingForm(c, missingNow(c)) : null,

      h('h2', {}, t('lettersTitle')),
      c.letters.length ? c.letters.map(letterCard) : h('p', { class: 'muted' }, t('noLetters')),

      c.status === 'open' ? h('div', { class: 'row' },
        h('button', { class: 'btn secondary', type: 'button', onclick: async () => {
          const v = await ask(t('refiled'), [{ name: 'date', label: t('date'), type: 'date', value: new Date().toISOString().slice(0, 10) }, { name: 'claim_id', label: t('newClaimId') }]);
          if (v) patchCase({ event: { type: 'refiled', date: v.date, claim_id: v.claim_id } });
        } }, icon('file'), t('refiled')),
        h('button', { class: 'btn accent', type: 'button', onclick: async () => {
          const v = await ask(t('moneyReceived'), [{ name: 'amount', label: t('amount'), type: 'number', inputmode: 'numeric' }, { name: 'date', label: t('date'), type: 'date', value: new Date().toISOString().slice(0, 10) }]);
          if (v) patchCase({ event: { type: 'money_received', amount: v.amount, date: v.date } });
        } }, icon('rupee'), t('moneyReceived'))) : null,

      h('h2', {}, t('history')),
      h('ol', { class: 'ladder' },
        h('li', { class: 'done' }, h('strong', {}, t('caseCreated')), ' — ', c.created_at.slice(0, 10)),
        c.events.map((e) => h('li', { class: 'done' }, h('strong', {}, t(`ev_${e.type}`)), ' — ', e.date,
          e.grievance_no ? ` (${e.grievance_no})` : '', e.amount ? ` (₹${e.amount.toLocaleString('en-IN')})` : ''))),

      waHelp(`Hi, I need help with my PF case ${c.id}.`, 'btn secondary'),
    );
  }

  function missingForm(c, missing) {
    const form = h('form', { class: 'card warn' },
      h('h2', { class: 'mt0' }, t('fillMissing')),
      missing.map((m) => field(m.key, c.details[m.key])),
      h('button', { class: 'btn', type: 'submit' }, t('saveDetails')));
    form.addEventListener('submit', (e) => { e.preventDefault(); patchCase({ details: readForm(form) }); });
    return form;
  }

  function letterCard(l) {
    let translated = false;
    const pre = h('div', { class: 'letter', tabindex: '0' }, l.text);
    const toggle = l.text_translated ? h('button', { class: 'btn secondary small', type: 'button' }, t('showTranslation')) : null;
    if (toggle) toggle.addEventListener('click', () => {
      translated = !translated;
      pre.textContent = translated ? l.text_translated : l.text;
      toggle.textContent = translated ? 'English' : t('showTranslation');
    });
    const site = SITES[l.where];
    const status = l.sent ? h('span', { class: 'pill ok' }, icon('check', 14), t('sent'))
      : l.status === 'wait' ? h('span', { class: 'pill warn' }, icon('clock', 14), t('waitUntil', { date: l.send_on }))
        : h('span', { class: 'pill' }, t('ready'));
    return h('details', { class: 'card', open: !l.sent && l.status === 'ready' },
      h('summary', {}, icon('file'), l.title),
      status,
      h('p', { class: 'small muted' }, '→ ', l.where),
      l.note ? h('p', { class: 'small' }, l.note) : null,
      l.text_translated ? h('p', { class: 'small muted' }, t('englishNote')) : null,
      pre,
      h('div', {},
        copyButton(t('copyLetter'), () => l.text, 'btn small'),
        toggle,
        site ? h('a', { class: 'btn secondary small', href: site, target: '_blank', rel: 'noopener' }, icon('external', 18), t('openSite', { site: l.where })) : null,
        !l.sent ? h('button', { class: 'btn secondary small', type: 'button', onclick: async () => {
          const fields = [{ name: 'date', label: t('date'), type: 'date', value: new Date().toISOString().slice(0, 10) }];
          if (l.key === 'epfigms') fields.push({ name: 'grievance_no', label: t('f_grievance_no') });
          const v = await ask(l.title, fields);
          if (v) patchCase({ event: { type: `${l.key}_sent`, date: v.date, grievance_no: v.grievance_no } });
        } }, icon('check', 18), t('markSent')) : null));
  }

  // ---------- boot ----------
  function route() {
    translateStatic();
    if (caseIds()) {
      document.body.classList.remove('chat-page');
      return loadCase();
    }
    state.view = 'chat';
    window.PFChat.start(state.config, app);
  }

  window.addEventListener('popstate', route);
  (async function boot() {
    try {
      state.config = await api('/api/config');
    } catch {
      state.config = { langs: { en: 'English' }, support_whatsapp: '', price_text: '' };
    }
    window.UI.setLang(window.UI.lang);
    setupLangPicker();
    route();
  })();
})();
