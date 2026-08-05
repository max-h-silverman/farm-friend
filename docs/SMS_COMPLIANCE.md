# Farm Friend — SMS Compliance

Keywords, consent, required behavior, and the FLAG safety rail. SMS is the **critical path** daily
driver. Routing mechanics are in [ARCHITECTURE.md](ARCHITECTURE.md); consent data in
[DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md).

> This document states the **enduring consent and carrier contract**. It carries no build status:
> what is actually built, registered, and open lives in
> [CURRENT_STATE.md](CURRENT_STATE.md).
>
> **Registered copy is transcribed, never authored here.** The opt-in, opt-out, and help
> auto-responses live once in `packages/core/src/sms/auto-responses.ts` and are drift-tested
> character-for-character against `docs/TELNYX_10DLC_FIELD_VALUES.txt`, which is a **transcript of
> live console state**. Change the carrier console first, then transcribe — never the reverse.

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
| `JOIN` | Establish consent to the one VIGA Farm Friend launch SMS program, **for a first-time sender only** — once a consent record exists, `JOIN` does not restore it and the sender is told to reply `START` (B-011, below). There is no launch `JOIN <program>` grammar. |
| `HELP` / `INFO` | Return help text; never suppressed by state. |

### Farmer product keywords (F-040 — never carrier-registered)

| Keyword | Behavior |
|---|---|
| `SIGNUP` / `SIGN UP` | Ask to be set up. A **bare** SIGNUP **grants no authority** — it opens one queue entry a coordinator acts on, and the reply deliberately does not read as a yes. Repeats are answered identically and produce one entry. An **invited** SIGNUP whose invitation carries a web agreement establishes launch consent (see §consent model, farmer onboarding); if that invitation also **names a farm**, redeeming it authorizes the farmer for it in the same transaction — the invitation is the decision, made when VIGA minted it. An invitation naming no farm still waits for a coordinator. |
| `LINK` | Send the farmer their private web-form link. **Refused unless the sender already holds a live authorization**; a stranger gets the signup acknowledgement and no link. |
| `STAND` | Issue a 12-hour numbered menu of the sender's currently editable locations. Each number binds one exact authorization+location pair; the model sees neither menu nor choice. |
| `SETTINGS` | Send the existing private standing link directly to its settings view. It uses the same token and revocation lifecycle as `LINK`, never a second login. |

### Customer map keyword (F-057 — never carrier-registered)

| Keyword | Behavior |
|---|---|
| `MAP` | Return only the configured canonical Farm Friend public-map URL. It is stateless, model-free, and does not alter an open confirmation or result list. |

`MAP` is parsed after compliance keywords and before all stateful commands. It therefore cannot
shadow STOP/START/JOIN/HELP, while a delayed MAP can still receive the current configured link.
Its direct reply is an `inquiry_reply`, so the existing STOP dispatch guard suppresses it for a
stopped sender.

### Customer paging keyword (F-046 — never carrier-registered)

| Keyword | Behavior |
|---|---|
| `MORE` / `NEXT` | Return the next page of the sender's pending result list. **Context-bound, never global** — it means nothing without a pending list, and with none it answers honestly rather than failing silently. Must match the **entire message**, so "any more eggs?" stays a question and reaches the model as free text. |

`MORE` is deliberately **independent of `YES`/`NO`** (max, 2026-07-31): a farmer with an open
inventory confirmation can page and keep the confirmation open. The words do not overlap, so
blocking one for the other would solve a collision that does not exist while making a farmer feel
ignored.

### Scheduled inventory keyword (F-052 — never carrier-registered)

| Keyword | Behavior |
|---|---|
| `SAME` | Publish an identical inventory revision only for the sender's active, provider-accepted scheduled prompt when that prompt displayed the complete current snapshot. **Context-bound, never global** — without that exact prompt it changes nothing, and "same eggs?" remains free text. It never confirms closure or profile data. |

