# Farm Friend

AI-powered SMS farm volunteer and gleaning coordinator for Vashon Island.

For product premise, design philosophy, and the up-to-date status / next-steps list, see **[CLAUDE.md](./CLAUDE.md)**. For one-time external-service setup (Firebase project, Telnyx 10DLC, Anthropic key, admin bootstrap), see **[OPS.md](./OPS.md)**.

## Repo layout

```
farm-friend/
├── CLAUDE.md                       # product/design source of truth + status
├── OPS.md                          # external-service setup runbook
├── README.md                       # this file
├── firebase.json                   # Firebase project + emulator config
├── firestore.rules                 # Firestore security rules (deny-by-default; admin custom claim required)
├── firestore.indexes.json          # Composite indexes for our queries
├── .firebaserc                     # Firebase project ids (per env)
├── .env.example                    # template; real values live in .env.<project> (gitignored)
├── functions/                      # Firebase Functions (Python 3.12)
│   ├── main.py                     # entrypoint — registers all functions
│   ├── pyproject.toml
│   ├── requirements.txt            # MUST stay in sync with pyproject.toml (Firebase reads this at deploy)
│   ├── app/
│   │   ├── config.py               # secrets + params (lazy, called inside function invocations)
│   │   ├── firebase_app.py         # Admin SDK singleton (lazy init)
│   │   ├── llm/                    # LLMClient — Anthropic adapter + OpenAI-compatible adapter
│   │   ├── messaging/              # MessagingProvider abstraction + Telnyx + fake; safe_send wrapper
│   │   ├── repos/                  # Firestore data access (the ONLY place that imports firestore directly)
│   │   ├── agent/                  # hotkeys (deterministic), opportunity parser, reply classifier, ambiguous handler
│   │   ├── flows/                  # business logic (message_dispatch, outreach, claim, post_event)
│   │   ├── prompts/                # LLM system prompts as versioned text files
│   │   ├── copy/                   # SMS-facing copy templates
│   │   └── admin/                  # callable functions for the admin SPA
│   ├── scripts/
│   │   ├── set_admin.py            # one-time: grant admin claim to a Firebase Auth user
│   │   ├── seed_smoke_test.py      # seed a test farmer/farm/volunteer/insider into Firestore
│   │   └── fire_inbound_sms.py     # POST a Telnyx-shaped payload at the deployed webhook (smoke testing)
│   └── tests/                      # pytest; pure-logic unit tests (no Firebase needed)
└── web/                            # Admin SPA (Alpine.js + Firebase JS SDK on Firebase Hosting)
    └── public/
        ├── index.html              # main dashboard
        ├── app.js                  # state + Firestore subscriptions + callable invocations
        ├── styles.css
        ├── privacy.html            # /privacy — required by Telnyx 10DLC
        ├── terms.html              # /terms — required by Telnyx 10DLC
        └── farmfriend.vcf          # contact card sent in first-contact SMS
```

## Local development

### Prerequisites
- Python 3.12 (deploy target — **must match locally for the deploy analyzer to work**)
- Node.js 20+
- `firebase-tools` CLI: `npm i -g firebase-tools`
- A Firebase project linked via `firebase use --add`

### First-time setup

Firebase's Python deploy analyzer imports your code, so it requires a venv named exactly `venv` inside `functions/` with all deps installed:

```bash
cd functions
python3.12 -m venv venv
venv/bin/pip install -r requirements.txt
venv/bin/pip install pytest pytest-asyncio pytest-mock freezegun   # dev-only test deps
```

> The `venv/` directory is gitignored. If you blow it away you must recreate it before `firebase deploy` will work.

### Run tests

```bash
cd functions
venv/bin/python -m pytest tests/
```

Tests are pure-logic only (hotkey parser, copy templates, LLM client schema validation, time formatting) — no Firebase touched. ~48 tests, <2 seconds.

### Run locally with emulators

```bash
firebase emulators:start
```

Starts Functions / Firestore / Auth / Hosting / UI emulators. Admin SPA at `http://localhost:5000`, webhook at `http://localhost:5001/<project-id>/us-west1/inbound_sms`, emulator UI at `http://localhost:4000`.

## Deploying

Whole project:

```bash
firebase deploy
```

Or just one piece:

```bash
firebase deploy --only functions
firebase deploy --only hosting
firebase deploy --only firestore:rules
firebase deploy --only firestore:indexes
```

Indexes deploy returns instantly but builds asynchronously (2–5 min). Watch the Firestore Console → Indexes tab until everything shows **Enabled** before exercising queries that depend on them.

## Smoke testing without real SMS

The deployed webhook accepts a **smoke-test bypass** when an `X-Smoke-Test-Token` header matches the `SMOKE_TEST_TOKEN` Firebase secret. Lets you simulate inbound SMS end-to-end without touching Telnyx.

```bash
# Seed a fake farmer + farm + volunteer + insider link
GOOGLE_APPLICATION_CREDENTIALS=~/secrets/farm-friend-vashon-firebase-adminsdk-*.json \
  venv/bin/python scripts/seed_smoke_test.py \
    --farmer-phone +15163178228 \
    --volunteer-phone +15555550199

# Fire a simulated inbound from the farmer
SMOKE_TEST_TOKEN=<your-token-value-from-secret-manager> \
  venv/bin/python scripts/fire_inbound_sms.py \
    --url https://us-west1-farm-friend-vashon.cloudfunctions.net/inbound_sms \
    --from +15163178228 \
    --body "need 2 ppl tomorrow 10am to harvest greens"
```

Expected: `Status: 200 / Body: ok`. The opportunity will appear in the admin SPA's Opportunities tab within a few seconds. Outbound sends will silently fail until the real Telnyx `from`-number is wired up — that's expected; see `app/messaging/_safe_send.py`.

## External-service setup

See **[OPS.md](./OPS.md)** for the one-time setup of Firebase project, Telnyx 10DLC brand + campaign, Anthropic API key, admin claim bootstrap, and pilot-launch checklist.
