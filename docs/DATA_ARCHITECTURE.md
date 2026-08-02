# Farm Friend — Data Architecture

The *data* source of truth: the minimum durable records, the constraints the database must
enforce, privacy/retention, and the model-run audit MAY-store list.

> This document states the **enduring data contract** — the durable records Farm Friend must keep and
> the constraints the database must enforce. It carries no build status: what is actually built,
> migrated, and open lives in [CURRENT_STATE.md](CURRENT_STATE.md).
>
> **A constraint here is a claim until a test can fail on it.** The real-Postgres integration harness
> is what makes these real: it creates an empty throwaway database, applies every committed migration
> in order, reruns the journal as a no-op, and exercises the checks, foreign keys, partial uniqueness,
> and published-history guards against live constraints. A guarantee proven only by a repository
> function — never by the constraint itself — is not proven.

## Scope discipline

Launch is a **single VIGA operation** and a **greenfield build**. Accordingly:

- **No tenancy.** No `tenant_id`, no tenant registry, no tenant-scoped queries.
- **No gleaning, volunteer, or Farm Bucks transaction state.** These are plausible future programs;
  the architecture leaves room for them by staying small, **not** by pre-creating their tables.
- **No legacy-import provenance.** Initial listing data was **seeded** from reviewed reference
  input, while later schema migrations preserve live rows. There is no `migrated` vs
  `farmer_confirmed` provenance axis, no corpus backfill, and no claim-state machine.
- **No native-app or multi-level-role state.** One administrator level at launch.

Recency is expressed by **when a revision was published and by whom**, which is sufficient to
render an honest "updated X ago" without a second provenance axis.

## Minimum durable data

- **farms and sales locations** — the farm and its stands or sales points. A location's
  `owner_farm_id` is the farm authorized to govern address, hours, closure, and visibility; owner
  authority is not seller participation. A farm without a public stand records an exact,
  approximate, or hidden map location.
- **farmer contacts and authorization** — who may act for a farm, and proof they control the phone
  number. **VIGA always grants this**, because a phone proves possession of a phone and not
  ownership of a farm: the only writer is administrator-gated, re-reads the administrator's
  authority inside its own transaction, and records who acted. Revocation updates the row rather
  than deleting it — published revisions reference the authorization they were made under.
- **farmer onboarding requests** (F-040) — what a farmer *asked* for, waiting for VIGA. **Grants
  nothing, and is shaped so it cannot**: no farm, no grant column, no message text, and nothing
  reads it as authority. It is the one record on this list writable from an unauthenticated inbound
  SMS, which is why it holds only "this phone asked, at this time". One open request per phone;
  settled requests stay as history and record which administrator answered them.
- **farmer standing links** (F-040) — a durable key letting a farmer reach *their own* listing form
  in a browser, with no password and no session. Only the **hash** of the token is stored, as with
  a session token. A link is a **pointer to an authorization, never authority itself**: resolution
  re-reads both the link's and the authorization's revocation columns on every request, so there is
  no cached "active" flag and no signed claim that could keep saying "valid" after the authority
  behind it was withdrawn. New links bind one exact owner+location pair; the duplicated owner id
  exists only so composite foreign keys can prove that both the authorization and location belong
  to the same farm. The link does not expire, so
  **revocation is the entire safety net** — which is why nothing about it may be cached. One live
  link per authorization: re-issuing replaces rather than accumulates.
- **farmer SMS target context** (F-051) — one selected authorization+owner+location tuple per
  sender, plus at most one 12-hour numbered menu whose options bind exact tuples. Selection is
  convenience, never authority: every use revalidates live authorization and location. Populated
  pre-F-051 links keep both target columns null and retain their one-location resolution rule.
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
- **structured availability** (F-035) — season, days of week, time of day, and restocking cadence as
  **queryable columns rather than prose**, so "what is open right now" is a filter and not a text
  scan. Kinds that are not clock times (`dawn_to_dusk`, `daylight_hours`) and cadences that are not
  schedules (`variable`, `as_needed`) are **first-class enum values, not missing data** — on an
  unattended honor-system stand they are the truthful answer, and a clock time would invent
  precision the farmer never stated. The farmer's own wording is kept verbatim beside them as
  **display-only text that is never filtered on**, so a caveat like "Saturday and Sunday when
  available" survives without the structured fields overstating it. `year_round` is distinct from an
  absent season: "always open" and "never recorded" are different facts.
