// Escalation timeline: given the date a claim was filed, work out which
// step of the ladder is due now and when the next one becomes due.
const { ladder } = require('./playbook');

const DAY = 24 * 60 * 60 * 1000;

// Parse YYYY-MM-DD (or DD-MM-YYYY / DD/MM/YYYY) as a UTC date. Returns null if invalid.
function parseDate(s) {
  if (!s) return null;
  if (s instanceof Date) return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
  let m = String(s).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let y, mo, d;
  if (m) [, y, mo, d] = m;
  else if ((m = String(s).trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) [, d, mo, y] = m;
  else return null;
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  return dt.getUTCDate() === +d && dt.getUTCMonth() === +mo - 1 ? dt : null;
}

// Indian style: 14-11-2026
function formatDate(dt) {
  if (!dt) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(dt.getUTCDate())}-${p(dt.getUTCMonth() + 1)}-${dt.getUTCFullYear()}`;
}

function addDays(dt, n) {
  return new Date(dt.getTime() + n * DAY);
}

function daysBetween(a, b) {
  return Math.round((b - a) / DAY);
}

// Returns { days_since_filed, current_step, next_step, steps:[{...ladder step, due_on, is_due}] }
// or null when the filing date is unknown.
function timeline(filedDate, today = new Date()) {
  const filed = parseDate(filedDate);
  const now = parseDate(today);
  if (!filed || !now) return null;
  const days = daysBetween(filed, now);
  const steps = ladder.map((s) => ({
    step: s.step,
    name: s.name,
    template: s.template || null,
    where: s.where,
    response_days: s.response_days || null,
    due_on: formatDate(addDays(filed, s.after_days)),
    is_due: days >= s.after_days,
  }));
  const due = steps.filter((s) => s.is_due);
  return {
    filed_on: formatDate(filed),
    days_since_filed: days,
    current_step: due[due.length - 1] || null,
    next_step: steps.find((s) => !s.is_due) || null,
    steps,
  };
}

module.exports = { timeline, parseDate, formatDate, addDays, daysBetween };
