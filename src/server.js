// Web server: serves the mobile website (public/) and a small JSON API.
// No framework on purpose: fewer moving parts for a 1-person team.
//
//   npm start            → http://localhost:3000
//
// Env: GEMINI_API_KEY, PORT, DATA_DIR, ADMIN_KEY, SUPPORT_WHATSAPP, PRICE_TEXT
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { diagnose, LANGS } = require('./diagnose');
const { generateLetters } = require('./letters');
const { byId, reasons } = require('./playbook');
const cases = require('./cases');
const gemini = require('./gemini');

const PUBLIC = path.join(__dirname, '..', 'public');
const MAX_BODY = 8 * 1024 * 1024; // screenshots
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/heic'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// --- small helpers ---------------------------------------------------------
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : headers['Content-Type'] || 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Too large. Please send a smaller photo.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Bad JSON')); }
    });
    req.on('error', reject);
  });
}

// Per-IP limit for the endpoints that cost money (Gemini).
const hits = new Map();
function rateLimit(req, limit = 30, windowMs = 60 * 60 * 1000) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  const now = Date.now();
  const h = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (h.length >= limit) throw new HttpError(429, 'Too many requests. Please try again in a while, or WhatsApp us.');
  h.push(now);
  hits.set(ip, h);
}

function cleanImage(image) {
  if (!image) return null;
  if (typeof image.base64 !== 'string' || !IMAGE_TYPES.includes(image.mimeType)) throw new HttpError(400, 'Please send a PNG or JPG photo.');
  return { mimeType: image.mimeType, base64: image.base64.replace(/^data:[^,]+,/, '') };
}

function adminOk(req) {
  const key = process.env.ADMIN_KEY;
  const got = req.headers['x-admin-key'];
  if (!key || typeof got !== 'string') return false;
  const a = Buffer.from(key);
  const b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function serveStatic(req, res, urlPath) {
  // Case pages and admin are single-page routes
  let rel = urlPath;
  if (rel === '/' || rel.startsWith('/c/')) rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html';
  const file = path.resolve(PUBLIC, `.${decodeURIComponent(rel)}`);
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, data, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
  });
}

// --- API -------------------------------------------------------------------
async function api(req, res, url) {
  const { pathname } = url;
  const m = req.method;

  if (m === 'GET' && pathname === '/api/config') {
    return send(res, 200, {
      langs: LANGS,
      ai: gemini.enabled(),
      support_whatsapp: (process.env.SUPPORT_WHATSAPP || '').replace(/\D/g, ''),
      price_text: process.env.PRICE_TEXT || '₹999',
      reasons: reasons.map((r) => ({ id: r.id, title: r.title })),
    });
  }

  if (m === 'POST' && pathname === '/api/diagnose') {
    rateLimit(req);
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.slice(0, 4000) : '';
    const image = cleanImage(body.image);
    if (!text.trim() && !image) throw new HttpError(400, 'Tell us the problem, or add a photo of the message.');
    const lang = LANGS[body.lang] ? body.lang : 'en';
    return send(res, 200, await diagnose({ text, image, lang }));
  }

  if (m === 'POST' && pathname === '/api/letters') {
    rateLimit(req, 60);
    const body = await readJson(req);
    const reasonIds = (Array.isArray(body.reason_ids) ? body.reason_ids : []).filter((id) => byId[id]);
    const out = await generateLetters({
      diagnosis: { reason_ids: reasonIds, extracted: body.extracted || {} },
      details: body.details || {},
      lang: LANGS[body.lang] ? body.lang : 'en',
    });
    return send(res, 200, out);
  }

  if (m === 'POST' && pathname === '/api/cases') {
    rateLimit(req, 20);
    const c = await cases.create(await readJson(req));
    return send(res, 201, { id: c.id, token: c.token, url: `/c/${c.id}#${c.token}` });
  }

  const cm = pathname.match(/^\/api\/cases\/([\w-]{4,20})$/);
  if (cm) {
    const token = req.headers['x-case-token'];
    if (m !== 'GET' && m !== 'PATCH') throw new HttpError(405, 'Method not allowed');
    let c;
    if (adminOk(req)) {
      c = require('./store').get(cm[1]);
      if (!c) throw new HttpError(404, 'Case not found');
    } else {
      c = cases.open(cm[1], token);
    }
    if (m === 'GET') return send(res, 200, await cases.view(c));
    if (m === 'PATCH') {
      const patch = await readJson(req);
      if (patch.reason_ids && !adminOk(req)) delete patch.reason_ids; // only the team re-classifies
      const before = c.reason_ids.join();
      cases.update(c, patch);
      if (c.reason_ids.join() !== before) await cases.rebuildPlan(c);
      return send(res, 200, await cases.view(c));
    }
  }

  if (m === 'GET' && pathname === '/api/admin/cases') {
    if (!adminOk(req)) throw new HttpError(401, 'Wrong admin key');
    return send(res, 200, { cases: cases.queue() });
  }

  throw new HttpError(404, 'Not found');
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      return send(res, status, { error: status === 500 ? 'Something went wrong. Please try again, or WhatsApp us.' : err.message });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => {
    console.log(`PF Rescue running on http://localhost:${port}`);
    console.log(gemini.enabled() ? `AI: Gemini (${gemini.MODEL})` : 'AI: off (no GEMINI_API_KEY) — using keyword rules');
    if (!process.env.ADMIN_KEY) console.log('Admin page disabled: set ADMIN_KEY in .env to use /admin');
  });
}

module.exports = { createServer };
