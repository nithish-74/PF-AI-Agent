// Daily reminders for the team: run every morning (or schedule it).
//   npm run reminders
// Prints every case that needs action today, with a WhatsApp click-to-chat link
// you can open to send the message yourself (until the WhatsApp bot exists).
const { queue } = require('../src/cases');

const rows = queue().filter((c) => c.status === 'open' && c.reminders.due.length);
if (!rows.length) {
  console.log('Nothing due today.');
  process.exit(0);
}
console.log(`${rows.length} case(s) need action today:\n`);
for (const c of rows) {
  console.log(`#${c.id}  ${c.name || '(no name)'}  ${c.mobile || '(no mobile)'}  [${c.reason_ids.join(', ') || 'unclassified'}]`);
  for (const r of c.reminders.due) console.log(`   - [${r.who}] ${r.text}`);
  if (c.mobile) {
    const n = `91${c.mobile.replace(/\D/g, '').slice(-10)}`;
    const text = `Hi${c.name ? ` ${c.name}` : ''}, this is PF Rescue. ${c.reminders.due[0].text} Open your case link to see the letter.`;
    console.log(`   WhatsApp: https://wa.me/${n}?text=${encodeURIComponent(text)}`);
  }
  console.log('');
}
