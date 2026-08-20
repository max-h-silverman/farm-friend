# Farm Friend — Data Architecture

The *data* source of truth: the constraints the database must enforce, privacy/retention, and the
model-run audit MAY-store list. The record-by-record reference is [DATA_RECORDS.md](DATA_RECORDS.md).

> The **enduring data contract**. No build status — that lives in
> [CURRENT_STATE.md](CURRENT_STATE.md).
>
> **A constraint here is a claim until a test can fail on it.** The real-Postgres integration harness
> is what makes these real: it creates an empty throwaway database, applies every committed migration
> in order, reruns the journal as a no-op, and exercises the checks, foreign keys, partial uniqueness,
> and published-history guards against live constraints. A guarantee proven only by a repository
> function is not proven.

## Scope discipline

Launch is a **single VIGA operation** and a **greenfield build**. Accordingly:

- **No tenancy.** No `tenant_id`, no tenant registry, no tenant-scoped queries.
- **No gleaning, volunteer, or Farm Bucks transaction state.** These are plausible future programs;
  the architecture leaves room for them by staying small, **not** by pre-creating their tables.
- **No import provenance.** Initial listing data was **seeded** from reviewed reference input, while
  later schema migrations preserve live rows. There is no `migrated` vs `farmer_confirmed` provenance
  axis, no corpus backfill, and no claim-state machine.
- **No native-app or multi-level-role state.** One administrator level at launch.

Recency is expressed by **when a revision was published, by whom, and from where** — the third being
`source` (F-063), which distinguishes a farmer's own handset from VIGA's records without a second axis
of its own. That is sufficient to render an honest "updated X ago".

## Minimum durable data

The record-by-record catalogue lives in **[DATA_RECORDS.md](DATA_RECORDS.md)** — what each durable
record is for and the rules that govern it. Look one up when you touch it.

| Group | Records |
|---|---|
| **farms and sales locations** | the farm and its stands; `address_public` / `prices_public`; `retired_at` on both levels; `farms.test_farm_at` |
| **farmer identity, access, invitation** | contacts and authorization, the farm email roster and verifications, onboarding requests, invitations, standing links, SMS target context, prompt preferences, VIGA approval, administrator and sessions, login-failure budgets |
| **listing facts** | structured public listing facts, structured availability |
| **seller payment** (F-125) | what a seller takes and whether she takes Farm Bucks — hers, stated once; a stand may only narrow it |
| **stand items** (F-066) | the one vocabulary a stand talks about its goods in — the standing and confirmed states, and structured prices |
| **records of what was said** | stand data flags, inventory revisions and entries, closure revisions, participants, stock-out reports, the SMS inbox, consent, outbox category, open confirmations, scheduled prompt subjects, pending result lists, flags, outbox, audit |

## Constraints the database must enforce

These are **database-level** requirements, not application conventions.

**A recurring rule worth stating once:** `select`-then-`insert` cannot serialize a row that does not
exist yet, and `for update` cannot lock one either. Wherever "at most one open X" must hold across
concurrent writers, the **unique index is the arbiter** — `insert … on conflict do nothing returning
…`, where an empty result means someone else won. This applies to verification codes, stand items,
participant names, onboarding requests, and prompt due-slots below.

- **Unique provider-event processing** — a provider event ID is accepted once. Retry or duplicate
  delivery cannot produce another state transition, model call consequence, publication, or outbox
  entry.
- **One ordinary stateful claim per sender** — concurrent workers cannot claim overlapping conversation
  work for one sender. An abandoned claim is recovered on the same inbox row.
- **An abandoned dispatch authorization is recoverable and resolves as ambiguous** — outbound work
  authorized but never resolved carries `dispatch_authorized_at`, and past a fixed lease it becomes
  `ambiguous` rather than being retried or left `dispatching` forever. It is never returned to
  `queued`: the provider may already have delivered the message (GL-003).
