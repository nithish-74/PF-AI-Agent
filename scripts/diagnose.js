// Rule-based first pass: match an EPFO rejection remark to playbook reasons.
// The AI layer (Day 2) will handle messages this can't match.
const { reasons } = require('../playbook/rejections.json');

function diagnose(remark) {
  const text = remark.toLowerCase();
  const hits = reasons
    .map((r) => ({ r, score: r.match.filter((m) => text.includes(m)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return hits.map((h) => h.r.id);
}

module.exports = { diagnose };

if (require.main === module) {
  // Real rejection remarks seen on Reddit / in news reports
  const samples = [
    ['wages exceeds rs15000 but eps service and contribution received and form 15 g assessment year and previous year wrongly submitted', ['eps_wage_ceiling', 'form_15g']],
    ['Insufficient Service – Not Eligible', ['not_eligible_service']],
    ['Uploaded cheque image not clear / improper cheque image', ['cheque_image']],
    ['Sent to field office', ['stuck_no_reason']],
    ['Member name mismatch with Aadhaar', ['name_mismatch']],
    ['Date of exit not available', ['exit_date']],
  ];
  let pass = 0;
  for (const [remark, expected] of samples) {
    const got = diagnose(remark);
    const ok = expected.every((e) => got.includes(e));
    pass += ok;
    console.log(`${ok ? 'PASS' : 'FAIL'}  "${remark.slice(0, 60)}" -> ${got.join(', ') || '(none)'}`);
  }
  console.log(`\n${pass}/${samples.length} matched`);
  process.exit(pass === samples.length ? 0 : 1);
}
