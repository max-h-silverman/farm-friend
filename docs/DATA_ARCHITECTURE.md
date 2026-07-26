# Farm Friend — Data Architecture

The *data* source of truth: the minimum durable records, the constraints the database must
enforce, privacy/retention, and the model-run audit MAY-store list.

> **Design authority.** [CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)
> is the settled contract; where this doc disagrees, the handoff wins.
>
> **Status: schema, transaction path, and retention purge implemented.**
> `packages/db/src/schema.ts`, `drizzle/0000_clean_launch.sql`, and the F-014 forward migration
> `drizzle/0001_authoritative_transactions.sql` contain the launch records and constraints below.
> The real-Postgres integration harness creates an empty throwaway database, applies every
> committed migration, reruns the journal as a no-op, and exercises the checks, foreign keys,
> partial uniqueness, and published-history guards. **F-014 implements and proves** the repository
> transactions for sender claiming and recovery, conversation ordering, consent ordering,
> confirmation/publication with authority and approval rechecks, dispatch authorization, and
> delivery monotonicity. **F-026 implements and proves** raw-context retention:
> `purgeExpiredBodies` (`packages/db/src/transactions.ts`) clears expired bodies on the scheduled
> trigger and honors the flagged-thread exemption, proven against real Postgres in
> `packages/db/src/retention.integration.test.ts`. **F-025a implements and proves** administrator
> identity, durable sessions, and farm approval/revocation (`drizzle/0003_admin_identity_and_sessions.sql`,
> `packages/db/src/admin.ts`), including the constraint that publication for an unapproved farm is
> refused when no fixture pre-inserts the approval row. The private-report and stock-out alerting
> paths owned by F-013 remain requirements.

## Scope discipline

Launch is a **single VIGA operation** and a **greenfield build**. Accordingly:

- **No tenancy.** No `tenant_id`, no tenant registry, no tenant-scoped queries.
- **No gleaning, volunteer, or Farm Bucks transaction state.** These are plausible future programs;
  the architecture leaves room for them by staying small, **not** by pre-creating their tables.
- **No legacy-migration provenance.** There is no production-data compatibility requirement and no
  non-destructive migration. Initial listing data is **seeded** from reference input. There is no
  `migrated` vs `farmer_confirmed` provenance axis and no claim-state machine.
- **No native-app or multi-level-role state.** One administrator level at launch.

Recency is expressed by **when a revision was published and by whom**, which is sufficient to
render an honest "updated X ago" without a second provenance axis.

## Minimum durable data

- **farms and sales locations** — the farm, its stands or sales points, and their public location.
  A farm without a public stand records an exact, approximate, or hidden map location.
- **farmer contacts and authorization** — who may act for a farm, and proof they control the phone
  number.
- **VIGA approval** — recorded **separately** from onboarding completion; approval is VIGA's act,
  not a side effect of a farmer finishing a form. Approval and revocation both record **which
  administrator acted and when**, and revocation updates the row rather than deleting it: published
  revisions reference the approval they were made under.
- **administrators and their sessions** — an administrator is identified by **email**, the identity
  the login path proves; the phone contact is optional and is not the identity. A session is a
  durable row holding only the **hash** of its token, so a database read cannot recover a live
  credential, and roles are re-looked-up per request so revocation is immediate. Sessions carry no
  personal data beyond the administrator link.
- **structured public listing facts** — including payment methods and VIGA Farm Bucks acceptance or
  eligibility as **read-only facts**, plus farmer-selected web/social links and an optional photo
  or short biography.
- **inventory revisions and inventory entries** — a revision is an immutable published version of a
  location's inventory; entries are the items in it, with quantity/unit/price text or an
  approximate label. Revisions have no draft state and are created only by successful confirmation.
- **customer stock-out reports** — private; each carries a required sales-location identifier bound
  by the web/QR reporting surface, and may reference a listed entry or name an unlisted item. A
  model does not supply the consequential location identifier.
- **minimized SMS inbox and message records** with limited retention — unique provider event/message
  identifiers, event type and `occurred_at`, sender/contact reference, TTL-bound body where needed,
  processing state, and per-sender conversation watermark/claim. The raw provider envelope is not a
  durable record.
