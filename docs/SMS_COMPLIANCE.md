# Farm Friend — SMS Compliance

Keywords, consent, required behavior, and the FLAG safety rail. SMS is the **critical path** daily
driver; **A2P 10DLC is assumed approved by launch** (Eat Vashon week). All copy here is
**provisional** until the campaign is registered. Routing mechanics are in
[ARCHITECTURE.md](ARCHITECTURE.md); consent data in [DATA_ARCHITECTURE.md](DATA_ARCHITECTURE.md).

> **Design authority.** [CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md](CLEAN_ROOM_PRODUCT_ARCHITECTURE_HANDOFF.md)
> is the settled contract; where this doc disagrees, the handoff wins.
>
> **Status: requirements, not claims.** The current webhook parses and echoes a command but does not
> persist or enforce consent, and the current schema still contains a speculative nullable program
> key. The behavior below is the approved F-016 target, not current executable proof.

## Deterministic keyword handling (code, before any model call)

Every inbound message is parsed by **code first**, in the fixed order in ARCHITECTURE §routing.

### Token matching (one rule for every keyword and token)

Normalize the message — trim whitespace, uppercase, strip trailing punctuation — then a keyword or
token matches only if it (or one of its **fixed, code-listed variants**) is the **entire
normalized message**. The affirmative accepts `YES` / `Y` / `YEP` / `YEA` / `SURE`; the decline
accepts `NO` / `N` / `NOPE` / `NAH` / `NO THANKS` / `NO THANK YOU`. So `"yes."`, `" YES "`,
`"Yep"`, `"y"`, `"n."`, and `"no thanks"` match, while `"yes, still right"` and
`"no thanks, but change it"` do **not** — they route onward as free text (in an active flow that
means the revision path, whose echoed draft + confirm protects against a garbled read). Matching
is deterministic code — a fixed list, never fuzzy — and near-misses are never "interpreted" into a
commit or decline.

### Compliance keywords (always handled by code)

| Keyword | Behavior |
|---|---|
| `STOP` / `UNSUBSCRIBE` / `END` / `QUIT` | **Global** opt-out of all SMS. Clears launch-program consent immediately. **Can never be reinterpreted by conversation state.** Send the single confirming opt-out reply, then nothing further. |
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

The exact expiry window is an unresolved launch decision.
An expired token gets an honest "that request expired — here's how to redo it" reply, never a
silent no-op.

`YES`/`NO` are **never global** and never override `STOP`/`HELP`/`FLAG`. `OUT` and `IGNORE` are not
commitment tokens and can never publish inventory. A stock-out alert may ask the farmer to send
current inventory; that reply uses the ordinary proposal and `YES`/`NO` flow.

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
human-handoff). Once public SMS is live (untrusted inbound), the flag-review UI + thread viewer is
a **hard pre-launch gate**. `FLAG` is handled by code, upstream of any model call.

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
  sends no passive customer follow-up, and has no scoped `MUTE` command.
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
- Outbound passes the **redaction guard** — no raw phone numbers / private fields, regardless of
  model output (see [AI_ARCHITECTURE.md](AI_ARCHITECTURE.md) §safety boundary).
- Raw inbound bodies are **short-lived** (exact retention is an unresolved launch decision; flagged
  threads exempt while the flag is open and for a bounded period after resolution); the phone is
  stored **hashed** for lookup/logging (the raw E.164 lives in **exactly one column**, read only by
  the outbound send path — see DATA_ARCHITECTURE §privacy).

## Provisional copy

Message templates (opt-out confirmation, help text, publish confirm, stock-out
alert) are drafted provisionally and finalized at A2P registration. Keep them in one place so the
registered copy is a single swap; none of the copy is a compliance *enforcement* point — the
enforcement is the deterministic code above.

> *Current drift:* the registered/public 10DLC source copy still advertises `OUT`/`IGNORE` stock-out
> actions and FLAG, and its `STOPALL` keyword is absent from the current parser. F-012 owns that
> registered keyword/sample-copy alignment before public SMS launch; F-016 does not silently absorb
> it.