`SAME` is parsed after compliance and ordinary `YES`/`NO` commitment tokens, and before farmer
product keywords. `STOP` therefore always wins, while an ordinary inventory confirmation keeps its
existing meaning. Replay, expiry, a changed inventory or closure base, a changed or paused
preference, revoked consent or authority, and the wrong provider prompt all refuse without
publishing.

These are **Farm Friend product keywords, exactly like `FLAG`** — not carrier-mandated, and they
must **never** be registered as compliance keywords or transcribed into `TELNYX_10DLC_FIELD_VALUES.txt`.
`farmer-keywords.test.ts` asserts both directions.

They are parsed **after** compliance keywords and commitment tokens, so a farmer keyword can never
shadow one. That ordering is the guarantee: if a synonym ever collided with `STOP`, an opt-out
would stop working.

A positive whole-message number is also deterministic and context-bound. It selects only from the
sender's current unexpired `STAND` menu; without one it receives a code-rendered no-active-choice
reply. Target selection never changes consent. `STOP` and `START` remain the only consent controls.

The `LINK` reply is a **proactive** category, not a reply category — handing over a durable
credential is Farm Friend speaking first, so it passes the same consent gate as any other proactive
message rather than riding on the inbound message that asked for it.

### Commitment tokens (context-bound, never global)

| Token | Behavior |
|---|---|
| `YES` / `NO` | Commit / decline the sender's **one live inventory-publication confirmation**. `YES` accepts the fixed variants `Y` / `YEP` / `YEA` / `SURE`; `NO` accepts `N` / `NOPE` / `NAH` / `NO THANKS` / `NO THANK YOU`. **Context-bound** — a YES/NO reply with no live pending inventory proposal does **not** commit or decline. A valid confirmation consumes the current proposal **exactly once** and **expires** (GC'd). |

A database constraint permits at most one open inventory proposal per sender. The deterministic
parser owns one fixed `YES`/`NO` vocabulary; proposal rows store only their version, expiry, and
current prompt activation. New inventory text revises that proposal and suspends token acceptance
until Telnyx accepts the replacement prompt. A token whose
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

Because the two watermarks are independent, **conversation staleness never refuses a compliance
keyword** (GL-002). Deterministic routing parses compliance *before* the staleness gate and applies
that gate to free text and confirmation tokens only, so a `STOP` delayed in the carrier network
still reaches consent and still suppresses later proactive dispatch. This is stated because the
opposite once shipped: the worker refused stale events before parsing them, and a delayed opt-out
was discarded while the sender remained recorded as subscribed.

### The FLAG safety rail

`FLAG` **pauses the thread** and **creates a review item** for the VIGA administrator (the
human-handoff). `FLAG` is handled by code, upstream of any model call.

**A flag must be disposable, or retention never terminates.** `/admin/flags` lists open flags and
resolves or dismisses them, and its thread viewer shows the flagged sender's retained messages with
the phone masked. Both dispositions record the acting administrator and, because the retention
exemption is keyed on `flags.status = 'open'`, **both** release the thread's expired bodies to the
next purge pass — a rail that could only be resolved, never dismissed, would exempt a dismissed
thread from retention forever.

`FLAG` is a **Farm Friend product safety feature**. It must **not** be represented as a
carrier-mandated keyword in campaign registration or public compliance copy.

## Consent model

- **One launch operational program** — VIGA Farm Friend launch SMS is the one program described by
  the registered/public opt-in. Inventory prompts, publication confirmations, customer inquiry
  replies, and stock-out alerts are applicable message categories inside it, not separately enrolled
  programs.
