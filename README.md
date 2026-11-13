# PF Rescue

AI that helps people fix rejected and stuck EPF (provident fund) claims.

- `playbook/rejections.json` — every common rejection reason, plain-language explanation, and fix steps
- `playbook/escalation.json` — escalation ladder (EPFiGMS → CPGRAMS → RTI → regional office)
- `playbook/templates.json` — grievance, CPGRAMS, RTI and employer email templates
- `scripts/diagnose.js` — matches an EPFO rejection remark to the playbook (`node scripts/diagnose.js` runs tests)
