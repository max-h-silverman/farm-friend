# Farm Friend — Session Log

Newest-first, on-demand build history: what was built each session, the decisions and rationale
that aren't obvious from the diff, and what was verified/owed. The **live snapshot** of what's
true/unfinished now lives in [../CLAUDE.md](../CLAUDE.md) "Current State & Open Items"; this file
is the *why behind past changes*.

Entries older than the newest eight are rotated into
[SESSION_LOG_ARCHIVE.md](SESSION_LOG_ARCHIVE.md) (rotated 2026-07-27 at 31 entries / 152k
chars, which had grown too large to open mid-session).

---

## 2026-07-27 (latest) — the callbacks nothing read, and a rule enforced twice

B-012, found the day before while verifying the scheduler by effect. One bounded pass, and a
sabotage sequence that corrected the test rather than the code.

### The machinery was complete except for the part that runs it

`applyPendingDeliveryEvent` had **zero callers** — no pass, no webhook, not even a test. Everything
around it worked: Telnyx's `message.sent` / `message.finalized` callbacks were signature-verified,
minimized, correlated to their dispatch attempt by `provider_message_id`, and durably stored with
their `delivery_status` already on the row. Then nothing ever read them. Production: 21/21 inbound
events `processed`, all 20 delivery callbacks still `pending`.

