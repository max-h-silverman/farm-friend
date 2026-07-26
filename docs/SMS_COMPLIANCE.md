# Farm Friend — SMS Compliance

Keywords, consent, required behavior, and the FLAG safety rail. SMS is the **critical path** daily
driver; **A2P 10DLC is assumed approved by launch** (Eat Vashon week). All copy here is
**provisional** until the campaign is registered. Routing mechanics are in
[ARCHITECTURE.md](ARCHITECTURE.md); consent data in [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md).

> **Design authority.** [CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)
> is the settled contract; where this doc disagrees, the handoff wins.
>
> **Status: consent model executable (F-016); one external question open.** The launch-program
> consent decision is now a pure predicate in `packages/core/src/sms/consent.ts` enforced at the
> outbox dispatch claim, and it requires **active** consent rather than merely "not stopped."
> F-014 implements
> verified ingress, durable minimized persistence, per-sender serialization, the separate
> provider-time STOP/START consent watermark, and the dispatch-claim consent boundary, all proven
> by real-Postgres tests. F-012 aligned the keyword set: the parser derives its tables from the
> registered opt-out/opt-in/help lists, `STOPALL` now opts out globally, and the obsolete
> `OUT`/`IGNORE` tokens are gone from the parser, the registered artifact, and public copy.
> **Resolved 2026-07-26 — no resubmission was required.** The live console registers two sample
> messages, both using `YES`/`NO`; the "Message 3" that advertised `OUT`/`IGNORE` existed only in
> `docs/TELNYX_10DLC_FIELD_VALUES.txt`, which was a draft misread as a record of registered copy.
> That file is now a transcript of live console state — **change the console first, then transcribe.**
> The HELP auto-response was also corrected to route to `board@vigavashon.org`, so the campaign's
> declared `Embedded Phone Number: No` is truthful.
> **Routed as of F-023.** Persisted inbound events now reach `parseCommand` through
> `runInboundPass` → `apps/web/lib/routing.ts`, driven by the scheduled worker route
> (`/api/internal/cron`, docs/RUNBOOK.md §"Scheduled work"). A verified `STOP` unsubscribes end to
> end, and `apps/web/lib/routing.integration.test.ts` proves it from a signed webhook POST to the
> durable consent row with a model that throws if it is ever reached. The registered opt-in,
> opt-out, and help auto-responses live in `packages/core/src/sms/auto-responses.ts`, transcribed
> from the console record and drift-tested against it in both directions.

## Deterministic keyword handling (code, before any model call)

Every inbound message is parsed by **code first**, in the fixed order in ARCHITECTURE §routing.

### Token matching (one rule for every keyword and token)

Normalize the message — trim whitespace, uppercase, strip trailing punctuation — then a keyword or
token matches only if it (or one of its **fixed, code-listed variants**) is the **entire
normalized message**. The affirmative accepts `YES` / `Y` / `YEP` / `YEA` / `SURE`; the decline
accepts `NO` / `N` / `NOPE` / `NAH` / `NO THANKS` / `NO THANK YOU`. So `"yes."`, `" YES "`,
`"Yep"`, `"y"`, `"n."`, and `"no thanks"` match, while `"yes, still right"` and
`"no thanks, but change it"` do **not** — they route onward as free text (in an active flow that
means the revision path, whose echoed proposal + confirm protects against a garbled read). Matching
is deterministic code — a fixed list, never fuzzy — and near-misses are never "interpreted" into a
commit or decline.

### Compliance keywords (always handled by code)

| Keyword | Behavior |
|---|---|
| `STOP` / `STOPALL` / `UNSUBSCRIBE` / `CANCEL` / `END` / `QUIT` | **Global** opt-out of all SMS — the exact registered opt-out list. Clears launch-program consent immediately. **Can never be reinterpreted by conversation state.** Send the single confirming opt-out reply, then nothing further. |
| `START` | Establish or restore consent to the one VIGA Farm Friend launch SMS program. |
| `JOIN` | Establish consent to the one VIGA Farm Friend launch SMS program. There is no launch `JOIN <program>` grammar. |
| `HELP` / `INFO` | Return help text; never suppressed by state. |

### Commitment tokens (context-bound, never global)

| Token | Behavior |
|---|---|
| `YES` / `NO` | Commit / decline the sender's **one live inventory-publication confirmation**. `YES` accepts the fixed variants `Y` / `YEP` / `YEA` / `SURE`; `NO` accepts `N` / `NOPE` / `NAH` / `NO THANKS` / `NO THANK YOU`. **Context-bound** — a YES/NO reply with no live pending inventory proposal does **not** commit or decline. A valid confirmation consumes the current proposal **exactly once** and **expires** (GC'd). |

A database constraint permits at most one open inventory proposal per sender. It carries its allowed
tokens, proposal version, expiry, and current prompt activation. New inventory text revises that
proposal and suspends token acceptance until Telnyx accepts the replacement prompt. A token whose
provider occurrence time does not follow the current prompt cannot consume the proposal.
The proposal is a distinct pending payload, not a draft inventory revision. `YES` creates the
immutable published revision; `NO` and expiry create no revision.

The exact expiry window is an unresolved launch decision.
An expired token gets an honest "that request expired — here's how to redo it" reply, never a
silent no-op.

