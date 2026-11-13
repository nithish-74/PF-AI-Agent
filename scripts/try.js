// Try the agent from the terminal:
//   node scripts/try.js "my claim got rejected, name mismatch" [lang]
//   node scripts/try.js --image screenshot.png [lang]
// Uses Gemini if GEMINI_API_KEY is set, otherwise rules only.
const fs = require('fs');
const path = require('path');
const { diagnose } = require('../src/diagnose');

async function main() {
  const args = process.argv.slice(2);
  let text = '';
  let image = null;
  if (args[0] === '--image') {
    const file = args[1];
    const ext = path.extname(file).slice(1).toLowerCase();
    image = { mimeType: ext === 'png' ? 'image/png' : 'image/jpeg', base64: fs.readFileSync(file).toString('base64') };
    args.splice(0, 2);
  } else {
    text = args.shift() || '';
  }
  const lang = args[0] || 'en';
  const r = await diagnose({ text, image, lang });
  console.log(JSON.stringify(r, null, 2));
}

main();
