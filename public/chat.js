// The chat with the PF Rescue agent. Messages are kept in this browser only
// (localStorage) so a refresh doesn't lose the conversation.
(function () {
  const { t, h, api, copyButton, waLink, toIso } = window.UI;
  const icon = window.icon;
  const KEY = 'pfchat:v1';
  const SPEECH_LANG = { en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN', te: 'te-IN', kn: 'kn-IN', ml: 'ml-IN', mr: 'mr-IN', bn: 'bn-IN' };
  const SITES = { 'epfigms.gov.in': 'https://epfigms.gov.in', 'pgportal.gov.in': 'https://pgportal.gov.in', 'rtionline.gov.in': 'https://rtionline.gov.in' };
  const ASKED_LATER = ['employer_action', 'grievance_no', 'grievance_date'];
  const DATE_FIELDS = ['filed_date', 'exit_date', 'grievance_date'];

  let config = {};
  let root = null;
  let thread = null;
  let busy = false;
  let pendingImage = null;
  let s = fresh();

  function fresh() {
    return {
      messages: [{ role: 'agent', key: 'greet', quick: ['qr_rejected', 'qr_stuck', 'qr_parent'], quickKeys: true }],
      forWhom: 'self', reason_ids: [], shown_fix: [], extracted: {}, details: {}, ticks: {}, caseUrl: null,
    };
  }
  function load() {
    try { const v = JSON.parse(localStorage.getItem(KEY)); if (v && Array.isArray(v.messages)) s = { ...fresh(), ...v }; } catch { /* ignore */ }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
  }

  // ---------- rendering ----------
  function msgText(m) { return m.key ? t(m.key) : m.text; }

  function messageNode(m, isLast) {
    if (m.role === 'user') {
      return h('div', { class: 'msg-row user' }, h('div', { class: 'msg-col' },
        h('div', { class: 'bubble' }, m.photo ? h('span', { class: 'photo-tag' }, icon('camera', 16), t('photoSent'), m.text ? '\n' : '') : null, m.text || '')));
    }
    const col = h('div', { class: 'msg-col' }, h('div', { class: 'bubble' }, msgText(m)));
    for (const c of m.cards || []) col.append(cardNode(c));
    const row = h('div', { class: 'msg-row agent' }, h('span', { class: 'avatar' }, h('img', { src: '/icon.svg', alt: '' })), col);
    if (!isLast || !m.quick || !m.quick.length) return row;
    return h('div', {}, row, h('div', { class: 'quick' }, m.quick.map((q) => {
      const label = m.quickKeys ? t(q) : q;
      return h('button', { type: 'button', onclick: () => { if (q === 'qr_parent') s.forWhom = 'family'; send(label); } }, label);
    })));
  }

  function renderThread() {
    thread.replaceChildren(...s.messages.map((m, i) => messageNode(m, i === s.messages.length - 1)));
  }

  function scrollDown() {
    requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
  }

  function render() {
    document.body.classList.add('chat-page');
    const ta = h('textarea', { id: 'msg', rows: '1', placeholder: t('typeHere'), 'aria-label': t('typeHere') });
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`; });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendFromBox(); } });
    const sendBtn = h('button', { class: 'round send', type: 'button', 'aria-label': t('send'), onclick: sendFromBox }, icon('arrow', 22));
    function sendFromBox() { const v = ta.value; ta.value = ''; ta.style.height = 'auto'; send(v); }

    thread = h('div', { class: 'thread', 'aria-live': 'polite' });
    const attach = h('div', { class: 'attach', hidden: !pendingImage });
    function showAttach() {
      attach.hidden = !pendingImage;
      attach.replaceChildren(...(pendingImage ? [h('img', { src: pendingImage.preview, alt: '' }), t('photoAdded'),
        h('button', { type: 'button', onclick: () => { pendingImage = null; showAttach(); } }, t('removePhoto'))] : []));
    }
    showAttach();

    root.replaceChildren(h('div', { class: 'chat' },
      h('div', { class: 'chat-intro' },
        h('div', {}, h('h1', {}, t('chatTitle')), h('p', {}, t('chatSub'))),
        h('button', { class: 'newchat', type: 'button', onclick: () => { s = fresh(); save(); render(); } }, t('newChat'))),
      thread,
      h('div', { class: 'composer-bar' },
        attach,
        h('div', { class: 'composer-inner' }, photoBtn(showAttach), ta, micBtn(ta), sendBtn),
        h('p', { class: 'composer-note' }, t('composerNote')))));
    renderThread();
    window.scrollTo(0, document.body.scrollHeight);
  }

  // ---------- sending ----------
  async function send(text) {
    text = (text || '').trim();
    if (busy || (!text && !pendingImage)) return;
    busy = true;
    const image = pendingImage;
    pendingImage = null;
    const a = root.querySelector('.attach');
    if (a) { a.hidden = true; a.replaceChildren(); }
    s.messages.push({ role: 'user', text, photo: Boolean(image) });
    renderThread();
    const typing = h('div', { class: 'msg-row agent' }, h('span', { class: 'avatar' }, h('img', { src: '/icon.svg', alt: '' })),
      h('div', { class: 'bubble typing', 'aria-label': t('thinking') }, h('i'), h('i'), h('i')));
    thread.append(typing);
    scrollDown();
    try {
      const res = await api('/api/chat', { method: 'POST', body: {
        messages: s.messages.map((m) => ({ role: m.role, text: m.role === 'user' ? (m.text || (m.photo ? '(sent a photo of the message)' : '')) : msgText(m) })),
        image: image && { mimeType: image.mimeType, base64: image.base64 },
        lang: window.UI.lang,
        for_whom: s.forWhom,
        state: { reason_ids: s.reason_ids, shown_fix: s.shown_fix, extracted: s.extracted, has_details: Object.keys(s.details).length > 0, case_saved: Boolean(s.caseUrl) },
      } });
      s.reason_ids = res.reason_ids || s.reason_ids;
      s.extracted = res.extracted || s.extracted;
      for (const c of res.cards || []) if (c.type === 'fix') s.shown_fix = [...new Set([...s.shown_fix, ...c.reason_ids])];
      s.messages.push({ role: 'agent', text: res.reply, key: res.reply ? null : res.reply_key, cards: res.cards || [], quick: res.quick_replies || [] });
    } catch (e) {
      s.messages.push({ role: 'agent', text: e.status === 429 ? e.message : null, key: e.status === 429 ? null : 'fb_error', cards: [{ type: 'human' }], quick: [] });
    }
    busy = false;
    save();
    renderThread();
    scrollDown();
  }

  // ---------- cards ----------
  // replaceChildren() would print arrays and nulls as text; flatten and drop empties first
  function fillBox(box, ...nodes) {
    box.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
  }
  function cardNode(c) {
    if (c.type === 'fix') return fixCard(c);
    if (c.type === 'letters') return lettersCard();
    if (c.type === 'save_case') return saveCard();
    if (c.type === 'human') return humanCard();
    return null;
  }

  function fixCard(c) {
    return h('div', { class: 'ccard' },
      h('div', { class: 'kicker' }, icon('check', 16), t('cardFix')),
      c.problems.map((p) => h('div', { class: 'problem-block' },
        h('h3', {}, p.title),
        h('span', { class: 'who' }, icon('user', 16), t('whoFixes'), ' ', p.who_fixes),
        p.needs_check ? h('p', { class: 'small', style: undefined }, t('checkPortal')) : null,
        h('ol', { class: 'steps' }, p.steps.map((step, i) => {
          const k = `${p.id}:${i}`;
          const box = h('input', { type: 'checkbox', checked: Boolean(s.ticks[k]) });
          const li = h('li', { class: s.ticks[k] ? 'done' : '' }, h('label', { class: 'check' }, box, h('span', {}, step)));
          box.addEventListener('change', () => { s.ticks[k] = box.checked; li.classList.toggle('done', box.checked); save(); });
          return li;
        })),
        p.documents && p.documents.length ? [h('p', { class: 'small mb0' }, h('strong', {}, t('documents'))), h('ul', { class: 'docs' }, p.documents.map((d) => h('li', {}, d)))] : null)),
      c.escalation && c.escalation.length ? h('details', {},
        h('summary', {}, icon('clock', 18), t('escalationTitle')),
        h('ol', { class: 'ladder' }, c.escalation.map((e) => h('li', {}, h('strong', {}, e.name), ' ', h('span', { class: 'pill' }, e.after_days ? t('afterDays', { n: e.after_days }) : t('now')), h('p', { class: 'small muted mb0' }, e.action))))) : null);
  }

  function field(key, value) {
    if (key === 'claim_type') {
      return h('label', { class: 'field' }, t('f_claim_type'), h('select', { class: 'full', name: key },
        ['final_settlement', 'partial_withdrawal', 'pension', 'transfer', 'unknown'].map((v) => h('option', { value: v, selected: v === (value || 'unknown') }, t(`ct_${v}`)))));
    }
    const type = DATE_FIELDS.includes(key) ? 'date' : /mobile/.test(key) ? 'tel' : 'text';
    return h('label', { class: 'field' }, t(`f_${key}`),
      h('input', { type, name: key, value: type === 'date' ? toIso(value) : value || '', inputmode: key === 'uan' ? 'numeric' : undefined, maxlength: key === 'uan' ? '12' : undefined }));
  }

  function readForm(form) {
    const out = {};
    for (const el of form.querySelectorAll('input[name], select[name]')) {
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.value.trim()) out[el.name] = el.value.trim();
    }
    return out;
  }

  function lettersCard() {
    const box = h('div', { class: 'ccard' }, h('span', { class: 'spinner' }));
    let askedOnce = Object.keys(s.details).length > 0;
    async function draw() {
      let out;
      try {
        out = await api('/api/letters', { method: 'POST', body: { reason_ids: s.reason_ids, extracted: s.extracted, details: s.details, lang: window.UI.lang } });
      } catch (e) {
        box.replaceChildren(h('p', { class: 'error' }, e.message));
        return;
      }
      if (!out.letters.length) { box.replaceChildren(h('p', { class: 'mb0' }, t('noLetters'))); return; }
      const missing = [...new Set(['name', 'uan', 'mobile', 'filed_date', ...out.missing.map((m) => m.key)])].filter((k) => !ASKED_LATER.includes(k) && !s.details[k] && !(k === 'filed_date' && s.extracted.filed_date) && !(k === 'remark' && s.extracted.remark));
      if (missing.length && !askedOnce) {
        const form = h('form', {},
          h('div', { class: 'kicker' }, icon('file', 16), t('lettersCardTitle')),
          h('p', { class: 'small' }, t('lettersNeed')),
          missing.map((k) => field(k, k === 'filed_date' ? s.extracted.filed_date : '')),
          out.letters.some((l) => l.key === 'epfigms') ? h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'kyc_verified' }), h('span', { class: 'small' }, t('kycVerified'))) : null,
          h('p', { class: 'small muted' }, icon('lock', 14), ' ', t('noAadhaar')),
          h('button', { class: 'btn', type: 'submit' }, t('writeLetters')));
        form.addEventListener('submit', (e) => { e.preventDefault(); Object.assign(s.details, readForm(form)); askedOnce = true; save(); box.replaceChildren(h('span', { class: 'spinner' })); draw(); });
        box.replaceChildren(form);
        return;
      }
      fillBox(box,
        h('div', { class: 'kicker' }, icon('file', 16), t('lettersCardTitle')),
        out.letters.map((l) => h('details', { open: out.letters.length === 1 },
          h('summary', {}, l.title, ' ', l.status === 'wait' ? h('span', { class: 'pill warn' }, t('waitUntil', { date: l.send_on })) : h('span', { class: 'pill' }, t('ready'))),
          h('p', { class: 'small muted' }, '→ ', l.where),
          l.note ? h('p', { class: 'small' }, l.note) : null,
          h('div', { class: 'letter', tabindex: '0' }, l.text),
          h('div', {}, copyButton(t('copyLetter'), () => l.text, 'btn small'),
            SITES[l.where] ? h('a', { class: 'btn secondary small', href: SITES[l.where], target: '_blank', rel: 'noopener' }, icon('external', 16), t('openSite', { site: l.where })) : null))),
        missing.length ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => { askedOnce = false; draw(); } }, t('addDetails')) : null);
    }
    draw();
    return box;
  }

  function saveCard() {
    const box = h('div', { class: 'ccard' });
    function done() {
      box.replaceChildren(h('div', { class: 'kicker' }, icon('bell', 16), t('saveCardTitle')), h('p', {}, t('caseSaved')),
        h('a', { class: 'btn', href: s.caseUrl }, t('openCase')));
    }
    if (s.caseUrl) { done(); return box; }
    const need = ['name', 'mobile', 'filed_date'].filter((k) => !s.details[k] && !(k === 'filed_date' && s.extracted.filed_date));
    const form = h('form', {},
      h('div', { class: 'kicker' }, icon('bell', 16), t('saveCardTitle')),
      h('p', { class: 'small' }, t('saveCardBody')),
      s.forWhom === 'family' ? [h('label', { class: 'field' }, t('helperName'), h('input', { type: 'text', name: 'helper_name' })), h('label', { class: 'field' }, t('helperMobile'), h('input', { type: 'tel', name: 'helper_mobile' }))] : null,
      need.map((k) => field(k, '')),
      h('button', { class: 'btn', type: 'submit' }, t('saveCaseBtn')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { helper_name: helperName, ...more } = readForm(form);
      Object.assign(s.details, more);
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        const c = await api('/api/cases', { method: 'POST', body: {
          for_whom: s.forWhom, helper_name: helperName, lang: window.UI.lang,
          problem_text: s.messages.filter((m) => m.role === 'user').map((m) => m.text).join('\n').slice(0, 2000),
          reason_ids: s.reason_ids, extracted: { ...s.extracted, filed_date: s.details.filed_date || s.extracted.filed_date },
          needs_human: s.reason_ids.length === 0, confidence: s.reason_ids.length ? 'medium' : 'low', details: s.details,
        } });
        s.caseUrl = c.url;
        save();
        done();
      } catch (err) {
        btn.disabled = false;
        form.append(h('p', { class: 'error' }, err.message));
      }
    });
    box.append(form);
    return box;
  }

  function humanCard() {
    const n = config.support_whatsapp;
    const last = s.messages.filter((m) => m.role === 'user').slice(-2).map((m) => m.text).join(' / ');
    return h('div', { class: 'ccard' },
      h('div', { class: 'kicker' }, icon('users', 16), t('humanCard')),
      n ? h('a', { class: 'btn wa', href: waLink(n, `Hi, I need help with a PF claim. ${last}`.slice(0, 500)), target: '_blank', rel: 'noopener' }, icon('whatsapp'), t('whatsappUs'))
        : h('p', { class: 'small mb0' }, t('humanSoon')));
  }

  // ---------- voice and photo ----------
  function micBtn(ta) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    const b = h('button', { class: 'round', type: 'button', 'aria-label': t('speak') }, icon('mic', 22));
    let rec = null;
    b.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = SPEECH_LANG[window.UI.lang] || 'en-IN';
      rec.continuous = true;
      const base = ta.value ? `${ta.value} ` : '';
      let heard = '';
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) heard += `${e.results[i][0].transcript} `;
        ta.value = base + heard;
      };
      rec.onend = () => { rec = null; b.classList.remove('live'); b.setAttribute('aria-label', t('speak')); };
      rec.onerror = () => rec && rec.stop();
      rec.start();
      b.classList.add('live');
      b.setAttribute('aria-label', t('listening'));
    });
    return b;
  }

  function photoBtn(onChange) {
    const input = h('input', { type: 'file', accept: 'image/*', class: 'sr', id: 'chatphoto' });
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      pendingImage = await shrink(f);
      input.value = '';
      onChange();
    });
    return h('label', { class: 'round', for: 'chatphoto', tabindex: '0', role: 'button', 'aria-label': t('addPhoto'),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } }, icon('camera', 22), input);
  }

  async function shrink(file) {
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
      return { mimeType: file.type || 'image/jpeg', base64: raw.split(',')[1], preview: raw };
    }
  }

  window.PFChat = {
    start(cfg, el) { config = cfg || {}; root = el; load(); render(); },
    render() { if (root) render(); },
  };
})();