- **One address per (farm, normalized address)** (F-078) — the roster ingest is re-run whenever VIGA
  re-exports, so a duplicate must be impossible rather than merely unlikely. The index normalizes case
  and the **explicitly named** whitespace class `E' \t\r\n'`, because `btrim(text)` strips spaces
  alone. Scoped to the farm, not global: one couple farming two plots from one inbox is real. What
  must never happen — one address verifying the **wrong** farm — is enforced by scoping the query, not
  by this index.
- **One live verification code per farm** (F-079) — a partial unique index over unconsumed rows. Two
  live codes would mean the older one still opens the listing while the farmer types the newer, so "one
  open confirmation" would be a fiction.
- **A verification code is consumed exactly once** (F-079) — redemption is a conditional UPDATE on
  `consumed_at is null`, which both commits and decides the race; the grant is minted in the **same
  statement**, so a spent code can never leave the farmer with nothing.
- **Every stored hash is a 64-character lowercase hex digest** — asserted by CHECK on the phone, email,
  code, and grant columns. A malformed hash is a row nothing can ever look up, and the miss would be
  silent: the farmer's correct value would simply never match.
- **One open farmer-update confirmation per sender** — a partial uniqueness constraint prevents
  overlapping proposals from making generic `YES`/`NO` ambiguous. `NO` and expiry create no revision;
  `YES` creates every included immutable section or neither, only after the transaction rechecks the
  current prompt/version, independent bases, owner authority, and VIGA approval.
- **One currently published inventory revision per sales location** — "which revision is current" is a
  constraint, not a fragile `max(published_at)`.
- **One item per stand per name** (F-066) — a unique index over the location and the normalized name is
  what makes "eggs exists once here" structural rather than a convention the readers case-fold their
  way around. Normalization is **case and surrounding whitespace only**: it exists so `Eggs` and `eggs`
  are one item, and it must never fold singulars into plurals or synonyms into each other, which would
  be a produce taxonomy wearing a different hat. The farmer's own casing is kept for display beside
  the normalized key. That index is also the first-insert arbiter when two confirmations name the same
  new item at once.
- **An item's standing state is unreachable from the SMS path** (F-066) — enforced by which code holds
  the capability to write it, not by a column a message handler could set. The inbound message path can
  create an item and confirm it; only the farmer's authenticated web form can make it a standing claim.
  A test that publishes an inventory revision naming an unknown item and then asserts the usual mix is
  unchanged is what proves it.
- **An inventory entry's published words never change** (F-066) — the entries table gained no column
  and no backfill, because its history guard refuses every update unconditionally. Editing the usual
  mix touches item state only. The rendered card resolves a confirmed item to its stand item's current
  spelling so both lists speak one vocabulary; the **published row keeps its own words**, which is what
  makes the confirmation still a record of what was said.
- **One current closure instruction per location and one closure revision per proposal** — partial and
  ordinary unique indexes make both claims structural. CHECK constraints reject malformed reopen/close
  shapes, seasonal end dates, reversed dates, and incoherent current/superseded state; each nullable
  case is tested against real Postgres because a CHECK otherwise passes on NULL.
- **One active normalized participant name per location** (F-050) — a partial unique index is the
  first-insert arbiter. Composite foreign keys bind the location and confirming/retiring authorization
  to the same owner. CHECKs reject blank names, half-populated retirement state, and retirement before
  confirmation; deletion and mutation of history are refused.
- **Farmer authority over inventory publication** — only an authorized farmer for that location can
  publish, and only an approved farm publishes publicly. Both are re-read while the confirmation
  transaction holds the sender and pending-confirmation locks.
- **One live approval per farm, one fixed administrator identity** — partial unique indexes over
  unrevoked rows, plus a CHECK that refuses every administrator email except `board@vigavashon.org`.
  Revoked administrator rows remain for audit history and authorize nothing.
