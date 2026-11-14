# PF AI Agent

An AI agent that helps people in India fix **rejected and stuck EPF (provident fund) claims**: it figures out why the claim failed, gives a step-by-step fix in the user's language, and drafts the grievance, CPGRAMS and RTI letters when EPFO doesn't respond.

## How it works

```
user message / voice-note text / screenshot
        │
        ▼
 mask Aadhaar, UAN & account numbers
        │
        ▼
 Gemini classifies the problem ──(no key / error)──► keyword rules
 (only from playbook ids)
        │
        ▼
 fix plan built from the PLAYBOOK  ← AI never writes the steps
        │
        ▼
 translated into user's language (Hindi, Tamil, Telugu, …)
```

**Safety rule:** the AI only *classifies* and *translates*. Every fix step comes from `playbook/`, which is checked by humans, so the agent can't invent EPFO rules.

## Project layout

| Path | What it is |
|---|---|
| `playbook/rejections.json` | 13 common rejection reasons → plain explanation, who fixes it, steps, documents, what to ask the employer |
| `playbook/escalation.json` | Escalation ladder: EPFiGMS → CPGRAMS → RTI → regional office |
| `playbook/templates.json` | Grievance, CPGRAMS, RTI and employer-email letter templates |
| `src/diagnose.js` | The agent: classify → build plan → translate |
| `src/letters.js` | Letter generator: fills grievance / CPGRAMS / RTI / HR email from the diagnosis + user details |
| `src/escalation.js` | Works out which escalation step is due from the filing date |
| `src/gemini.js` | Gemini API wrapper |
| `src/privacy.js` | Masks ID numbers before anything is sent to the AI |
| `test/` | Tests (run without an API key using a fake Gemini) |

## Run it

```bash
npm install
cp .env.example .env        # add your free key from https://aistudio.google.com/apikey
npm test                    # 18 tests, no key needed

# try it (works without a key using rules only)
node scripts/try.js "claim rejected: name mismatch with aadhaar"
node scripts/try.js "mera claim reject ho gaya, cheque photo clear nahi tha" hi
GEMINI_API_KEY=... node scripts/try.js --image rejection.png ta

# ready-to-send letters (sample-details.json is made-up data)
node scripts/letters.js "status: sent to field office" scripts/sample-details.json
node scripts/letters.js "Rejected: Date of exit not available" scripts/sample-details.json ta
```

## Letters (Day 3)

- Picks the right letters: HR email when the employer must act; EPFiGMS → CPGRAMS → RTI when the claim is stuck.
- Tells you **when** each one can be sent (e.g. CPGRAMS only 35 days after filing), based on `playbook/escalation.json`.
- Anything unknown stays as a visible blank like `[Your mobile number]` and is listed in `missing`, so the app can ask for it.
- Only says "KYC is verified" if the user confirmed it. Never includes Aadhaar.
- Letters to EPFO stay in English; with a language set you also get a translated copy to read. Only the blank template is sent to Gemini, never the user's details.

## Roadmap
- [x] Day 1 – Playbook, escalation ladder, letter templates
- [x] Day 2 – AI diagnosis (text + screenshot), privacy masking, translation
- [x] Day 3 – Letter generator (auto-filled grievance / RTI) + escalation timeline
- [ ] Day 4 – Mobile-first website
- [ ] Day 5 – Case tracker, reminders, family mode
- [ ] Day 6 – Testing with real users
- [ ] Day 7 – Launch

> This tool gives general guidance based on public EPFO processes. It is not affiliated with EPFO. Always check the official portal.
