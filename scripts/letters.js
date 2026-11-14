// Generate ready-to-send letters from the terminal:
//   node scripts/letters.js "<problem / rejection text>" [details.json] [lang]
// Example (sample data, not a real person):
//   node scripts/letters.js "status: sent to field office" scripts/sample-details.json ta
const fs = require('fs');
const { diagnose } = require('../src/diagnose');
const { generateLetters } = require('../src/letters');

async function main() {
  const [text = '', detailsFile, lang = 'en'] = process.argv.slice(2);
  const details = detailsFile ? JSON.parse(fs.readFileSync(detailsFile, 'utf8')) : {};
  const diagnosis = await diagnose({ text });
  const out = await generateLetters({ diagnosis, details, lang });

  console.log(`Problems: ${diagnosis.reason_ids.join(', ') || '(none found — needs a human)'}`);
  if (out.timeline) console.log(`Filed ${out.timeline.filed_on}, ${out.timeline.days_since_filed} days ago`);
  if (!out.letters.length) console.log('\nNo letters needed: follow the fix steps and re-file the claim.');
  for (const l of out.letters) {
    console.log(`\n==== ${l.title} → ${l.where} [${l.status}${l.send_on ? `, from ${l.send_on}` : ''}] ====`);
    console.log(l.text);
    if (l.text_translated) console.log(`\n---- (${l.lang} copy for you to read) ----\n${l.text_translated}`);
    if (l.note) console.log(`\nNote: ${l.note}`);
  }
  if (out.missing.length) console.log(`\nStill need: ${out.missing.map((m) => m.label).join(', ')}`);
  for (const c of out.checks) console.log(`✔ ${c}`);
}

main();