- **One live authorization per (farm, contact), one open onboarding request per phone, one live link
  per authorization** (F-040) — the same partial-index discipline. The authorization index is per
  *pair*, not per farm: a household where two people both text is ordinary, and refusing the second
  would be a product defect dressed as a constraint. The request index is what stops an impatient
  farmer texting five times from producing five queue entries.
- **One coherent farmer target context per sender** (F-051) — selected target columns are all null or
  all populated; menu issue/expiry/purpose are all null or all populated with expiry after issue; every
  option number is positive and unique within the sender's exact menu. **The seller a target names
  is bound to its PROVIDER, not to the stand's own seller** (`0047`), so a hosted listing is
  representable while a row still cannot name one seller's listing under another seller's name. The
  acting authorization is a plain reference: who may target whom is two live facts — the
  relationship's opt-in and the authorization's revocation — that a static key cannot see, and
  `PROVIDER_AUTHORITY_ARMS` enforces it at every reader.
- **One prompt preference per LISTING and one subject per preference due slot** (F-052; per-provider
  since F-114 C.4) — unique constraints make both facts structural, and `(provider_id,
  owner_seller_id)` binds the preference's seller to the listing's rather than to the stand owner's.
  Preference versions are positive; paused rows have no next
  due time; active rows do. Subject versions are positive, owner/location/authorization and
  inventory/closure bases are composite-FK bound, and a subject may offer `SAME` only when an inventory
  base exists. The due-slot unique constraint arbitrates concurrent schedulers.
- **A farmer's standing link resolves through its authorization, every request** (F-040) — the link
  carries no claim and no cached state, so there is nothing that could still resolve after the
  authority behind it was revoked. This is a *shape* requirement rather than a constraint the database
  can express, and it is the reason the never-expiring link is defensible.
- **Administrator authority is re-read at the moment of the write** — approval and revocation check the
  administrator row inside their own transaction, so a revocation that committed after a request began
  still wins. A principal proves who the caller was; only the locked row proves who they are.
- **Universal STOP before dispatch authorization** — a globally stopped recipient cannot claim a queued
  non-required message for dispatch. The atomic outbox claim is the boundary: work claimed before STOP
  may already be in flight and cannot be recalled.
- **Outbox uniqueness and bounded attempts** — business state and one logical outbound item commit
  together. A definitive retryable rejection may create another bounded attempt; a result that may have
  been provider-accepted becomes `ambiguous` and is not automatically resent.
- **Accepted confirmation dispatch and exact proposal activation are atomic** — after the external
  provider call, recording acceptance and opening the named current proposal version's window are one
  transaction. A failure leaves neither a `sent` outbox row nor an activated proposal; an old version
  or non-confirmation category activates nothing.
- **Monotonic provider delivery state** — duplicate or out-of-order delivery events cannot regress a
  terminal result.
- **Bounded valid states and transitions** — states are enumerated and illegal transitions rejected.
- **Separation between private customer reports and published inventory** — a stock-out report can
  **never** write inventory. This must be structural, and proven end-to-end rather than by checking
  that a returned object lacks a property.
- **Bound location before stock-out alerting** — a report capable of queuing a farmer alert must
  reference a valid sales location supplied by the code-bound surface. Recipient resolution follows
  that location's current farmer authorization in code; no model-produced location or recipient
  identifier is accepted.

## Privacy & retention

**One mechanism, two kinds of personal data** — emails are an *instance* of the phone discipline, not
a second mechanism. For both: normalized at ingress, the raw value lives in **exactly one column**, the
**hash is the only lookup/log key**, and raw values are **never logged**, **never enter model context**,
and are masked in admin.

| | Phones | Emails (F-078/F-079) |
|---|---|---|
| Raw column | `contacts.phone_e164` | `farm_emails.email` |
| Read only by | the outbound send path (SMS cannot be sent to a hash) | the send path and the verification lookup |
| Canonical form | discard punctuation | **case and whitespace only**, class named explicitly (`E' \t\r\n'`) to match the unique index |
| Admin masking | `maskPhoneSuffix` | `maskEmail` |

