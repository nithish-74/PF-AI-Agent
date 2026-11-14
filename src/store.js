// Tiny JSON-file store for cases. Good enough for the first few hundred
// cases; swap for Postgres/SQLite later without touching the rest of the code.
// Data lives in DATA_DIR (default ./data), which is git-ignored.
const fs = require('fs');
const path = require('path');

function dir() {
  return process.env.DATA_DIR || path.join(__dirname, '..', 'data');
}

function file() {
  return path.join(dir(), 'cases.json');
}

let cache = null;
let cacheFile = null;

function load() {
  if (cache && cacheFile === file()) return cache;
  cacheFile = file();
  try {
    cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    cache = {};
  }
  return cache;
}

function save() {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, file()); // atomic on the same disk
}

module.exports = {
  get: (id) => load()[id] || null,
  all: () => Object.values(load()),
  put: (c) => {
    load()[c.id] = c;
    save();
    return c;
  },
  reset: () => { cache = null; cacheFile = null; },
};