- **stand specialties** (F-035) — what a location *usually* carries, held separately from inventory
  revisions. The separation is **structural, not conventional**: a revision requires a farmer
  authorization and a VIGA approval, so a seeder or an ingest path cannot fabricate a confirmation
  by writing one. Specialties carry no confirmation time and must never be rendered as current
  availability. **Read by the public listing** (F-042) as a field of its own, never merged into the
  confirmed items, and rendered under a heading that takes no timestamp — the record's "no
  confirmation time" property has to survive all the way to the screen to mean anything.
- **stand data flags** (F-035) — where a contradiction in seeded source data waits for a human.
  Distinct from the customer-message `flags` table, which is keyed to a contact and an inbox event a
  seed flag has neither of. One open flag per (location, reason); resolved flags stay as history.
- **inventory revisions and inventory entries** — a revision is an immutable published version of a
  location's inventory; entries are the items in it, with quantity/unit/price text or an
  approximate label. Revisions have no draft state and are created only by successful confirmation.
- **closure revisions** (F-049) — append-only owner-confirmed close/reopen history, separate from
  inventory. A close carries `temporary` or `seasonal` plus a Vashon-local start date; temporary may
  carry an inclusive end date. Reopen carries no kind or dates. Composite foreign keys bind the
  location, authorization, and approval to the same owner farm. One current instruction per
  location and one revision per proposal are database constraints; bounded expiry is computed by
  the canonical reader and never rewrites these rows.
- **sales-location participants** (F-050) — owner-confirmed public display names for other sellers
  at a location, separate from both ownership and inventory. Names are unlinked plain text: code
  does no farm/profile/alias matching, the owner is not inserted automatically, and inventory
  entries carry no participant or seller provenance. Retirement records the owner authorization
  and time without deleting history. The public reader returns active names under **Also selling
  here**, separately from the single aggregate inventory list.
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
- **one open farmer-update confirmation per sender** — target sales location, explicit inventory
  and closure section-presence flags, an independent base binding for each included section,
  structured complete payload/version, allowed `YES`/`NO` tokens, provider-accepted prompt
  activation, expiry, and consumption state. Existing inventory entries retain their opaque
  reference IDs in that payload; code issues opaque draft IDs for new entries so later unconfirmed
  edits can target them. This is neither an inventory nor a closure revision.
- **one pending result list per sender** (F-046) — the ordered fact identifiers a customer's last
  answer selected, the product words it was about, how far through them they have read, and an
  expiry. `MORE` **replays** this list rather than re-running retrieval, so paging is consistent
  and costs no model call; the accepted tradeoff is that stock confirmed mid-paging waits for the
  next question, which the expiry bounds. **One row per sender**, replaced by each new question, so
  `MORE` is never ambiguous about which list it means.
  It stores **no message body and no rendered reply text**: the customer's question is untrusted
  inbound text with a short retention life of its own, and copying it here would create a second,
  longer-lived home for it. The requested items are the narrow exception — the product words the
  interpretation seam extracted, not the sender's sentence — because a later page must name its
  subject to read as an answer.
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
- **An abandoned dispatch authorization is recoverable and resolves as ambiguous** — outbound work
  authorized but never resolved carries `dispatch_authorized_at`, and past a fixed lease it becomes
  `ambiguous` rather than being retried or left `dispatching` forever. It is never returned to
  `queued`: the provider may already have delivered the message (GL-003).
- **One open farmer-update confirmation per sender** — a partial uniqueness constraint prevents
  overlapping proposals from making generic `YES`/`NO` ambiguous. `NO` and expiry create no
  revision; `YES` creates every included immutable section or neither only after the transaction
  rechecks the current prompt/version, independent bases, owner authority, and VIGA approval.
- **One currently published inventory revision per sales location** — "which revision is current"
  is a constraint, not a fragile `max(published_at)`.
