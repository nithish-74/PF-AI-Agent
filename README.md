# PF AI Agent (PF Rescue)

Helps people in India fix **rejected and stuck EPF (provident fund) claims**. It works out why the claim failed, gives step-by-step fixes in the user's language, writes the grievance, CPGRAMS, RTI and HR letters, and reminds them when to escalate. It's built so a son or daughter can run the case for an elderly parent.

## How it works

```
user (or their child) on a phone
  │  types / speaks / photographs the rejection message
  ▼
mask Aadhaar, UAN & account numbers
  ▼
Gemini classifies the problem ──(no key / error)──► keyword rules
(only from playbook ids)                          unsure ──► your team queue
  ▼
fix plan from the PLAYBOOK  ← AI never writes the steps
  ▼
letters filled locally (EPFiGMS → CPGRAMS → RTI, HR email)
  ▼
case tracker: private link, checklist, deadlines, calendar reminders
```

**Safety rule:** the AI only *classifies* and *translates*. Every fix step comes from `playbook/`, which humans check, so the agent can't invent EPFO rules. Letter translation sends only the blank template to Gemini, never the user's details.

## Run it

```bash
npm install
cp .env.example .env     # add GEMINI_API_KEY (free: https://aistudio.google.com/apikey), ADMIN_KEY, SUPPORT_WHATSAPP
npm start                # http://localhost:3000   (team queue: /admin)
npm test                 # 39 tests, no key needed
```

Without a Gemini key everything still works using keyword rules. Answers stay in English, and photos can't be read.

Other tools:

```bash
npm run reminders                                              # who needs a nudge today, with WhatsApp links
node scripts/try.js "mera claim reject ho gaya, cheque photo clear nahi tha" hi
node scripts/letters.js "status: sent to field office" scripts/sample-details.json
```

## The website

| Screen | What it does |
|---|---|
| Chat (home) | A WhatsApp-style chat with the PF Rescue agent. Type in any language, tap the mic to speak, or send a photo of the SMS. The agent asks one question at a time, explains the problem in plain words, answers follow-ups ("papa ko password yaad nahi"), and shows cards inside the chat: a **fix checklist** (from the playbook), **letters** (details collected by a form, never through the AI), **save case** for reminders, and **talk to a person** (WhatsApp). Remembers the conversation in the browser. |
| Case page `/c/<id>#<token>` | Private link (the token sits in the `#` part, so it never reaches server logs). Shows "to do now", the next deadline with **add to phone calendar**, the steps checklist, letters with copy / open portal / **I sent it**, "I filed again" and "Money received". |
| `/admin` | Your queue: every case, most urgent first, with WhatsApp buttons, a way to re-classify a case the AI got wrong, and the total recovered. That's your YC number. |

Design: a "paper and ink" look (cream paper, serif headings, marigold highlighter), always light, even in dark mode. Built for older users: 18px+ text, high contrast, large tap targets, one action per screen, and plain sentences. It works on cheap Android phones, with no app to install.

## Project layout

| Path | What it is |
|---|---|
| `playbook/rejections.json` | 13 rejection reasons: plain explanation, who fixes it, steps, documents, what to ask the employer |
| `playbook/escalation.json` | Escalation ladder: EPFiGMS → CPGRAMS → RTI → regional office |
| `playbook/templates.json` | Letter templates |
| `playbook/basics.json` | Everyday portal help the agent may use (forgot password, find UAN, claim status…) |
| `src/diagnose.js` | Classify → build plan → translate |
| `src/letters.js` | Fills the letters from the diagnosis and user details |
| `src/escalation.js` | Which escalation step is due, from the filing date |
| `src/cases.js` | Case tracker: create, update, reminders, team queue |
| `src/store.js` | JSON-file storage in `data/` (swap for a database later) |
| `src/agent.js` | The chat agent: Gemini prompt grounded in the playbook, cards, rules fallback |
| `src/server.js` | Web server + API, no framework |
| `public/` | The website (plain HTML/CSS/JS, no build step) |
| `test/` | Tests (fake Gemini, temporary data folder) |

## API

| Method | Path | Body / headers |
|---|---|---|
| GET | `/api/config` | Languages, WhatsApp number, fee |
| POST | `/api/chat` | `{messages:[{role,text}], image?, lang, for_whom, state}` → `{reply, quick_replies, cards, reason_ids, extracted}` |
| POST | `/api/diagnose` | `{text, image:{mimeType, base64}, lang}` |
| POST | `/api/letters` | `{reason_ids, extracted, details, lang}` |
| POST | `/api/cases` | Creates a case and returns `{id, token, url}` |
| GET/PATCH | `/api/cases/:id` | Header `X-Case-Token`. PATCH accepts `{details}`, `{step:{key,done}}`, `{event:{type,date,...}}` |
| GET | `/api/admin/cases` | Header `X-Admin-Key` |

## Deploying

Any Node 22+ host works, for example Render, Railway, Fly.io, or a ₹400/month VPS.

1. Set the env vars from `.env.example` in the host's dashboard. Never commit `.env`.
2. Start command: `npm start`.
3. **Cases are saved to disk** (`DATA_DIR`). Use a host with a persistent disk (Render disk, Fly volume, a VPS), or cases will vanish on redeploy. Move to Postgres once you pass a few hundred cases.
4. Schedule `npm run reminders` every morning (cron), or just run it yourself.

Before taking real users' data: add a short privacy notice (what you store, why, how to delete), keep `ADMIN_KEY` long and secret, and turn on HTTPS. Most hosts do HTTPS for you.

## Roadmap
- [x] Day 1 – Playbook, escalation ladder, letter templates
- [x] Day 2 – AI diagnosis (text + screenshot), privacy masking, translation
- [x] Day 3 – Letter generator + escalation timeline
- [x] Day 4 – Mobile-first website (voice, photo, 8 languages)
- [x] Day 5 – Case tracker, reminders, family mode, team queue
- [ ] Day 6 – Test with 3–5 real people (including one older person)
- [ ] Day 7 – Deploy and take the first 10 real cases

Later: WhatsApp bot (Meta Business API), have native speakers review the Hindi and Tamil text, button text for the other 5 languages, a database, and payment collection for the success fee.

> This tool gives general guidance based on public EPFO processes. It is not affiliated with EPFO. Always check the official portal.
