# Farm Friend — Data Architecture

The *data* source of truth: the minimum durable records, the constraints the database must
enforce, privacy/retention, and the model-run audit MAY-store list.

> **Design authority.** [CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)
> is the settled contract; where this doc disagrees, the handoff wins.
>
> **Status: requirements, not claims.** There are **no committed migrations** in the repository,
> and the current schema contains speculative structures this document no longer describes. Every
> entity and constraint below is a **requirement for the launch schema**, not a description of what
> exists. Do not cite this doc as evidence that a constraint is enforced.

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
  not a side effect of a farmer finishing a form.
- **structured public listing facts** — including payment methods and VIGA Farm Bucks acceptance or
  eligibility as **read-only facts**, plus farmer-selected web/social links and an optional photo
  or short biography.
- **inventory revisions and inventory entries** — a revision is a published version of a location's
  inventory; entries are the items in it, with quantity/unit/price text or an approximate label.
- **customer stock-out reports** — private; each carries a required sales-location identifier bound
  by the web/QR reporting surface, and may reference a listed entry or name an unlisted item. A
  model does not supply the consequential location identifier.
- **minimized SMS inbox and message records** with limited retention — unique provider event/message
  identifiers, event type and `occurred_at`, sender/contact reference, TTL-bound body where needed,
  processing state, and per-sender conversation watermark/claim. The raw provider envelope is not a
  durable record.
- **consent events and universal STOP** — global consent plus per-program enrollment for any future
  program, provenance for how consent was captured, and a separate provider-time STOP/START
  transition watermark.
- **one open inventory-publication confirmation per sender** — proposal/version, allowed `YES`/`NO`
  tokens, provider-accepted prompt activation, expiry, and consumption state.
- **narrow expiring follow-up interests and scoped MUTE.**
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
  overlapping proposals from making generic `YES`/`NO` ambiguous.
- **One currently published inventory revision per sales location** — "which revision is current"
  is a constraint, not a fragile `max(published_at)`.
- **Farmer authority over inventory publication** — only an authorized farmer for that location can
  publish, and only an approved farm publishes publicly. Both are re-read while the confirmation
  transaction holds the sender and pending-confirmation locks.
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
- **Raw message context is short-lived** and deleted on expiry. Messages in a flagged thread stay
  readable while the flag is open and for a bounded period after resolution — flag review needs
  readable threads. *(Exact retention period is an unresolved launch decision.)*
- **Only selected preference and safety records survive raw-context expiration.** Farm Friend may
  retain lightweight facts such as foods requested or preferred stands; it must not accumulate a
  rich personal profile, and **precise durable home addresses are not part of a customer profile**.
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
- **Consent:** global consent gates all SMS; per-program enrollment gates each future program;
  `STOP` clears global consent immediately and applies across all Farm Friend messaging. STOP/START
  transitions are ordered separately from conversation state by provider occurrence time, with STOP
  winning an exact timestamp tie.
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