- **launch-program SMS consent and universal STOP** — one current launch consent state per
  recipient, provenance for how, when, and where consent was captured, and a separate provider-time
  STOP/START transition watermark. Launch has no program discriminator or future-program enrollment
  rows. `sms_consents` is keyed by `recipient_hash` alone, so a second enrollment for the same
  recipient is not representable; `consent_capture_source` is bounded to `join` / `start` /
  `farmer_onboarding`, all of which establish the same one program (F-016).
- **outbox message category** — `outbox_work.message_category` is a bounded enum naming which
  launch category a queued message is, and it is the typed input to the dispatch consent gate. It
  replaces the former free-text `message_kind` plus `is_required` boolean, which were two
  overlapping ways to say one thing and could not express a direct reply that is permitted by the
  recipient's own message without being carrier-required.
- **one open inventory-publication confirmation per sender** — target sales location, distinct
  structured pending proposal payload/version, allowed `YES`/`NO` tokens, provider-accepted prompt
  activation, expiry, and consumption state. This is not an inventory revision.
- **flags and admin dispositions.**
- **transactional outbox.**
- **minimal audit and model-run evidence.**

## Constraints the database must enforce

These are **database-level** requirements, not application conventions:

- **Unique provider-event processing** — a provider event ID is accepted once. Retry or duplicate
  delivery cannot produce another state transition, model call consequence, publication, or outbox
  entry.
- **One ordinary stateful claim per sender** — concurrent workers cannot claim overlapping
  conversation work for one sender. An abandoned claim is recovered on the same inbox row.
- **One open inventory confirmation per sender** — a partial uniqueness constraint prevents
  overlapping proposals from making generic `YES`/`NO` ambiguous. `NO` and expiry create no
  revision; `YES` creates the immutable revision and entries only after the transaction rechecks
  the current prompt/version, farmer authority, and VIGA approval.
- **One currently published inventory revision per sales location** — "which revision is current"
  is a constraint, not a fragile `max(published_at)`.
- **Farmer authority over inventory publication** — only an authorized farmer for that location can
  publish, and only an approved farm publishes publicly. Both are re-read while the confirmation
  transaction holds the sender and pending-confirmation locks.
- **One live approval per farm, one live administrator per email** — partial unique indexes over
  unrevoked rows. The email index is what keeps the login lookup unambiguous; revoked rows remain
  for the audit trail and are excluded from both.
- **Administrator authority is re-read at the moment of the write** — approval and revocation check
  the administrator row inside their own transaction, so a revocation that committed after a request
  began still wins. A principal proves who the caller was; only the locked row proves who they are.
- **Universal STOP before dispatch authorization** — a globally stopped recipient cannot claim a
  queued non-required message for dispatch. The atomic outbox claim is the boundary: work claimed
  before STOP may already be in flight and cannot be recalled.
- **Outbox uniqueness and bounded attempts** — business state and one logical outbound item commit
  together. A definitive retryable rejection may create another bounded attempt; a result that may
  have been provider-accepted becomes `ambiguous` and is not automatically resent.
- **Monotonic provider delivery state** — duplicate or out-of-order delivery events cannot regress a
  terminal result.
- **Bounded valid states and transitions** — states are enumerated and illegal transitions rejected.
- **Separation between private customer reports and published inventory** — a stock-out report can
  **never** write inventory. This must be structural, and proven end-to-end rather than by checking
  that a returned object lacks a property.
- **Bound location before stock-out alerting** — a report capable of queuing a farmer alert must
  reference a valid sales location supplied by the code-bound web/QR surface. Recipient resolution
  follows that location's current farmer authorization in code; no model-produced location or
  recipient identifier is accepted.

## Privacy & retention

- **Phones:** normalized at ingress; the raw E.164 lives in **exactly one column**, read **only** by
  the outbound send path (SMS cannot be sent to a hash); the **hash is the only lookup/log key**.
  Raw numbers are **never logged**, **never enter model context**, and are masked in admin.
- **Raw message context is short-lived** and deleted on expiry. A body is written with a **30-day**
  `body_expires_at` (`DEFAULT_BODY_TTL_MS`); the scheduled retention purge clears it once that
  instant passes. Only the body text goes — the `sms_messages` row, its inbox projection, dispatch
  attempts, flags, and audit events are retained.
