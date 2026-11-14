// Small helpers shared by the app and admin pages. All text goes in via
// textContent, never innerHTML, so nothing a user types can run as code.
(function () {
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  let lang = store.get('lang') || 'en';

  function t(key, vars) {
    const dict = window.I18N[lang] || window.I18N.en;
    let s = dict[key] ?? window.I18N.en[key] ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
    return s;
  }

  // h('div', {class: 'x', onclick: fn}, 'text', child, [more])
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  async function api(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || t('errorGeneric'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {
      const ta = h('textarea', { class: 'sr' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      return ok;
    }
  }

  // Button that shows "Copied!" for a moment
  function copyButton(label, getText, cls = 'btn secondary small') {
    const b = h('button', { class: cls, type: 'button' }, label);
    b.addEventListener('click', async () => {
      if (await copy(getText())) {
        b.textContent = t('copied');
        setTimeout(() => { b.textContent = label; }, 1800);
      }
    });
    return b;
  }

  function waLink(number, text) {
    const n = (number || '').replace(/\D/g, '');
    return `https://wa.me/${n}?text=${encodeURIComponent(text)}`;
  }

  // DD-MM-YYYY → YYYY-MM-DD for <input type=date>
  function toIso(d) {
    if (!d) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    const m = d.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
  }

  // All-day calendar event with a morning alarm, as a downloadable .ics
  function icsFile({ title, date, description, url }) {
    const ymd = toIso(date).replace(/-/g, '');
    const next = new Date(`${toIso(date)}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const end = next.toISOString().slice(0, 10).replace(/-/g, '');
    const esc = (s) => String(s).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PF Rescue//EN', 'BEGIN:VEVENT',
      `UID:${Date.now()}-${Math.random().toString(36).slice(2)}@pf-rescue`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
      `DTSTART;VALUE=DATE:${ymd}`, `DTEND;VALUE=DATE:${end}`,
      `SUMMARY:${esc(title)}`, `DESCRIPTION:${esc(`${description}\n${url}`)}`,
      'BEGIN:VALARM', 'TRIGGER:PT9H', 'ACTION:DISPLAY', `DESCRIPTION:${esc(title)}`, 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR',
    ];
    return new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // Simple modal form. fields: [{name, label, type, value}] → resolves values or null
  function ask(title, fields) {
    return new Promise((resolve) => {
      const inputs = {};
      const form = h('form', { method: 'dialog' },
        h('h2', { text: title }),
        fields.map((f) => h('label', { class: 'field' }, f.label,
          (inputs[f.name] = h('input', { type: f.type || 'text', name: f.name, value: f.value || '', inputmode: f.inputmode })))),
        h('div', { class: 'row' },
          h('button', { class: 'btn secondary', value: 'cancel', type: 'submit' }, t('cancel')),
          h('button', { class: 'btn', value: 'ok', type: 'submit' }, t('save'))));
      const dlg = h('dialog', {}, form);
      document.body.append(dlg);
      dlg.addEventListener('close', () => {
        const ok = dlg.returnValue === 'ok';
        const out = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value.trim()]));
        dlg.remove();
        resolve(ok ? out : null);
      });
      dlg.showModal();
    });
  }

  window.UI = {
    t, h, api, copy, copyButton, waLink, toIso, icsFile, download, ask, store,
    get lang() { return lang; },
    setLang(l) { lang = l || 'en'; store.set('lang', lang); document.documentElement.lang = lang; },
  };
})();