`farm_email_verifications` holds the hash and never a second copy of the address. VIGA's roster is
largely *personal* addresses, so they carry the same weight as phones.

**`administrator_phones` (F-074) does not weaken this:** it deliberately has **no `phone_e164` column
at all**, asserted against the real schema. `contacts` keeps a raw number *only* because the sender
needs something to send to; nothing on the test-farm path ever sends, so a raw column there would be
stored personal data with no reader. It keeps the **last four digits** beside the hash — the same lossy
fragment admin already shows (`right(phone_e164, 4)`) — so an operator can tell which row to remove.
Four digits identify a row to a human being; they do not identify a subscriber.

**Verifying is not publishing.** Farms that declined to put contact email on the printed map are still
stored and still authenticate. Nothing in `farm_emails` is a display column, and no public read path
selects from it — a query property proven by test against the **served bytes**, since a schema cannot
enforce it.

**The F-079 farmer-start secret is OBSCURITY, not authentication, and must be documented as such.**
`FARMER_START_SECRET` is a path segment, so it lands in browser history, `Referer` headers, access
logs, and any proxy in between. Unlike `/stand/[token]` it is **neither one-use nor revocable per
farmer** — it is one shared value for everyone VIGA sends it to. What it buys is that the migration
door is not crawled or casually walked into. **The credential that actually gates publishing is the
emailed code**, which is per-farm, single-use, expiring, attempt-capped, and rate-limited by farm and
by address. A deployment with no secret configured has no door at all, and answers every request under
`/farmer/start` with the same 404 it gives a wrong secret.

**Raw message context is short-lived** and deleted on expiry. A body is written with a **30-day**
`body_expires_at` (`DEFAULT_BODY_TTL_MS`); the scheduled retention purge clears it once that instant
passes. Only the body text goes — the `sms_messages` row, its inbox projection, dispatch attempts,
flags, and audit events are retained.

**A second, much shorter-lived copy exists while a question is open.** `pending_stock_out_reports`
holds one unanswered stock-out report per sender so the answer to "Which stand are you at?" has
somewhere to land (B-065). It carries the reporter's own message for **15 minutes**, keyed by phone
hash, deleted on resolution and on release, with the retention purge as the backstop. It adds no new
exposure: the same body already lives in `sms_messages` under the 30-day rule, and this copy is
strictly shorter-lived. It is a held *question*, not a conversation history — nothing outside the
stock-out path reads it, and it is unreachable from deterministic routing.

**Messages in a flagged thread stay readable while the flag is open.** The exemption is keyed on
`flags.status = 'open'` for any flag on the message's inbox event, and it **fails safe**: a body is
purged only when the absence of an open flag can be shown, because over-retention is recoverable and
destroying evidence under an open safety review is not. Resolution makes the body immediately
eligible; there is **no** bounded grace period after resolution, since no consumer needs one.
`disposeFlag` moves a flag to `resolved` or `dismissed`, and either one ends the exemption — including
that a *dismissed* thread purges, which is what a drift from `= 'open'` to `<> 'resolved'` would break.

**The purge never races live delivery.** Outbound bodies are cleared only in a terminal state
(`sent`/`failed`/`ambiguous`/`suppressed`), because the dispatcher reads `outbox_work.body` to send it.
It reports **counts only** — never a body, an identifier, or a phone.

**Only selected preference and safety records survive raw-context expiration.** Farm Friend may retain
lightweight facts such as foods requested or preferred stands; it must not accumulate a rich personal
profile, and **precise durable home addresses are not part of a customer profile**.