`YES`/`NO` are **never global** and never override `STOP`/`HELP`/`FLAG`. They are the only two
commitment tokens: `OUT` and `IGNORE` are not tokens at all and parse as ordinary free text, so a
farmer who texts "out" reaches the interpreter rather than publishing something unreviewed. A
stock-out alert may ask the farmer to send current inventory; that reply uses the ordinary proposal
and `YES`/`NO` flow.

### Concurrent and out-of-order messages

After raw-body signature verification, a minimized inbox event commits before acknowledgement.
Provider event ID uniqueness makes retries and duplicates no-ops. Postgres claims at most one
ordinary stateful event per sender; no model or SMS call occurs while its row lock transaction is
open.

Ordinary stateful events are ordered by provider `occurred_at` plus event ID. An older event cannot
mutate newer conversation, confirmation, or publication state and may receive a deterministic
resend request. `STOP` and `START` use a separate consent-transition watermark: the later
provider-time command wins, and `STOP` wins an exact timestamp tie. An older delayed `START`
therefore cannot restore consent after a newer `STOP`.

### The FLAG safety rail

`FLAG` **pauses the thread** and **creates a review item** for the VIGA administrator (the
human-handoff). `FLAG` is handled by code, upstream of any model call.

**The review half is built (F-030).** `/admin/flags` lists open flags and resolves or dismisses
them, and its thread viewer shows the flagged sender's retained messages with the phone masked — so
the pre-launch gate this rail represents is satisfied. Both dispositions record the acting
administrator and, because the retention exemption is keyed on `flags.status = 'open'`, both release
the thread's expired bodies to the next purge pass.

`FLAG` is a **Farm Friend product safety feature**. It must **not** be represented as a
carrier-mandated keyword in campaign registration or public compliance copy.

## Consent model

- **One launch operational program** — VIGA Farm Friend launch SMS is the one program described by
  the registered/public opt-in. Inventory prompts, publication confirmations, customer inquiry
  replies, and stock-out alerts are applicable message categories inside it, not separately enrolled
  programs.
- **Launch-program consent** — `JOIN` and `START` establish or restore one durable consent state.
  `STOP` clears it and applies across all Farm Friend messaging. No **proactive non-required** SMS is
  sent without active launch consent.
- **Farmer onboarding** — after verifying control of the SMS number, onboarding may capture consent
  with provenance: how, when, and where it was captured and who recorded it. Every proactive farmer
  send must trace to that documented opt-in or a deterministic `JOIN`/`START`.
- **Customer-initiated inquiry** — the inbound inquiry permits its relevant direct response but does
  not create durable consent for later proactive notifications. Launch stores no follow-up interest,
  sends no passive customer follow-up, and has no scoped `MUTE` command. `MUTE` and follow-up
  interest were never implemented in executable code; F-016 verified their absence and added the
  schema and workflow guards that keep them out.
- **Message categories, not enrollments** — `outbox_work.message_category` is a bounded enum
  (`required_reply`, `inquiry_reply`, `inventory_prompt`, `inventory_confirmation`,
  `stock_out_alert`). A `required_reply` is the carrier-required answer to the recipient's own
  message and is never suppressed — otherwise `STOP` could not acknowledge itself. An
  `inquiry_reply` rides on the customer's own inbound message and needs no durable consent, but
  `STOP` still suppresses it. Every other category is proactive and requires **active** consent.
- **Future programs** — each requires its own disclosed enrollment when approved and built. Launch
  pre-creates no program discriminator, enrollment state, command arguments, tables, or UI.
- Consent decisions are **pure code, never a model call**.

## Required behavior

- Honor opt-out **immediately** and durably.
- Every proactive non-required message is attributable to active launch-program consent; code checks
  it again at dispatch authorization.
- The atomic outbox dispatch claim is the STOP boundary. STOP committed first suppresses every
  still-queued non-required message; a request dispatch-authorized first may already be in flight.
- Retry only definitive retryable rejection under a bounded policy. Record a possibly accepted
  result as ambiguous and do not automatically resend it without a verified Telnyx idempotency
  facility.
- Outbound passes the **outbound guard**, which normalizes avoidable typographic Unicode and
  refuses the **named raw-phone class**, regardless of model output. It is deliberately *not* a
  general private-value detector: keeping other actors' data out of a message comes from
  code-rendering cross-actor text from permitted typed facts and returning model prose only to
  the actor whose own task text produced it (see [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md)
  §"The code-enforced safety boundary and its verification").
- Raw inbound bodies are **short-lived** (exact retention is an unresolved launch decision; flagged
  threads exempt while the flag is open and for a bounded period after resolution); the phone is
  stored **hashed** for lookup/logging (the raw E.164 lives in **exactly one column**, read only by
  the outbound send path — see DATA_ARCHITECTURE §privacy).

## Provisional copy

Message templates (opt-out confirmation, help text, publish confirm, stock-out
alert) are drafted provisionally and finalized at A2P registration. Keep them in one place so the
registered copy is a single swap; none of the copy is a compliance *enforcement* point — the
enforcement is the deterministic code above.

The registered opt-out, opt-in, and help keyword lists are stated once in
`packages/core/src/sms/commands.ts` (`REGISTERED_*_KEYWORDS`), and the parser's tables are derived
from them, so a keyword cannot be advertised without being honored. `commands.test.ts` reads
`docs/TELNYX_10DLC_FIELD_VALUES.txt` and fails if the registered artifact and the parser disagree
in either direction.
