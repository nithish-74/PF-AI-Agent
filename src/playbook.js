// Loads the playbook and exposes the rule-based matcher.
const { reasons } = require('../playbook/rejections.json');
const { ladder } = require('../playbook/escalation.json');
const { templates } = require('../playbook/templates.json');

const byId = Object.fromEntries(reasons.map((r) => [r.id, r]));

// Keyword match against EPFO remarks. Fast, free, works offline.
function matchRules(text) {
  const t = (text || '').toLowerCase();
  return reasons
    .map((r) => ({ id: r.id, score: r.match.filter((m) => t.includes(m)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.id);
}

module.exports = { reasons, byId, ladder, templates, matchRules };