**A customer's email is held only where they asked for a reply, and only for as long as that reply is
owed** (B-091). An issue reporter may add an address so VIGA can answer them; it is stored **on the
flag**, not on the contact, so it is scoped to the one issue it was given for and disappears with it.
This is not the start of a customer profile and must not become one: the address exists because a
person asked to be written to, and it dies with the question they asked. It follows the same shape as
every other identifier here — raw value in exactly one column, the hash as the only lookup and log key,
masked wherever an operator reads it, never in model context. Where the salt is not mounted, the
address is **refused rather than stored without its key**.

**Browser origins are transient.** Optional browser geolocation may be used to calculate approximate
proximity to validated public sales-location coordinates; it is not stored, logged, sent to the model,
or retained as a customer preference.

**Model inputs are task-specific projections, not records or transcripts.** A seam receives only its
current task text and the permitted public facts or opaque identifiers its job requires, as specified in `AI_ARCHITECTURE.md`;
it receives no other actor's message, unrelated thread history, raw contact data,
authentication/consent state, admin/audit rows, internal notes, or secrets. Model-authored prose may
return only to the actor whose current task text supplied that context. Cross-actor messages are
code-rendered without relaying customer free text.

**The configured model provider passes a privacy gate.** It must not train on Farm Friend
requests/responses; calls are stateless with no provider-managed conversation, file, memory, or
retrieval store; request/response logging is disabled where supported; and any unavoidable provider
retention has an approved documented maximum compatible with Farm Friend's raw-context retention.

**Public listings expose** stand addresses and farmer-selected links from their code-owned listing
fields. Public strings are validated together at publication and the whole write is
refused — never sanitized — when they contain phone numbers, email addresses, web links, or
direct-contact instructions. **Direct farmer contact is never public.** The rule follows the string
to the public surface, not the writer: it covers model-written listing fields, the display-only
participant names, and — since F-114 Phase C.1 — a **seller name typed at either invitation door**,
because a hosted seller is credited on the stand's public card. An existing seller's name is not
re-validated on invitation; it is already public, and refusing it would block an invitation over a
row that call did not write.

**Consent:** active launch-program consent gates every proactive non-required SMS. `START` establishes
**or restores** it with provenance; `JOIN` and documented farmer onboarding establish it only for a
sender with **no** consent record, because the carrier's own opt-out list is cleared by `START` alone
(B-011, SMS_COMPLIANCE.md). Onboarding is therefore never a way back in after an opt-out — a farmer
who texted `STOP` and later completes a web form is not re-enrolled. A customer-initiated inquiry
permits its relevant direct response but creates no durable consent for later proactive notifications.
`STOP` clears launch consent immediately and applies across all Farm Friend messaging. STOP/START
transitions are ordered separately from conversation state by provider occurrence time, with STOP
winning an exact timestamp tie. A future program gets separate enrollment only when built. **Active**
consent is required — an absent consent row is not permission (F-016).

**Pending confirmations are GC'd on expiry.** A confirmation is live only after its current prompt is
provider-accepted; a token that predates that activation or names no live proposal commits nothing.

**Raw webhook bytes are ephemeral.** They are used to verify the Telnyx signature and then discarded
after the minimized inbox projection commits; the raw envelope is never logged or retained.

**Flags and audit rows are retained.**

## Model-run evidence — what it MAY store (never the model input)

The audit row must be **debuggable without becoming a PII leak**. It stores **no raw or stripped model
input** and no output content that could carry PII. It **MAY** store:

- the **seam** name;
- the **provider** and **model** id;
- the **schema version** the output was validated against;
- the **validation status** (passed / repaired-then-passed / rejected) and repair count;
- an **opaque id set or hashes** linking to the durable rows involved (not their contents);
- timing and cost metadata.

To debug *content*, reproduce from the durable source rows through the assembler — this row is a
provenance/telemetry record, not a transcript.

**Verified against the schema (F-026):** `model_runs` carries exactly these columns and no other.
`retention.integration.test.ts` asserts the column set and fails if a content-bearing column is ever
added.
