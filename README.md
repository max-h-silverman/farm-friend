# Farm Friend

AI-powered SMS farm volunteer and gleaning coordinator for Vashon Island.

See **[CLAUDE.md](./CLAUDE.md)** for the product premise, design philosophy, and stack.

## Repo layout

```
farm-friend/
├── CLAUDE.md                      # product/design source of truth
├── firebase.json                  # Firebase project config
├── firestore.rules                # Firestore security rules (deny-by-default)
├── firestore.indexes.json         # Composite indexes
├── .firebaserc                    # Firebase project IDs (per env)
├── functions/                     # Firebase Functions (Python 3.12)
│   ├── pyproject.toml
│   ├── main.py                    # Functions entrypoint
│   ├── app/
│   │   ├── config.py              # Secrets / params
│   │   ├── llm/                   # LLM portability layer
│   │   ├── messaging/             # SMS provider abstraction
│   │   ├── repos/                 # Firestore data access (the only place that imports firestore directly)
│   │   ├── agent/                 # LLM-driven tasks (parser, classifier, ambiguous handler)
│   │   ├── flows/                 # Business logic (opportunity lifecycle, outreach, claims, post-event)
│   │   ├── prompts/               # System prompts as versioned text files
│   │   └── copy/                  # SMS-facing copy templates
│   └── tests/
└── web/                           # Admin SPA (Alpine.js + Firebase JS SDK)
    ├── public/
    │   ├── index.html
    │   └── farmfriend.vcf         # Contact card for first-time SMS recipients
    └── src/
        └── app.ts
```

## Local development

### Prerequisites
- Python 3.12+
- Node.js 20+ (for Firebase CLI + admin SPA tooling)
- `firebase-tools` CLI: `npm i -g firebase-tools`
- A Firebase project (free tier is fine for the pilot)

### First-time setup

```bash
# Install Functions deps
cd functions
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# Link to your Firebase project
cd ..
firebase use --add   # follow prompts; sets .firebaserc

# Copy env template, fill in secrets
cp .env.example .env
```

### Run locally with emulators

```bash
firebase emulators:start
```

This starts the Functions, Firestore, Auth, and Hosting emulators. The admin SPA serves at `http://localhost:5000`; the Functions HTTP webhook at `http://localhost:5001/{project-id}/us-central1/{function-name}`.

### Run tests

```bash
cd functions
pytest
```

Integration tests start a Firestore emulator on a random port; ensure `firebase-tools` is on `PATH`.

## Deploying

```bash
firebase deploy
```

Deploys Functions, Firestore rules + indexes, and Hosting. For just one piece:

```bash
firebase deploy --only functions
firebase deploy --only hosting
firebase deploy --only firestore:rules
```

## Required Firebase setup (out-of-band)

These steps must be done in the Firebase Console before the app will work end-to-end:

1. **Create a Firebase project** (use the free Spark plan; upgrade to Blaze before deploying Functions 2nd gen — required for outbound HTTPS).
2. **Enable**: Authentication (Email + Google providers), Firestore, Cloud Functions, Cloud Scheduler, Hosting.
3. **Secrets** (set via `firebase functions:secrets:set`):
   - `ANTHROPIC_API_KEY`
   - `TELNYX_API_KEY`
   - `TELNYX_PUBLIC_KEY` (for webhook signature verification)
4. **Telnyx**:
   - Provision a US 10DLC number.
   - Register a brand + campaign (required for A2P 10DLC delivery).
   - Configure the inbound webhook to point at the deployed `inbound_sms` Function URL.
5. **Admin account**: in Firebase Auth, after signing in with your Google account once, manually set the custom claim `admin=true` on your user record (one-time, via `set-admin` script in `functions/scripts/`).

## Pilot deployment notes

See `CLAUDE.md` for cost constraints and the LLM portability story (default Anthropic; designed to swap to self-hosted open-weight later).
