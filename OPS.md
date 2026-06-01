# Operational setup

Things that aren't code — the manual steps you need to do once before any of this runs end-to-end.

## 1. Firebase project

1. Create a Firebase project (Console → "Add project"). Suggested name: `Farm Friend Vashon`.
2. Upgrade billing to **Blaze (pay as you go)**. Required for Functions 2nd gen (which we use). Set a budget alert at $20/month for safety.
3. Update `.firebaserc` with the actual project ID:
   ```json
   { "projects": { "default": "<your-project-id>" } }
   ```
4. Enable these products in the Console:
   - **Authentication** — enable Google sign-in provider.
   - **Firestore Database** — create in production mode, region `us-west1` (closest to Vashon).
   - **Cloud Functions** (auto-enabled when you deploy).
   - **Cloud Scheduler** (auto-enabled by scheduled functions).
   - **Hosting**.

## 2. Telnyx

1. Sign up at telnyx.com.
2. Buy a **US 10DLC number** (Mission Control Portal → Numbers → Search & Buy).
3. Register a **brand** and a **campaign** (required for A2P 10DLC delivery). Pick "Higher Education / Not for Profit" as the campaign use case — fits the volunteer coordination model and is cheaper to register.
4. In Messaging → Profiles, create a profile if you don't have one and assign the number to it.
5. Configure the inbound webhook to point to the deployed `inbound_sms` function URL:
   ```
   https://<region>-<project-id>.cloudfunctions.net/inbound_sms
   ```
   (Get this URL after the first `firebase deploy --only functions`.)
6. Grab your **API key** and **public key** (Auth → Manage Public Keys) and set them as secrets:
   ```bash
   firebase functions:secrets:set TELNYX_API_KEY
   firebase functions:secrets:set TELNYX_PUBLIC_KEY
   ```
7. Set the From number as a deploy-time config:
   ```bash
   firebase functions:config:set TELNYX_FROM_NUMBER="+1XXXXXXXXXX"
   ```
   Or, simpler, just add it to your `.env` for the emulator and re-deploy with the deploy-time param.
8. Update `web/public/farmfriend.vcf` — replace the placeholder `+15555550100` in the `TEL` line with your real Telnyx number.

## 3. LLM provider

The active model is configuration, not a product assumption — `LLM_PROVIDER`
selects the adapter and sensible defaults (see CLAUDE.md → "Project Constitution"
and "Stack → LLM"; `app/config.py:load_settings` is the source of truth). You only
need to provision the key for whichever provider you're running.

- **Code default — `mistral-deepinfra`** (Mistral Small 3.2 24B on DeepInfra, a
  neutral inference provider). Create a DeepInfra API key and set it as the
  generic LLM key:
  ```bash
  firebase functions:secrets:set LLM_API_KEY
  ```
- **Real Ai2 OLMo via OpenRouter** (`LLM_PROVIDER=olmo-openrouter`): set
  `OPENROUTER_API_KEY` (falls back to `LLM_API_KEY` if unset).
- **Anthropic fallback** (`LLM_PROVIDER=anthropic`, Sonnet 4.6): only a
  config-switchable fallback, not the default. To use it, create a key at
  console.anthropic.com and set it:
  ```bash
  firebase functions:secrets:set ANTHROPIC_API_KEY
  ```

> Before pointing the pilot at any provider, run the live eval against it:
> `LLM_API_KEY=<key> python -m tests.evals.runner --live` from `functions/`.

## 3a. Coordinator phone (for immediate escalations)

The LLM can mark an escalation as `immediate` urgency — in which case dispatch texts the coordinator directly so it doesn't sit in the dashboard. Set your phone in `.env.<project>`:

```
COORDINATOR_PHONE=+1206XXXXXXX
```

Without this, urgent escalations still flag and reply to the user — they just don't ring through to you. Strongly recommended before pilot.

## 4. First deploy

```bash
firebase deploy
```

This deploys Functions, Firestore rules + indexes, and Hosting all at once.

## 5. Grant yourself admin

After the first deploy:

1. Visit `https://<your-project-id>.web.app` and sign in with Google. (You'll see an "not an admin" message — expected, on first sign-in.)
2. Either:
   - Use the `set_admin.py` script with a service account, OR
   - In the Firebase Console → Functions, invoke `set_admin_claim` directly (during the bootstrap-window when zero admins exist, the callable is unauthenticated by design).
3. Sign out + back in. You'll now see the dashboard.

## 6. Seed your first farm

The admin SPA onboards subsequent farmers/volunteers through the `pending_users` → approve flow (texted JOIN, or admin-typed in). But for the very first farmer (so the system has *someone* to text), seed manually in the Firebase Console:

1. In the Firebase Console → Firestore Data, create a `users` doc:
   ```json
   {
     "phone": "+1206XXXXXXX",
     "name": "Farmer Name",
     "role": "farmer",
     "status": "active",
     "created_at": <server timestamp>
   }
   ```
2. Create a `farms` doc:
   ```json
   {
     "name": "Plum Forest Farm",
     "owner_user_id": "<user doc id from above>",
     "location": "Vashon Island, WA",
     "activity_tags": [],
     "insider_window_minutes": 180,
     "pickup_insider_window_minutes": 30,
     "created_at": <server timestamp>
   }
   ```
3. Text the Telnyx number from the farmer's phone — `HELP` should come back, confirming the loop is live.

## 7. Pilot launch checklist

Before onboarding real farms (target: ~July 2026):

- [ ] Telnyx A2P 10DLC campaign is **approved** (this takes 1–2 weeks; do it first).
- [ ] `COORDINATOR_PHONE` is set in `.env.<project>` and deployed — without it, urgent escalations don't page you.
- [ ] vCard is updated with the real number.
- [ ] You've run through the end-to-end manual test (post a test shift, claim it, confirm post-event check-in, FLAG a message, send a deliberately-escalating message like "someone hurt their hand" and verify it lands as an immediate-urgency flag + texts your phone).
- [ ] You've verified the confirmation reminder fires: claim a shift whose `starts_at` is within ~24h, wait for `tick_confirmations` (every 15 min) to send the reminder, then reply DROP (the keyword the reminder now asks for; legacy CANCEL still works only in this reminder context) and confirm seat unwinds + farmer gets notified.
- [ ] At least one friendly farmer + 3–5 friendly volunteers are onboarded as a soft pilot.
- [ ] Cost dashboard shows total spend tracking under the $30/month budget.

## Recurring ops

- **Check the admin worklist daily** for pending approvals and open flags during the pilot. The system runs autonomously but you're still the trust-and-safety gate.
- **Telnyx + LLM-provider billing**: glance at both monthly (the LLM provider is whoever `LLM_PROVIDER` points at — DeepInfra by default, or OpenRouter/Anthropic if switched). If LLM spend exceeds Telnyx, that's a signal — the LLM is being called too often (likely because too many messages are slipping past the hotkey parser).