The consequence is a meaning gap, not a crash. `sent` in `outbox_work` recorded that Telnyx
*accepted* a message and never that the carrier *delivered* it — which is exactly what you would
want when a farmer says they never got a prompt, and exactly the data B-011's invisible carrier
block would surface in. This is the third instance of the same shape (F-023 routing existed and was
unreachable; F-026's purge existed and was unscheduled), so the wiring test came first this time.

### Both design questions were settled by reading, not assuming

**Not the per-sender inbound path.** The schema had already made this decision and written it down:
`provider_inbox_events_minimal_projection_per_event_type` *forbids* a `sender_hash` on a delivery
row, and the one-claim-per-sender index is scoped `where event_type = 'message_received'`. Routing
delivery callbacks through `claimNextInboundEvent` would serialize unrelated carrier traffic behind
a farmer's conversation, and risk advancing a conversation watermark from an outbound event — which
would make that sender's *next real message* look stale and be rejected. So: a fourth bounded pass
on the one cron trigger, alongside inbound, outbound, and retention.

**Idempotent under replay, already.** `applyDeliveryEvent` ignores a repeated provider event ID and
any event at or before the row's current delivery instant, under a `for update` on `outbox_work`.
And `releaseAbandonedClaims` is *not* scoped to `message_received`, so it already recovers a lapsed
delivery claim — the claim is a real one because `coherent_claim_state` requires a token and expiry
on any `processing` row.

### The sabotage that found a third mechanism

Removing the duplicate-event guard from `applyDeliveryEvent` left the entire suite green. The first
assumption — that the test was weak — was half right, but the reason was not the expected one.
Probing the actual `UPDATE ... RETURNING` showed it matching a row and returning the *old* status,
which pointed at a **database trigger nobody had mentioned**: `guard_outbox_delivery_watermark`
(migration 0001) returns `OLD` when `delivery_event_id` repeats. The rule is enforced **twice**,
independently — trigger and application guard — so no single-point sabotage can fail a test of it.

The test was also passing for a third wrong reason: with a *terminal* first status, the trigger's
"a terminal result cannot be replaced" branch enforced it regardless. Rewritten with `sent` as the
first status, so only the duplicate rule is in play; it now fails only when *both* mechanisms are
removed, which is the honest result for a genuinely redundant guarantee. Four separate sabotages
were run: `for update skip locked` (fails only the 8-claimant contention test), the event-type
filter (fails the "never claims a conversational event" boundary), each duplicate mechanism alone
(green — the finding), and both together (fails).

**Contention was tested with eight simultaneous claimants**, per B-011's lesson that `Promise.all`
over two branches serializes itself and cannot fail.

### A designed path deleted instead of built

An orphaned-callback path — a `rejected` terminal state for an event whose dispatch attempt vanished,
so it wouldn't be re-claimed forever — was written, then deleted once its test wouldn't construct:
the projection check forbids a delivery event without a `dispatch_attempt_id`, and the FK is
`on delete restrict`. The state is **unreachable**, so a test now asserts that guarantee instead, and
fails if either constraint is relaxed. The zero-caller singular wrapper was deleted rather than left
beside the new plural one.

### Merged past a permanently-red check, deliberately

Merged as `f16ef8f` (PR #46) with GitHub's Vercel check failing. It fails on **every** commit
including `main`'s last three, all predating this work: the committed `vercel.json` declares a
one-minute cron the Hobby plan rejects, which is why production is deployed by hand with the `crons`
block stripped. max's call: merge now. It is written into CLAUDE.md so the red check is not mistaken
for a signal about a change under review — worth removing at go-live, since a check nobody can
distinguish from a real failure is how a real failure eventually gets missed.

**Production verification by effect is owed and not done**: no scheduled run has been observed
applying a real callback, since that needs the production `DATABASE_URL`. It is step one of the next
session, the same way the retention purge was verified the day before.

---

## 2026-07-27 — a scheduler that can fail loudly, the sentence the database threw away, and conforming to the carrier

Two pieces of the durability gap, and a consent rule that removed a divergence rather than repairing it.

### Production's recovery net exists in the repo now, not yet in the world

The deployed build is uploaded with `vercel.json`'s `crons` block stripped, because Hobby rejects a
one-minute schedule. The consequence had been sitting in plain sight since B-009: the best-effort
kick was the *only* thing invoking the workers, which is the precise inversion B-009 was filed
against, and F-026's retention purge — which runs on that trigger alone — had never executed in
production at all.

Decision (max): external scheduler now, revisit Pro at go-live. **GitHub Actions over a SaaS
scheduler for one reason only:** a dashboard-configured job is *unassertable*. cron-job.org would
have scheduled more faithfully — GitHub's schedules are best-effort and droppable, so `*/5` is a
request rather than a guarantee — but nothing in the repo could then prove the job existed or still
authenticated, which is the exact silent-failure shape B-005 was filed against. The interval is
acceptable only because the kick front-runs live traffic, so it governs how long *missed* work waits,
never reply latency. That distinction is written into the workflow and the RUNBOOK, because calling
it "a one-minute cron" would be false.

**The assertion that matters is that the run checks its HTTP status.** A bare `curl` exits 0 on a
401, so a rotated `CRON_SECRET` would produce a tidy column of green checkmarks while nothing had run
for weeks. And that assertion's first draft **survived its own sabotage** — a workflow accepting
every status still passed, because `/--fail|-f\b|http_code|status/` was satisfied by the
`-w '%{http_code}'` flag and the bare `/exit 1/` by an unrelated missing-secret guard. Same trap as
B-009's import line, in a new costume. It is now anchored to the comparison itself and fails under
four separate sabotages of it. Nine sabotages were run across the file; all six assertions fail when
the property they name is removed.

### B-011 turned out to be blocked on something more basic than its Golden Rule question

The plan was to bring max the consent-transition decision. Reading the code first changed the
sequencing: `classify()` in `packages/sms/src/delivery.ts` read only the **HTTP status** off the
thrown error, and `createTelnyxTransport` discarded the response body outright. Telnyx returns
`40300` in that body. **The error code B-011's candidate rule keys on did not exist anywhere in the
system** — every 409 arrived indistinguishable from every other conflict.

So B-010 was the prerequisite, and max chose to do it first and decide B-011 against real stored
rows rather than a single hand-run curl.

### B-010: the privacy question in its own notes had a "yes" answer

The item asked whether any class of provider error echoes the destination number, and said that if so
the class should be *dropped* rather than truncated. It does — the real 40300 body names **both**
E.164 numbers. But dropping it would discard the diagnostic entirely, so phones are **masked**
instead: the sentence survives, no digits do.

`maskRawPhones` is built on the outbound guard's existing `PHONE_BODY` pattern rather than a second
regex, so both consumers inherit every future correction to it — including B-001's UUID-hex fix. Same
detector, two dispositions: the guard *refuses* an outbound body carrying a phone (it is our own
message; a phone in it is a defect to surface), while stored third-party text is *masked* (a
provider legitimately names the numbers it could not deliver between).

Two columns, kept separate on purpose: `provider_code` is a **validated machine token** — a future
rule may key on it — and `provider_error_detail` is free text nothing may ever branch on. Both are
nullable and excluded from the `coherent_result` check, because a provider returning an unparseable
body (a gateway's HTML 502) must still be able to record its rejection; requiring them would turn a
malformed error into a failed write *inside the dispatch path*. `summarizeProviderError` never throws
for the same reason.

Nothing branches on either value today. `errorCode` remains what the retry policy reads, so this
changed no dispatch decision — it only made the next failure readable in one query.

**Why the discard survived this long: `createTelnyxTransport` was unexported.** The single code path
that parses a real provider error had no test, because everything above it used the simulator, which
never fails. It is now exported and covered against the two real 2026-07-27 payloads, and that suite
fails under a full revert to the original defect.

### B-011: conform to the carrier instead of reconciling after it

max's call, and it reframed the problem: **"conform to telnyx. join only works on first-time inbound.
otherwise require START."**

Both options the item had been carrying accepted that the two records would diverge and argued about
the repair — reconcile consent from a 409, or surface the mismatch for an operator. A third that
surfaced while reading the code (surface blocked recipients, reconcile nothing) had the same shape.
max's rule removes the divergence at its source instead: our record can no longer claim consent the
carrier will not honour, because JOIN never again enrolls someone Telnyx may be blocking.

And it does that with **no Golden Rule #2 exposure at all** — the outcome the "authoritative 40300"
option kept bumping into. No provider response drives a consent transition; a 409 is never consulted.
The decision stays a pure function of our own deterministic routing plus our own stored record. The
B-010 work that unblocked the authoritative option turned out not to be needed for the fix that
actually shipped, though it is what made the carrier's behaviour legible enough to reason about.

**Where the rule lives is the load-bearing part — and the first version of it was wrong.** It
belongs in `applyConsentTransition`, not `routing.ts`: a caller-side read followed by a write is a
race, since two concurrent JOINs could both observe "no record" and both enroll.

The first implementation did `select ... from sms_consents` inside the transaction and refused on a
hit, with a comment asserting the existing `for update` on the watermark serialized it. **It does
not.** `for update` locks rows that EXIST; a genuinely first-time sender has no watermark row, so
there is nothing to lock and the eight transactions ran concurrently. The race test enrolled
**three of eight**.

Every unit test passed throughout, because the unit stubs cannot model row-level contention. **Only
the integration run against real Postgres could see it** — the same shape as B-009, where Node
semantics hid a serverless-lifecycle bug, and B-005→B-008, where a hoisted `node_modules` hid an
isolated install. The fix moves the decision into the `sms_consents` PRIMARY KEY:
`insert ... on conflict (recipient_hash) do nothing returning state`. The database resolves the
contention, exactly one insert reports a row, and the losers learn it from their own write rather
than from a stale read. `returning` is what makes winner and loser distinguishable at all.

Sabotage-proven afterwards: reverting to the read-then-refuse version fails the race test, and
disabling `firstTimeOnly` entirely fails two.

Two smaller decisions that took a second pass:

- The guard keys on the **`sms_consents` row, not the watermark**. Every transition writes a
  watermark, including ones that do not enroll, so an absent consent row is the honest test of "never
  opted in". A refused JOIN also writes **no** watermark — otherwise it could mask a later legitimate
  START arriving at an earlier provider time.
- `applied: false` was **ambiguous** between "stale event" and "already enrolled", which need
  different answers to the sender. `ConsentTransitionResult.refusal` now says which. Routing keys on
  the reason, and **keying on `!applied` passed the entire routing suite** until a stale-JOIN fixture
  existed — the fourteenth sabotage of the session and the second time this session that an
  assertion proved to be satisfied by something other than the property it named.

`ALREADY_JOINED_RESPONSE` is 114 chars, one GSM-7 segment, and is deliberately **not** one of the
three registered 10DLC auto-responses — those are transcribed from live console state and pinned
character-for-character, this is ordinary code-rendered copy that can be edited without touching the
carrier registration. It goes out as `required_reply`, which is what lets it reach a `stopped` sender.

**The limitation is real and is written into the code comment rather than smoothed over:** while the
carrier block is active, that reply is itself 409'd and the farmer never sees it. It is still correct
to send — the block may not be active, it costs nothing when it is, and B-010 now records the refusal
with its reason. **The durable fix is farmer-facing, not code:** onboarding material and printed
instructions must say START, not JOIN, for returning after an opt-out. That is the one piece of B-011
still open.

### Shipped to production, and the purge finally ran

All three owed steps completed 2026-07-27, in the order the outage risk demanded — except the first,
which max chose to reorder knowingly.

**The ordering call.** `recordDispatchResult` writes `provider_code` / `provider_error_detail` on
*every* dispatch outcome, so deploying before migration 0004 means every outbound SMS fails at the
record step until the migration lands. Flagged as a real window rather than a theoretical one; max
accepted it (the number carries no real traffic and this is still throwaway validation) and the
migration followed immediately. Confirmed after the fact: both columns present, 5 migrations applied.

**Deploy** used the documented Hobby workaround — strip `crons` uncommitted, `npx vercel --prod`
(the CLI uploads from disk), restore, confirm `cron-schedule.test.ts` back to 4/4. Live checks:
health 200, cron 401 without a secret, webhook **401** — which is the three-way diagnostic saying all
four Telnyx credentials resolved, since a missing one renders 500.

**The purge ran against real data for the first time.** F-026 had only ever reported `0/0/0` because
nothing was eligible, so a privacy commitment had been *unenforced*, not merely unverified. With
`CRON_SECRET` set and a manual run returning 200, one body was made eligible among 21 real messages:

| | before | after |
|---|---|---|
| `body` | present | **NULL** |
| `body_expires_at` | past | **NULL** |
| the row itself | present | **present** |
| other bodies | 21 | **20** |

Cleared as a pair, minimized projection intact, blast radius exactly one. Checking what *survived*
mattered as much as what went — a purge that over-reached would be worse than one that never ran.

**And the verification found something.** The same sweep showed `message_received` 21/21 `processed`
but `message_sent` (9) and `message_finalized` (11) **all still `pending`**.
`applyPendingDeliveryEvent` has **zero callers** — no pass, no webhook, not even a test. So `sent` in
`outbox_work` means "the provider accepted it", never "the handset received it", and the rows
accumulate with no terminal state. Filed as **B-012**; same unowned-machinery shape as `model_runs`.
Not caused by this session's work — found *because* the scheduler was verified by effect rather than
by a green checkmark, which is the entire argument for doing it that way.

### Verified

Merged to `main` as **e4798fa** (PR #45, squashed). The PR's only check — Vercel — was failing, but
`main`@456ad93 carried the identical failure at the same URL: it is the known Hobby rejection of
`vercel.json`'s one-minute cron, which is precisely why deploys go out via `npx vercel --prod` from a
local checkout with the `crons` block stripped. Pre-existing, and it blocks `main` equally.

Everything green at wrap, on real Postgres 16.12:

| Suite | Result |
|---|---|
| `npm test` | **393/393** across 42 files |
| `npm run test:integration` | **226/226** across 16 files |
| `npm run evals` | critical **11/11**, advisory 4/4, adversarial 25/25 |
| typecheck / lint / `next build` | clean |

Critical evals went 10 → 11: a new fixture asserts the B-011 rule (JOIN refused for any existing
record, START honoured from every state, STOP unnarrowed). Migration **0004** applies from an empty
database, proven by the integration run rather than by `drizzle-kit check`.

Three test-side defects were found and fixed during the wrap, none of which the unit suite could
see: the B-011 integration fixtures reused `farmerHash`, which `beforeEach` seeds with an *active*
consent row (so "first-time" was never first-time); the routing stubs returned `[]` for the guard's
new `insert ... returning`, making every first-time sender look already-enrolled; and one assertion
("no `insert into sms_consents` runs") became wrong by design once the guard *became* an insert —
the load-bearing assertion is that no **watermark** advances.

### What is owed

- **Integration DID run, after an environment mistake worth recording.** Two attempts to find
  Postgres came up empty and the session proceeded on "no database available" — but Homebrew's
  `postgresql@16` was installed and running the whole time, merely absent from `PATH`
  (`/opt/homebrew/opt/postgresql@16/bin`). Finding it during the wrap is what surfaced the race
  above. **A negative result from a tool lookup is not proof the thing is absent** — the same
  reasoning-from-indirect-evidence trap that produced the wrong `vercel env ls` conclusion earlier.
- ~~The scheduler is merged but not live.~~ **Done and verified the same day — see below.**
- **B-011's farmer-facing half.** The code rule is in; the onboarding copy that tells returning
  farmers to text START rather than JOIN is not, and no code change can substitute for it.

---

## 2026-07-27 — B-009: the reply never went out because the kick never ran

Farm Friend sent its first SMS. The full round trip works: inbound keyword → deterministic route →
queued reply → Telnyx dispatch with a real provider message ID → delivery callbacks returning
through the same webhook.

Three defects were stacked, each hiding the next. Only the middle one was in the code.

### The diagnosis, in the database rather than on the phone

Two real inbound `HELP` messages had been committed and acknowledged 200 with no reply. Reading
every table localized it in one pass:

| Table | Rows | Reading |
|---|---|---|
| `sms_messages` | 2 | ingress committed |
| `contacts` | 1 | committed in the request path |
| `provider_inbox_events` | 2, `state='pending'`, `claimed_at` NULL | **never claimed — the break** |
| `sender_states` / `outbox_work` / `outbox_dispatch_attempts` / `sms_consents` | 0 | nothing downstream ran |

20 of 23 tables were empty. Everything the webhook does *synchronously* committed; everything the
kick does never happened. The first missing step is the first step past the durable commit, which
is the `void kickSenderPasses(...)` call.

### The cause is a platform contract, not a logic error

`void` starts work the Vercel runtime knows nothing about. Once the handler returns, the invocation
is free to suspend, and the promise simply stops. Vercel's reference states it outright: work that
is not awaited may be shut down before it completes. `waitUntil` registers the promise and extends
the invocation's lifetime until it settles, without holding the response open. (`after()` from
`next/server` is the modern equivalent and needs Next 15.1+; this app is on Next 14.)

The kick gained no guarantee from this. A registered promise shares the function's timeout and is
cancelled with it, so it stays best-effort and the scheduled trigger stays the durable net.

**The compliance exposure is why this was critical rather than a latency bug.**
`applyConsentTransition` runs inside `routeInboundMessage`, inside `runInboundPass`, inside the
kick — so a real `STOP` would have committed **no consent row at all** while Telnyx received a 200.
Not "consent correct, acknowledgement missing": the opt-out silently dropped. No violation had
occurred, because both test messages were `HELP` and an earlier `STOP` was sent during the
unprovisioned-number window and left no trace in any table.

### Why every local suite passed

**Vitest runs in Node, where a floating promise resolves normally.** The entire existing kick suite
— including `kick-wiring.test.ts`, written specifically to police how the kick is wired — passed
throughout. No behavioural test in that runtime can see this bug. `kick-survival.test.ts` therefore
asserts the registration against the route source, the same technique `cron-auth.test.ts` and
`workspace-manifests.test.ts` use for properties that are constructs rather than behaviours.

**That test's first draft survived its own sabotage.** It asserted `/waitUntil\s*\(/` against the
whole file; reverting the call site to the production defect still passed, because the `import` line
matched. It now strips imports and anchors to the call site, and fails under three sabotages —
revert to `void`, wrap an unrelated promise, `await` the kick. `kick-wiring.test.ts` passes through
all three, which is precisely why the new file had to exist.

`kick-wiring.test.ts` asserted `void kickSenderPasses(`. `void` was only ever a proxy for
"deliberately not awaited" — and it turned out to *be* the defect — so that assertion now follows
the intent instead of the keyword.

### Two configuration defects on either side of it

**Before:** the 10DLC campaign provisioning (previous entry) — fixed between sessions.

**After:** `TELNYX_FROM_NUMBER` was not in exact E.164 form, so Telnyx returned `400` on every send.
This masked B-009's fix for most of the session and cost far more time than it should have, because
`outbox_dispatch_attempts` stores `error_code = '400'` and **discards Telnyx's own sentence** —
`"The source phone number was deemed invalid by the carrier."` — which names the field outright.
Filed as **B-010**. Localizing it instead required probing the Telnyx API directly, testing each
request component in isolation, and enumerating malformed `from` formats until the error reproduced.

A dead end worth recording: `vercel env ls` showed `TELNYX_API_KEY` as "1h ago" while the web UI
showed "Updated just now". The CLI column is not last-update, and trusting it produced a confidently
wrong conclusion mid-diagnosis. Vercel values are write-only — the UI hides them and `vercel env
pull` returns `[SENSITIVE]` (confirmed for all ten) — so the only honest check is behavioural.

### Verified by effect, in the deployment

| | Before | After |
|---|---|---|
| Inbound claim latency | never, unless cron was triggered by hand | **4–8s, automatic** |
| Consent commit | nothing recorded | `active` / `start`, watermark correct |
| Routing | never ran | every message routed to the correct registered copy |

Six keywords in 39 seconds, out of order, each claimed within seconds with no cron and no manual
trigger. Claim latency is the load-bearing number: ~1888s (and only when a pass was triggered by
hand) → single-digit seconds. Consent semantics held against real traffic — the watermark carries
only the latest transition, and `HELP` did not move consent.

The supervised keyword demo then completed on a clean number: `start` → `join` → `help` at
06:43, all three `accepted` with real provider message IDs, consent landing at
`active` / `capture_source='join'`. A free-text inquiry (`"where can i get bok choy?"`) was also
exercised and returned a code-rendered clarification.

`npm test` 363/363 across 39 files; typecheck, lint and `next build` clean.

### B-011, found while demoing: the carrier owns STOP, and JOIN cannot undo it

The demo surfaced a second defect that the database alone did not show — it took a screenshot of
the actual handset. **Telnyx answers STOP/START itself**, in copy that is not ours ("Reply START to
re-subscribe"), while Farm Friend's registered copy says "Reply HELP for assistance". Two voices,
with contradictory instructions.

Worse, Telnyx then **rejects Farm Friend's own reply with 409** while its block rule is active.
Probing the API directly named it:

```
40300 | Blocked due to STOP message
"Messages cannot be sent from '…' to '…' due to an existing block rule."
```

This settles a question the previous framing had left open: **suppression is enforced independently
of the profile's auto-response fields**, which were deliberately left empty in an earlier session.
Disabling the auto-response text would therefore not restore deliverability, so "accept carrier
handling for STOP/START" is the workable path rather than one of two equal options.

**`START` lifts the block; `JOIN` does not** — `JOIN` is Farm Friend's registered opt-in keyword and
means nothing to Telnyx's compliance layer. Confirmed by outcome, not by timing: a `join` sent four
minutes after a `stop` still 409'd, while a `start` between them was accepted.

The consequence is a **consent-integrity divergence**, not a cosmetic one. A farmer who texts STOP
and later texts JOIN is recorded `active` by Farm Friend — `isProactiveSendPermitted` returns true —
while Telnyx blocks every message to them. The database and the carrier disagree about the same
person and nothing reconciles them. One candidate fix (treat a `40300` as authoritative and
reconcile consent to `stopped`) brushes against Golden Rule #2, since it lets a provider response
drive a consent transition; it would have to be a deterministic code-owned rule keyed to that one
error, never a general "provider says so" path. Undecided, and max's call.

### Owed

**The durability half is not done.** The deployed build has its `crons` block stripped for Hobby, so
production has **no scheduled recovery net at all** — the kick is the only thing running passes,
which is the exact inversion this item was filed against. The external-scheduler-vs-Pro decision
(external now, Pro at go-live) still needs implementing, and `CRON_SECRET` had to be rotated
mid-session because it was unreadable, which any external scheduler will need again.

The retention purge has still never been verified by effect; every observed pass reported `0/0/0`.

**Credential hygiene is now a go-live blocker, not a nicety.** `DATABASE_URL`, `CRON_SECRET` and the
Telnyx API key were all exposed in a working transcript this session and need rotating. Note the
asymmetry: **`PHONE_HASH_SALT` cannot be rotated** — changing it orphans every phone hash in the
database. Record it while it still works.

B-008 is still open, and its symptom appeared again in this session's build log.

---

## 2026-07-27 — Telnyx wired and verified; the demo blocked on an unprovisioned number

No code changed. The Telnyx transport was configured and every app-side property verified against
the live deployment — and the supervised `JOIN` demo still could not run, because the number was
never provisioned on the 10DLC campaign, so inbound SMS never reached Telnyx at all.

### What now works

`SMS_PROVIDER=telnyx` plus the four credentials are live in Vercel Production. The webhook answers
**401 `missing_signature`** where it previously answered 503, which is the observable proof that
`resolveConfig` resolved a complete Telnyx config.

Signature rejection was probed five ways against the deployment, all 401:

| Probe | Reason returned |
|---|---|
| No headers | `missing_signature` |
| Well-formed but wrong signature | **`signature_mismatch`** |
| Stale timestamp (−1h) | `timestamp_outside_window` |
| Junk (non-base64) signature | `malformed_signature` |
| Signature without timestamp | `missing_signature` |

`signature_mismatch` is the load-bearing one. Reaching it requires the timestamp check to pass, a
64-byte signature to decode, and **`TELNYX_PUBLIC_KEY` to decode to exactly 32 bytes and import as a
valid ed25519 key** — a wrong-key paste returns `malformed_key` instead. So the public key is
structurally a real ed25519 key. Whether it is *the account's* key is still unproven; only a genuine
Telnyx-signed request settles that.

### The three-way diagnostic the runbook got wrong

The session prompt (and RUNBOOK step 4) framed step 2 as two-way: 401 good, 503 means a missing
credential. That is wrong, and it points at the wrong fix.

`route.ts` calls `appContext()` as its **first statement**, before the provider check. `resolveConfig`
**throws** when `SMS_PROVIDER=telnyx` and any Telnyx var is missing or blank, and a throw in a route
handler renders **500**. So:

- **401** — config resolved.
- **503** — `SMS_PROVIDER` is not `telnyx`; execution reached the provider check, so all five vars
  resolved.
- **500** — `SMS_PROVIDER=telnyx` but a credential is missing or empty.

A missing credential is **500, never 503**. This mattered in practice: the first redeploy still
returned 503, and the correct read was "`SMS_PROVIDER` was never flipped from `simulator`" — which is
what it turned out to be. The `vercel env ls` timestamps were the tell: the four Telnyx vars were
minutes old, `SMS_PROVIDER` was two hours old, unchanged with the rest of the original set.

Note `vercel env pull` cannot help here — encrypted values come back as `[SENSITIVE]`.

### Hobby cannot deploy this repo's `vercel.json`

`npx vercel --prod` from `main` fails outright: `Hobby accounts are limited to daily cron jobs. This
cron expression (* * * * *) would run more than once per day.` B-005's one-minute schedule is
incompatible with the plan.

Rather than redeploy the stale `throwaway/hobby-deploy-test` branch — which was **17 commits of
doc drift** behind `main` and is documented as never-merge — the crons block was stripped from the
working tree **uncommitted**, deployed, and restored immediately. `vercel --prod` uploads from disk,
so this needs no branch and no commit. Confirmed first that the two branches differ in **zero source
files**: only docs and `vercel.json`.

This makes the Hobby-vs-Pro question concrete rather than theoretical. The throwaway project can
never become the real one; it cannot run the schedule the app requires.

### The demo could not run — and the app is not implicated

Real `STOP`, then `HELP`, to +1 206-864-5326. No reply to either. Diagnosis from both ends:

- **Vercel runtime logs** — zero requests to `/api/sms/webhook` in the window. The only hits were
  this session's own probes, timestamps confirmed. No application code ran.
- **Telnyx → Webhook Deliveries** — "No deliveries found."
- **Telnyx → Detail Record Search** — **"No records found."**

The last is decisive. Telnyx has no record of the inbound messages *at all*, so the failure is
upstream of the webhook and upstream of Telnyx's own message records.

**Root cause found at the end of the session: the number's Provisioning Status on the 10DLC campaign
read `Pending`.** It had never been provisioned on the campaign; max assigned it minutes before the
wrap. An unprovisioned number has no carrier route for inbound 10DLC traffic, which is exactly why
the messages died before Telnyx saw them.

The trap is that **three separate things all looked correct**: the campaign was *approved*, the
number was *Active*, and the number was *attached to the messaging profile*. None of those implies
the number is provisioned **on the campaign**, and no view we looked at surfaced the gap — we found
it only by opening the campaign's own number list. Attaching the number to the profile mid-session
did not change the result, because that was never the missing binding.

**`HELP` failing alongside `STOP` is what rules out the leading theory.** Carrier keyword absorption
was the suspected cause — Telnyx maintains its own opt-out list, and the console's Keywords page
shows STOP/START/HELP as fixed, non-editable defaults. But HELP is not an opt-out keyword and Telnyx
has no compliance reason to swallow it. Two different keywords failing identically means the problem
is not keyword-specific.

The three auto-response message fields were deliberately left **empty** during profile creation, so
Telnyx would not double-reply alongside Farm Friend's registered copy. That decision stands and was
not the cause.

### B-008: the sixth defect of the B-007 family

The successful deploy's build log carried
`ESLint: Failed to load plugin '@typescript-eslint' … Cannot find module '@typescript-eslint/eslint-plugin'`.

`apps/web/package.json` declares `eslint` but not `@typescript-eslint/eslint-plugin` or
`@typescript-eslint/parser`, which the root `.eslintrc.cjs` loads. Next treats the failure as
non-fatal, so **lint is skipped and the build goes green**. Not a runtime defect — compilation and
type-check both ran — but a lost quality gate whose absence is invisible on a passing deploy.

`workspace-manifests.test.ts` could not have caught it: it matches
`@farm-friend/*` **in import statements**. This is an *external* package referenced from a *config
file* — outside the test's design on two independent axes. `npm run lint` passes locally for exactly
the hoisting reason the whole family shares.

Filed as B-008 rather than fixed mid-session; the valuable part is extending the general test to
config-file references, not the two-line manifest fix.

### Verified

`npm test` 356/356 across 38 files; typecheck and lint clean. Integration and evals not run — no
database, model-seam, or workflow code was touched. `cron-schedule.test.ts` passing is the
confirmation that the `vercel.json` strip was restored.

### Owed

**Late update, after the wrap commit: provisioning cleared, ingress now works, and the demo still
fails — one stage later.** Two inbound webhooks returned **200** (05:49:10Z and 05:59:57Z): signature
verified, message committed durably, acknowledgement returned. No reply arrived at the handset.

The failure has therefore **moved from ingress to outbound**, which retires the carrier theory
entirely and makes this the first app-side suspicion of the whole effort. The prime suspect is the
**B-004 kick**: it is started with `void`, never awaited, and swallows every failure by construction,
and on Hobby there is **no cron to recover what it drops**. That is exactly the silent-failure mode
flagged at the session's start — a reply that never arrives with no error surfaced anywhere, because
the webhook already returned its 200.

Next session begins in the database rather than on the phone: `sms_messages` (did the inbound row
commit?), `sender_states` (did the inbound pass run?), `outbox_work` (was a reply queued, and what is
its `state`?), `outbox_dispatch_attempts` (was dispatch attempted, and what came back?), and
`sms_consents` (did the STOP transition commit even though no acknowledgement went out?). Each table
answers a different stage, and the first empty one localizes the break. B-008 is open. The throwaway Vercel project and branch still want deleting before go-live,
and production cron remains the open Pro-vs-external-scheduler decision, now sharper because Hobby
cannot deploy this repo's `vercel.json` at all.

---

## 2026-07-27 — The first deploy, and the five defects a green suite could not see

Farm Friend is **deployed**: https://farm-friend-web.vercel.app. Health returns `{"ok":true}`,
`/api/public/stands` returns `{"stands":[]}` against a real Neon database, and every security
boundary built over the last several sessions holds against a live deployment rather than a test
runner — cron 401 with no or wrong secret, admin API 403 unauthenticated, sign-in responses
byte-identical across addresses, throttle firing.

This was not the F-029 go-live. It is a **throwaway Hobby-tier deploy** to validate build and env
wiring, on branch `throwaway/hobby-deploy-test`, to be torn down.

### Five defects, one shape

Every one was invisible to 346 passing tests, because every test ran in a developer's fully-hoisted
`node_modules` or against a local database:

- **B-005** — no `vercel.json` at all, while RUNBOOK documented `vercel.json` → `crons`. Nothing
  would ever have been scheduled.
- **B-006** — no migrate command, while RUNBOOK said "migrations run as part of the deploy step."
  Migrations were applied in exactly one place: the integration harness, against a database it
  created and dropped.
- **B-007a** — `apps/web` imported `@farm-friend/ai` without declaring it.
- **B-007b** — `transpilePackages` listed only `@farm-friend/core` while three others were imported.
  **This was the actual build failure.** Every package ships raw TypeScript, the dev server
  tolerates it, `next build` does not.
- **B-007c** — `typescript`, `@types/node`, and `eslint` declared only at the workspace root. The
  build reached `✓ Compiled successfully` and then died in the type-check phase.

Each now has a test that fails without its fix, including a general one — `workspace-manifests.test.ts`
walks every workspace and asserts imports are declared, matching on `from "…"` / `import("…")` rather
than any occurrence of the string so a package named in a comment or in `architecture.test.ts`'s
tripwire list is not counted.

**The lesson worth keeping: npm workspaces hoisting makes a whole class of packaging defect
undetectable locally.** `npm test`, `npm run typecheck`, `npm run lint`, and `next build` from the
repo root all pass against manifests that cannot survive an isolated install. The only place the
repository now asserts that property is a test that reads the manifests directly.

### The near-miss

The Neon database was not empty. It held the **older Farm Friend** — the gleaning volunteer
coordination model (`volunteers`, `opportunities`, `claims`, `dispatch_waves`) whose machinery
CLAUDE.md names as an explicit non-goal — with 6 volunteer records, 17 SMS messages, and 2 farms
carrying contact phone numbers.

The reset script's row-count guard refused, having been written on the assumption the database was
empty. **That guard is the only reason nothing was destroyed.** The order was wrong: a destructive
script was proposed before the database was inspected. Inspect first.

It also explains the migration failures. `flags` existed with the old schema
(`phone_hash`/`volunteer_id`, not `contact_hash`/`reason_code`), so `CREATE TABLE IF NOT EXISTS`
skipped it and the foreign key could never be created. **The repeated failure was protecting the old
data.** A pooled-vs-direct Neon connection theory was advanced confidently and was wrong — the same
failure occurred on both.

Max confirmed the contents were his own test numbers from a superseded deployment, and authorized the
wipe. The rewritten script required `CONFIRM_WIPE=yes` **and** fingerprinted the old schema, so a
mistyped connection string would fail rather than erase something else.

### The Vercel specifics

Hobby caps cron at once per day and **rejects** the one-minute schedule, so the throwaway branch
carries a `vercel.json` with no `crons` block — which is why `cron-schedule.test.ts` fails on that
branch by construction, and only there. The Git integration also built the same pre-fix commit three
times; deploying with `npx vercel --prod` from a local checkout sidestepped it entirely and is what
finally worked.

### A correction that matters for the demo

Earlier guidance in this session wrongly implied F-024, B-002, and F-031 gate a live `JOIN` demo.
**They do not.** `JOIN`/`STOP`/`HELP`/`START` are deterministic keyword paths handled before any
model call (`provider.calls === 0`, asserted through the real webhook route), and the reply is sent
by the **B-004 kick in ~47ms** rather than by cron — so a demo needs no cron and no Vercel Pro. What
it needs is Telnyx credentials, `SMS_PROVIDER=telnyx`, and the messaging profile webhook pointed at
the deployed URL. F-029 records this correction.

### Verified

`npm test` 356/356 across 38 files; real-Postgres integration 222/222 across 16 files; typecheck +
lint clean; evals critical 10/10, advisory 4/4, adversarial 25/25. Live deployment verified by
request against every route above. PRs #41, #42, #43 merged.

### Owed

The throwaway Vercel project and `throwaway/hobby-deploy-test` branch should be deleted before
go-live. `PUBLIC_BASE_URL` may still be a placeholder in Vercel. Production cron remains an open
F-029 decision (Pro vs. an external scheduler). F-024, B-002, and F-031 still gate a *useful* launch,
just not a keyword demo.

---

## 2026-07-26 — F-032: the sign-in path gets built up to the wire, and F-031 keeps the wire

One item, one PR, merged. F-025a built magic-link verification and the session it mints; F-030 built
the queues those sessions unlock. Nothing could **send** a link, so a non-technical VIGA operator
still could not sign in unaided.

### The split, and why it happened first

The session opened by surfacing the blocker the prompt named: F-031 needs a mail provider,
credentials, and an attestation of its data-processing terms that **no decision has authorized**.
Max asked whether GCP offers an option (he has `farm-friend-vashon`). It does not — Google has no
first-party transactional email API. "Email on GCP" in practice means SendGrid via Marketplace,
whose terms are **Twilio's, not Google's**, so GCP billing consolidation buys no privacy or
architectural advantage. Gmail API on Workspace works but is a mailbox API with sending limits not
designed for automated mail. Max held the decision to find out what email infrastructure VIGA
already runs — the right sequencing, since an existing Workspace tenant or sending domain constrains
the choice more than any vendor comparison.

That made F-031's "receive it by email" criterion unmeetable this session. Rather than narrow the
item silently or mark it done against criteria it does not meet, **F-032 was split off** for the
provider-independent half. F-031 keeps the transport, the attestation, and the SPF/DKIM/DMARC
sending-domain work, and stays the F-029 blocker.

### The decisions worth keeping

**The mail seam fails closed by throwing, not by no-oping.** A "no provider configured" sender that
quietly returned success would present as a healthy system that never delivers — the hardest version
of this bug to diagnose. Its error carries **neither the recipient nor the body**, because an error
is the most likely thing on this path to reach a log aggregator and the body contains a live
credential. Startup deliberately does *not* require a provider: making it mandatory would take down
the map, the webhook, and the cron worker over a feature none of them use. The cost of that trade is
paid at send time, loudly.

**Enumeration safety is a property of whole responses, and it has to survive failure.** The endpoint
is public, so any observable difference — status, header, body, timing — tells a stranger who VIGA's
operators are. Asserted by comparing **whole serialized responses** rather than shapes. The subtle
half is the failure path: mail is only ever attempted for a real administrator, so letting a mail
error become a 500 rebuilds the oracle precisely. That is proven with a throwing seam, and it is the
case a cooperative stub would have missed. The live run confirmed it end to end — a **bootstrapped
real administrator** and a stranger got byte-identical 202s while the seam was throwing
`MailNotConfiguredError`.

**The budget is per client, never per email address.** A per-address budget is itself an oracle: an
attacker learns which addresses are real by watching which ones start refusing. Sign-in also gets its
own throttle instance, because sharing the stock-out form's would let anonymous QR traffic from a
shared NAT exhaust a real operator's ability to sign in — an availability failure on the recovery
path of the whole admin surface.

**The throttle runs before the administrator lookup.** A refused request performs no database read,
so the endpoint cannot be used to time the table and a throttled attacker cannot keep probing.

**`createModelCallThrottle` became `createPublicActionThrottle`.** The mechanism was always general —
a sliding window over a coarse client key — and only the name was model-specific. One mechanism with
two consumers beat a second near-identical limiter.

**No `console` call exists in the handler, asserted against its source.** A vendor SDK routinely
attaches the request payload — containing the live sign-in link — to the error it throws, so there is
no safe console call on this path. The accepted cost is a silent delivery failure, and it is paid for
by the seam failing loudly at send time instead.

**Writing the no-JS test caught a real defect.** `/admin/login` must work without JavaScript, since
it is the recovery path for every other admin screen. The handler parsed only JSON, so every native
form post would have answered 400 while the enhanced path worked fine — the acceptance criterion
would have been false. It now accepts form-encoded bodies, verified in the built app's markup.

### The sabotage log

Ten sabotages, each verified to fail before the claim was believed: 404 for a non-administrator; a
distinguishing response header on an identical body; a mail error escaping as a 500; logging the
caught error; debug-logging the minted link; the throttle moved after the lookup; the link built from
the `Host` header; lowercase normalization removed; form-encoding support removed; and
`revoked_at is null` dropped from the administrator query — the one property only the real database
owns, which correctly failed the integration suite with a revoked operator receiving mail.

**None passed silently this time**, unlike F-030's two. The enumeration tests were written to compare
whole serialized responses specifically because F-030's near-miss was a shape check that could not
see a changed value.

### Verified

`npm test` 342/342 across 36 files; real-Postgres integration 216/216 across 15 files; typecheck +
lint clean; evals critical 10/10, advisory 4/4, adversarial 25/25; production build passes with
`/admin/login` and `/api/auth/request-link` present and every route dynamic. Exercised live against a
bootstrapped administrator: identical 202s, throttle refusing the 4th request with `retry-after: 900`,
and **no token or address in the server log**. Merged to `main`.

### Owed

F-031 is now purely the transport: pick a provider once VIGA's existing email infrastructure is
known, read its terms, implement the `MailSender` adapter, and set up SPF/DKIM/DMARC. Until then no
link is delivered and a link must still be minted out of band with `issueMagicToken`. `model_runs`
still has no production writer.

---

## 2026-07-26 — F-030: the flag rail gets its human half, and retention learns to terminate

One item, one PR, merged. `FLAG` is a **registered 10DLC compliance commitment** and no human
could act on one: `/api/admin/flags` returned `{ flags: [] }` behind a *working* role check and
read nothing from the `flags` table. Customer stock-out reports accumulated with no reader at all.
Two consequences, and the second is the one that made this urgent — F-026's retention exemption
**never terminated**, because nothing in the product could move a flag out of `open`, so a flagged
body retained indefinitely.

### The decisions worth keeping

**Dismissal ends the exemption exactly as resolution does.** The purge predicate is
`flags.status = 'open'`, so both dispositions release the thread. That is asserted as its own test
rather than folded into the resolution case, because the drift this project has already been bitten
by once — `= 'open'` → `<> 'resolved'` — keeps a *dismissed* thread exempt forever while passing a
resolution-only suite. Sabotaging the predicate now fails with "expected +0 to be 1".

**No grace period after disposal, deliberately.** DATA_ARCHITECTURE already said no consumer needs
one; building a bounded post-resolution window would have been speculative state with no owner. The
very next purge pass clears the body, and the operator copy says to read the thread *before*
closing the flag.

**Masking is a query-level guarantee, not a rendering convention.** `listFlagsForReview` and
`readFlaggedThread` select `right(phone_e164, 4)`, so the full number is never materialized in
application memory and the admin surface never becomes a second reader of the send path's one
column. `maskPhoneSuffix` **refuses** anything longer than four digits rather than truncating —
a caller that passes a whole number fails closed instead of leaking, and the sabotage that selects
the full column now throws at the boundary rather than reaching a response.

**The thread viewer shows what the sender typed, verbatim.** That text is the thing under review;
redacting it would defeat the rail. The guarantee is over *our* identifiers — no hash, no E.164 —
not over prose a sender chose to send (Golden Rule #6). A body retention already cleared is
reported as `bodyPurged`, so an operator can tell "deleted on schedule" from "they sent nothing."

**Triage has no action that could change a listing.** Reviewed and dismissed, nothing else. The
temptation this forecloses is specific — "the customer said it is out, so remove the item" — and it
is the exact failure the private-signal design exists to prevent. Golden Rule #1 is proven by
snapshotting every published revision, entry, and approval across every operator action and
asserting **byte equality**, not "still one revision."

**One guard, four consumers.** `requireAdministrator` moved out of `farms/route.ts` into
`apps/web/lib/admin-guard.ts`. Four copies of an authorization check would have been four places
for one to drift. RUNBOOK's "how to extend" gained an *Add an admin route* subsection recording the
pattern.

### The sabotage log

Eleven sabotages, each verified to fail the suite before the claim was believed: disposition and
triage status written as constants; the administrator liveness re-read removed; both exactly-once
guards removed; full `phone_e164` selected in the queue and in the thread viewer; a sender hash
added to a queue row; the exemption predicate drifted to `<> 'resolved'`; the route guard swallowing
`AuthorizationError`; the acting administrator read from the request body; triage superseding the
current revision.

**Two of them passed, and that was the point.** Writing `'resolved'` when the operator chose
`dismissed` passed all 26 tests — the dismissal test asserted only that the body got purged, never
that the *recorded decision matched the one made*. Same hole on the triage side. Both suites now
assert the recorded disposition directly, which is a defect class independent of retention: an
operator's audit record differing from their decision. A third finding worth keeping: sabotaging
`delete from inventory_entries` was caught by a **database trigger** ("published inventory entries
are immutable"), not by the test — so the Golden Rule #1 claim was re-proven with a supersession
sabotage the trigger does not block, which the snapshot test does catch.

### Verified

`npm test` 298/298 across 31 files; real-Postgres integration 210/210 across 14 files; typecheck +
lint clean; evals critical 10/10, advisory 4/4, adversarial 25/25; production Next.js build passes
with `/admin/flags` and `/admin/reports` rendering and every route dynamic. Merged to `main`.

### Owed

`model_runs` still has no production writer. F-031 (sending a sign-in link) remains the reason a
non-technical VIGA operator cannot yet sign in unaided — the queues built here are reachable only
by a link minted out of band with `issueMagicToken`.

---

## 2026-07-26 — F-025a: the operator gets an identity, and farms can finally be approved

One item, one PR. Farm Friend could not approve a farm. Publication refuses with `not_approved`
unless a live `farm_approvals` row exists, and **no code path created one** — every test that
published successfully did so because its *fixture* inserted the row by hand. The suite was green
and the product could not work. This is the item that closes that.

**Three defects with one cause: the operator had no identity.** `administrators` identified people
only by `contact_id` — a phone contact — while magic-link auth identifies them by email, and nothing
connected the two, so an authenticated operator could never be resolved to an administrator row.
`resolvePrincipal` therefore returned an empty role list and `hasRole` denied everything. Approval
was reachable only by hand-written SQL. Fixing the identity fixes all three.

### The decisions worth keeping

**Identity is email, and existing rows fail closed.** Migration 0003 adds `administrators.email`
(NOT NULL, lowercased and structurally checked, one live row per address) and makes `contact_id`
optional — an operator who never texts is still an operator. Pre-existing rows have no email and no
way to invent one, so the migration **revokes** them rather than fabricating an identity. Inventing
one would have been a real authorization grant conjured by a schema change; this is a greenfield
build, so failing closed costs nothing.

**A session is a database row, not a signed claim — and that is the whole point.** Roles are
re-looked-up against the session's administrator on *every* request, so revoking an administrator
takes effect on their **next request** rather than whenever a self-contained token would have
expired. Only the token's SHA-256 hash is stored, so a database read cannot recover a live
credential — the same discipline as the phone hash. Unsalted SHA-256 is correct here and wrong for
phones: the input is 256 bits of uniform randomness, so there is no candidate set to enumerate.

**Login is not first-user-wins, and that took the shape it did deliberately.** The callback verifies
the link, then looks the email up in `administrators`. Holding a valid link proves you control an
address; it does **not** make you an operator. Auto-provisioning there would have been an open door
on a public URL. A non-administrator gets the same 401 as a bad token, so the endpoint never reveals
who VIGA's operators are. Bootstrap is a seed script rather than an env-var allowlist, because
authorization belongs in data where the audit trail can record it — an env var cannot say who
granted it or when.

**`ADMINISTRATOR_ROLES` is a constant, not a query.** That is the enforcement of Golden Rule #1: the
farmer owns published state, so an operator role must never confer the ability to act as a farm's
owner. A list that cannot vary cannot be widened by a bad row, a join, or a future column. VIGA
approves *whether* a farm may publish; the farmer alone owns *what* it publishes.

**Authority is re-read at the moment of the write.** `approveFarm` and `revokeFarmApproval` check the
administrator row inside their own transaction, holding the lock. A principal proves who the caller
*was* when the request started; only the locked row proves who they *are*. The route adds a second
check and the transaction the third — the third is the one that matters.

### The sabotage log

Every claim was verified falsifiable before being believed:

| Sabotage | Result |
|---|---|
| Role lookup also grants `farmer` | 2 tests fail |
| The `not_approved` gate removed entirely | 2 tests fail |
| `approveFarm` skips the administrator liveness check | 2 tests fail |
| Callback auto-provisions any verified email | 1 test fails |
| `POST` takes `administratorId` from the request body | 1 test fails |
| Logout clears only the cookie | 1 test fails |
| `requireRole` dropped from the farms route | 5 tests fail |
| `resolvePrincipal` returns a hardcoded admin | 5 tests fail |
| Each of 5 migration constraints dropped | 1 test each |
| Prefix-matching cookie parser; each cookie attribute | 1 test each |
| Session revocation / expiry-boundary / hash-identity | 1 test each |

**A false negative that taught the lesson again.** The first "callback skips the administrator
lookup" sabotage came back green, which looked like a hole in the test. It was not — the edit was
`if (false || administrator === null)`, which is *identical* to the original. Rewriting it as genuine
auto-provisioning made the test fail correctly. Worth recording because the failure mode is
seductive: a sabotage that does not change behavior proves nothing about the test, and reads exactly
like a test that cannot fail.

**One genuinely weak assertion, found and fixed.** That same test asserted
`expect(sessions.length).toBeGreaterThanOrEqual(0)` — a check that cannot fail. It now asserts that
no administrator row and no session were created, which is what the property actually is.

### Findings

- **Eight existing fixtures broke on the new NOT NULL, and that is the correct signal.** Every suite
  that inserts an administrator needed an email. Each got a distinct address, since the partial
  unique index rejects duplicate live rows and a shared literal would couple independent suites.
- **`createDb`, not a hand-built `Db`.** The first version of the approval suite built
  `{ orm: drizzle(clientA), sql: clientB }` and hit `ERR_INVALID_ARG_TYPE` binding a `Date`. The
  cause is documented on `createDb` itself: `drizzle()` overwrites the date serializers on whatever
  postgres.js client it is constructed over. Use `createDb`, which keeps the two clients separate
  structurally. (`sharedDb`'s first-call caching, per the standing rule, is why `createAppContext`
  is not an option here.)
- **Route suites must close `publicReadContext`'s pool.** It is cached for the process life and has
  no other owner in a test, so `dropdb` fails on the live connection without an explicit close.
- **Migration/schema drift was checked directly** rather than assumed: applying 0000–0003 to an empty
  database produces exactly the constraints and indexes `schema.ts` declares, with `email` NOT NULL
  and `contact_id` nullable.

### Deliberately not built

**Email delivery of the sign-in link (filed as F-031).** F-025a builds link *verification* and the
session it mints, not sending. Sending needs a mail provider, credentials, and a data-handling
attestation no decision has authorized — inventing one would be exactly the speculative machinery
CLAUDE.md forbids. Today a link is minted out of band with `issueMagicToken`, so a non-technical VIGA
operator cannot yet sign in unaided. That is a real gap before go-live, and it now has an owner.

**The flag queue and stock-out visibility (F-030, was F-025b).** `/api/admin/flags` keeps a *working*
role check over an empty list and reads nothing. Its retired-F-009 comment is gone, replaced by one
saying what it does and does not do. Until F-030 ships, an arriving flag is durable and unreviewable
— which is also why F-026's retention exemption never terminates.

**Verified, then merged to `main` as `0f2f44d` (PR #38):** unit 292/292 (30 files), integration
176/176 (13 files, real Postgres), typecheck, lint, evals critical 10/10 + advisory 4/4 +
adversarial 25/25, production build with `/admin` rendering. Re-verified green on merged `main`.
No deploy owed — nothing is deployed until F-029, and migrations run as part of that step.

---

## 2026-07-26 — B-004: the webhook kicks the workers, and three tests that could not fail

One item (B-004), one PR. Inbound reply latency went from a ~60s worst case to a **measured 47ms**
end to end against real Postgres. The production diff is 41 lines in one route plus a new 95-line
module; no worker, transaction, or handler changed, which was the explicit scope boundary.

**The fix is smaller than the problem sounded.** `runInboundPass` and `runOutboundPass` already
accepted an optional ID list — added during F-023 so tests could drive one sender — so a per-sender
kick needed no new plumbing at all. The webhook builds its 200 first, starts both passes with `void`
and a `.catch`, and returns. Everything durable stays where it was: the claim is still
`claimNextInboundEvent`'s row lock, dedup is still the inbox's unique provider event ID, the consent
recheck is still `authorizeDispatch`'s.

**The kick owns no guarantee, deliberately.** Next 14.2.35 has neither `unstable_after` nor
`@vercel/functions`' `waitUntil`, so work started after the response can be frozen or killed by the
runtime. That is not a problem to solve — it is the design. B-004's own acceptance criteria require
that a kick which "crashes, times out, or never runs loses nothing," so the kick is best-effort by
construction: every failure swallowed, each pass budgeted at 10s, cron unchanged as the recovery net
and still the only trigger for F-026's retention purge. Awaiting the kick would satisfy the latency
criterion and violate the acknowledgement one.

### The sabotage log, which is where the real work went

**"Suppressing the kick loses nothing" — proven by deleting it.** With the kick removed from the
route entirely, exactly the two latency tests fail and all four durability tests still pass,
including the reply going out on the next cron pass and both race tests. That asymmetry is the
proof; a suite where removing the feature fails everything would prove nothing about recoverability.

**The race tests could not fail, and finding that took four attempts.** First version used two
`Promise.all` branches. With the claim's `alreadyProcessing` check disabled — then the explicit
`for update` — then the `state = 'pending'` filter — the suite stayed green every time. Two branches
in one event loop do not race: the first claim transaction resolves before the second starts.
Instrumenting concurrent claims directly showed 1 of 3 succeeding even with guards removed, which
identified the actual load-bearing primitive: the **`sender_states` upsert**, whose `on conflict do
update` takes the row lock that serializes the whole claim transaction. The other three guards are
defense-in-depth over it. Only removing the upsert's lock produced genuine triple-claiming — and
only then did the race tests fail. They now use 8 contenders instead of 2.

**F-023's suite assumed an inert webhook, and 9 of its tests broke.** Not a defect in the kick: the
suite delivered a message through the real route and then ran its *own* pass with a controlled clock
and a `ForbiddenProvider`, which now raced a second real processor. Two fixes, deliberately
different. Tests that must own the model interaction (scripted-provider free-text cases) use a new
`deliverInboundOnly` that persists exactly what the route persists without kicking. Compliance tests
keep the original `ForbiddenProvider` proof on a no-kick delivery, and separately assert the kick
carried the message end to end.

**An honest limit, recorded rather than papered over.** `expectKickProcessedIt` was initially
commented as proving "no model on the compliance path" via the composition root's response-less stub
provider. Sabotage disproved that: moving the `freeText` call ahead of `parseCommand` still passed,
because these fixtures leave the database empty, empty retrieval short-circuits in code before any
seam (Golden Rule #4), and the stub is therefore never reached. The comment now says what the helper
does and does not prove, and the guarantee stays owned by `routing.test.ts`, whose throwing seam
fails 8 tests on that sabotage. The compliance path's `ForbiddenProvider` proof was re-verified as
still falsifiable after the restructure.

### Findings reported rather than absorbed

- **`sharedDb` caches on first call and ignores the URL thereafter.** So `createAppContext` cannot be
  bound to a second database in-process, and calling `close()` on a context tears down the pool other
  suites share. The latency suite assembles the two capabilities `runOutboundPass` actually reads
  (`db`, `sendSms`) instead. Worth knowing before anything else tries to build a second context.
- **Provider selection couples the webhook verification key to the delivery transport.** The route
  requires `SMS_PROVIDER=telnyx` to trust an inbound webhook, which also selects the live Telnyx
  transport — the test suite hit a real 401 against `api.telnyx.com` with a fake key. That coupling
  is a safety property (the simulator never inherits live secrets), so the suite stubs the one
  `fetch` at the network boundary rather than splitting the config axis.

**Verified on the branch:** unit 279/279 (28 files), integration 144/144 (10 files, PostgreSQL
16.12), typecheck, lint, evals critical 10/10 + advisory 4/4 + adversarial 25/25, production build.

---