- **Messages in a flagged thread stay readable while the flag is open** — flag review needs readable
  threads. The exemption is keyed on `flags.status = 'open'` for any flag on the message's inbox
  event, and it **fails safe**: a body is purged only when the absence of an open flag can be shown,
  because over-retention is recoverable and destroying evidence under an open safety review is not.
  Resolution makes the body immediately eligible; there is **no** bounded grace period after
  resolution, since no consumer needs one and an unowned window would be speculative state.
  **F-030 owns the resolution path** (split out of F-025, whose identity half shipped); until it
  flagged body retains indefinitely — the exemption working, not a leak.
- **The purge never races live delivery.** Outbound bodies are cleared only in a terminal state
  (`sent`/`failed`/`ambiguous`/`suppressed`), because the dispatcher reads `outbox_work.body` to
  send it. It reports **counts only** — never a body, an identifier, or a phone.
- **Only selected preference and safety records survive raw-context expiration.** Farm Friend may
  retain lightweight facts such as foods requested or preferred stands; it must not accumulate a
  rich personal profile, and **precise durable home addresses are not part of a customer profile**.
- **Browser origins are transient.** Optional browser geolocation may be used to calculate
  approximate proximity to validated public sales-location coordinates; it is not stored, logged,
  sent to the model, or retained as a customer preference.
- **Model inputs are task-specific projections, not records or transcripts.** A seam receives only
  its current task text, permitted public facts, and opaque identifiers as specified in
  `AI_ARCHITECTURE.md`; it receives no other actor's message, unrelated thread history, raw contact
  data, authentication/consent state, admin/audit rows, internal notes, or secrets. Model-authored
  prose may return only to the actor whose current task text supplied that context. Cross-actor
  messages are code-rendered without relaying customer free text.
- **The configured model provider passes a privacy gate.** It must not train on Farm Friend
  requests/responses; calls are stateless with no provider-managed conversation, file, memory, or
  retrieval store; request/response logging is disabled where supported; and any unavoidable
  provider retention has an approved documented maximum compatible with Farm Friend's raw-context
  retention.
- **Public listings expose** stand addresses and farmer-selected links. **Direct farmer phone
  numbers and email addresses are never public.**
- **Consent:** active launch-program consent gates every proactive non-required SMS. `JOIN`, `START`,
  and documented farmer onboarding establish it with provenance. A customer-initiated inquiry
  permits its relevant direct response but creates no durable consent for later proactive
  notifications. `STOP` clears launch consent immediately and applies across all Farm Friend
  messaging. STOP/START transitions are ordered separately from conversation state by provider
  occurrence time, with STOP winning an exact timestamp tie. A future program gets separate
  enrollment only when built; launch stores no future-program state. **Active** consent is
  required — an absent consent row is not permission, and the gate that once asked only "has this
  recipient STOPped?" was a real defect fixed in F-016.
- **Pending confirmations are GC'd on expiry.** A confirmation is live only after its current prompt
  is provider-accepted; a token that predates that activation or names no live proposal commits
  nothing.
- **Raw webhook bytes are ephemeral.** They are used to verify the Telnyx signature and then
  discarded after the minimized inbox projection commits; the raw envelope is never logged or
  retained.
- **Flags and audit rows are retained.**

## Model-run evidence — what it MAY store (never the model input)

The audit row must be **debuggable without becoming a PII leak**. It stores **no raw or stripped
model input** and no output content that could carry PII. It **MAY** store:

- the **seam** name;
- the **provider** and **model** id;
- the **schema version** the output was validated against;
- the **validation status** (passed / repaired-then-passed / rejected) and repair count;
- an **opaque id set or hashes** linking to the durable rows involved (not their contents);
- timing and cost metadata.

To debug *content*, reproduce from the durable source rows through the assembler — this row is a
provenance/telemetry record, not a transcript.

**Verified against the schema (F-026):** `model_runs` carries exactly these columns and no other —
nothing holding a prompt, a completion, or a transcript. The list and the table agree, so the
retention purge has nothing to reach here. `retention.integration.test.ts` asserts the column set
and fails if a content-bearing column is ever added.