- **One current closure instruction per location and one closure revision per proposal** — partial
  and ordinary unique indexes make both claims structural. CHECK constraints reject malformed
  reopen/close shapes, seasonal end dates, reversed dates, and incoherent current/superseded state;
  each nullable case is tested against real Postgres because a CHECK otherwise passes on NULL.
- **One active normalized participant name per location** (F-050) — a partial unique index is the
  first-insert arbiter; row locks cannot serialize a row that does not exist. Composite foreign
  keys bind the location and confirming/retiring authorization to the same owner. CHECKs reject
  blank names, half-populated retirement state, and retirement before confirmation; deletion and
  mutation of history are refused.
- **Farmer authority over inventory publication** — only an authorized farmer for that location can
  publish, and only an approved farm publishes publicly. Both are re-read while the confirmation
  transaction holds the sender and pending-confirmation locks.
- **One live approval per farm, one live administrator per email** — partial unique indexes over
  unrevoked rows. The email index is what keeps the login lookup unambiguous; revoked rows remain
  for the audit trail and are excluded from both.
- **One live authorization per (farm, contact), one open onboarding request per phone, one live
  link per authorization** (F-040) — the same partial-index discipline. The authorization index is
  per *pair*, not per farm: a household where two people both text is ordinary, and refusing the
  second would be a product defect dressed as a constraint. The request index is what stops an
  impatient farmer texting five times from producing five queue entries, and it is the **arbiter**
  rather than a read — concurrent inserts would both observe "none open", and `for update` cannot
  lock a row that does not exist yet, so the writer uses `on conflict do nothing returning`.
- **One coherent farmer target context per sender** (F-051) — selected target columns are all null
  or all populated; menu issue/expiry/purpose are all null or all populated with expiry after
  issue; every option number is positive and unique within the sender's exact menu. Targeted
  standing-link owner/location columns are both null or both populated, with composite foreign
  keys binding both the authorization and location to that owner.
- **A farmer's standing link resolves through its authorization, every request** (F-040) — the link
  carries no claim and no cached state, so there is nothing that could still resolve after the
  authority behind it was revoked. This is a *shape* requirement rather than a constraint the
  database can express, and it is the reason the never-expiring link is defensible: revocation is
  the only safety net, so it must be impossible to cache around.
- **Administrator authority is re-read at the moment of the write** — approval and revocation check
  the administrator row inside their own transaction, so a revocation that committed after a request
  began still wins. A principal proves who the caller was; only the locked row proves who they are.
- **Universal STOP before dispatch authorization** — a globally stopped recipient cannot claim a
  queued non-required message for dispatch. The atomic outbox claim is the boundary: work claimed
  before STOP may already be in flight and cannot be recalled.
- **Outbox uniqueness and bounded attempts** — business state and one logical outbound item commit
  together. A definitive retryable rejection may create another bounded attempt; a result that may
  have been provider-accepted becomes `ambiguous` and is not automatically resent.
- **Accepted confirmation dispatch and exact proposal activation are atomic** — after the external
  provider call, recording acceptance and opening the named current proposal version's window are
  one transaction. A failure leaves neither a `sent` outbox row nor an activated proposal; an old
  version or non-confirmation category activates nothing.
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
  **F-030 built the resolution path**: `disposeFlag` moves a flag to `resolved` or `dismissed`, and
  either one ends the exemption, so the next purge pass clears that thread's expired bodies. Proven
  end to end in `packages/db/src/review.integration.test.ts` — including that a *dismissed* thread
  purges, which is what a drift from `= 'open'` to `<> 'resolved'` would break.
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
- **Public listings expose** stand addresses and farmer-selected links from their code-owned listing
  fields. Model-writable public strings are validated together at publication and the whole write is
  refused — never sanitized — when they contain phone numbers, email addresses, web links, or
  direct-contact instructions. **Direct farmer contact is never public.**
- **Consent:** active launch-program consent gates every proactive non-required SMS. `START` and
  documented farmer onboarding establish or restore it with provenance; `JOIN` establishes it only
  for a sender with **no** consent record, because the carrier's own opt-out list is cleared by
  `START` alone (B-011, docs/SMS_COMPLIANCE.md). A customer-initiated inquiry
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