- **Launch-program consent** — one durable consent state. `JOIN` **establishes** it for a sender
  with no record; `START` establishes **or restores** it from any state. `STOP` clears it and
  applies across all Farm Friend messaging. No **proactive non-required** SMS is sent without active
  launch consent. Inventory reminders use the same consent; choosing or pausing a cadence does not
  establish, restore, or revoke it.

  A successful first-time `JOIN` or restoring `START` queues two distinct, deduplicated replies:
  the carrier-registered consent receipt as `required_reply`, then a product welcome explaining
  customer inquiry, `MAP`, `HELP`, and `STOP` as an ordinary `inquiry_reply`. A retry may create
  neither a second receipt nor a second welcome. An already-enrolled `JOIN` receives only the
  existing code-rendered instruction to use `START`.

  **Why the two opt-in keywords differ (B-011).** The carrier keeps its own opt-out list and
  enforces it independently of ours: while a number is on it, Telnyx refuses every send with
  `409 / 40300`, regardless of the messaging profile's auto-response settings. **`START` clears that
  block; `JOIN` does not** — `JOIN` is Farm Friend's registered keyword and carries no meaning to
  the carrier's compliance layer (verified 2026-07-27: a `join` four minutes after a `stop` still
  409'd, while a `start` between them was accepted; it is a state, not a timing window).

  If `JOIN` restored consent, Farm Friend would record `active` for a recipient the carrier blocks —
  the database and the carrier disagreeing about the same person, with `isProactiveSendPermitted`
  returning true for messages that can never arrive. Restricting `JOIN` to first-time senders makes
  our record **conform** to the carrier's rather than reconciling after a divergence, and it does so
  without letting any provider response drive a consent transition: the decision is a pure function
  of our own deterministic routing and our own stored record (Golden Rule #2 intact). A `409` is
  never consulted.

  A `JOIN` from an existing record receives a code-rendered reply naming `START`, sent as
  `required_reply`. **Known limitation:** while the carrier block is active that reply is itself
  blocked and never arrives — so the instruction cannot rely on being delivered by SMS, and the
  written material a person reads *before* they text has to carry it.

  **GL-034 aligned that material.** Every place the public pages explain resuming after an opt-out
  now names `START`: the opt-in page, the Terms opt-in and opt-out sections, the Terms supported
  commands, and the Privacy "Your Choices" section — all in
  [VIGA_10DLC_WEBSITE_COPY.md](VIGA_10DLC_WEBSITE_COPY.md), which is the paste-ready source for the
  public Squarespace pages. `JOIN` remains the published *first-time* call to action; only the
  returning path changed. `packages/core/src/sms/return-after-optout-copy.test.ts` asserts both
  halves — that the returning instruction names `START` and that the first-time `JOIN` invitation
  survives — plus the same property on `ALREADY_JOINED_RESPONSE`.

  **Still owed, and not ours to change:** the registered campaign's own `Opt In Workflow
  Description` in the Telnyx console still describes the published page without the `START`
  sentence, and the registered opt-out auto-response names no way back. Both are live console
  state; see GL-034 in [GO_LIVE_GUIDE.md](GO_LIVE_GUIDE.md) for the exact edits, which must be made
  in the console first and then transcribed into
  [TELNYX_10DLC_FIELD_VALUES.txt](TELNYX_10DLC_FIELD_VALUES.txt).
- **Farmer onboarding** — the invited farmer accepts an SMS agreement on
  `/farmer/onboarding/[token]`, which stamps `farmer_invitations.agreed_to_sms_at`. That stamp is
  **not** consent: a tick on a web page proves nothing about who holds the handset. Consent is
  established when `SIGNUP <token>` arrives from a phone, which is the evidence tying the person who
  agreed to the number that will be messaged — recorded with capture source `farmer_onboarding`, the
  agreement's own moment as its documented origin. Every proactive farmer send must trace to that
  opt-in or a deterministic `JOIN`/`START`.

  It goes through **the same** `applyConsentTransition` writer as `JOIN`, under
  `firstTimeOnly`, so it establishes consent **only for a sender with no record**. A farmer who
  already opted in keeps one unchanged record, and a farmer who texted `STOP` is **not** silently
  re-enrolled by filling in a web form — the same B-011 reasoning, since the carrier would refuse
  the send regardless and only `START` clears its list. A `SIGNUP` that establishes consent is
  answered with the registered opt-in receipt; a `SIGNUP` with no consent basis (uninvited, or an
  invitation whose box was never ticked) is told to reply `JOIN`, which is the one place that word
  belongs in farmer-facing copy.
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
- Raw inbound bodies expire after **30 days**; flagged threads are exempt only while a flag is open
  and become eligible on disposition, with no grace period. The phone is
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
